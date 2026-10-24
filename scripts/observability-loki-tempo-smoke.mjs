#!/usr/bin/env node
// AWS 없이 고정 ARM64 Loki·Tempo·플랫폼 Collector·Grafana를 렌더된 설정 그대로 띄워 합성 로그·trace 왕복을 검증한다(ADR-0039).
// 증거에는 합성 trace ID·시각·고유 run ID만 남긴다. 고객 데이터와 비밀을 쓰지 않는다. 실제 dev 배포·부하 검증이 아니다.
//
//   HELM_BIN=/path/to/helm node scripts/observability-loki-tempo-smoke.mjs --output /tmp/loki-tempo-smoke-<new>.json
//
// 모든 container는 chart의 memory limit(swap 없음)으로 뜬다. 필수 검사 하나라도 어기면 status는 PASS가 아니다.
// Loki 수신 상한·burst·장시간 메모리·WAL 복구 부하는 scripts/observability-loki-capacity.mjs가 맡는다.
// 먼저 `node scripts/observability-prepare.mjs`로 고정 chart archive를 준비한다. Docker가 필요하다.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dump, load, loadAll } from 'js-yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputArg = process.argv.indexOf('--output');
if (outputArg < 0 || !process.argv[outputArg + 1]) throw new Error('usage: observability-loki-tempo-smoke.mjs --output <새 증거 파일>');
const output = resolve(process.argv[outputArg + 1]);
if (existsSync(output)) throw new Error('기존 증거를 덮어쓰지 않는다. 새 --output 경로를 사용한다.');
const helm = process.env.HELM_BIN;
if (!helm) throw new Error('HELM_BIN을 고정 버전 실행 파일로 지정해야 한다');

const NS = 'pulsemetry-observability';
const GRAFANA = `grafana/grafana:12.3.1@sha256:${load(readFileSync(resolve(root, 'helm/observability/pulsemetry-observability/values.yaml'), 'utf8')).monitoring.grafana.image.sha}`;
const run = (bin, args, options = {}) => spawnSync(bin, args, { encoding: 'utf8', timeout: 300_000, maxBuffer: 32 * 1024 * 1024, ...options });
const checked = (bin, args) => {
  const result = run(bin, args);
  assert.equal(result.status, 0, `${bin} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
};
const docker = (...args) => checked('docker', args);
const sleep = ms => new Promise(done => setTimeout(done, ms));
async function until(label, probe, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { const value = await probe(); if (value) return value; } catch { /* 아직 준비되지 않았다 */ }
    if (Date.now() > deadline) throw new Error(`${label}: ${timeoutMs / 1000}초 안에 확인하지 못했다`);
    await sleep(1000);
  }
}
const http = async (url, options = {}) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000), ...options });
  return { status: response.status, text: await response.text() };
};

// 렌더된 chart에서 실제 설정 파일과 이미지를 뽑는다. 로컬 실행은 k8s DNS 이름을 Docker network alias로 그대로 쓴다.
const render = (release, chart, extra = []) => loadAll(checked(helm, ['template', release, resolve(root, chart), '-n', NS, ...extra])).filter(Boolean);
const stack = {
  loki: render('loki', 'helm/observability/loki'),
  tempo: render('tempo', 'helm/observability/tempo'),
  collector: render('otel-platform', 'helm/observability/otel-platform'),
};
const image = docs => docs.find(x => x.kind === 'StatefulSet').spec.template.spec.containers[0].image;
// chart의 memory limit 그대로 띄우고 swap을 막는다. limit을 넘으면 OOMKilled로 드러난다.
const limitOf = docs => docs.find(x => ['StatefulSet', 'Deployment'].includes(x.kind)).spec.template.spec.containers[0].resources.limits.memory;
const memory = value => {
  const match = /^(\d+)(Mi|Gi)$/.exec(String(value));
  assert.ok(match, `memory limit 형식: ${value}`);
  const size = `${match[1]}${match[2] === 'Gi' ? 'g' : 'm'}`;
  return ['--memory', size, '--memory-swap', size];
};
const observability = render('observability', 'helm/observability/pulsemetry-observability', ['-f', resolve(root, 'helm/observability/tests/generated-values.yaml')]);
const datasources = load(observability.find(x => x.kind === 'ConfigMap' && x.metadata.name === 'pulsemetry-grafana').data['datasources.yaml']);
// 이 smoke에는 Prometheus·CloudWatch 백엔드가 없다. Loki·Tempo 두 항목은 렌더된 값을 그대로 쓴다.
datasources.datasources = datasources.datasources.filter(x => ['pulsemetry-loki', 'pulsemetry-tempo'].includes(x.uid));

const suffix = randomBytes(6).toString('hex');
const network = `proj256-lt-${suffix}`;
const work = mkdtempSync(resolve(tmpdir(), 'proj256-loki-tempo-'));
const dir = name => { const path = resolve(work, name); mkdirSync(path, { recursive: true }); chmodSync(path, 0o777); return path; };
const containers = [];
const evidence = { scope: 'local-loki-tempo-collector-grafana-only', runId: `loki-tempo-smoke/${suffix}`, status: 'NOT_RUN', images: {}, memoryLimits: {}, checks: {} };
const grafanaDocs = observability.filter(x => x.metadata?.name === 'pulsemetry-grafana');
const started = Date.now();
let createdNetwork = false;
try {
  for (const [name, docs] of Object.entries(stack)) {
    for (const map of docs.filter(x => x.kind === 'ConfigMap')) for (const [key, value] of Object.entries(map.data)) writeFileSync(resolve(dir(`${name}-conf`), key), value);
    evidence.images[name] = image(docs);
    evidence.memoryLimits[name] = limitOf(docs);
  }
  evidence.images.grafana = GRAFANA;
  evidence.memoryLimits.grafana = limitOf(grafanaDocs);
  writeFileSync(resolve(dir('grafana-provisioning/datasources'), 'datasources.yaml'), dump(datasources));
  docker('network', 'create', network); createdNetwork = true;
  const base = ['run', '-d', '--network', network, '--read-only', '--user', '10001:10001'];
  const start = (name, args) => { const id = docker(...base, '--name', `${network}-${name}`, ...args); containers.push(id); return id; };
  const port = (id, internal) => docker('port', id, `${internal}/tcp`).split('\n')[0].split(':').pop();

  const loki = start('loki', [...memory(evidence.memoryLimits.loki),
    '--network-alias', `pulsemetry-loki.${NS}.svc`, '--network-alias', `pulsemetry-loki.${NS}.svc.cluster.local`,
    '--network-alias', `pulsemetry-loki-memberlist.${NS}.svc.cluster.local`, '--tmpfs', '/tmp:uid=10001',
    '-v', `${resolve(work, 'loki-conf')}:/etc/loki/config:ro`, '-v', `${resolve(work, 'loki-conf')}:/etc/loki/runtime-config:ro`,
    '-v', `${dir('loki-data')}:/var/loki`, '-p', '127.0.0.1::3100', evidence.images.loki,
    '-config.file=/etc/loki/config/config.yaml', '-config.expand-env=true', '-target=all',
  ]);
  const tempoArgs = [...memory(evidence.memoryLimits.tempo), '--network-alias', `pulsemetry-tempo.${NS}.svc`, '-v', `${resolve(work, 'tempo-conf')}:/conf:ro`,
    '-v', `${dir('tempo-data')}:/var/tempo`, '-p', '127.0.0.1::3200', evidence.images.tempo, '-config.file=/conf/tempo.yaml'];
  let tempo = start('tempo', tempoArgs);
  const collector = start('collector', [...memory(evidence.memoryLimits.collector),
    '--network-alias', `pulsemetry-otel-platform.${NS}.svc`, '-e', 'MY_POD_IP=0.0.0.0',
    '-v', `${resolve(work, 'collector-conf')}:/conf:ro`, '-v', `${dir('collector-queue')}:/var/lib/otelcol/queue`,
    '-p', '127.0.0.1::4318', '-p', '127.0.0.1::13133', '-p', '127.0.0.1::8888', evidence.images.collector, '--config=/conf/relay',
  ]);
  const grafana = docker('run', '-d', '--network', network, '--name', `${network}-grafana`, ...memory(evidence.memoryLimits.grafana),
    '-e', 'GF_AUTH_ANONYMOUS_ENABLED=true', '-e', 'GF_AUTH_ANONYMOUS_ORG_ROLE=Admin', '-e', 'GF_AUTH_DISABLE_LOGIN_FORM=true',
    '-v', `${resolve(work, 'grafana-provisioning')}:/etc/grafana/provisioning:ro`, '-p', '127.0.0.1::3000', GRAFANA);
  containers.push(grafana);

  const url = { loki: `http://127.0.0.1:${port(loki, 3100)}`, collector: `http://127.0.0.1:${port(collector, 4318)}`,
    health: `http://127.0.0.1:${port(collector, 13133)}`, metrics: `http://127.0.0.1:${port(collector, 8888)}`, grafana: `http://127.0.0.1:${port(grafana, 3000)}` };
  url.tempo = `http://127.0.0.1:${port(tempo, 3200)}`;
  await until('Loki ready', async () => (await http(`${url.loki}/ready`)).status === 200, 120_000);
  await until('Tempo ready', async () => (await http(`${url.tempo}/ready`)).status === 200, 120_000);
  await until('Collector health', async () => (await http(url.health)).status === 200);
  await until('Grafana health', async () => (await http(`${url.grafana}/api/health`)).status === 200);
  evidence.checks.readOnlyRootNonRoot = 'PASS';

  const now = () => BigInt(Date.now()) * 1_000_000n;
  const sendTrace = async (traceId, extraAttributes = []) => {
    const end = now();
    const body = { resourceSpans: [{ resource: { attributes: [
      { key: 'service.name', value: { stringValue: 'telemetry-gateway' } }, { key: 'k8s.namespace.name', value: { stringValue: 'pulsemetry-dev' } },
      { key: 'deployment.environment.name', value: { stringValue: 'dev' } }] },
    scopeSpans: [{ scope: { name: 'proj256-smoke' }, spans: [{ traceId, spanId: randomBytes(8).toString('hex'), name: 'POST /v1/logs', kind: 2,
      startTimeUnixNano: String(end - 5_000_000n), endTimeUnixNano: String(end),
      attributes: [{ key: 'pulsemetry.outcome', value: { stringValue: 'accepted' } }, ...extraAttributes] }] }] }] };
    const result = await http(`${url.collector}/v1/traces`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(result.status, 200, `Collector OTLP/HTTP: ${result.text}`);
  };
  const tempoSpans = async traceId => {
    const result = await http(`${url.tempo}/api/v2/traces/${traceId}`);
    if (result.status !== 200) return null;
    const spans = (JSON.parse(result.text).trace?.resourceSpans ?? []).flatMap(b => b.scopeSpans.flatMap(s => s.spans));
    return spans.length ? spans : null;
  };

  // 1) 합성 로그 → Loki, trace_id로 다시 찾는다.
  const traceA = randomBytes(16).toString('hex');
  const line = JSON.stringify({ log: `event=platform_trace_completed stage=gateway outcome=accepted run=${suffix} trace_id=${traceA} span_id=${randomBytes(8).toString('hex')}`, kubernetes: { pod_name: 'telemetry-gateway-smoke' } });
  const pushed = await http(`${url.loki}/loki/api/v1/push`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ streams: [{
    stream: { environment: 'dev', cluster: 'local-smoke', namespace: 'pulsemetry-dev', service_name: 'telemetry-gateway', container: 'telemetry-gateway' },
    values: [[String(now()), line]] }] }) });
  assert.equal(pushed.status, 204, `Loki push: ${pushed.text}`);
  const t0 = Date.now();
  const query = new URLSearchParams({ query: `{environment="dev", service_name="telemetry-gateway"} |= "trace_id=${traceA}"`, start: String(now() - 600_000_000_000n), end: String(now() + 60_000_000_000n) });
  await until('Loki 조회', async () => JSON.parse((await http(`${url.loki}/loki/api/v1/query_range?${query}`)).text).data.result.length === 1);
  evidence.checks.lokiLogRoundTrip = { status: 'PASS', seconds: (Date.now() - t0) / 1000 };

  // 2) 같은 trace ID의 합성 span → Collector → Tempo. 앱이 실수로 보낸 URL·SQL 속성은 Collector가 지운다.
  const t1 = Date.now();
  await sendTrace(traceA, [{ key: 'url.full', value: { stringValue: `http://clickhouse/?query=SELECT+canary-${suffix}` } }, { key: 'db.statement', value: { stringValue: `SELECT canary-${suffix}` } }]);
  const spans = await until('Tempo trace ID 조회', () => tempoSpans(traceA));
  const keys = spans.flatMap(s => (s.attributes ?? []).map(a => a.key));
  assert.ok(keys.includes('pulsemetry.outcome') && !keys.includes('url.full') && !keys.includes('db.statement'), `민감 속성 삭제: ${keys}`);
  assert.ok(!JSON.stringify(spans).includes(`canary-${suffix}`));
  evidence.checks.tempoTraceRoundTrip = { status: 'PASS', seconds: (Date.now() - t1) / 1000, keptAttributes: [...new Set(keys)].sort() };
  const roundTripSeconds = (Date.now() - t0) / 1000;
  assert.ok(roundTripSeconds <= 60, `로그·trace 왕복 ${roundTripSeconds}초 > 60초`);
  evidence.checks.within60Seconds = 'PASS';

  // 3) Grafana가 렌더된 datasource 그대로 Loki·Tempo에 붙고 `$$` 매크로가 `$`로 남는다.
  for (const uid of ['pulsemetry-loki', 'pulsemetry-tempo']) {
    const health = await until(`Grafana ${uid} health`, async () => { const r = await http(`${url.grafana}/api/datasources/uid/${uid}/health`); return r.status === 200 && JSON.parse(r.text); });
    assert.equal(health.status, 'OK', `${uid}: ${JSON.stringify(health)}`);
  }
  const lokiSource = JSON.parse((await http(`${url.grafana}/api/datasources/uid/pulsemetry-loki`)).text);
  const tempoSource = JSON.parse((await http(`${url.grafana}/api/datasources/uid/pulsemetry-tempo`)).text);
  assert.equal(lokiSource.jsonData.derivedFields[0].url, '${__value.raw}');
  assert.equal(lokiSource.jsonData.derivedFields[0].datasourceUid, 'pulsemetry-tempo');
  assert.equal(tempoSource.jsonData.tracesToLogsV2.query, '{${__tags}} |= "trace_id=${__trace.traceId}"');
  const viaGrafana = await http(`${url.grafana}/api/ds/query`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    from: 'now-15m', to: 'now', queries: [{ refId: 'A', datasource: { uid: 'pulsemetry-loki' }, expr: `{environment="dev"} |= "trace_id=${traceA}"`, queryType: 'range', maxLines: 10 }] }) });
  assert.ok(viaGrafana.status === 200 && viaGrafana.text.includes(traceA), 'Grafana에서 Loki 로그 조회');
  evidence.checks.grafanaDatasources = 'PASS';

  // 4) Loki를 SIGKILL로 끊고 다시 띄운다. flush_on_shutdown이 돌지 않으므로 앞의 로그는 볼륨의 WAL에서 복구돼야 한다.
  const lokiConfig = load((await http(`${url.loki}/config`)).text);
  assert.ok(lokiConfig.ingester.wal.dir.startsWith('/var/loki/'), `WAL은 PVC 경로 아래다: ${lokiConfig.ingester.wal.dir}`);
  const t2 = Date.now();
  docker('kill', '--signal', 'KILL', loki);
  docker('start', loki);
  url.loki = `http://127.0.0.1:${port(loki, 3100)}`;
  await until('Loki 재기동', async () => (await http(`${url.loki}/ready`)).status === 200, 120_000);
  await until('Loki 재시작 뒤 이전 로그', async () => JSON.parse((await http(`${url.loki}/loki/api/v1/query_range?${query}`)).text).data.result.length === 1, 60_000);
  assert.equal(docker('inspect', '-f', '{{.State.OOMKilled}}', loki), 'false');
  evidence.checks.lokiWalReplayAfterKill = {
    status: 'PASS', seconds: (Date.now() - t2) / 1000, walDir: lokiConfig.ingester.wal.dir, replayMemoryCeiling: lokiConfig.ingester.wal.replay_memory_ceiling,
  };

  // 5) Tempo가 내려간 동안 보낸 span은 Collector의 file_storage queue에 남고, Collector 재시작 뒤 Tempo가 돌아오면 전송된다.
  docker('stop', tempo);
  const traceB = randomBytes(16).toString('hex');
  await sendTrace(traceB);
  await until('queue 적재', async () => /otelcol_exporter_queue_size\{[^}]*\} [1-9]/.test((await http(`${url.metrics}/metrics`)).text), 60_000);
  docker('restart', collector);
  // 임의 host 포트는 재시작 때 다시 배정된다.
  url.health = `http://127.0.0.1:${port(collector, 13133)}`;
  await until('Collector 재시작', async () => (await http(url.health)).status === 200);
  docker('start', tempo);
  url.tempo = `http://127.0.0.1:${port(tempo, 3200)}`;
  await until('Tempo 재기동', async () => (await http(`${url.tempo}/ready`)).status === 200, 120_000);
  await until('queue 재전송', () => tempoSpans(traceB), 120_000);
  evidence.checks.collectorQueueSurvivesRestart = 'PASS';
  // 6) Tempo 재시작 전 trace가 PVC(볼륨)에서 다시 조회된다.
  assert.ok(await tempoSpans(traceA), 'Tempo 재시작 뒤 이전 trace');
  evidence.checks.tempoDataSurvivesRestart = 'PASS';

  evidence.coverage = {
    verified: [
      'chart memory limit(swap 없음) 아래 기동', 'Loki push·조회', 'Collector→Tempo 왕복과 민감 속성 삭제', 'Grafana datasource health·$$ 매크로·Loki 조회',
      'Loki SIGKILL 재시작의 WAL 복구', 'Collector queue 재시작 보존', 'Tempo 재시작 보존',
    ],
    notVerified: [
      'Fluent Bit 병행 배송(observability-fluent-bit-loki-harness.mjs가 CloudWatch 대역으로 맡는다. 실제 CloudWatch는 live)', 'Grafana UI의 로그↔trace 클릭', '실제 앱 요청의 Kafka commit·ClickHouse 저장',
      'NetworkPolicy 강제·차단', 'dev 배포', 'Loki 수신 상한·장시간 메모리·WAL 복구 부하(observability-loki-capacity.mjs가 맡는다)',
    ],
  };
  evidence.syntheticTraceIds = [traceA, traceB];
  evidence.status = 'PASS';
} finally {
  evidence.seconds = (Date.now() - started) / 1000;
  evidence.finishedAt = new Date().toISOString();
  writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n');
  // 이 실행이 만든 컨테이너만 ID로 지운다. 같은 이미지를 쓰는 다른 컨테이너를 건드리지 않는다.
  for (const id of containers.reverse()) run('docker', ['rm', '-f', id]);
  if (createdNetwork) run('docker', ['network', 'rm', network]);
  rmSync(work, { recursive: true, force: true });
}
console.log(`${evidence.status}: Loki·Tempo·Collector·Grafana 로컬 왕복과 재시작 복구 (${output})`);
