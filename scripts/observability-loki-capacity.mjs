#!/usr/bin/env node
// Loki 단일 바이너리의 수신 상한·burst·메모리·WAL 복구를 chart 설정 그대로 로컬 Docker에서 잰다(ADR-0039). AWS에 연결하지 않는다.
// 로그는 앱 JSON envelope 형태의 대표 줄(16 stream)이다. 메모리는 Docker cgroup v2 값을 읽는다:
// memory.peak(커널이 기록한 최대, page cache 포함)·memory.events(oom_kill)와 5초 표본의 memory.current·memory.stat anon.
//
//   HELM_BIN=/path/to/helm node scripts/observability-loki-capacity.mjs --output <새 증거 파일>
//       [--phases sustained,overload,burst,wal] [--sustained-minutes 30] [--overload-minutes 10]
//
// 기본 시간보다 짧게 돌리면 status가 SHORT_RUN이다. 필수 기준 하나라도 어기면 FAIL이고 종료 코드가 1이다.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dump, load, loadAll } from 'js-yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argument = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const output = argument('output') && resolve(argument('output'));
if (!output) throw new Error('usage: observability-loki-capacity.mjs --output <새 증거 파일>');
if (existsSync(output)) throw new Error('기존 증거를 덮어쓰지 않는다. 새 --output 경로를 사용한다.');
const helm = process.env.HELM_BIN;
if (!helm) throw new Error('HELM_BIN을 고정 버전 실행 파일로 지정해야 한다');
const DEFAULT_MINUTES = { sustained: 30, overload: 10 };
const minutes = { sustained: Number(argument('sustained-minutes', DEFAULT_MINUTES.sustained)), overload: Number(argument('overload-minutes', DEFAULT_MINUTES.overload)) };
const phases = argument('phases', 'sustained,overload,burst,wal').split(',');
const MiB = 1024 * 1024;
// 통과 기준. 표본 anon 최대가 limit의 80% 이하이고, 지속 수신 후반의 anon 증가 기울기가 분당 2MiB 이하여야 한다.
const CRITERIA = { anonPeakRatio: 0.8, anonSlopeMiBPerMinute: 2, overloadOfferedMiBPerSecond: 5.5 };

const NS = 'pulsemetry-observability';
const run = (bin, args, options = {}) => spawnSync(bin, args, { encoding: 'utf8', timeout: 300_000, maxBuffer: 64 * MiB, ...options });
const checked = (bin, args) => {
  const result = run(bin, args);
  assert.equal(result.status, 0, `${bin} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
};
const docker = (...args) => checked('docker', args);
const sleep = ms => new Promise(done => setTimeout(done, ms));
const round = value => Math.round(value * 10) / 10;
const http = async (url, options = {}) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000), ...options });
  return { status: response.status, text: await response.text() };
};
async function until(label, probe, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { const value = await probe(); if (value) return value; } catch { /* 아직 준비되지 않았다 */ }
    if (Date.now() > deadline) throw new Error(`${label}: ${timeoutMs / 1000}초 안에 확인하지 못했다`);
    await sleep(1000);
  }
}
const dirBytes = path => readdirSync(path, { withFileTypes: true })
  .reduce((sum, entry) => sum + (entry.isDirectory() ? dirBytes(resolve(path, entry.name)) : statSync(resolve(path, entry.name)).size), 0);

// chart 렌더 결과에서 설정·이미지·limit을 읽는다. 값을 이 스크립트에 복사하지 않는다.
const docs = loadAll(checked(helm, ['template', 'loki', resolve(root, 'helm/observability/loki'), '-n', NS])).filter(Boolean);
const configFiles = Object.assign({}, ...docs.filter(x => x.kind === 'ConfigMap').map(x => x.data));
const config = load(configFiles['config.yaml']);
const container = docs.find(x => x.kind === 'StatefulSet').spec.template.spec.containers[0];
const limitText = container.resources.limits.memory;
const limitBytes = Number(/^(\d+)Gi$/.exec(limitText)?.[1] ?? NaN) * 1024 * MiB;
assert.ok(limitBytes > 0, `memory limit 형식: ${limitText}`);
const rate = config.limits_config.ingestion_rate_mb * MiB;
const burst = config.limits_config.ingestion_burst_size_mb * MiB;
const dockerMemory = `${limitBytes / MiB}m`;
// cgroup을 읽는 보조 container는 이미 고정한 Prometheus 이미지(busybox)다.
const helperImage = JSON.parse(readFileSync(resolve(root, 'helm/observability/dependencies.lock.json'), 'utf8')).localRemoteWriteVerification.prometheusImage;

const runId = randomBytes(5).toString('hex');
const network = `proj256-cap-${runId}`;
const work = mkdtempSync(resolve(tmpdir(), 'proj256-loki-capacity-'));
const containers = [];
const evidence = {
  scope: 'local-loki-single-binary-capacity', runId: `loki-capacity/${runId}`, status: 'NOT_RUN', image: container.image,
  settings: { memoryLimit: limitText, ingestionRateMiBPerSecond: rate / MiB, burstMiB: burst / MiB, walReplayCeiling: config.ingester.wal.replay_memory_ceiling },
  measurement: {
    method: 'Docker cgroup v2 /sys/fs/cgroup/docker/<id>: memory.peak(커널 최대, page cache 포함)·memory.events oom_kill, memory.current·memory.stat anon 5초 표본',
    sampleIntervalSeconds: 5, note: '표본 최대값은 절대 최대가 아니다. 절대 최대는 memory.peak뿐이며 page cache를 포함한다.',
  },
  criteria: CRITERIA, requested: { phases, minutes }, phases: {}, failures: [],
};

// 대표 로그: Gateway·ingest·enrollment·dashboard·ClickHouse·Grafana·Prometheus·Fluent Bit의 envelope. 줄마다 식별자가 달라 압축률이 실제와 비슷하다.
const SERVICES = [
  ['pulsemetry-dev', 'telemetry-gateway'], ['pulsemetry-dev', 'telemetry-ingest'], ['pulsemetry-dev', 'enrollment-api'], ['pulsemetry-dev', 'dashboard-api'],
  ['pulsemetry-dev', 'clickhouse'], ['pulsemetry-observability', 'grafana'], ['pulsemetry-observability', 'prometheus'], ['pulsemetry-dev-logs', 'fluent-bit'],
];
const STREAMS = SERVICES.flatMap(([namespace, service]) => ['a', 'b'].map(shard => ({ namespace, service, pod: `${service}-${randomBytes(4).toString('hex')}-${shard}${randomBytes(2).toString('hex')}` })));
const hex = n => randomBytes(n).toString('hex');
const message = (service, batchMarker) => {
  const at = new Date().toISOString();
  switch (Math.floor(Math.random() * 4)) {
    case 0: return `${at}  INFO 1 --- [pulsemetry-${service}] [nio-8082-exec-${1 + Math.floor(Math.random() * 20)}] c.t.p.t.gateway.api.GatewayOtlpController : event=platform_trace_completed stage=gateway signal=logs status=200 outcome=accepted ${batchMarker} trace_id=${hex(16)} span_id=${hex(8)}`;
    case 1: return `${at}  INFO 1 --- [pulsemetry-${service}] [Container-0-C-1] o.a.k.c.c.internals.ConsumerCoordinator : [Consumer clientId=pulsemetry-telemetry-ingest-0, groupId=pulsemetry-dev-telemetry-ingest] Committed offset ${Math.floor(Math.random() * 1e7)} for partition pulsemetry-dev-telemetry-ingress-${Math.floor(Math.random() * 3)} ${batchMarker}`;
    case 2: return JSON.stringify({ date_time: at, thread_name: 'TCPHandler', level: 'Information', query_id: randomUUID(), logger_name: 'executeQuery', message: `Read ${Math.floor(Math.random() * 1e5)} rows, ${Math.floor(Math.random() * 900)} KiB in 0.0${Math.floor(Math.random() * 9)} sec. ${batchMarker}` });
    default: return `${at}  WARN 1 --- [pulsemetry-${service}] [Container-0-C-1] c.t.p.t.consumer.TelemetryFailureReporter : event=telemetry_transient_failure messageId=${randomUUID()} topic=pulsemetry-dev-telemetry-ingress partition=1 offset=${Math.floor(Math.random() * 1e6)} stage=persist reason=unavailable attempt=2 cause=TelemetrySinkUnavailableException ${batchMarker}`;
  }
};
const envelope = (stream, batchMarker) => JSON.stringify({
  time: new Date().toISOString(), stream: 'stdout', _p: 'F', log: message(stream.service, batchMarker), environment: 'dev', cluster: 'local-capacity',
  kubernetes: {
    pod_name: stream.pod, namespace_name: stream.namespace, pod_id: randomUUID(), host: `i-0${hex(8)}`, container_name: stream.service,
    docker_id: hex(32), container_image: `123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/soma-376/${stream.service}@sha256:${'ab'.repeat(32)}`,
    labels: { 'app.kubernetes.io/name': stream.service, 'app.kubernetes.io/instance': stream.service, 'pod-template-hash': stream.pod.split('-').at(-2) },
  },
});
// 줄 bytes(Loki가 rate·burst를 세는 단위)가 target에 닿을 때까지 한 stream의 줄을 만든다.
const makeBatch = (streamIndex, targetBytes, batchMarker) => {
  const stream = STREAMS[streamIndex % STREAMS.length];
  const values = [];
  let bytes = 0;
  const base = BigInt(Date.now()) * 1_000_000n;
  while (bytes < targetBytes) {
    const line = envelope(stream, batchMarker);
    values.push([String(base + BigInt(values.length)), line]);
    bytes += Buffer.byteLength(line);
  }
  return { bytes, lines: values.length, body: JSON.stringify({ streams: [{ stream: { environment: 'dev', cluster: 'local-capacity', namespace: stream.namespace, service_name: stream.service, container: stream.service }, values }] }) };
};

let helper;
const cgroup = id => {
  const text = docker('exec', helper, 'sh', '-c', `cd /cg/docker/${id} && cat memory.current memory.peak memory.max && grep -E '^(anon|file) ' memory.stat && grep -E '^(oom|oom_kill) ' memory.events`);
  const lines = text.split('\n');
  const field = name => Number(lines.find(x => x.startsWith(`${name} `)).split(' ')[1]);
  return { current: Number(lines[0]), peak: Number(lines[1]), max: lines[2], anon: field('anon'), file: field('file'), oom: field('oom'), oomKill: field('oom_kill') };
};
const state = id => JSON.parse(docker('inspect', '-f', '{{json .State}}', id));

const startLoki = (label, override = conf => conf) => {
  const confDir = resolve(work, `${label}-conf`);
  const data = resolve(work, `${label}-data`);
  for (const dir of [confDir, data]) { mkdirSync(dir, { recursive: true }); chmodSync(dir, 0o777); }
  for (const [name, text] of Object.entries(configFiles)) writeFileSync(resolve(confDir, name), text);
  writeFileSync(resolve(confDir, 'config.yaml'), dump(override(structuredClone(config))));
  const id = docker('run', '-d', '--network', network, '--name', `${network}-${label}`, '--memory', dockerMemory, '--memory-swap', dockerMemory,
    '--read-only', '--user', '10001:10001', '--tmpfs', '/tmp:uid=10001', '--network-alias', `pulsemetry-loki-memberlist.${NS}.svc.cluster.local`,
    '-v', `${confDir}:/etc/loki/config:ro`, '-v', `${confDir}:/etc/loki/runtime-config:ro`, '-v', `${data}:/var/loki`, '-p', '127.0.0.1::3100',
    container.image, '-config.file=/etc/loki/config/config.yaml', '-config.expand-env=true', '-target=all');
  containers.push(id);
  return { id, data, url: () => `http://127.0.0.1:${docker('port', id, '3100/tcp').split('\n')[0].split(':').pop()}` };
};
const ready = async loki => until('Loki ready', async () => (await http(`${loki.url()}/ready`)).status === 200, 180_000);

// 한 batch를 보낸다. 429면 retry가 참일 때만 deadline 안에서 다시 보낸다. 결과는 accepted|rejected|error다.
const push = async (loki, batch, { retry, deadline }) => {
  for (;;) {
    let response;
    try {
      response = await http(`${loki.url()}/loki/api/v1/push`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: batch.body });
    } catch (error) { return { outcome: 'error', detail: String(error.cause?.code ?? error.message) }; }
    if (response.status === 204) return { outcome: 'accepted' };
    if (response.status !== 429) return { outcome: 'error', detail: `${response.status} ${response.text.slice(0, 200)}` };
    if (!retry || Date.now() > deadline) return { outcome: 'rejected', detail: response.text.slice(0, 160) };
    await sleep(500);
  }
};
const countLines = async (loki, marker) => {
  const query = new URLSearchParams({ query: `sum(count_over_time({cluster="local-capacity"} |= "${marker}" [3h]))`, time: String(BigInt(Date.now()) * 1_000_000n) });
  const result = await http(`${loki.url()}/loki/api/v1/query?${query}`);
  assert.equal(result.status, 200, `count query: ${result.text.slice(0, 300)}`);
  return Number(JSON.parse(result.text).data.result[0]?.value[1] ?? 0);
};

// 정해진 속도로 batch를 보내며 5초마다 메모리를 표본한다. 대표 조회는 queryEveryMs마다 한다.
async function drive(loki, phase, { offeredBytesPerSecond, durationMs, batchBytes, concurrency, retry, queryEveryMs }) {
  const started = Date.now();
  const ledger = { accepted: [], rejected: [], errors: [] };
  const samples = [];
  const queries = [];
  let sentBytes = 0;
  let sequence = 0;
  let stop = false;
  const sampler = (async () => {
    while (!stop) {
      try { const c = cgroup(loki.id); samples.push({ t: (Date.now() - started) / 1000, currentMiB: round(c.current / MiB), anonMiB: round(c.anon / MiB), fileMiB: round(c.file / MiB) }); } catch { /* 종료 중이다 */ }
      await sleep(5000);
    }
  })();
  const querier = (async () => {
    let first = true;
    while (!stop && queryEveryMs) {
      // 첫 조회는 30초 뒤, 이후 queryEveryMs마다 한다.
      await sleep(first ? 30_000 : queryEveryMs);
      first = false;
      if (stop) break;
      const t0 = Date.now();
      const q = new URLSearchParams({ query: '{namespace="pulsemetry-dev", service_name="telemetry-ingest"} |= "Committed offset"', limit: '100',
        start: String(BigInt(Date.now() - 300_000) * 1_000_000n), end: String(BigInt(Date.now()) * 1_000_000n) });
      try {
        const r = await http(`${loki.url()}/loki/api/v1/query_range?${q}`);
        queries.push({ t: (t0 - started) / 1000, status: r.status, seconds: (Date.now() - t0) / 1000, lines: r.status === 200 ? JSON.parse(r.text).data.result.reduce((n, s) => n + s.values.length, 0) : 0 });
      } catch (error) { queries.push({ t: (t0 - started) / 1000, status: 'error', detail: String(error.cause?.code ?? error.message) }); }
    }
  })();
  const worker = async () => {
    while (Date.now() - started < durationMs) {
      const wait = started + (sentBytes / offeredBytesPerSecond) * 1000 - Date.now();
      if (wait > 0) { await sleep(wait); continue; }
      const id = `cap-${runId}-${phase}-${sequence}-`;
      const batch = makeBatch(sequence++, batchBytes, id);
      sentBytes += batch.bytes;
      const result = await push(loki, batch, { retry, deadline: Date.now() + 30_000 });
      const entry = { id, lines: batch.lines, bytes: batch.bytes };
      if (result.outcome === 'accepted') ledger.accepted.push(entry);
      else if (result.outcome === 'rejected') ledger.rejected.push(entry);
      else ledger.errors.push({ ...entry, detail: result.detail });
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  stop = true;
  await Promise.all([sampler, querier]);
  return { ledger, samples, queries, seconds: (Date.now() - started) / 1000, offeredMiB: round(sentBytes / MiB) };
}

// 후반부 anon 기울기(MiB/분, 최소제곱).
const slope = samples => {
  const tail = samples.slice(Math.floor(samples.length / 2));
  if (tail.length < 3) return null;
  const n = tail.length; const mx = tail.reduce((s, x) => s + x.t, 0) / n; const my = tail.reduce((s, x) => s + x.anonMiB, 0) / n;
  const num = tail.reduce((s, x) => s + (x.t - mx) * (x.anonMiB - my), 0); const den = tail.reduce((s, x) => s + (x.t - mx) ** 2, 0);
  return round((num / den) * 60);
};
// 수락·거절 batch를 Loki 조회와 대조한다. 전체 수와 무작위 식별자 표본을 본다.
async function reconcile(loki, phase, ledger) {
  const acceptedLines = ledger.accepted.reduce((n, x) => n + x.lines, 0);
  const lokiLines = await countLines(loki, `cap-${runId}-${phase}-`);
  const pick = (list, k) => [...list].sort(() => Math.random() - 0.5).slice(0, k);
  const acceptedSample = [];
  for (const entry of pick(ledger.accepted, 5)) acceptedSample.push({ id: entry.id, expected: entry.lines, found: await countLines(loki, entry.id) });
  const rejectedSample = [];
  for (const entry of pick(ledger.rejected, 5)) rejectedSample.push({ id: entry.id, expected: 0, found: await countLines(loki, entry.id) });
  return {
    acceptedBatches: ledger.accepted.length, acceptedLines, acceptedMiB: round(ledger.accepted.reduce((n, x) => n + x.bytes, 0) / MiB),
    rejectedBatches: ledger.rejected.length, rejectedLines: ledger.rejected.reduce((n, x) => n + x.lines, 0), errorBatches: ledger.errors.length,
    errors: ledger.errors.slice(0, 5), lokiLines, acceptedSample, rejectedSample,
    matches: lokiLines === acceptedLines && acceptedSample.every(x => x.found === x.expected) && rejectedSample.every(x => x.found === 0),
  };
}
const memorySummary = (id, samples) => {
  const c = cgroup(id);
  const anonMax = Math.max(0, ...samples.map(x => x.anonMiB));
  return { peakMiB: round(c.peak / MiB), peakRatio: round(c.peak / limitBytes * 100) / 100, sampledAnonMaxMiB: anonMax,
    sampledAnonMaxRatio: round(anonMax * MiB / limitBytes * 100) / 100, oomKill: c.oomKill, anonSlopeMiBPerMinute: slope(samples) };
};
const fail = (phase, reason) => evidence.failures.push(`${phase}: ${reason}`);
const health = (phase, loki, memory) => {
  const s = state(loki.id);
  if (!s.Running || s.OOMKilled || s.Restarting) fail(phase, `Loki 상태 ${JSON.stringify({ running: s.Running, oomKilled: s.OOMKilled })}`);
  if (memory.oomKill > 0) fail(phase, `oom_kill ${memory.oomKill}`);
  if (memory.sampledAnonMaxRatio > CRITERIA.anonPeakRatio) fail(phase, `anon 표본 최대 ${memory.sampledAnonMaxMiB}MiB가 limit의 ${CRITERIA.anonPeakRatio * 100}%를 넘었다`);
  return { running: s.Running, oomKilled: s.OOMKilled, restartCount: Number(docker('inspect', '-f', '{{.RestartCount}}', loki.id)) };
};

const started = Date.now();
let exitCode = 0;
try {
  docker('network', 'create', network);
  helper = docker('run', '-d', '--network', 'none', '-v', '/sys/fs/cgroup:/cg:ro', '--entrypoint', 'sh', helperImage, '-c', 'sleep 86400');
  containers.push(helper);

  if (phases.includes('sustained')) {
    // 상한 바로 아래로 오래 넣는다. 429는 30초 안에서 다시 보낸다. 1분마다 대표 조회를 한다.
    const loki = startLoki('sustained'); await ready(loki);
    const result = await drive(loki, 'sustained', { offeredBytesPerSecond: rate * 0.95, durationMs: minutes.sustained * 60_000, batchBytes: 512 * 1024, concurrency: 2, retry: true, queryEveryMs: 60_000 });
    await sleep(5000);
    const memory = memorySummary(loki.id, result.samples);
    const lines = await reconcile(loki, 'sustained', result.ledger);
    const phase = { offeredMiBPerSecond: round(rate * 0.95 / MiB * 100) / 100, minutes: minutes.sustained, ...result, ledger: undefined, lines, memory, state: health('sustained', loki, memory) };
    if (memory.anonSlopeMiBPerMinute !== null && memory.anonSlopeMiBPerMinute > CRITERIA.anonSlopeMiBPerMinute) fail('sustained', `후반 anon 증가 ${memory.anonSlopeMiBPerMinute}MiB/분`);
    if (!lines.matches || lines.errorBatches) fail('sustained', '수락 로그와 조회 결과가 다르거나 오류 batch가 있다');
    if (phase.queries.some(x => x.status !== 200) || !phase.queries.length) fail('sustained', '대표 조회 실패');
    evidence.phases.sustained = phase;
    docker('stop', loki.id);
  }

  if (phases.includes('overload')) {
    // 이전 OOM 조건(약 5MB/s)보다 크게 넣는다. 429는 다시 보내지 않고 거절로 센다.
    const loki = startLoki('overload'); await ready(loki);
    const offered = CRITERIA.overloadOfferedMiBPerSecond * MiB;
    const result = await drive(loki, 'overload', { offeredBytesPerSecond: offered, durationMs: minutes.overload * 60_000, batchBytes: 512 * 1024, concurrency: 6, retry: false, queryEveryMs: 120_000 });
    await sleep(5000);
    const memory = memorySummary(loki.id, result.samples);
    const lines = await reconcile(loki, 'overload', result.ledger);
    const acceptedRate = lines.acceptedMiB * MiB / result.seconds;
    const phase = { offeredMiBPerSecond: CRITERIA.overloadOfferedMiBPerSecond, minutes: minutes.overload, ...result, ledger: undefined, lines, memory,
      acceptedMiBPerSecond: round(acceptedRate / MiB * 100) / 100, state: health('overload', loki, memory) };
    // 수락량은 상한과 burst를 넘지 않아야 한다(5% 여유).
    if (acceptedRate > rate * 1.05 + burst / result.seconds) fail('overload', `수락 속도 ${phase.acceptedMiBPerSecond}MiB/s가 상한을 넘었다`);
    if (!lines.rejectedBatches) fail('overload', '429가 나지 않았다 — 제한이 동작했는지 알 수 없다');
    if (!lines.matches || lines.errorBatches) fail('overload', '수락·거절과 조회 결과가 다르거나 오류 batch가 있다');
    evidence.phases.overload = phase;
    docker('stop', loki.id);
  }

  if (phases.includes('burst')) {
    // 쉬어서 bucket을 채운 뒤 burst 안팎의 요청을 보낸다. burst보다 큰 요청은 기다려도 받지 않아야 한다.
    const loki = startLoki('burst'); await ready(loki);
    const refillMs = Math.ceil(burst / rate * 1000) + 1500;
    const cases = [];
    const send = async (label, bytes, expect) => {
      const id = `cap-${runId}-burst-${cases.length}-`;
      const batch = makeBatch(cases.length, bytes, id);
      const result = await push(loki, batch, { retry: false, deadline: 0 });
      cases.push({ label, lineMiB: round(batch.bytes / MiB * 100) / 100, expect, actual: result.outcome, id, lines: batch.lines });
    };
    for (let cycle = 0; cycle < 3; cycle++) {
      await sleep(refillMs);
      await send('burst 90% (bucket 가득)', burst * 0.9, 'accepted');
      await send('곧바로 burst 90%', burst * 0.9, 'rejected');
      await sleep(refillMs);
      await send('burst 110%', burst * 1.1, 'rejected');
      await sleep(refillMs);
      await send('기다린 뒤에도 burst 110%', burst * 1.1, 'rejected');
    }
    await sleep(3000);
    const memory = memorySummary(loki.id, []);
    for (const c of cases) c.found = await countLines(loki, c.id);
    const phase = { refillSeconds: refillMs / 1000, cases, memory, state: health('burst', loki, { ...memory, sampledAnonMaxRatio: 0 }) };
    for (const c of cases) {
      if (c.actual !== c.expect) fail('burst', `${c.label}: 기대 ${c.expect}, 실제 ${c.actual}`);
      if (c.found !== (c.actual === 'accepted' ? c.lines : 0)) fail('burst', `${c.label}: 조회 ${c.found}줄`);
    }
    evidence.phases.burst = phase;
    docker('stop', loki.id);
  }

  if (phases.includes('wal')) {
    // checkpoint를 늦춰 상한 속도로 5분 동안 WAL을 쌓는다(운영은 5분 checkpoint라 그 사이 최대 약 상한×300초가 쌓인다).
    // SIGKILL 뒤 limit 안에서 Ready로 돌아오고 수락한 줄이 모두 다시 조회돼야 한다.
    const loki = startLoki('wal', conf => { conf.ingester.wal.checkpoint_duration = '10m'; return conf; });
    await ready(loki);
    const result = await drive(loki, 'wal', { offeredBytesPerSecond: rate * 0.98, durationMs: 300_000, batchBytes: 512 * 1024, concurrency: 2, retry: true, queryEveryMs: 0 });
    const walMiB = round(dirBytes(resolve(loki.data, 'wal')) / MiB);
    const before = memorySummary(loki.id, result.samples);
    docker('kill', '--signal', 'KILL', loki.id);
    const restarted = Date.now();
    docker('start', loki.id);
    const replaySamples = [];
    let isReady = false;
    while (Date.now() - restarted < 300_000) {
      if (!state(loki.id).Running) break;
      try { const c = cgroup(loki.id); replaySamples.push({ t: (Date.now() - restarted) / 1000, currentMiB: round(c.current / MiB), anonMiB: round(c.anon / MiB), fileMiB: round(c.file / MiB) }); } catch { /* 재기동 중 */ }
      try { if ((await http(`${loki.url()}/ready`)).status === 200) { isReady = true; break; } } catch { /* 복구 중 */ }
      await sleep(1000);
    }
    const replaySeconds = (Date.now() - restarted) / 1000;
    const memory = memorySummary(loki.id, replaySamples);
    const lines = isReady ? await reconcile(loki, 'wal', result.ledger) : null;
    const ceilingMiB = parseInt(config.ingester.wal.replay_memory_ceiling, 10);
    const phase = { walMiB, ceiling: config.ingester.wal.replay_memory_ceiling, checkpointDurationForTest: '10m', ingest: { ...before, seconds: result.seconds, offeredMiB: result.offeredMiB },
      replaySeconds, replaySampleIntervalSeconds: 1, replaySamples, replayMemory: memory, lines, ready: isReady, state: health('wal', loki, memory) };
    // 복구 상한은 메모리에 올린 양이다. 디스크 WAL은 압축될 수 있어 수락한 줄 bytes로 비교한다.
    const acceptedMiB = result.ledger.accepted.reduce((n, x) => n + x.bytes, 0) / MiB;
    phase.acceptedMiBBeforeKill = round(acceptedMiB);
    if (acceptedMiB <= ceilingMiB) fail('wal', `수락량 ${round(acceptedMiB)}MiB가 복구 상한 ${ceilingMiB}MB보다 작아 상한을 시험하지 못했다`);
    if (!isReady) fail('wal', '재시작 뒤 Ready가 되지 않았다');
    if (lines && !lines.matches) fail('wal', '수락한 줄이 재시작 뒤 모두 조회되지 않았다');
    evidence.phases.wal = phase;
    docker('stop', loki.id);
  }

  const short = minutes.sustained < DEFAULT_MINUTES.sustained || minutes.overload < DEFAULT_MINUTES.overload || phases.length < 4;
  evidence.status = evidence.failures.length ? 'FAIL' : short ? 'SHORT_RUN' : 'PASS';
} catch (error) {
  evidence.status = 'FAIL';
  evidence.failures.push(`실행 오류: ${error.message}`);
} finally {
  evidence.seconds = (Date.now() - started) / 1000;
  evidence.finishedAt = new Date().toISOString();
  writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n');
  // 이 실행이 만든 컨테이너·network만 ID로 지운다.
  for (const id of containers.reverse()) run('docker', ['rm', '-f', id]);
  run('docker', ['network', 'rm', network]);
  rmSync(work, { recursive: true, force: true });
}
if (evidence.status === 'FAIL') exitCode = 1;
console.log(`${evidence.status}: Loki 수신 상한·burst·메모리·WAL (${output})${evidence.failures.length ? `\n- ${evidence.failures.join('\n- ')}` : ''}`);
process.exit(exitCode);
