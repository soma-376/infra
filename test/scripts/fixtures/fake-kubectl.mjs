#!/usr/bin/env node
// observability-networkpolicy-probe.mjs 회귀 시험용 모의 kubectl. 실제 클러스터에 붙지 않는다.
// FAKE_KUBECTL_DIR에 호출 기록(calls.jsonl)과 상태(state.json)를 남긴다. FAKE_SCENARIO(JSON)로 장애를 흉내 낸다.
//   controllerOff, namespaceExists, namespaceLookupError(조회만 연결 오류, 실제로는 있음), namespaceCreateConflict(조회 뒤 누가 먼저 만듦),
//   noEnforcement, serverNotReady, podsDelayMs(np-server Pod 조회 응답 지연),
//   portControl: { grafana: { 'loki-3100': 'TIMEOUT' } }, functionalZero: true, stranger: { 'loki-3100': 'OPEN' }
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(resolve(process.env.FAKE_REPO_ROOT, 'package.json'));
const { loadAll } = require('js-yaml');
const dir = process.env.FAKE_KUBECTL_DIR;
const scenario = JSON.parse(process.env.FAKE_SCENARIO || '{}');
const args = process.argv.slice(2).filter(x => !x.startsWith('--request-timeout'));
appendFileSync(resolve(dir, 'calls.jsonl'), JSON.stringify(args) + '\n');
const statePath = resolve(dir, 'state.json');
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { namespace: false, denyAll: false, allow: false, jobs: {} };
const save = () => writeFileSync(statePath, JSON.stringify(state));
const out = value => { process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value)); process.exit(0); };
const exit = code => process.exit(code);
const has = (...words) => words.every(w => args.includes(w));

const NS = 'pulsemetry-observability';
const pod = (name, ports = []) => ({
  metadata: { name }, spec: { containers: [{ ports }] },
  status: { conditions: [{ type: 'Ready', status: 'True' }], containerStatuses: [{ restartCount: 0 }] },
});
const TARGET_PORTS = { 'pulsemetry-loki': [3100], 'pulsemetry-tempo': [3200, 4317], 'pulsemetry-otel-platform': [4318, 8888] };
const probeResult = (target, labels) => {
  if (target === 'np-server') {
    const allowed = state.allow && labels['np-probe/allowed'] === 'true';
    return state.denyAll && !scenario.noEnforcement && !allowed ? 'TIMEOUT' : 'OPEN';
  }
  return scenario.stranger?.[target] ?? 'TIMEOUT';
};
const targetsOf = text => text.trim().split(/\s+/).filter(Boolean).map(t => t.split('=')[0]);

if (has('config', 'current-context')) out('fake-context\n');
if (has('get', 'configmap', 'amazon-vpc-cni')) {
  if (scenario.controllerOff) { process.stderr.write('NotFound'); exit(1); }
  out({ data: { 'enable-network-policy-controller': 'true' } });
}
const namespaceExists = () => scenario.namespaceExists || scenario.namespaceLookupError || state.namespace;
if (has('get', 'namespace', 'pulsemetry-np-probe')) {
  if (scenario.namespaceLookupError) { process.stderr.write('Unable to connect to the server: read tcp 127.0.0.1:52100->127.0.0.1:8443: read: connection reset by peer'); exit(1); }
  if (namespaceExists()) out('NAME STATUS AGE\npulsemetry-np-probe Active 5m\n');
  process.stderr.write('Error from server (NotFound): namespaces "pulsemetry-np-probe" not found'); exit(1);
}
if (has('create', 'namespace', 'pulsemetry-np-probe')) {
  if (namespaceExists() || scenario.namespaceCreateConflict) { process.stderr.write('Error from server (AlreadyExists): namespaces "pulsemetry-np-probe" already exists'); exit(1); }
  state.namespace = true; save(); out('namespace/pulsemetry-np-probe created\n');
}
if (args[0] === 'apply') {
  for (const doc of loadAll(readFileSync(0, 'utf8')).filter(Boolean)) {
    if (doc.kind === 'Namespace') state.namespace = true;
    if (doc.kind === 'NetworkPolicy' && doc.metadata.name === 'np-deny-all') state.denyAll = true;
    if (doc.kind === 'NetworkPolicy' && doc.metadata.name === 'np-allow-labeled') state.allow = true;
    if (doc.kind === 'Job') {
      const env = Object.fromEntries(doc.spec.template.spec.containers[0].env.map(e => [e.name, e.value]));
      state.jobs[doc.metadata.name] = { labels: doc.spec.template.metadata.labels, targets: env.TARGETS };
    }
  }
  save();
  out('applied\n');
}
if (args[0] === 'rollout' || args[0] === 'wait' || args[0] === 'describe' || args[0] === 'delete') out('');
if (args[0] === 'logs') {
  const job = state.jobs[args.find(x => x.startsWith('job/')).slice(4)];
  out(targetsOf(job.targets).map(t => JSON.stringify({ target: t, result: probeResult(t, job.labels), attempts: 1 })).join('\n') + '\n');
}
if (has('get', 'events')) out('');
if (args[0] === 'get' && args[1] === 'pods') {
  const selector = args[args.indexOf('-l') + 1];
  if (selector === 'app.kubernetes.io/name=np-server') {
    // API 응답 지연을 흉내 낸다(동기 대기).
    if (scenario.podsDelayMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, scenario.podsDelayMs);
    const p = pod('np-server-0');
    if (scenario.serverNotReady && state.denyAll) p.status.conditions[0].status = 'False';
    out({ items: [p] });
  }
  const service = selector.includes('loki') ? 'pulsemetry-loki' : selector.includes('tempo') ? 'pulsemetry-tempo' : 'pulsemetry-otel-platform';
  out({ items: [pod(`${service}-0`, TARGET_PORTS[service].map(containerPort => ({ containerPort })))] });
}
if (has('get', 'networkpolicy')) out({ items: ['pulsemetry-loki-ingress', 'pulsemetry-tempo-ingress', 'pulsemetry-otel-platform-ingress'].map(name => ({ metadata: { name } })) });
if (has('get', 'policyendpoints')) out({ items: ['pulsemetry-loki-ingress', 'pulsemetry-tempo-ingress', 'pulsemetry-otel-platform-ingress'].map(name => ({ spec: { policyRef: { name } } })) });
if (has('get', 'service')) {
  const service = Object.keys(TARGET_PORTS).find(x => args.includes(x));
  out({ spec: { ports: TARGET_PORTS[service].map(port => ({ port, targetPort: port })) } });
}
if (args[0] === 'exec') {
  const sender = args.includes('deploy/pulsemetry-grafana') ? 'grafana' : 'prometheus';
  const command = args.slice(args.indexOf('--') + 1);
  if (command[0] === 'env') {
    const targets = command.find(x => x.startsWith('TARGETS=')).slice('TARGETS='.length);
    out(targetsOf(targets).map(t => JSON.stringify({ target: t, result: scenario.portControl?.[sender]?.[t] ?? 'OPEN', attempts: 1 })).join('\n') + '\n');
  }
  const url = command.at(-1);
  if (url.includes('/api/search')) out({ traces: scenario.functionalZero ? [] : [{ traceID: 'x' }] });
  const query = decodeURIComponent(url.split('query=')[1] ?? '');
  const bad = /errors_total|send_failed/.test(query);
  out({ data: { result: [{ value: [0, String(bad || scenario.functionalZero ? 0 : 10)] }] } });
}
process.stderr.write(`fake kubectl: 처리하지 않은 호출 ${JSON.stringify(args)}`);
exit(2);
