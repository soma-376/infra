#!/usr/bin/env node
// NetworkPolicy 강제·차단을 live dev에서 시험한다(ADR-0039, 관측 런북 PROJ-256 N2·N5). kubectl의 현재 context를 쓴다.
//
//   node scripts/observability-networkpolicy-probe.mjs --phase n2 --output <새 증거 파일>   # 일회용 namespace에서 정책 전후 비교
//   node scripts/observability-networkpolicy-probe.mjs --phase n5 --output <새 증거 파일>   # 운영 정책의 허용·차단 대조(정책을 지우지 않는다)
//   node scripts/observability-networkpolicy-probe.mjs --render-only                       # 클러스터에 붙지 않고 시험 manifest만 낸다
//
// 결과는 OPEN·TIMEOUT·REFUSED·DNS_FAIL·TOOL_ERROR·JOB_FAILED로 나눈다. VPC CNI 정책은 패킷을 버리므로 차단은 TIMEOUT으로 보인다.
// 정책 차단으로 세는 것은 TIMEOUT이면서 (1) SG가 그 경로를 열고 (2) 같은 목적지·포트의 허용 송신자 대조가 성공하고
// (3) 정책·PolicyEndpoints·대상 Ready가 확인된 경우뿐이다. 나머지 실패는 원인을 정책으로 단정하지 않고 INCONCLUSIVE로 남긴다.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dump, loadAll } from 'js-yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argument = name => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? undefined : process.argv[i + 1]; };
const renderOnly = process.argv.includes('--render-only');
// deny-all 뒤 server Ready 관찰 시간. 기본 70초이고, 짧게 주면(회귀 시험) status는 PASS가 아니라 SHORT_RUN이다.
const READY_SECONDS = Number(argument('ready-seconds') ?? 70);
const phase = argument('phase');
const output = argument('output') && resolve(argument('output'));
if (!renderOnly) {
  if (!['n2', 'n5'].includes(phase) || !output) throw new Error('usage: --phase n2|n5 --output <새 증거 파일> 또는 --render-only');
  if (existsSync(output)) throw new Error('기존 증거를 덮어쓰지 않는다. 새 --output 경로를 사용한다.');
}

const NS = 'pulsemetry-observability';
const PROBE_NS = 'pulsemetry-np-probe';
const MARK = 'pulsemetry.io/np-probe';
// 실행마다 다른 값이다. 정리는 이 값으로만 한다 — 다른 실행의 Job을 지우지 않는다.
const RUN_MARK = 'pulsemetry.io/np-probe-run';
const suffix = renderOnly ? 'render-only' : randomBytes(3).toString('hex');
const lock = JSON.parse(readFileSync(resolve(root, 'helm/observability/dependencies.lock.json'), 'utf8'));
const IMAGE = lock.localRemoteWriteVerification.prometheusImage;
const files = name => loadAll(readFileSync(resolve(root, 'helm/observability/tests/networkpolicy', name), 'utf8')).filter(Boolean);
const POOLS = {
  apps: { nodeSelector: { 'kubernetes.io/arch': 'arm64', 'pulsemetry.io/workload': 'apps' } },
  observability: {
    nodeSelector: { 'kubernetes.io/arch': 'arm64', 'pulsemetry.io/workload': 'observability' },
    tolerations: [{ key: 'workload', operator: 'Equal', value: 'observability', effect: 'NoSchedule' }],
  },
};
// SG가 노드 풀 사이에 여는 TCP 포트(lib/dev/network-stack.ts). 같은 풀 안은 모두 열려 있다. SG가 막는 경로의 TIMEOUT은 정책 증거가 아니다.
const SG_OPEN = { apps: { observability: [3100, 4318] }, observability: { observability: 'all' } };
const sgOpen = (from, to, port) => { const rule = SG_OPEN[from]?.[to]; return rule === 'all' || (rule ?? []).includes(port); };
const fqdn = service => `${service}.${NS}.svc.cluster.local`;
const TARGETS = {
  'loki-3100': { service: 'pulsemetry-loki', port: 3100, selector: 'app.kubernetes.io/name=loki,app.kubernetes.io/component=single-binary' },
  'tempo-3200': { service: 'pulsemetry-tempo', port: 3200, selector: 'app.kubernetes.io/name=tempo' },
  'tempo-4317': { service: 'pulsemetry-tempo', port: 4317, selector: 'app.kubernetes.io/name=tempo' },
  'collector-4318': { service: 'pulsemetry-otel-platform', port: 4318, selector: 'app.kubernetes.io/name=collector,component=statefulset-collector' },
  'collector-8888': { service: 'pulsemetry-otel-platform', port: 8888, selector: 'app.kubernetes.io/name=collector,component=statefulset-collector' },
};
const TARGET_POOL = 'observability';
const targetSpec = names => names.map(name => `${name}=${fqdn(TARGETS[name].service)}:${TARGETS[name].port}`).join(' ');
// 허용 label이 없는 시험 송신자. apps 풀은 SG가 여는 3100·4318만 정책 증거가 되고, 관측 풀은 모든 포트가 정책 증거다.
const STRANGERS = [
  { name: 'apps-dev', namespace: 'pulsemetry-dev', pool: 'apps', targets: Object.keys(TARGETS) },
  { name: 'apps-logs', namespace: 'pulsemetry-dev-logs', pool: 'apps', targets: ['loki-3100'] },
  { name: 'observability', namespace: NS, pool: 'observability', targets: Object.keys(TARGETS) },
];
// 같은 목적지·포트를 실제 허용 송신자에서 연다(busybox가 있는 Grafana·Prometheus).
const PORT_CONTROLS = [
  { sender: 'grafana', exec: [`-n`, NS, 'deploy/pulsemetry-grafana', '-c', 'grafana'], targets: ['loki-3100', 'tempo-3200'] },
  { sender: 'prometheus', exec: ['-n', NS, 'pod/prometheus-pulsemetry-monitoring-prometheus-0', '-c', 'prometheus'], targets: ['loki-3100', 'tempo-3200', 'collector-8888'] },
];
// 셸이 없는 허용 송신자는 동작으로 본다. 값이 0이면 통신량이 없어 PENDING이다(실패가 아니다).
const FUNCTIONAL_CONTROLS = [
  { sender: 'fluent-bit', target: 'loki-3100', ok: 'sum(increase(fluentbit_output_proc_records_total{name=~"loki.*"}[15m]))', bad: 'sum(increase(fluentbit_output_errors_total{name=~"loki.*"}[15m]))' },
  { sender: 'collector', target: 'tempo-4317', ok: 'sum(increase(otelcol_exporter_sent_spans{exporter="otlp_grpc/tempo"}[15m]))', bad: 'sum(increase(otelcol_exporter_send_failed_spans{exporter="otlp_grpc/tempo"}[15m]))' },
  { sender: 'telemetry-gateway', target: 'collector-4318', tempoService: 'telemetry-gateway' },
  { sender: 'telemetry-ingest', target: 'collector-4318', tempoService: 'telemetry-ingest' },
];

// busybox 시험 스크립트. TARGETS의 각 대상에 이름 해석 → nc 연결을 하고 JSON 한 줄씩 낸다.
// EXPECT가 있으면 DEADLINE 초 안에서 그 결과가 나올 때까지 5초마다 다시 본다(정책 반영을 고정 대기로 판단하지 않는다).
const PROBE_SCRIPT = `
for tool in nc nslookup timeout date; do command -v $tool >/dev/null 2>&1 || { echo "{\\"result\\":\\"TOOL_ERROR\\",\\"tool\\":\\"$tool\\"}"; exit 0; }; done
probe() {
  case "$1" in *[!0-9.]*) nslookup "$1" >/dev/null 2>&1 || { echo DNS_FAIL; return; };; esac
  s=$(date +%s)
  if err=$(timeout 10 nc -z -w 5 "$1" "$2" 2>&1); then echo OPEN; return; fi
  case "$err" in *"bad address"*) echo DNS_FAIL; return;; esac
  if [ $(( $(date +%s) - s )) -ge 4 ]; then echo TIMEOUT; else echo REFUSED; fi
}
end=$(( $(date +%s) + \${DEADLINE:-0} ))
for t in $TARGETS; do
  name=\${t%%=*}; hp=\${t#*=}; host=\${hp%:*}; port=\${hp##*:}; n=0
  while :; do
    n=$((n+1)); r=$(probe "$host" "$port")
    if [ -z "\${EXPECT:-}" ] || [ "$r" = "$EXPECT" ] || [ $(date +%s) -ge $end ]; then break; fi
    sleep 5
  done
  echo "{\\"target\\":\\"$name\\",\\"result\\":\\"$r\\",\\"attempts\\":$n}"
done`;

const job = ({ name, namespace, pool, labels, targets, expect = '', deadline = 0 }) => ({
  apiVersion: 'batch/v1', kind: 'Job',
  metadata: { name, namespace, labels: { [MARK]: 'true', [RUN_MARK]: suffix } },
  spec: {
    backoffLimit: 0, ttlSecondsAfterFinished: 900, activeDeadlineSeconds: 60 + deadline + 15 * targets.split(' ').length,
    template: {
      metadata: { labels: { [MARK]: 'true', [RUN_MARK]: suffix, ...labels } },
      spec: {
        restartPolicy: 'Never', ...POOLS[pool], securityContext: { runAsNonRoot: true, runAsUser: 65534 },
        containers: [{
          name: 'probe', image: IMAGE, command: ['sh', '-c', PROBE_SCRIPT],
          env: [{ name: 'TARGETS', value: targets }, { name: 'EXPECT', value: expect }, { name: 'DEADLINE', value: String(deadline) }],
          resources: { requests: { cpu: '10m', memory: '16Mi' }, limits: { cpu: '100m', memory: '64Mi' } },
        }],
      },
    },
  },
});
const STRANGER_LABELS = { 'app.kubernetes.io/name': 'np-probe-stranger' };
const N2_TARGET = `np-server=np-server.${PROBE_NS}.svc.cluster.local:9090`;

if (renderOnly) {
  const docs = [
    ...files('probe.yaml'), ...files('deny-all.yaml'), ...files('allow-labeled.yaml'),
    job({ name: 'np-n2-client', namespace: PROBE_NS, pool: 'apps', labels: {}, targets: N2_TARGET, expect: 'TIMEOUT', deadline: 120 }),
    job({ name: 'np-n2-allowed', namespace: PROBE_NS, pool: 'apps', labels: { 'np-probe/allowed': 'true' }, targets: N2_TARGET, expect: 'OPEN', deadline: 120 }),
    ...STRANGERS.map(s => job({ name: `np-n5-${s.name}`, namespace: s.namespace, pool: s.pool, labels: STRANGER_LABELS, targets: targetSpec(s.targets) })),
  ];
  process.stdout.write(docs.map(x => dump(x, { lineWidth: -1 })).join('---\n'));
  process.exit(0);
}

const kubectl = (args, input) => spawnSync('kubectl', ['--request-timeout=60s', ...args], { encoding: 'utf8', input, timeout: 600_000, maxBuffer: 16 * 1024 * 1024 });
const kube = (args, input) => {
  const result = kubectl(args, input);
  assert.equal(result.status, 0, `kubectl ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
};
const kubeJson = args => JSON.parse(kube([...args, '-o', 'json']));
const apply = docs => kube(['apply', '-f', '-'], docs.map(x => dump(x)).join('---\n'));
const sleep = ms => new Promise(done => setTimeout(done, ms));
let createdNamespace = false;
const evidence = { phase, runId: `np-probe/${phase}/${suffix}`, context: kube(['config', 'current-context']).trim(), startedAt: new Date().toISOString(), image: IMAGE, status: 'NOT_RUN', steps: [], failures: [] };
const fail = reason => evidence.failures.push(reason);
const parseLines = text => text.split('\n').filter(x => x.startsWith('{')).map(x => JSON.parse(x));

// Job 하나를 띄워 끝날 때까지 기다리고 결과 줄을 읽는다. Job은 controller가 관리하는 Pod라 정책 적용 대상으로 안정적이다.
async function runJob(spec) {
  const name = `${spec.name}-${randomBytes(3).toString('hex')}`;
  apply([job({ ...spec, name })]);
  const timeout = 60 + (spec.deadline ?? 0) + 15 * spec.targets.split(' ').length + 120;
  const waited = kubectl(['wait', '-n', spec.namespace, `job/${name}`, '--for=condition=complete', `--timeout=${timeout}s`]);
  const logs = kubectl(['logs', '-n', spec.namespace, `job/${name}`]);
  const detail = waited.status === 0 ? null : kubectl(['describe', '-n', spec.namespace, `job/${name}`]).stdout.slice(-1500);
  kubectl(['delete', '-n', spec.namespace, `job/${name}`, '--cascade=foreground', '--wait=false']);
  const results = waited.status === 0 ? parseLines(logs.stdout) : [];
  return { job: name, namespace: spec.namespace, pool: spec.pool, labels: spec.labels, complete: waited.status === 0, results, detail };
}
// 실행 중인 허용 송신자 container에서 같은 스크립트를 돌린다.
const execProbe = (control, targets) => {
  const result = kubectl(['exec', ...control.exec, '--', 'env', `TARGETS=${targets}`, 'EXPECT=', 'DEADLINE=0', 'sh', '-c', PROBE_SCRIPT]);
  return { status: result.status, results: result.status === 0 ? parseLines(result.stdout) : [], stderr: result.stderr.slice(0, 300) };
};
const promQuery = expr => {
  const result = kubectl(['exec', '-n', NS, 'pod/prometheus-pulsemetry-monitoring-prometheus-0', '-c', 'prometheus', '--',
    'wget', '-qO-', `http://127.0.0.1:9090/api/v1/query?query=${encodeURIComponent(expr)}`]);
  if (result.status !== 0) return null;
  const data = JSON.parse(result.stdout).data.result;
  return data.length ? Number(data[0].value[1]) : 0;
};
const tempoHasService = service => {
  const end = Math.floor(Date.now() / 1000);
  const url = `http://${fqdn('pulsemetry-tempo')}:3200/api/search?tags=${encodeURIComponent(`service.name=${service}`)}&limit=1&start=${end - 900}&end=${end}`;
  const result = kubectl(['exec', ...PORT_CONTROLS[0].exec, '--', 'wget', '-qO-', url]);
  if (result.status !== 0) return null;
  return (JSON.parse(result.stdout).traces ?? []).length > 0;
};
const podsReady = (namespace, selector) => {
  const pods = kubeJson(['get', 'pods', '-n', namespace, '-l', selector]).items;
  return { count: pods.length, ready: pods.length > 0 && pods.every(p => p.status.conditions?.some(c => c.type === 'Ready' && c.status === 'True')),
    restarts: pods.reduce((n, p) => n + (p.status.containerStatuses ?? []).reduce((m, c) => m + c.restartCount, 0), 0) };
};

try {
  if (phase === 'n2') {
    const controller = kubectl(['get', 'configmap', '-n', 'kube-system', 'amazon-vpc-cni', '-o', 'json']);
    evidence.controller = controller.status === 0 ? JSON.parse(controller.stdout).data : null;
    if (evidence.controller?.['enable-network-policy-controller'] !== 'true') throw new Error('controller ConfigMap이 켜져 있지 않다(N1 먼저)');
    // 조회 실패(연결 오류 등)를 "없다"로 읽지 않는다. NotFound일 때만 만든다.
    const lookup = kubectl(['get', 'namespace', PROBE_NS]);
    if (lookup.status === 0) throw new Error(`${PROBE_NS}가 이미 있다. 다른 시험의 자원을 지우지 않는다`);
    if (!/\(NotFound\)/.test(lookup.stderr)) throw new Error(`${PROBE_NS} 조회 실패 — 없다고 단정하지 않는다: ${lookup.stderr.trim().slice(0, 200)}`);
    // apply는 이미 있는 namespace에도 성공하므로 create로 만든다. create가 성공했을 때만 이 실행이 만든 것으로 기록하고, 그것만 지운다.
    const created = kubectl(['create', 'namespace', PROBE_NS]);
    if (created.status !== 0) throw new Error(`${PROBE_NS}를 만들지 못했다(이미 있을 수 있다): ${created.stderr.trim().slice(0, 200)}`);
    createdNamespace = true;
    apply(files('probe.yaml').filter(x => x.kind !== 'Namespace'));
    kube(['rollout', 'status', '-n', PROBE_NS, 'deploy/np-server', '--timeout=180s']);
    const step = async (label, spec, expect) => {
      const result = await runJob({ namespace: PROBE_NS, pool: 'apps', targets: N2_TARGET, ...spec });
      const actual = result.results[0]?.result ?? (result.complete ? 'NO_RESULT' : 'JOB_FAILED');
      evidence.steps.push({ label, expect, actual, ...result });
      if (actual !== expect) fail(`${label}: 기대 ${expect}, 실제 ${actual}`);
      return actual;
    };
    await step('정책 전 label 없는 client', { name: 'np-n2-before', labels: {} }, 'OPEN');
    apply(files('deny-all.yaml'));
    // client가 120초 안에 TIMEOUT으로 바뀌는지 본다. 바뀐 뒤(정책이 강제되는 동안) server Ready를 5초마다 READY_SECONDS 동안 관찰한다.
    // Job 대기는 동기 호출이라 그 사이에 관찰할 수 없다 — 관찰은 별도 단계로 한다.
    await step('deny-all 뒤 label 없는 client', { name: 'np-n2-deny', labels: {}, expect: 'TIMEOUT', deadline: 120 }, 'TIMEOUT');
    // 표본은 시작 시각 기준 5초 간격으로 잡는다. API 응답 시간이 간격에 쌓이지 않는다. 표본 시작이 READY_SECONDS에 닿을 때까지 본다.
    // 판정은 표본 개수가 아니라 실제 관찰 구간(첫·마지막 표본 시작 간격)과 가장 긴 표본 간격(10초 이하)이다.
    const readiness = [];
    const observeStart = Date.now();
    for (let k = 0; ; k++) {
      const wait = observeStart + k * 5000 - Date.now();
      if (wait > 0) await sleep(wait);
      const t = (Date.now() - observeStart) / 1000;
      try { readiness.push({ t, at: new Date().toISOString(), ...podsReady(PROBE_NS, 'app.kubernetes.io/name=np-server') }); } catch (error) {
        readiness.push({ t, at: new Date().toISOString(), error: String(error.message).slice(0, 200) });
      }
      if (t >= READY_SECONDS) break;
    }
    const spanSeconds = readiness.at(-1).t - readiness[0].t;
    const maxGapSeconds = Math.max(0, ...readiness.slice(1).map((x, i) => x.t - readiness[i].t));
    evidence.readySeconds = READY_SECONDS;
    evidence.readinessObservation = { samples: readiness.length, spanSeconds, maxGapSeconds };
    evidence.serverReadinessAfterDenyAll = readiness;
    if (readiness.some(x => x.error)) fail('Ready 관찰 중 API 조회가 실패했다 — 관찰이 끊겨 판정할 수 없다');
    else if (spanSeconds < READY_SECONDS || maxGapSeconds > 10) fail(`Ready 관찰 구간 ${spanSeconds}초·최대 간격 ${maxGapSeconds}초 — ${READY_SECONDS}초를 10초 이하 간격으로 보지 못했다`);
    else if (!readiness.every(x => x.ready) || new Set(readiness.map(x => x.restarts)).size > 1) {
      fail(`deny-all 뒤 server가 ${READY_SECONDS}초 동안 Ready를 유지하지 못했다 — kubelet probe가 막혔을 수 있다. 노드 대역 ipBlock으로 우회하지 않는다`);
      evidence.events = kubectl(['get', 'events', '-n', PROBE_NS, '--sort-by=.lastTimestamp']).stdout.slice(-3000);
    }
    apply(files('allow-labeled.yaml'));
    await step('label 허용 뒤 허용 client', { name: 'np-n2-allowed', labels: { 'np-probe/allowed': 'true' }, expect: 'OPEN', deadline: 120 }, 'OPEN');
    await step('label 허용 뒤 label 없는 client', { name: 'np-n2-still-denied', labels: {} }, 'TIMEOUT');
  }

  if (phase === 'n5') {
    // 사전조건: 세 정책과 각 PolicyEndpoints, controller, 대상 Ready, Service port = container port(AWS 고려사항).
    const policies = kubeJson(['get', 'networkpolicy', '-n', NS]).items.map(x => x.metadata.name);
    const endpoints = kubeJson(['get', 'policyendpoints', '-n', NS]).items.map(x => x.spec?.policyRef?.name);
    const expected = ['pulsemetry-loki-ingress', 'pulsemetry-tempo-ingress', 'pulsemetry-otel-platform-ingress'];
    const targets = Object.fromEntries(Object.entries(TARGETS).map(([name, t]) => {
      const service = kubeJson(['get', 'service', '-n', NS, t.service]);
      const pod = kubeJson(['get', 'pods', '-n', NS, '-l', t.selector]).items[0];
      const port = service.spec.ports.find(p => p.port === t.port);
      const containerPort = pod?.spec.containers.flatMap(c => c.ports ?? []).find(p => p.containerPort === t.port);
      const portsMatch = Boolean(port && containerPort && (port.targetPort === t.port || (port.targetPort === containerPort.name && port.name === containerPort.name)));
      return [name, { ...podsReady(NS, t.selector), portsMatch }];
    }));
    evidence.preconditions = { policies, policyEndpoints: endpoints, targets };
    for (const name of expected) {
      if (!policies.includes(name)) fail(`정책 ${name}이 없다`);
      if (!endpoints.includes(name)) fail(`PolicyEndpoints가 ${name}을 가리키지 않는다 — controller가 정책을 반영하지 않았다`);
    }
    for (const [name, t] of Object.entries(targets)) {
      if (!t.ready) fail(`${name} 대상 Pod가 Ready가 아니다`);
      if (!t.portsMatch) fail(`${name}: Service port와 container port가 다르다(AWS 정책 적용 조건)`);
    }
    const preconditionsOk = evidence.failures.length === 0;

    // 허용 송신자 대조: 포트 수준(실행 중 container)과 동작 수준(지표·Tempo 검색)을 나눠 기록한다.
    const controls = {};
    for (const control of PORT_CONTROLS) {
      const result = execProbe(control, targetSpec(control.targets));
      evidence.steps.push({ kind: 'port-control', sender: control.sender, ...result });
      for (const target of control.targets) {
        const actual = result.status !== 0 ? 'EXEC_FAILED' : result.results.find(r => r.target === target)?.result ?? 'NO_RESULT';
        (controls[target] ??= []).push({ sender: control.sender, kind: 'port', ok: actual === 'OPEN', result: actual });
        // 허용 송신자는 하나하나 닿아야 한다. 다른 송신자의 성공으로 대신하지 않는다.
        if (actual !== 'OPEN') fail(`허용 송신자 ${control.sender} → ${target}: ${actual}`);
      }
    }
    for (const control of FUNCTIONAL_CONTROLS) {
      let state;
      if (control.tempoService) { const found = tempoHasService(control.tempoService); state = found === null ? 'ERROR' : found ? 'OK' : 'PENDING'; }
      else { const ok = promQuery(control.ok); const bad = promQuery(control.bad); state = ok === null || bad === null ? 'ERROR' : bad > 0 ? 'FAIL' : ok > 0 ? 'OK' : 'PENDING'; }
      evidence.steps.push({ kind: 'functional-control', sender: control.sender, target: control.target, state });
      (controls[control.target] ??= []).push({ sender: control.sender, kind: 'functional', ok: state === 'OK', result: state });
      if (state === 'FAIL' || state === 'ERROR') fail(`허용 송신자 ${control.sender} → ${control.target}: ${state}`);
    }
    evidence.controls = controls;

    // 허용 label 없는 송신자: 같은 목적지·포트에서 막혀야 한다.
    const cases = [];
    for (const stranger of STRANGERS) {
      const result = await runJob({ name: `np-n5-${stranger.name}`, namespace: stranger.namespace, pool: stranger.pool, labels: STRANGER_LABELS, targets: targetSpec(stranger.targets) });
      evidence.steps.push({ kind: 'stranger', ...result });
      for (const name of stranger.targets) {
        const actual = result.results.find(r => r.target === name)?.result
          ?? (result.results.some(r => r.result === 'TOOL_ERROR') ? 'TOOL_ERROR' : result.complete ? 'NO_RESULT' : 'JOB_FAILED');
        const open = sgOpen(stranger.pool, TARGET_POOL, TARGETS[name].port);
        // 같은 목적지·포트의 필수 허용 송신자가 모두 성공해야 대조가 성립한다.
        const required = controls[name] ?? [];
        const controlOk = required.length > 0 && required.every(c => c.ok);
        const controlPending = required.some(c => c.result === 'PENDING') && required.every(c => c.ok || c.result === 'PENDING');
        const verdict = actual === 'OPEN' ? 'NOT_BLOCKED'
          : actual !== 'TIMEOUT' ? 'INCONCLUSIVE'
            : !open ? 'SG_ALSO_BLOCKS'
              : !preconditionsOk ? 'INCONCLUSIVE'
                : controlOk ? 'BLOCKED_BY_POLICY' : controlPending ? 'PENDING_CONTROL' : 'INCONCLUSIVE';
        cases.push({ sender: { namespace: stranger.namespace, labels: STRANGER_LABELS, nodePool: stranger.pool }, target: name, sgOpen: open, expect: 'TIMEOUT', actual, controlOk, verdict });
        if (verdict === 'NOT_BLOCKED') fail(`${stranger.name} → ${name}: 허용 label 없는 Pod가 닿았다`);
      }
    }
    evidence.cases = cases;
    // 목적지·포트마다 SG가 여는 경로에서 정책 차단이 하나 이상 입증돼야 한다.
    for (const name of Object.keys(TARGETS)) {
      if (!cases.some(c => c.target === name && c.verdict === 'BLOCKED_BY_POLICY')) {
        const pending = cases.some(c => c.target === name && c.verdict === 'PENDING_CONTROL');
        evidence.steps.push({ kind: 'verdict', target: name, state: pending ? 'PENDING' : 'NOT_PROVEN' });
        if (!pending) fail(`${name}: 정책 차단을 입증하지 못했다(대조·사전조건 확인)`);
      }
    }
  }
  const pending = evidence.steps.some(x => x.state === 'PENDING');
  const short = phase === 'n2' && READY_SECONDS < 70;
  evidence.status = evidence.failures.length ? 'FAIL' : short ? 'SHORT_RUN' : pending ? 'PENDING' : 'PASS';
} catch (error) {
  evidence.status = 'FAIL';
  fail(`실행 오류: ${error.message.slice(0, 500)}`);
} finally {
  // 이 실행이 만든 자원만 지운다. N2는 이 실행이 만든 일회용 namespace, N5는 이 실행의 run label이 붙은 Job뿐이다.
  if (phase === 'n2' && createdNamespace) kubectl(['delete', 'namespace', PROBE_NS, '--wait=false']);
  if (phase === 'n5') for (const s of STRANGERS) kubectl(['delete', 'job', '-n', s.namespace, '-l', `${RUN_MARK}=${suffix}`, '--wait=false']);
  evidence.cleanup = { namespaceDeleted: phase === 'n2' && createdNamespace, jobSelector: phase === 'n5' ? `${RUN_MARK}=${suffix}` : null };
  evidence.finishedAt = new Date().toISOString();
  writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n');
}
console.log(`${evidence.status}: NetworkPolicy ${phase} (${output})${evidence.failures.length ? `\n- ${evidence.failures.join('\n- ')}` : ''}`);
process.exit(evidence.status === 'FAIL' ? 1 : 0);
