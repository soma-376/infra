import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { dump, load, loadAll } from 'js-yaml';

/**
 * dev 부하 시험 k6 Job 차트(ADR-0064)의 실제 Helm 렌더·schema 검사. 클러스터에 연결하지 않는다.
 * 계획 시간 계산은 backend tools/loadtest/k6/lib/schedule.js 와 같아야 한다 — 기댓값은 그 selftest 의 값이다.
 */
const enabled = Boolean(process.env.HELM_BIN && process.env.KUBECONFORM_BIN);
const suite = enabled ? describe : describe.skip;
const root = resolve(__dirname, '../..');
const chart = 'helm/dev/loadtest';
const namespace = 'pulsemetry-loadtest';
const required = ['testid=pipeline-01', 'configMapName=loadtest-k6-0123456789ab'];

function run(binary: string, args: string[]) {
  return spawnSync(binary, args, { cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
}

function args(set: string[], ns = namespace): string[] {
  return ['x', chart, '--namespace', ns, '--kube-version', '1.36.0', ...set.flatMap(item => ['--set', item])];
}

function render(set: string[] = []): any[] {
  const lint = run(process.env.HELM_BIN!, ['lint', chart, '--strict', ...args([...required, ...set]).slice(2)]);
  expect([lint.status, lint.stderr]).toEqual([0, '']);
  const result = run(process.env.HELM_BIN!, ['template', ...args([...required, ...set])]);
  expect([result.status, result.stderr]).toEqual([0, '']);
  return loadAll(result.stdout).filter(Boolean) as any[];
}

function rejects(set: string[], ns = namespace): string {
  const result = run(process.env.HELM_BIN!, ['template', ...args(set, ns)]);
  expect([set, ns, result.status === 0]).toEqual([set, ns, false]);
  return result.stderr;
}

const job = (documents: any[]) => documents.find(document => document.kind === 'Job');

suite('dev 부하 시험 k6 Job 차트', () => {
  let directory: string;
  beforeAll(() => { directory = mkdtempSync(join(tmpdir(), 'loadtest-chart-')); });
  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  test('기본 렌더는 Job·collector ConfigMap 둘이고 kubeconform strict(1.36)를 통과한다', () => {
    const documents = render();
    expect(documents.map(document => `${document.kind}/${document.metadata.name}`).sort())
      .toEqual(['ConfigMap/loadtest-pipeline-01-collector', 'Job/loadtest-pipeline-01']);
    for (const document of documents) expect(document.metadata.namespace).toBe(namespace);
    const file = join(directory, 'render.yaml');
    writeFileSync(file, documents.map(document => dump(document)).join('---\n'));
    const result = run(process.env.KUBECONFORM_BIN!, ['-strict', '-summary', '-kubernetes-version', '1.36.0', file]);
    expect([result.status, result.stderr, result.status === 0 ? '' : result.stdout]).toEqual([0, '', '']);
    expect(result.stdout).toContain('Valid: 2, Invalid: 0, Errors: 0, Skipped: 0');
  });

  test('Job 은 재시도·중단 없이 apps 풀에서 Gateway·ingest 와 다른 노드에 놓인다', () => {
    const spec = job(render()).spec;
    expect(spec.backoffLimit).toBe(0);
    expect(spec.ttlSecondsAfterFinished).toBe(86400);
    const pod = spec.template;
    expect(pod.metadata.labels).toMatchObject({ 'app.kubernetes.io/name': 'pulsemetry-loadtest-k6', 'pulsemetry.io/testid': 'pipeline-01' });
    expect(pod.metadata.annotations['karpenter.sh/do-not-disrupt']).toBe('true');
    expect(pod.spec.nodeSelector).toEqual({ 'kubernetes.io/arch': 'arm64', 'karpenter.sh/nodepool': 'pulsemetry-dev-apps' });
    expect(pod.spec.affinity.podAntiAffinity.requiredDuringSchedulingIgnoredDuringExecution).toEqual([{
      labelSelector: { matchExpressions: [{ key: 'app.kubernetes.io/name', operator: 'In', values: ['telemetry-gateway', 'telemetry-ingest'] }] },
      namespaces: ['pulsemetry-dev'],
      topologyKey: 'kubernetes.io/hostname',
    }]);
    expect(pod.spec.restartPolicy).toBe('Never');
    expect(pod.spec.automountServiceAccountToken).toBe(false);
  });

  test('collector 는 native sidecar 로 루프백 OTLP 를 받아 metrics(9404)로 내놓고, kubelet 은 health_check 로 시작을 확인한다', () => {
    const documents = render();
    const pod = job(documents).spec.template.spec;
    expect(pod.initContainers).toHaveLength(1);
    const collector = pod.initContainers[0];
    expect(collector.restartPolicy).toBe('Always');
    expect(collector.ports).toEqual([
      { name: 'metrics', containerPort: 9404, protocol: 'TCP' }, { name: 'health', containerPort: 13133, protocol: 'TCP' },
    ]);
    // kubelet 은 Pod IP 로 확인한다. 루프백 전용 4318 을 TCP 로 보면 정상 collector 도 실패해 k6 가 시작하지 않는다.
    expect(collector.startupProbe).toEqual({ httpGet: { path: '/', port: 'health' }, periodSeconds: 1, failureThreshold: 60 });
    expect(collector.startupProbe.tcpSocket).toBeUndefined();
    const config = load(documents.find(document => document.kind === 'ConfigMap').data['config.yaml']) as any;
    expect(config.receivers.otlp.protocols.http.endpoint).toBe('127.0.0.1:4318');
    expect(config.exporters.prometheus.endpoint).toBe('0.0.0.0:9404');
    expect(config.service.pipelines.metrics).toEqual({ receivers: ['otlp'], processors: ['batch'], exporters: ['prometheus'] });
    expect(config.extensions.health_check.endpoint).toBe('0.0.0.0:13133');
    expect(config.service.extensions).toEqual(['health_check']);
    expect(collector.resources).toEqual({ requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '500m', memory: '256Mi' } });
  });

  test('k6 는 REST 를 루프백에만 열고 OTel 로 보내며, 스크립트·시드는 정해진 경로에 읽기 전용이다', () => {
    const pod = job(render()).spec.template.spec;
    const k6 = pod.containers.find((container: any) => container.name === 'k6');
    expect(k6.args).toEqual(['run', '--address', '127.0.0.1:6565', '-o', 'opentelemetry', '/scripts/main.js']);
    const env = Object.fromEntries(k6.env.map((item: any) => [item.name, item.value]));
    expect(env).toMatchObject({
      K6_NO_USAGE_REPORT: 'true', K6_OTEL_EXPORTER_TYPE: 'http', K6_OTEL_HTTP_EXPORTER_ENDPOINT: '127.0.0.1:4318', K6_OTEL_METRIC_PREFIX: 'k6_',
      TESTID: 'pipeline-01', SCENARIO: 'smoke', IDENTITIES_FILE: '/seed/identities.json', SEED_SECRET_FILE: '/seed/seed-secret', FINAL_FLUSH: '25s',
      GATEWAY_URL: 'http://telemetry-gateway.pulsemetry-dev.svc:8082', ENROLLMENT_URL: 'http://enrollment-api.pulsemetry-dev.svc:8080',
      START_RPS: '5', STEP_RPS: '5', MAX_RPS: '60', RAMP: '30s', STEP_HOLD: '5m', COOLDOWN: '30s', HOLD_DURATION: '20m',
      MIX_SIGNAL: 'logs:70,metrics:20,traces:10', MIX_PRODUCT: 'claude-code:50,codex:50', GZIP: '1',
    });
    expect(env).not.toHaveProperty('HOLD_RPS');
    expect(k6.resources).toEqual({ requests: { cpu: '1', memory: '1Gi' }, limits: { cpu: '2', memory: '2Gi' } });
    const volumes = Object.fromEntries(pod.volumes.map((volume: any) => [volume.name, volume]));
    expect(volumes.scripts.configMap.name).toBe('loadtest-k6-0123456789ab');
    expect(volumes.scripts.configMap.items).toEqual([
      { key: 'main.js', path: 'main.js' }, { key: 'lib.config.js', path: 'lib/config.js' }, { key: 'lib.schedule.js', path: 'lib/schedule.js' },
      { key: 'lib.payload.js', path: 'lib/payload.js' }, { key: 'lib.auth.js', path: 'lib/auth.js' }, { key: 'lib.summary.js', path: 'lib/summary.js' },
      { key: 'data.templates.json', path: 'data/templates.json' },
    ]);
    expect(volumes.seed.secret).toEqual({ secretName: 'loadtest-seed', defaultMode: 0o440,
      items: [{ key: 'seed-secret', path: 'seed-secret' }, { key: 'identities.json', path: 'identities.json' }] });
    expect(k6.volumeMounts).toEqual([
      { name: 'scripts', mountPath: '/scripts', readOnly: true }, { name: 'seed', mountPath: '/seed', readOnly: true }, { name: 'tmp', mountPath: '/tmp' },
    ]);
  });

  test('restricted PSA 를 통과하는 securityContext 다', () => {
    const pod = job(render()).spec.template.spec;
    expect(pod.securityContext).toMatchObject({ runAsNonRoot: true, seccompProfile: { type: 'RuntimeDefault' } });
    for (const container of [...pod.initContainers, ...pod.containers]) {
      expect([container.name, container.securityContext]).toEqual([container.name, expect.objectContaining({
        runAsNonRoot: true, allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] },
      })]);
      expect(container.securityContext.runAsUser).toBeGreaterThan(0);
    }
  });

  test('이미지는 ARM64 증거(tests/arm64-images.json)와 같은 digest 다', () => {
    const evidence = JSON.parse(readFileSync(join(root, chart, 'tests/arm64-images.json'), 'utf8'));
    expect(evidence.status).toBe('PASS');
    const pinned = evidence.images.map((image: any) => image.image.replace(/^docker\.io\//, '')).sort();
    const pod = job(render()).spec.template.spec;
    const used = [pod.initContainers[0].image, pod.containers[0].image].map((image: string) => image.replace(/^docker\.io\//, '')).sort();
    expect(used).toEqual(pinned);
    for (const image of evidence.images) expect(image.image.endsWith(`@sha256:${image.manifest_index_sha256}`)).toBe(true);
  });

  test('계획 시간과 deadline 은 k6 schedule.js 와 같은 계산이다', () => {
    const deadline = (set: string[]) => {
      const document = job(render(set));
      return [Number(document.metadata.annotations['pulsemetry.io/planned-seconds']), document.spec.activeDeadlineSeconds];
    };
    expect(deadline([])).toEqual([60, 660]);
    expect(deadline(['scenario=stair'])).toEqual([3990, 4590]);
    expect(deadline(['scenario=stair', 'startRps=2', 'stepRps=2', 'maxRps=6', 'ramp=5s', 'stepHold=20s', 'cooldown=5s'])).toEqual([80, 680]);
    expect(deadline(['scenario=hold', 'holdRps=40'])).toEqual([1200, 1800]);
    expect(deadline(['scenario=hold', 'holdRps=1', 'holdDuration=10200s'])).toEqual([10200, 10800]);
    expect(deadline(['scenario=stair', 'activeDeadlineSeconds=5000'])).toEqual([3990, 5000]);
    const env = Object.fromEntries(job(render(['scenario=hold', 'holdRps=40'])).spec.template.spec.containers[0].env.map((item: any) => [item.name, item.value]));
    expect(env).toMatchObject({ SCENARIO: 'hold', HOLD_RPS: '40' });
  });

  test.each([
    ['다른 namespace', required, 'pulsemetry-dev', /namespace 는 pulsemetry-loadtest/],
    ['testid 없음', ['configMapName=loadtest-k6-0123456789ab'], namespace, /testid/],
    ['digest 없는 이미지', [...required, 'images.k6=docker.io/grafana/k6:1.8.2'], namespace, /images|k6/],
    ['maxRps 1000 초과', [...required, 'maxRps=1001'], namespace, /maxRps|1000/],
    ['계획 시간 10200s 초과', [...required, 'scenario=stair', 'maxRps=300', 'stepRps=1', 'stepHold=10m'], namespace, /10200s/],
    ['configMapName 없음', ['testid=pipeline-01'], namespace, /configMapName/],
    ['hold 에 holdRps 없음', [...required, 'scenario=hold'], namespace, /holdRps/],
    ['deadline 이 계획 시간 + 600 미만', [...required, 'scenario=stair', 'activeDeadlineSeconds=4000'], namespace, /activeDeadlineSeconds/],
    ['10201s hold', [...required, 'scenario=hold', 'holdRps=1', 'holdDuration=10201s'], namespace, /10200s/],
  ])('거부: %s', (_name, set, ns, pattern) => {
    expect(rejects(set as string[], ns as string)).toMatch(pattern as RegExp);
  });
});
