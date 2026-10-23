#!/usr/bin/env node
// Loki·Tempo·플랫폼 Collector wrapper chart의 렌더·고정값·실패 경계를 검증한다(ADR-0039). AWS에 연결하거나 배포하지 않는다.
// 실제 바이너리 기동·송수신은 scripts/observability-loki-tempo-smoke.py가 맡는다.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dump, load, loadAll } from 'js-yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const helm = process.env.HELM_BIN;
if (!helm) throw new Error('HELM_BIN을 고정 버전 실행 파일로 지정해야 한다');
const temp = mkdtempSync(resolve(tmpdir(), 'platform-trace-check-'));
const namespace = 'pulsemetry-observability';
const lock = JSON.parse(readFileSync(resolve(root, 'helm/observability/dependencies.lock.json'), 'utf8'));
const evidence = JSON.parse(readFileSync(resolve(root, 'helm/observability/tests/fixtures/arm64-platform-trace-images.json'), 'utf8'));
assert.equal(evidence.status, 'PASS');
const pinned = new Map(evidence.images.map(x => [x.image.replace(/^docker\.io\//, '').split(':')[0], `sha256:${x.manifest_index_sha256}`]));

const run = (args, options = {}) => spawnSync(helm, args, { cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 24 * 1024 * 1024, ...options });
const checked = args => {
  const result = run(args);
  assert.equal(result.status, 0, `helm ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
};

// release별 기대값. 렌더 결과에 이 밖의 리소스 종류가 생기면 실패한다(MinIO·gateway·canary·cache·test·ClusterRole 등).
const RELEASES = {
  loki: {
    kinds: { ConfigMap: 2, Service: 3, ServiceAccount: 1, StatefulSet: 1 },
    service: 'pulsemetry-loki', ports: [3100], pvc: ['storage', '20Gi'],
    requests: { cpu: 250, memory: 512 }, limits: { cpu: 1000, memory: 1024 },
  },
  tempo: {
    kinds: { ConfigMap: 1, Service: 2, ServiceAccount: 1, StatefulSet: 1 },
    service: 'pulsemetry-tempo', ports: [3200, 4317], pvc: ['storage', '20Gi'],
    requests: { cpu: 250, memory: 512 }, limits: { cpu: 1000, memory: 1024 },
  },
  'otel-platform': {
    kinds: { ConfigMap: 1, Service: 1, ServiceAccount: 1, StatefulSet: 1 },
    service: 'pulsemetry-otel-platform', ports: [4318, 8888], pvc: ['queue', '1Gi'],
    requests: { cpu: 100, memory: 256 }, limits: { cpu: 500, memory: 512 },
  },
};
const cpu = value => String(value).endsWith('m') ? Number(String(value).slice(0, -1)) : Number(value) * 1000;
const mib = value => String(value).endsWith('Gi') ? Number(String(value).slice(0, -2)) * 1024 : Number(String(value).slice(0, -2));

const rendered = {};
for (const [wrapper, expected] of Object.entries(RELEASES)) {
  const chart = resolve(root, 'helm/observability', wrapper);
  const locked = lock.charts[wrapper];
  const archive = readFileSync(resolve(chart, 'charts', `${locked.name}-${locked.version}.tgz`));
  assert.equal(createHash('sha256').update(archive).digest('hex'), locked.sha256, `${wrapper} archive SHA256`);
  const dependency = load(readFileSync(resolve(chart, 'Chart.yaml'), 'utf8')).dependencies[0];
  assert.deepEqual([dependency.name, dependency.version], [locked.name, locked.version], `${wrapper} Chart.yaml와 lock`);
  checked(['lint', chart, '-n', namespace]);
  const docs = loadAll(checked(['template', wrapper, chart, '-n', namespace])).filter(Boolean);
  rendered[wrapper] = docs;

  const kinds = {};
  for (const doc of docs) kinds[doc.kind] = (kinds[doc.kind] ?? 0) + 1;
  assert.deepEqual(kinds, expected.kinds, `${wrapper} 리소스 종류`);
  for (const doc of docs) assert.equal(doc.metadata.namespace ?? namespace, namespace);

  const services = docs.filter(x => x.kind === 'Service');
  for (const service of services) assert.equal(service.spec.type ?? 'ClusterIP', 'ClusterIP', `${wrapper} Service는 ClusterIP뿐이다`);
  const main = services.find(x => x.metadata.name === expected.service);
  assert.ok(main, `${wrapper} 고정 Service ${expected.service}`);
  for (const port of expected.ports) assert.ok(main.spec.ports.some(x => x.port === port), `${expected.service}:${port}`);

  const sts = docs.find(x => x.kind === 'StatefulSet');
  assert.equal(sts.spec.replicas, 1);
  const pod = sts.spec.template.spec;
  assert.equal(pod.nodeSelector['kubernetes.io/arch'], 'arm64');
  assert.equal(pod.nodeSelector['pulsemetry.io/workload'], 'observability');
  assert.ok(pod.tolerations.some(x => x.key === 'workload' && x.value === 'observability' && x.effect === 'NoSchedule'));
  assert.equal(pod.securityContext.runAsNonRoot, true, `${wrapper} 비루트 실행`);
  assert.equal(pod.containers.length, 1, `${wrapper} sidecar 없음`);
  assert.ok(!(pod.initContainers ?? []).length, `${wrapper} init container 없음`);
  const container = pod.containers[0];
  assert.equal(container.securityContext.readOnlyRootFilesystem, true, `${wrapper} 읽기 전용 root`);
  assert.ok(!(container.ports ?? []).some(x => x.hostPort), `${wrapper} hostPort 없음`);
  const [reference, digest] = container.image.replace(/^docker\.io\//, '').split('@');
  assert.equal(digest, pinned.get(reference.split(':')[0]), `${wrapper} 이미지 digest가 ARM64 증거와 같다: ${container.image}`);
  assert.deepEqual([cpu(container.resources.requests.cpu), mib(container.resources.requests.memory)], [expected.requests.cpu, expected.requests.memory]);
  assert.deepEqual([cpu(container.resources.limits.cpu), mib(container.resources.limits.memory)], [expected.limits.cpu, expected.limits.memory]);

  // PVC는 StatefulSet 삭제·축소로 지워지지 않는다. 정책이 없으면 Kubernetes 기본(Retain)이다.
  const policy = sts.spec.persistentVolumeClaimRetentionPolicy ?? { whenDeleted: 'Retain', whenScaled: 'Retain' };
  assert.deepEqual([policy.whenDeleted, policy.whenScaled], ['Retain', 'Retain'], `${wrapper} PVC 보존`);
  const claim = sts.spec.volumeClaimTemplates[0];
  assert.equal(sts.spec.volumeClaimTemplates.length, 1);
  assert.deepEqual([claim.metadata.name, claim.spec.resources.requests.storage], expected.pvc);
  assert.equal(claim.spec.storageClassName, 'gp3-observability');
}

// 초기 자원 예산(ADR-0039): request 600m CPU·1280Mi memory, PVC 41Gi.
const total = Object.values(RELEASES).reduce((sum, x) => ({ cpu: sum.cpu + x.requests.cpu, memory: sum.memory + x.requests.memory }), { cpu: 0, memory: 0 });
assert.deepEqual(total, { cpu: 600, memory: 1280 });

const configOf = (wrapper, key) => load(rendered[wrapper].find(x => x.kind === 'ConfigMap' && x.data?.[key]).data[key]);
const loki = configOf('loki', 'config.yaml');
assert.equal(loki.auth_enabled, false);
assert.equal(loki.common.replication_factor, 1);
assert.deepEqual(loki.schema_config.configs.map(x => [x.store, x.schema, x.object_store, x.index.period]), [['tsdb', 'v13', 'filesystem', '24h']]);
assert.equal(loki.compactor.retention_enabled, true);
assert.equal(loki.compactor.delete_request_store, 'filesystem');
assert.ok(loki.compactor.working_directory.startsWith('/var/loki/'), '압축·삭제 작업 경로도 PVC 아래다');
assert.equal(loki.limits_config.retention_period, '72h');
assert.equal(loki.analytics.reporting_enabled, false);

const tempo = configOf('tempo', 'tempo.yaml');
assert.deepEqual(Object.keys(tempo.distributor.receivers), ['otlp']);
assert.deepEqual(Object.keys(tempo.distributor.receivers.otlp.protocols), ['grpc']);
assert.equal(tempo.distributor.receivers.otlp.protocols.grpc.endpoint, '0.0.0.0:4317');
assert.equal(tempo.backend_scheduler.provider.compaction.compaction.block_retention, '48h');
assert.equal(tempo.storage.trace.backend, 'local');
assert.ok(tempo.storage.trace.local.path.startsWith('/var/tempo/') && tempo.storage.trace.wal.path.startsWith('/var/tempo/'));
assert.equal(tempo.usage_report.reporting_enabled, false);

const collector = configOf('otel-platform', 'relay');
assert.deepEqual(Object.keys(collector.service.pipelines), ['traces'], '플랫폼 Collector는 trace pipeline만 연다');
assert.deepEqual(collector.service.pipelines.traces, {
  receivers: ['otlp'], processors: ['memory_limiter', 'attributes/drop-sensitive', 'batch'], exporters: ['otlp_grpc/tempo'],
});
assert.deepEqual(Object.keys(collector.receivers), ['otlp']);
assert.deepEqual(Object.keys(collector.receivers.otlp.protocols), ['http']);
assert.equal(collector.exporters['otlp_grpc/tempo'].endpoint, 'pulsemetry-tempo.pulsemetry-observability.svc:4317');
assert.equal(collector.exporters['otlp_grpc/tempo'].sending_queue.storage, 'file_storage');
assert.ok(collector.exporters['otlp_grpc/tempo'].retry_on_failure.max_elapsed_time, '재시도 시간은 유한하다');
assert.deepEqual(Object.keys(collector.exporters), ['otlp_grpc/tempo']);
assert.equal(collector.extensions.file_storage.directory, '/var/lib/otelcol/queue');
const limiter = collector.processors.memory_limiter;
assert.ok(limiter.limit_mib < 512 && limiter.limit_percentage === undefined && limiter.spike_limit_percentage === undefined, 'memory limit보다 낮은 MiB 값 하나만 쓴다');
const dropped = collector.processors['attributes/drop-sensitive'].actions.map(x => x.key);
for (const key of ['url.full', 'url.query', 'db.statement', 'db.query.text', 'http.request.header.authorization', 'exception.message']) assert.ok(dropped.includes(key), `지우는 속성: ${key}`);
const queueMount = rendered['otel-platform'].find(x => x.kind === 'StatefulSet').spec.template.spec.containers[0].volumeMounts;
assert.ok(queueMount.some(x => x.name === 'queue' && x.mountPath === '/var/lib/otelcol/queue'));

// 잘못된 입력은 렌더 단계에서 거부한다.
const rejects = [
  ['loki', ['--set', 'loki.singleBinary.replicas=2']],
  ['loki', ['--set', 'loki.minio.enabled=true']],
  ['loki', ['--set', 'loki.gateway.enabled=true']],
  ['loki', ['--set', 'loki.fullnameOverride=loki']],
  ['loki', ['--set', 'loki.singleBinary.persistence.whenDeleted=Delete']],
  ['tempo', ['--set', 'tempo.persistence.enableStatefulSetAutoDeletePVC=true']],
  ['tempo', ['--set', 'tempo.replicas=2']],
  ['tempo', ['--set', 'tempo.tempo.tag=3.1.0']],
  ['otel-platform', ['--set', 'collector.mode=deployment']],
  ['otel-platform', ['--set', 'collector.image.digest=']],
  ['otel-platform', ['--set-json', 'collector.config.service.pipelines.logs={"receivers":["otlp"],"exporters":["otlp_grpc/tempo"]}']],
  ['otel-platform', ['--set', 'collector.statefulset.persistentVolumeClaimRetentionPolicy.whenDeleted=Delete']],
];
for (const [wrapper, overrides] of rejects) {
  const result = run(['template', wrapper, resolve(root, 'helm/observability', wrapper), '-n', namespace, ...overrides]);
  assert.notEqual(result.status, 0, `잘못된 입력이 허용됨: ${wrapper} ${overrides.join(' ')}`);
}
for (const wrapper of Object.keys(RELEASES)) {
  const result = run(['template', wrapper, resolve(root, 'helm/observability', wrapper), '-n', 'default']);
  assert.notEqual(result.status, 0, `${wrapper}: 다른 namespace가 허용됨`);
}

if (process.env.KUBECONFORM_BIN) {
  const path = resolve(temp, 'platform-trace.yaml');
  writeFileSync(path, Object.values(rendered).flat().map(x => dump(x)).join('---\n'));
  const args = ['-strict', '-summary', '-kubernetes-version', '1.36.0'];
  if (process.env.KUBERNETES_SCHEMA_LOCATION) args.push('-schema-location', process.env.KUBERNETES_SCHEMA_LOCATION);
  const result = spawnSync(process.env.KUBECONFORM_BIN, [...args, path], { encoding: 'utf8', timeout: 120_000 });
  assert.equal(result.status, 0, `kubeconform\n${result.stdout}\n${result.stderr}`);
}
console.log(`Loki·Tempo·플랫폼 Collector wrapper 3개/${Object.values(rendered).flat().length}개 resource/${rejects.length + 3}개 실패 입력/고정 digest·PVC 보존·자원 예산 통과 (live 미실행)`);
