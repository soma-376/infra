#!/usr/bin/env node
// Fluent Bit이 CloudWatch와 Loki로 함께 보낼 때 Loki 수신 제한·일시 장애가 다른 출력과 Loki 손실에 주는 영향을 로컬에서 잰다(ADR-0039).
// Fluent Bit 이미지·[SERVICE]·Loki [OUTPUT]은 chart values를 그대로 쓴다. CloudWatch는 AWS 없이 시험할 수 없어 같은 Match·Retry·
// storage 상한을 둔 http 출력(로컬 대역 서버)으로 바꾼다. 실제 CloudWatch 배송은 live 검증 대기다.
//
//   HELM_BIN=/path/to/helm node scripts/observability-fluent-bit-loki-harness.mjs --output <새 증거 파일>
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dump, load, loadAll } from 'js-yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputIndex = process.argv.indexOf('--output');
const output = outputIndex > 0 && resolve(process.argv[outputIndex + 1]);
if (!output) throw new Error('usage: observability-fluent-bit-loki-harness.mjs --output <새 증거 파일>');
if (existsSync(output)) throw new Error('기존 증거를 덮어쓰지 않는다. 새 --output 경로를 사용한다.');
const helm = process.env.HELM_BIN;
if (!helm) throw new Error('HELM_BIN을 고정 버전 실행 파일로 지정해야 한다');
const NS = 'pulsemetry-observability';
const phasesIndex = process.argv.indexOf('--phases');
const phases = (phasesIndex > 0 ? process.argv[phasesIndex + 1] : 'normal,overload,outage').split(',');
const MiB = 1024 * 1024;
const run = (bin, args, options = {}) => spawnSync(bin, args, { encoding: 'utf8', timeout: 300_000, maxBuffer: 64 * MiB, ...options });
const checked = (bin, args) => { const r = run(bin, args); assert.equal(r.status, 0, `${bin} ${args.join(' ')}\n${r.stdout}\n${r.stderr}`); return r.stdout.trim(); };
const docker = (...args) => checked('docker', args);
const sleep = ms => new Promise(done => setTimeout(done, ms));
const http = async (url, options = {}) => { const r = await fetch(url, { signal: AbortSignal.timeout(60_000), ...options }); return { status: r.status, text: await r.text() }; };
async function until(label, probe, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { const v = await probe(); if (v) return v; } catch { /* 준비 중 */ }
    if (Date.now() > deadline) throw new Error(`${label}: ${timeoutMs / 1000}초 안에 확인하지 못했다`);
    await sleep(1000);
  }
}

// chart values에서 Fluent Bit 이미지·[SERVICE]·Loki [OUTPUT]을 읽는다.
const fbValues = load(readFileSync(resolve(root, 'helm/dev/runtime/fluent-bit-values.yaml'), 'utf8'));
const lokiOverlay = load(readFileSync(resolve(root, 'helm/dev/runtime/fluent-bit-loki-values.yaml'), 'utf8'));
const FB_IMAGE = `${fbValues.image.repository}:${fbValues.image.tag}@${fbValues.image.digest}`;
const blocks = text => text.split(/(?=^\[OUTPUT\])/m).map(x => x.trim()).filter(Boolean);
const lokiOutput = blocks(lokiOverlay.config.outputs).find(x => /^\s*Name\s+loki\s*$/m.test(x));
const cloudwatchApp = blocks(lokiOverlay.config.outputs).find(x => /Match application\.\*/.test(x) && /cloudwatch_logs/.test(x));
assert.ok(lokiOutput && cloudwatchApp, 'overlay에서 Loki·CloudWatch 출력을 찾지 못했다');
const setting = (block, key) => new RegExp(`^\\s*${key}\\s+(.+)$`, 'm').exec(block)?.[1].trim();
const service = fbValues.config.service.split('\n').filter(line => !/Parsers_File|Health_Check|Daemon/.test(line)).join('\n')
  + '\n    Parsers_File /harness-conf/parsers.conf\n    storage.metrics On\n';

// Loki는 chart 렌더 설정 그대로다(수신 상한·burst·limit).
const lokiDocs = loadAll(checked(helm, ['template', 'loki', resolve(root, 'helm/observability/loki'), '-n', NS])).filter(Boolean);
const lokiFiles = Object.assign({}, ...lokiDocs.filter(x => x.kind === 'ConfigMap').map(x => x.data));
const lokiContainer = lokiDocs.find(x => x.kind === 'StatefulSet').spec.template.spec.containers[0];
const lokiConfig = load(lokiFiles['config.yaml']);
const lokiMemory = `${Number(/^(\d+)Gi$/.exec(lokiContainer.resources.limits.memory)[1]) * 1024}m`;

const runId = randomBytes(5).toString('hex');
const network = `proj256-fbh-${runId}`;
const work = mkdtempSync(resolve(tmpdir(), 'proj256-fb-harness-'));
const dir = name => { const p = resolve(work, name); mkdirSync(p, { recursive: true }); chmodSync(p, 0o777); return p; };
const containers = [];
const evidence = {
  scope: 'local-fluent-bit-loki-parallel-delivery', runId: `fb-loki-harness/${runId}`, status: 'NOT_RUN',
  images: { fluentBit: FB_IMAGE, loki: lokiContainer.image },
  substitution: 'CloudWatch application 출력을 같은 Match·Retry_Limit·storage.total_limit_size의 http 출력(로컬 대역 서버)으로 바꿨다. 실제 CloudWatch 배송·권한·속도 제한은 live 검증 대기다.',
  settings: { loki: { ingestionRateMiBPerSecond: lokiConfig.limits_config.ingestion_rate_mb, burstMiB: lokiConfig.limits_config.ingestion_burst_size_mb, memoryLimit: lokiContainer.resources.limits.memory },
    fluentBitLokiOutput: { retryLimit: setting(lokiOutput, 'Retry_Limit'), storageTotalLimit: setting(lokiOutput, 'storage.total_limit_size') },
    standIn: { retryLimit: setting(cloudwatchApp, 'Retry_Limit'), storageTotalLimit: setting(cloudwatchApp, 'storage.total_limit_size') } },
  phases: {}, failures: [],
};

// CloudWatch 대역: 같은 Docker network의 busybox httpd CGI가 요청 본문을 요청마다 파일로 남긴다(이미 고정한 Prometheus 이미지).
// 받은 record의 harness 식별자를 세고 중복(재전송)도 센다. 새 이미지를 받지 않는다.
const STAND_IN_IMAGE = JSON.parse(readFileSync(resolve(root, 'helm/observability/dependencies.lock.json'), 'utf8')).localRemoteWriteVerification.prometheusImage;
const standInPort = 8080;
const received = new Map();
const seenFiles = new Set();
const collect = standInData => {
  for (const name of readdirSync(standInData)) {
    // CGI가 본문을 다 쓴 뒤에만 이름을 req.로 바꾼다. 쓰는 중인 파일은 읽지 않는다.
    if (seenFiles.has(name) || !name.startsWith('req.')) continue;
    seenFiles.add(name);
    for (const row of readFileSync(resolve(standInData, name), 'utf8').split('\n')) {
      if (!row.trim()) continue;
      try { const id = JSON.parse(row).harness; if (id) received.set(id, (received.get(id) ?? 0) + 1); } catch { /* 형식이 다른 줄 */ }
    }
  }
};

const fluentConf = () => `${service}
[INPUT]
    Name tail
    Path /harness-in/*.log
    DB /var/fluent-bit/state/tail.db
    DB.Sync Normal
    Buffer_Max_Size 256k
    storage.type filesystem
    Tag application.harness
    Mem_Buf_Limit 10MB
    Skip_Long_Lines On
    Read_From_Head On
    Refresh_Interval 1
    Parser harness_json

[OUTPUT]
    Name http
    Match application.*
    Host cloudwatch-stand-in
    Port ${standInPort}
    URI /cgi-bin/ingest
    Format json_lines
    Retry_Limit ${setting(cloudwatchApp, 'Retry_Limit')}
    storage.total_limit_size ${setting(cloudwatchApp, 'storage.total_limit_size')}

${lokiOutput}
`;

const startLoki = () => {
  const conf = dir('loki-conf');
  for (const [name, text] of Object.entries(lokiFiles)) writeFileSync(resolve(conf, name), text);
  const id = docker('run', '-d', '--network', network, '--name', `${network}-loki`, '--memory', lokiMemory, '--memory-swap', lokiMemory, '--read-only',
    '--user', '10001:10001', '--tmpfs', '/tmp:uid=10001', '--network-alias', `pulsemetry-loki.${NS}.svc`, '--network-alias', `pulsemetry-loki-memberlist.${NS}.svc.cluster.local`,
    '-v', `${conf}:/etc/loki/config:ro`, '-v', `${conf}:/etc/loki/runtime-config:ro`, '-v', `${dir('loki-data')}:/var/loki`, '-p', '127.0.0.1::3100',
    lokiContainer.image, '-config.file=/etc/loki/config/config.yaml', '-config.expand-env=true', '-target=all');
  containers.push(id);
  return id;
};
const lokiUrl = id => `http://127.0.0.1:${docker('port', id, '3100/tcp').split('\n')[0].split(':').pop()}`;
const countLoki = async (id, prefix) => {
  const q = new URLSearchParams({ query: `sum(count_over_time({cluster="local-harness"} |= "${prefix}" [3h]))`, time: String(BigInt(Date.now()) * 1_000_000n) });
  const r = await http(`${lokiUrl(id)}/loki/api/v1/query?${q}`);
  assert.equal(r.status, 200, r.text.slice(0, 200));
  return Number(JSON.parse(r.text).data.result[0]?.value[1] ?? 0);
};
const metrics = async port => {
  const text = (await http(`http://127.0.0.1:${port}/api/v1/metrics/prometheus`)).text;
  // Fluent Bit은 값 뒤에 timestamp를 붙인다. label 뒤의 첫 숫자가 값이다.
  const value = (name, plugin) => text.split('\n').filter(l => l.startsWith(`${name}{`) && l.includes(`name="${plugin}`))
    .reduce((n, l) => n + Number(l.slice(l.indexOf('}') + 1).trim().split(/\s+/)[0]), 0);
  const out = {};
  for (const plugin of ['http', 'loki']) {
    out[plugin] = Object.fromEntries(['proc_records_total', 'retries_total', 'retries_failed_total', 'dropped_records_total', 'errors_total']
      .map(m => [m, value(`fluentbit_output_${m}`, plugin)]));
  }
  return out;
};
const diff = (after, before) => Object.fromEntries(Object.entries(after).map(([plugin, m]) => [plugin, Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v - before[plugin][k]]))]));

// 대표 envelope 줄을 정해진 속도로 파일에 쓴다. 줄마다 phase·순번 식별자가 있다.
const inbox = dir('in');
const logFile = resolve(inbox, 'app.log');
writeFileSync(logFile, '');
const line = (phase, seq) => JSON.stringify({
  log: `${new Date().toISOString()}  INFO 1 --- [pulsemetry-telemetry-ingest] [Container-0-C-1] c.t.p.t.consumer.TelemetryRecordListener : event=platform_trace_completed stage=ingest signal=logs outcome=completed attempt=1 trace_id=${randomBytes(16).toString('hex')} span_id=${randomBytes(8).toString('hex')}`,
  stream: 'stdout', environment: 'dev', cluster: 'local-harness', harness: `fbh-${runId}-${phase}-${seq}`,
  kubernetes: { namespace_name: 'pulsemetry-dev', container_name: 'telemetry-ingest', pod_name: 'telemetry-ingest-8dd5c8f57-harness', pod_id: randomUUID(),
    labels: { 'app.kubernetes.io/name': 'telemetry-ingest', 'app.kubernetes.io/instance': 'telemetry-ingest' } },
});
async function write(phase, linesPerSecond, seconds, onTick) {
  const started = Date.now();
  let seq = 0;
  while (Date.now() - started < seconds * 1000) {
    const due = Math.floor(((Date.now() - started) / 1000) * linesPerSecond);
    if (due > seq) {
      const chunk = [];
      for (; seq < due; seq++) chunk.push(line(phase, seq));
      appendFileSync(logFile, chunk.join('\n') + '\n');
    }
    if (onTick) await onTick((Date.now() - started) / 1000);
    await sleep(100);
  }
  return seq;
}
// 대역 서버가 모두 받고 Loki 수가 60초 동안 그대로면 끝난 것으로 본다(최대 maxMs).
async function drain(phase, written, loki, maxMs) {
  const started = Date.now();
  let last = -1;
  let stableSince = Date.now();
  for (;;) {
    collect(evidence.standInData);
    const standInCount = [...received.keys()].filter(k => k.startsWith(`fbh-${runId}-${phase}-`)).length;
    let lokiCount = last;
    try { lokiCount = await countLoki(loki, `fbh-${runId}-${phase}-`); } catch { /* Loki 재기동 중 */ }
    if (lokiCount !== last) { last = lokiCount; stableSince = Date.now(); }
    if ((standInCount >= written && (lokiCount >= written || Date.now() - stableSince > 60_000)) || Date.now() - started > maxMs) {
      return { standInCount, lokiCount, drainSeconds: (Date.now() - started) / 1000 };
    }
    await sleep(10_000);
  }
}
const duplicates = phase => [...received.entries()].filter(([k, n]) => k.startsWith(`fbh-${runId}-${phase}-`) && n > 1).length;

const started = Date.now();
try {
  docker('network', 'create', network);
  writeFileSync(resolve(dir('harness-conf'), 'parsers.conf'), '[PARSER]\n    Name harness_json\n    Format json\n');
  const standInData = dir('stand-in-data');
  const cgi = dir('stand-in-www/cgi-bin');
  writeFileSync(resolve(cgi, 'ingest'), '#!/bin/sh\nf=$(mktemp /data/tmp.XXXXXX)\nhead -c "$CONTENT_LENGTH" > "$f" && mv "$f" "/data/req.${f##*.}"\nprintf "Content-Type: text/plain\\r\\n\\r\\nok"\n');
  chmodSync(resolve(cgi, 'ingest'), 0o755);
  containers.push(docker('run', '-d', '--network', network, '--name', `${network}-stand-in`, '--network-alias', 'cloudwatch-stand-in',
    '-v', `${resolve(work, 'stand-in-www')}:/www:ro`, '-v', `${standInData}:/data`, '--entrypoint', 'httpd', STAND_IN_IMAGE, '-f', '-p', String(standInPort), '-h', '/www'));
  evidence.standInData = standInData;
  let loki = startLoki();
  await until('Loki ready', async () => (await http(`${lokiUrl(loki)}/ready`)).status === 200, 180_000);
  writeFileSync(resolve(work, 'harness-conf', 'fluent-bit.conf'), fluentConf());
  const fb = docker('run', '-d', '--network', network, '--name', `${network}-fluent-bit`,
    '-v', `${resolve(work, 'harness-conf')}:/harness-conf:ro`, '-v', `${inbox}:/harness-in:ro`, '-v', `${dir('fb-state')}:/var/fluent-bit/state`,
    '-p', '127.0.0.1::2020', FB_IMAGE, '/fluent-bit/bin/fluent-bit', '-c', '/harness-conf/fluent-bit.conf');
  containers.push(fb);
  const fbPort = docker('port', fb, '2020/tcp').split('\n')[0].split(':').pop();
  await until('Fluent Bit metrics', async () => (await http(`http://127.0.0.1:${fbPort}/api/v1/metrics/prometheus`)).status === 200, 60_000);

  const phase = async (name, plan) => {
    const before = await metrics(fbPort);
    const written = await plan.write();
    const drained = await drain(name, written, loki, plan.drainMs);
    const after = await metrics(fbPort);
    const result = { ...plan.describe, written, ...drained, standInDuplicates: duplicates(name), lokiLost: written - drained.lokiCount,
      standInMissing: written - drained.standInCount, fluentBit: diff(after, before) };
    evidence.phases[name] = result;
    return result;
  };

  // 1) 평상시: dev 실측(0.3KB/s 이하)보다 훨씬 큰 200줄/초(약 70KB/s)도 손실·재시도 없이 두 출력에 간다.
  if (phases.includes('normal')) {
  const normal = await phase('normal', { describe: { linesPerSecond: 200, seconds: 60 }, drainMs: 180_000, write: () => write('normal', 200, 60) });
  if (normal.standInMissing || normal.lokiLost) evidence.failures.push(`normal: 대역 누락 ${normal.standInMissing}, Loki 누락 ${normal.lokiLost}`);
  }

  // 2) Loki 수신 상한 초과: 약 4MB/s로 60초 쓴다. 대역 출력은 모두 받아야 하고, Loki 손실은 측정해 남긴다.
  if (phases.includes('overload')) {
  const overload = await phase('overload', { describe: { linesPerSecond: 11_000, seconds: 60 }, drainMs: 600_000, write: () => write('overload', 11_000, 60) });
  if (overload.standInMissing) evidence.failures.push(`overload: 대역 출력 누락 ${overload.standInMissing}`);
  }

  // 3) Loki 일시 장애: 200줄/초로 180초 쓰는 중 30초부터 120초 동안 Loki를 멈춘다. 대역 출력은 끊기지 않아야 한다.
  if (phases.includes('outage')) {
  let stopped = false; let restarted = false;
  const outage = await phase('outage', { describe: { linesPerSecond: 200, seconds: 180, lokiStoppedSeconds: [30, 150] }, drainMs: 600_000, write: () => write('outage', 200, 180, async t => {
    if (!stopped && t >= 30) { docker('stop', loki); stopped = true; }
    if (stopped && !restarted && t >= 150) { docker('start', loki); restarted = true; await until('Loki 재기동', async () => (await http(`${lokiUrl(loki)}/ready`)).status === 200, 180_000); }
  }) });
  if (outage.standInMissing) evidence.failures.push(`outage: 대역 출력 누락 ${outage.standInMissing}`);
  }

  const lokiState = JSON.parse(docker('inspect', '-f', '{{json .State}}', loki));
  evidence.lokiState = { running: lokiState.Running, oomKilled: lokiState.OOMKilled };
  if (lokiState.OOMKilled) evidence.failures.push('Loki OOMKilled');
  evidence.status = evidence.failures.length ? 'FAIL' : phases.length < 3 ? 'SHORT_RUN' : 'PASS';
} catch (error) {
  evidence.status = 'FAIL';
  evidence.failures.push(`실행 오류: ${error.message}`);
} finally {
  evidence.seconds = (Date.now() - started) / 1000;
  evidence.finishedAt = new Date().toISOString();
  delete evidence.standInData;
  writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n');
  for (const id of containers.reverse()) run('docker', ['rm', '-f', id]);
  run('docker', ['network', 'rm', network]);
  rmSync(work, { recursive: true, force: true });
}
console.log(`${evidence.status}: Fluent Bit 병행 배송 (${output})${evidence.failures.length ? `\n- ${evidence.failures.join('\n- ')}` : ''}`);
process.exit(evidence.status === 'FAIL' ? 1 : 0);
