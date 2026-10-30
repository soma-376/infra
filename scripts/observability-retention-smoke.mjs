#!/usr/bin/env node
// dev 설정을 바꾸지 않는 PROJ-256 보존 검증. 고정 chart/image를 새 로컬 저장소에서만 5분 보존으로 실행한다.
// 현재 시각의 합성 입력 하나를 자동 flush/retention으로 삭제하고, 같은 저장소 재시작과 새 입력까지 대조한다.
// HELM_BIN=/path/to/helm node scripts/observability-retention-smoke.mjs --output-dir /private/path/new-run
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dump, load, loadAll } from 'js-yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha = data => createHash('sha256').update(data).digest('hex');
const sleep = ms => new Promise(done => setTimeout(done, ms));
const iso = () => new Date().toISOString();

export function isolatedConfigs(original) {
  const configs = structuredClone(original);
  assert.equal(configs.loki.limits_config.retention_period, '72h', '원래 Loki 보존 계약');
  assert.equal(configs.tempo.backend_scheduler.provider.compaction.compaction.block_retention, '48h', '원래 Tempo 보존 계약');
  assert.equal(configs.tempo.backend_worker?.compaction?.block_retention, '48h', '실제 Tempo 보존 worker도 48h 계약');
  Object.assign(configs.loki.limits_config, { retention_period: '5m', max_query_lookback: '1h' });
  Object.assign(configs.loki.compactor, { compaction_interval: '10s', apply_retention_interval: '20s', retention_delete_delay: '30s' });
  Object.assign(configs.loki.ingester, { chunk_idle_period: '30s', max_chunk_age: '1m', chunk_retain_period: '0s', flush_check_period: '5s' });
  Object.assign(configs.loki.ingester.wal, { checkpoint_duration: '30s' });
  configs.tempo.backend_scheduler.provider.retention = { interval: '10s' };
  Object.assign(configs.tempo.backend_scheduler.provider.compaction.compaction, { block_retention: '5m', compacted_block_retention: '30s' });
  configs.tempo.backend_worker = { ...(configs.tempo.backend_worker ?? {}), compaction: { block_retention: '5m', compacted_block_retention: '30s' } };
  configs.tempo.storage.trace.blocklist_poll = '10s';
  configs.tempo.live_store = { ...(configs.tempo.live_store ?? {}), complete_block_timeout: '1m' };
  return configs;
}

// 만료 전 생존, 실제 경과 시간, 경로 존재→부재, 삭제 작업을 모두 요구한다.
// 실행 중 chunk cache는 삭제된 내용을 잠시 조회할 수 있다. API 부재는 같은 저장소 재시작 뒤 별도로 필수 검사한다.
export function deletionVerdict({ mapped, remaining, deletedCount, ready, elapsedSeconds, survivalBeforeExpiry }) {
  return mapped.length > 0 && remaining.length === 0 && deletedCount > 0 && ready === 200 && elapsedSeconds >= 300 && survivalBeforeExpiry === true;
}

export function metricSum(text, name, label) {
  return text.split('\n').filter(line => line.startsWith(`${name}{`) || line.startsWith(`${name} `))
    .filter(line => !label || line.includes(label))
    .reduce((sum, line) => sum + Number(line.trim().split(/\s+/)[1]), 0);
}

// Loki filesystem은 legacy 전체-key base64와 tenant/fingerprint/base64(suffix) 경로를 지원한다.
export function storageObjects(lokiFiles, tempoFiles, knownBlockIds = []) {
  const loki = lokiFiles.filter(file => {
    if (!file.path.startsWith('chunks/')) return false;
    const decoded = Buffer.from(basename(file.path), 'base64').toString('utf8');
    return /^fake\/[a-f0-9]+:[a-f0-9]+:[a-f0-9]+:[a-f0-9]+$/.test(decoded) ||
      (/^chunks\/fake\/[a-f0-9]+\//.test(file.path) && /^[a-f0-9]+:[a-f0-9]+:[a-f0-9]+$/.test(decoded));
  });
  const blockIds = knownBlockIds.length ? knownBlockIds : [...new Set(tempoFiles.flatMap(file => {
    const match = /^traces\/single-tenant\/([a-f0-9-]{36})\/(?:meta|meta\.compacted)\.json$/.exec(file.path);
    return match ? [match[1]] : [];
  }))];
  // metadata만 사라진 경우를 성공으로 세지 않는다. backend·live-store의 대응 data/index/WAL도 모두 추적한다.
  const tempo = tempoFiles.filter(file => blockIds.some(id => file.path.includes(`/${id}/`) || file.path.includes(`/${id}+`)));
  return { loki, tempo, tempoBlockIds: blockIds };
}

export function inventory(path) {
  const result = [];
  const walk = dir => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) {
        try {
          const stat = statSync(file);
          result.push({ path: relative(path, file), bytes: stat.size, modifiedAt: stat.mtime.toISOString(), sha256: sha(readFileSync(file)) });
        } catch (error) { if (error.code !== 'ENOENT') throw error; } // retention과 파일 목록 읽기의 경합
      }
    }
  };
  if (existsSync(path)) walk(path);
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

async function main() {
  const args = process.argv.slice(2);
  assert.equal(args.length, 2, 'usage: --output-dir <새 전용 증거 디렉터리>');
  assert.equal(args[0], '--output-dir');
  const output = resolve(args[1]);
  assert.ok(!existsSync(output), '기존 증거 디렉터리를 덮어쓰지 않는다');
  const helm = process.env.HELM_BIN;
  assert.ok(helm && existsSync(helm), 'HELM_BIN 고정 바이너리 필요');
  mkdirSync(output, { recursive: true, mode: 0o700 });
  chmodSync(output, 0o700);
  const write = (name, value) => writeFileSync(join(output, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const run = (bin, input, timeout = 120_000) => spawnSync(bin, input, { encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });
  const checked = (bin, input) => {
    const r = run(bin, input);
    assert.equal(r.status, 0, `${bin} ${input[0]}: ${(r.stderr || r.stdout || r.error?.message || '').slice(-4000)}`);
    return r.stdout.trim();
  };
  const docker = (...input) => checked('docker', input);
  const suffix = randomBytes(6).toString('hex');
  const network = `proj191-retention-${suffix}`;
  const label = `pulsemetry.retention.run=${suffix}`;
  const work = mkdtempSync(join(tmpdir(), 'proj191-retention-'));
  chmodSync(work, 0o755);
  const dir = name => { const p = join(work, name); mkdirSync(p, { recursive: true }); chmodSync(p, 0o777); return p; };
  const data = { loki: dir('loki-data'), tempo: dir('tempo-data'), collector: dir('collector-data') };
  const containers = {};
  const evidence = {
    schema: 1, scope: 'isolated-local-retention-only', runId: suffix, startedAt: iso(), status: 'RUNNING',
    constraints: { devMutated: false, clockChanged: false, backdatedInput: false, deleteApiUsed: false, beforeVerdictFileDeletion: false, observationCapSeconds: 1800 },
    original: {}, isolated: {}, images: {}, checks: {}, failures: [], workDirectory: work,
  };
  const event = (phase, details = {}) => {
    const value = { at: iso(), phase, ...details };
    appendFileSync(join(output, 'timeline.jsonl'), JSON.stringify(value) + '\n', { mode: 0o600 });
    writeFileSync(join(output, 'progress.json'), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify(value));
  };
  let createdNetwork = false;
  const urls = {};
  const request = async (url, init = {}) => {
    assert.equal(new URL(url).hostname, '127.0.0.1', 'HTTP는 이 실행의 loopback endpoint만 사용');
    const res = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(10_000) });
    return { status: res.status, text: await res.text() };
  };
  const until = async (message, callback, ms = 120_000) => {
    const end = Date.now() + ms;
    let lastError;
    while (Date.now() < end) {
      try { const result = await callback(); if (result) return result; } catch (error) { lastError = error.message; }
      await sleep(1000);
    }
    throw new Error(`${message}: ${ms / 1000}초 경과${lastError ? ` (${lastError})` : ''}`);
  };
  const portUrl = (name, port) => `http://127.0.0.1:${docker('port', containers[name], `${port}/tcp`).split('\n')[0].split(':').pop()}`;
  const refreshUrls = () => { urls.loki = portUrl('loki', 3100); urls.tempo = portUrl('tempo', 3200); urls.collector = portUrl('collector', 4318); urls.collectorHealth = portUrl('collector', 13133); };
  try {
    event('render');
    const ns = 'pulsemetry-observability';
    const chart = name => loadAll(checked(helm, ['template', name, join(root, 'helm/observability', name), '-n', ns])).filter(Boolean);
    const docs = { loki: chart('loki'), tempo: chart('tempo'), collector: chart('otel-platform') };
    const maps = {};
    const memory = {};
    for (const [name, manifests] of Object.entries(docs)) {
      maps[name] = Object.assign({}, ...manifests.filter(x => x.kind === 'ConfigMap').map(x => x.data));
      const c = manifests.find(x => x.kind === 'StatefulSet').spec.template.spec.containers[0];
      assert.match(c.image, /@sha256:[a-f0-9]{64}$/, 'digest 고정 필요');
      evidence.images[name] = c.image;
      const match = /^(\d+)(Mi|Gi)$/.exec(c.resources.limits.memory);
      assert.ok(match, '메모리 상한 형식');
      memory[name] = `${match[1]}${match[2] === 'Gi' ? 'g' : 'm'}`;
    }
    const original = { loki: load(maps.loki['config.yaml']), tempo: load(maps.tempo['tempo.yaml']) };
    const isolated = isolatedConfigs(original);
    evidence.original = { lokiRetention: original.loki.limits_config.retention_period, tempoRetention: original.tempo.backend_scheduler.provider.compaction.compaction.block_retention,
      tempoWorkerRetention: original.tempo.backend_worker.compaction.block_retention };
    evidence.isolated = { lokiRetention: isolated.loki.limits_config.retention_period, tempoRetention: isolated.tempo.backend_scheduler.provider.compaction.compaction.block_retention };
    maps.loki['config.yaml'] = dump(isolated.loki);
    maps.tempo['tempo.yaml'] = dump(isolated.tempo);
    for (const [name, files] of Object.entries(maps)) for (const [file, contents] of Object.entries(files)) {
      assert.equal(basename(file), file);
      writeFileSync(join(dir(`${name}-conf`), file), contents, { mode: 0o644 });
      write(`${name}-${file}`, contents);
    }
    write('source-configs.json', original);
    write('empty-storage.json', { loki: inventory(data.loki), tempo: inventory(data.tempo) });
    docker('network', 'create', '--label', label, network); createdNetwork = true;
    const start = (name, extra) => {
      const id = docker('run', '-d', '--platform', 'linux/arm64', '--network', network, '--label', label, '--name', `${network}-${name}`,
        '--read-only', '--user', '10001:10001', '--memory', memory[name], '--memory-swap', memory[name], ...extra);
      containers[name] = id;
      evidence.images[`${name}Runtime`] = JSON.parse(docker('inspect', id))[0].Image;
      return id;
    };
    start('loki', ['--network-alias', `pulsemetry-loki.${ns}.svc`, '--network-alias', `pulsemetry-loki.${ns}.svc.cluster.local`,
      '--network-alias', `pulsemetry-loki-memberlist.${ns}.svc.cluster.local`, '--tmpfs', '/tmp:uid=10001',
      '-v', `${join(work, 'loki-conf')}:/etc/loki/config:ro`, '-v', `${join(work, 'loki-conf')}:/etc/loki/runtime-config:ro`,
      '-v', `${data.loki}:/var/loki`, '-p', '127.0.0.1::3100', evidence.images.loki,
      '-config.file=/etc/loki/config/config.yaml', '-config.expand-env=true', '-target=all']);
    start('tempo', ['--network-alias', `pulsemetry-tempo.${ns}.svc`, '-v', `${join(work, 'tempo-conf')}:/conf:ro`,
      '-v', `${data.tempo}:/var/tempo`, '-p', '127.0.0.1::3200', evidence.images.tempo, '-config.file=/conf/tempo.yaml']);
    start('collector', ['--network-alias', `pulsemetry-otel-platform.${ns}.svc`, '-e', 'MY_POD_IP=0.0.0.0',
      '-v', `${join(work, 'collector-conf')}:/conf:ro`, '-v', `${data.collector}:/var/lib/otelcol/queue`,
      '-p', '127.0.0.1::4318', '-p', '127.0.0.1::13133', evidence.images.collector, '--config=/conf/relay']);
    refreshUrls();
    for (const name of ['loki', 'tempo']) await until(`${name} Ready`, async () => (await request(`${urls[name]}/ready`)).status === 200);
    await until('Collector Ready', async () => (await request(urls.collectorHealth)).status === 200);
    const effectiveLokiResponse = await request(`${urls.loki}/config`);
    write('effective-loki.yaml', effectiveLokiResponse.text);
    const effectiveLoki = load(effectiveLokiResponse.text);
    const effectiveTempoResponse = await request(`${urls.tempo}/status/config`);
    assert.equal(effectiveTempoResponse.status, 200, 'Tempo effective config');
    write('effective-tempo.yaml', effectiveTempoResponse.text);
    const effectiveTempo = loadAll(effectiveTempoResponse.text).find(config => config?.backend_scheduler);
    assert.ok(effectiveTempo, 'Tempo effective 설정 문서');
    assert.equal(effectiveLoki.limits_config.retention_period, '5m');
    assert.equal(effectiveLoki.limits_config.max_query_lookback, '1h');
    assert.equal(effectiveLoki.compactor.retention_enabled, true);
    assert.equal(effectiveTempo.backend_scheduler.provider.compaction.compaction.block_retention, '5m0s');
    assert.equal(effectiveTempo.backend_worker.compaction.block_retention, '5m0s');
    write('effective-configs.json', { loki: effectiveLoki, tempo: effectiveTempo });
    evidence.checks.configParsedAndReady = true;
    event('ready');
    const makeFixture = () => ({ traceId: randomBytes(16).toString('hex'), spanId: randomBytes(8).toString('hex'), timestamp: Date.now() });
    const send = async fixture => {
      const nsTime = String(BigInt(fixture.timestamp) * 1_000_000n);
      const pushed = await request(`${urls.loki}/loki/api/v1/push`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ streams: [{
        stream: { environment: 'isolated-retention', run: suffix, fixture: fixture.traceId },
        values: [[nsTime, `synthetic-retention run=${suffix} trace_id=${fixture.traceId}`]],
      }] }) });
      assert.equal(pushed.status, 204, `Loki synthetic push ${pushed.status}: ${pushed.text}`);
      const trace = await request(`${urls.collector}/v1/traces`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ resourceSpans: [{
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'retention-smoke' } }] },
        scopeSpans: [{ scope: { name: 'isolated-retention-smoke' }, spans: [{ traceId: fixture.traceId, spanId: fixture.spanId, name: 'retention-fixture', kind: 1,
          startTimeUnixNano: nsTime, endTimeUnixNano: String(BigInt(nsTime) + 1_000_000n) }] }],
      }] }) });
      assert.equal(trace.status, 200, `Collector synthetic push ${trace.status}`);
    };
    const query = async fixture => {
      const params = new URLSearchParams({ query: `{environment="isolated-retention",run="${suffix}",fixture="${fixture.traceId}"}`, start: String(BigInt(fixture.timestamp - 1000) * 1_000_000n), end: String(BigInt(fixture.timestamp + 1000) * 1_000_000n) });
      const lr = await request(`${urls.loki}/loki/api/v1/query_range?${params}`);
      const tr = await request(`${urls.tempo}/api/v2/traces/${fixture.traceId}`);
      assert.equal(lr.status, 200, `Loki query HTTP${lr.status}`);
      assert.ok([200, 404].includes(tr.status), `Tempo query HTTP${tr.status}`);
      const lines = JSON.parse(lr.text).data.result.reduce((n, stream) => n + stream.values.length, 0);
      const spans = tr.status === 200 ? (JSON.parse(tr.text).trace?.resourceSpans ?? []).flatMap(x => x.scopeSpans ?? []).flatMap(x => x.spans ?? []).length : 0;
      return { loki: lines ? 'PRESENT' : 'ABSENT', tempo: spans ? 'PRESENT' : 'ABSENT', logCount: lines, spanCount: spans, tempoHttp: tr.status };
    };
    const fixture = makeFixture();
    evidence.fixture = fixture;
    await send(fixture);
    await until('초기 로그/trace 조회', async () => { const q = await query(fixture); return q.logCount === 1 && q.spanCount === 1 && q; });
    evidence.checks.fixtureInitiallyQueryable = true;
    const deadline = fixture.timestamp + 1800_000;
    const mapsOf = (knownBlockIds = []) => storageObjects(inventory(data.loki), inventory(data.tempo), knownBlockIds);
    const mapped = await until('chunk/block 저장소 대응', async () => { const m = mapsOf(); return m.loki.length && m.tempo.length && m; });
    evidence.mapped = mapped;
    write('persisted-storage.json', { at: iso(), loki: inventory(data.loki), tempo: inventory(data.tempo), mapping: mapped });
    event('persisted', { lokiChunkCount: mapped.loki.length, tempoBlockCount: mapped.tempoBlockIds.length, tempoObjectCount: mapped.tempo.length });
    const lokiMetric = 'loki_boltdb_shipper_retention_sweeper_chunk_deleted_duration_seconds_count';
    let observed;
    let tick = 0;
    while (Date.now() < deadline) {
      const [q, lm, tm, lr, tr] = await Promise.all([
        query(fixture), request(`${urls.loki}/metrics`), request(`${urls.tempo}/metrics`), request(`${urls.loki}/ready`), request(`${urls.tempo}/ready`),
      ]);
      assert.equal(lm.status, 200); assert.equal(tm.status, 200);
      const current = mapsOf(mapped.tempoBlockIds);
      const lokiDeleted = metricSum(lm.text, lokiMetric, 'status="success"');
      const tempoDeleted = metricSum(tm.text, 'tempodb_retention_deleted_total');
      observed = { at: iso(), elapsedSeconds: (Date.now() - fixture.timestamp) / 1000, query: q, remaining: current,
        deleted: { loki: lokiDeleted, tempo: tempoDeleted }, ready: { loki: lr.status, tempo: tr.status } };
      appendFileSync(join(output, 'observations.jsonl'), JSON.stringify(observed) + '\n', { mode: 0o600 });
      if (!evidence.beforeExpiry && observed.elapsedSeconds >= 270 && observed.elapsedSeconds < 300 &&
          q.loki === 'PRESENT' && q.tempo === 'PRESENT' && current.loki.length && current.tempo.length &&
          lr.status === 200 && tr.status === 200 && lokiDeleted === 0 && tempoDeleted === 0) {
        evidence.beforeExpiry = observed;
        write('before-expiry.json', observed);
      }
      const timing = { elapsedSeconds: observed.elapsedSeconds, survivalBeforeExpiry: Boolean(evidence.beforeExpiry) };
      if (deletionVerdict({ mapped: mapped.loki, remaining: current.loki, deletedCount: lokiDeleted, ready: lr.status, ...timing }) &&
          deletionVerdict({ mapped: mapped.tempo, remaining: current.tempo, deletedCount: tempoDeleted, ready: tr.status, ...timing })) {
        evidence.checks.retentionDeletedPersistedObjects = true;
        write('after-retention-storage.json', { ...observed, loki: inventory(data.loki), tempo: inventory(data.tempo) });
        write('after-retention-metrics.txt', lm.text + '\n' + tm.text);
        break;
      }
      if (tick++ % 6 === 0) event('observing', { elapsedSeconds: observed.elapsedSeconds, query: q, remaining: { loki: current.loki.length, tempo: current.tempo.length }, deleted: observed.deleted });
      await sleep(Math.min(10_000, Math.max(0, deadline - Date.now())));
    }
    if (!evidence.checks.retentionDeletedPersistedObjects) {
      evidence.status = 'INCOMPLETE';
      throw new Error('30분 내 자동 보존 삭제의 경과시간/만료전생존/파일/작업 증거를 모두 확인하지 못했다');
    }
    evidence.deletion = observed;
    event('deleted', { elapsedSeconds: observed.elapsedSeconds, deleted: observed.deleted });
    for (const name of ['loki', 'tempo']) docker('restart', containers[name]);
    refreshUrls();
    for (const name of ['loki', 'tempo']) await until(`${name} 같은 저장소 재시작`, async () => (await request(`${urls[name]}/ready`)).status === 200);
    const postRestart = [];
    for (let i = 0; i < 3; i++) { const q = await query(fixture); assert.equal(q.loki, 'ABSENT'); assert.equal(q.tempo, 'ABSENT'); postRestart.push({ at: iso(), ...q }); await sleep(5000); }
    write('same-storage-restart.json', { queries: postRestart, loki: inventory(data.loki), tempo: inventory(data.tempo) });
    evidence.checks.sameStorageRestartDoesNotReplayFixture = true;
    const fresh = makeFixture();
    await send(fresh);
    await until('재시작 뒤 새 fixture', async () => { const q = await query(fresh); return q.logCount === 1 && q.spanCount === 1 && q; });
    evidence.checks.newFixtureQueryable = true;
    evidence.freshFixture = fresh;
    evidence.coverage = { verified: '동일 digest의 격리 filesystem에서 자동 보존 chunk/block 삭제·재시작 비복원·신규 입력', notVerified: ['dev 특정 과거 파일의 물리 삭제', 'dev 72h/48h 전체 기간 경과 재현', '디스크 secure erase 또는 모든 WAL bytes의 포렌식 부재'] };
    evidence.status = 'PASS';
  } catch (error) {
    if (evidence.status !== 'INCOMPLETE') evidence.status = 'FAIL';
    evidence.failures.push(error.stack ?? error.message);
    event('failed', { status: evidence.status, reason: error.message });
  } finally {
    for (const [name, id] of Object.entries(containers)) {
      const logs = run('docker', ['logs', id]);
      write(`${name}-container.log`, `${logs.stdout ?? ''}${logs.stderr ?? ''}`);
    }
    write('final-storage.json', { at: iso(), loki: inventory(data.loki), tempo: inventory(data.tempo) });
    // 판정 전에 파일을 삭제하지 않는다. 실패/미완료 저장소는 후속 진단용으로 보존한다.
    const cleanup = [];
    for (const [name, id] of Object.entries(containers).reverse()) {
      const info = run('docker', ['inspect', id]);
      if (info.status === 0 && JSON.parse(info.stdout)[0].Config.Labels['pulsemetry.retention.run'] === suffix) {
        const removed = run('docker', ['rm', '-f', id]); cleanup.push({ name, id, removed: removed.status === 0 });
      } else cleanup.push({ name, id, removed: false, reason: 'ownership-check-failed' });
    }
    if (createdNetwork) { const r = run('docker', ['network', 'rm', network]); cleanup.push({ network, removed: r.status === 0 }); }
    evidence.cleanup = cleanup;
    if (cleanup.some(x => !x.removed)) { evidence.status = 'FAIL'; evidence.failures.push('소유 로컬 리소스 정리 미완료'); }
    evidence.finishedAt = iso();
    evidence.seconds = (Date.now() - Date.parse(evidence.startedAt)) / 1000;
    write('result.json', evidence);
    if (evidence.status === 'PASS') rmSync(work, { recursive: true, force: false });
  }
  console.log(`${evidence.status}: isolated retention (${join(output, 'result.json')})`);
  process.exitCode = evidence.status === 'PASS' ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
