import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { dump, load, loadAll } from 'js-yaml';
import { main as values } from '../../scripts/perf-values';
import { DIGEST, ENVIRONMENT_ID, KID, MSK_BOOTSTRAP, MSK_NODES, REGISTRY, RUNTIME_VALUES, describeStacks, perfRequest } from '../perf/perf-fixtures';

/**
 * perf chart의 실제 Helm 렌더·schema 검사. dev 차트를 environment=perf로 렌더하는 경로를 포함한다.
 * dev 렌더 결과 불변은 scripts/validate-helm-workloads.mjs(dev 입력 전체)가 계속 검사한다. AWS에 연결하지 않는다.
 */
const enabled = Boolean(process.env.HELM_BIN && process.env.KUBECONFORM_BIN);
const suite = enabled ? describe : describe.skip;
const root = resolve(__dirname, '../..');
const helm = process.env.HELM_BIN ?? 'helm';
const kubeconform = process.env.KUBECONFORM_BIN ?? 'kubeconform';

let directory: string;
const generated = (name: string) => join(directory, 'generated', name);

function run(binary: string, args: string[]) {
  return spawnSync(binary, args, { cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });
}

function render(release: string, chart: string, namespace: string, files: string[], set: string[] = []): any[] {
  const args = [release, chart, '--namespace', namespace, '--kube-version', '1.36.0', ...files.flatMap(file => ['-f', file]), ...set.flatMap(item => ['--set', item])];
  const lint = run(helm, ['lint', chart, '--strict', ...args.slice(2)]);
  expect([chart, lint.status, lint.stderr]).toEqual([chart, 0, '']);
  const result = run(helm, ['template', ...args]);
  expect([chart, result.status, result.stderr]).toEqual([chart, 0, '']);
  return loadAll(result.stdout).filter(Boolean) as any[];
}

function rejects(chart: string, namespace: string, files: string[], set: string[] = []): string {
  const result = run(helm, ['template', 'x', chart, '--namespace', namespace, '--kube-version', '1.36.0', ...files.flatMap(file => ['-f', file]), ...set.flatMap(item => ['--set', item])]);
  expect([chart, set, result.status === 0]).toEqual([chart, set, false]);
  return result.stderr;
}

function schema(documents: any[]): void {
  const file = join(directory, `schema-${Math.random().toString(16).slice(2)}.yaml`);
  writeFileSync(file, documents.map(document => dump(document)).join('---\n'));
  const result = run(kubeconform, ['-strict', '-summary', '-kubernetes-version', '1.36.0', '-ignore-missing-schemas',
    '-schema-location', 'default', '-schema-location', 'helm/dev/runtime/schemas/{{.ResourceKind}}_{{.Group}}_{{.ResourceAPIVersion}}.json', file]);
  expect([result.status, result.stderr, result.status === 0 ? '' : result.stdout]).toEqual([0, '', '']);
}

const find = (documents: any[], kind: string, name: string) => {
  const document = documents.find(item => item.kind === kind && item.metadata.name === name);
  expect([kind, name, Boolean(document)]).toEqual([kind, name, true]);
  return document;
};
const workload = (name: string) => [join(root, `helm/perf/workloads/${name}.yaml`), generated(`${name}.yaml`)];

function jobValues(overrides: Record<string, unknown> = {}): string {
  const infra = (load(readFileSync(generated('jobs.yaml'), 'utf8')) as any).infra;
  const runId = 'm1-smoke-01';
  const value: any = {
    run: { experimentId: '0002-perf-smoke', runId, testid: `0002-perf-smoke/${runId}`, epochId: 'e1' },
    images: { k6Runner: `${REGISTRY}/perf-k6-runner@${DIGEST('5')}`, perfTools: `${REGISTRY}/perf-tools@${DIGEST('6')}` },
    namespaces: infra.namespaces,
    objects: { inputsConfigMap: `run-${runId}-inputs`, identitiesConfigMap: 'perf-identities', seedConfigMap: 'perf-seed-config', bundleSecret: `run-${runId}-bundle` },
    jobs: { prepare: `prepare-${runId}`, sentinel: `sentinel-${runId}`, runner: `k6-${runId}`, verify: `verify-${runId}` },
    endpoints: infra.endpoints,
    evidenceUri: `s3://${infra.evidenceBucket}/runs/0002-perf-smoke/${runId}/`,
    rawArchiveUri: infra.rawArchiveUri, environmentId: ENVIRONMENT_ID, cluster: infra.cluster,
    enrollment: { deployment: 'enrollment-api', sessionMethod: 'application-name', sessionValue: 'pulsemetry-enrollment-api', jwtKid: KID,
      publicKeySecretRef: { provider: 'aws-secretsmanager', name: `soma-376/perf/${ENVIRONMENT_ID}/telemetry-jwt/public-keys`, key: null } },
    deadlines: { runnerActiveDeadlineSeconds: 1500, gracefulStopSeconds: 15, terminationGracePeriodSeconds: 135, prepareActiveDeadlineSeconds: 900,
      verifyActiveDeadlineSeconds: 3600, sentinelActiveDeadlineSeconds: 2400, drainDeadlineSeconds: 900, requiredLifetimeSeconds: 2700 },
    runner: { outputSizeLimit: '2930Mi', remoteWritePushInterval: '5s', journalBytesEstimate: 1_000_000_000 },
    tools: { clockSkewBoundMs: 1000, archiveSample: 20 },
    ...overrides,
  };
  if (overrides.contractVersion === 3 && !overrides.bootstrapMode) {
    value.objects.generatorPolicyConfigMap = `run-${runId}-generator-policy`;
    value.pathPair ??= { pairId: 'readiness-01', sha256: 'a'.repeat(64),
      evidenceUri: `s3://${infra.evidenceBucket}/runs/pairs/readiness-01/`, smokeRequestReserve: 100, smokeSlotStart: 6 };
    value.deadlines.verifyPollDeadlineSeconds ??= 900;
    value.deadlines.verifyActiveDeadlineSeconds = 1920;
  }
  const file = join(directory, `job-values-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(value));
  return file;
}

suite('perf Helm chart', () => {
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'perf-helm-'));
    const write = (name: string, value: unknown) => { const file = join(directory, name); writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); return file; };
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    values(['--request', write('request.json', perfRequest().toString()), '--outputs', write('stacks.json', describeStacks()),
      '--runtime-values', write('runtime.yaml', RUNTIME_VALUES), '--msk-bootstrap', write('bootstrap.json', MSK_BOOTSTRAP),
      '--msk-nodes', write('nodes.json', MSK_NODES), '--output-dir', join(directory, 'generated')]);
  });
  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  test('v3 Strimzi Job은 provider 연결을 검사하고 MSK 변수를 공급하지 않는다', () => {
    const infra = (load(readFileSync(generated('jobs.yaml'), 'utf8')) as any).infra;
    delete infra.msk;
    infra.contractVersion = 3;
    infra.kafka = { provider: 'strimzi', clusterName: 'soma-376-perf-telemetry', namespace: 'pulsemetry-perf', topic: 'pulsemetry-perf-telemetry-ingress', consumerGroup: 'pulsemetry-perf-telemetry-ingest', partitions: 6 };
    const file = join(directory, 'strimzi-infra.yaml');
    writeFileSync(file, dump({ infra }));
    const values = jobValues({ contractVersion: 3, kafka: infra.kafka, tools: { clockSkewBoundMs: 1000, archiveSample: 20 } });
    const job = render('verify', 'helm/perf/jobs', 'pulsemetry-perf-runner', [file, values], ['job=verify'])[0];
    const env = Object.fromEntries(job.spec.template.spec.containers[0].env.map((e: any) => [e.name, e.value]));
    expect(env.KAFKA_PROVIDER).toBe('strimzi');
    expect(env.MSK_CLUSTER_NAME).toBeUndefined();
    expect(env.KAFKA_LAG_QUERY).toBeUndefined();
    expect(env).toMatchObject({ KAFKA_METRICS_ENVIRONMENT: 'perf', KAFKA_CLUSTER_NAME: infra.kafka.clusterName,
      KAFKA_NAMESPACE: infra.kafka.namespace, KAFKA_PARTITIONS: '6', KAFKA_TOPIC: infra.kafka.topic,
      KAFKA_CONSUMER_GROUP: infra.kafka.consumerGroup, CLOCK_SKEW_BOUND_MS: '1000' });
    rejects('helm/perf/jobs', 'pulsemetry-perf-runner', [file, jobValues()], ['job=verify']);
    rejects('helm/perf/jobs', 'pulsemetry-perf-runner', [file, values], ['job=verify', 'kafka.partitions=7']);
    rejects('helm/perf/jobs', 'pulsemetry-perf-runner', [file, values], ['job=verify', 'tools.kafkaLagQuery=sum(kafka_consumergroup_lag)']);
  });

  test('ingressPath는 선택한 배포 origin만 runner에 전달하고 내부 fallback을 하지 않는다', () => {
    const infra = (load(readFileSync(generated('jobs.yaml'), 'utf8')) as any).infra;
    infra.contractVersion = 3; infra.msk.partitions = 6;
    infra.endpoints.gatewayHttps = 'https://perf-api.pulsemetry.co.kr';
    const kafka = { ...infra.msk, provider: 'msk' };
    const file = join(directory, 'https-infra.yaml'); writeFileSync(file, dump({ infra }));
    const selected = jobValues({ contractVersion: 3, kafka, ingressPath: 'alb_https', endpoints: { ...infra.endpoints, gatewayHttps: undefined, gateway: infra.endpoints.gatewayHttps } });
    const job = render('runner', 'helm/perf/jobs', 'pulsemetry-perf-runner', [file, selected], ['job=runner'])[0];
    expect(job.spec.template.spec.containers[0].env).toContainEqual({ name: 'GATEWAY_ENDPOINT', value: 'https://perf-api.pulsemetry.co.kr' });
    expect(job.spec.template.spec.containers[0].env).toContainEqual({ name: 'INGRESS_PATH', value: 'alb_https' });
    const pod = job.spec.template.spec;
    expect(pod.containers[0].env).toEqual(expect.arrayContaining([
      { name: 'ENVIRONMENT', value: 'perf' },
      { name: 'PROMETHEUS_URL', value: infra.endpoints.prometheus },
      { name: 'GENERATOR_POLICY', value: '/generator-policy/generator-policy.json' },
      { name: 'POD_NAME', valueFrom: { fieldRef: { fieldPath: 'metadata.name' } } },
      { name: 'POD_NAMESPACE', valueFrom: { fieldRef: { fieldPath: 'metadata.namespace' } } },
      { name: 'NODE_NAME', valueFrom: { fieldRef: { fieldPath: 'spec.nodeName' } } },
    ]));
    expect(pod.volumes.find((v: any) => v.name === 'generator-policy').configMap).toEqual({
      name: 'run-m1-smoke-01-generator-policy', items: [{ key: 'generator-policy.json', path: 'generator-policy.json' }],
    });
    schema([job]);
    const smoke = render('smoke', 'helm/perf/jobs', 'pulsemetry-perf-runner', [file, selected], ['job=smoke'])[0];
    expect(smoke.spec.template.spec.containers[0].env).toEqual(expect.arrayContaining([
      { name: 'PAIR_SHA256', value: 'a'.repeat(64) }, { name: 'SMOKE_REQUEST_RESERVE', value: '100' },
      { name: 'SMOKE_SLOT_START', value: '6' },
      { name: 'PAIR_EVIDENCE_URI', value: `s3://${infra.evidenceBucket}/runs/pairs/readiness-01/` },
    ]));
    for (const change of ['pathPair=null', 'pathPair.sha256=bad', 'pathPair.smokeSlotStart=101',
      'pathPair.evidenceUri=s3://other/runs/pairs/readiness-01/', 'objects.generatorPolicyConfigMap=null',
      'deadlines.verifyActiveDeadlineSeconds=900', 'deadlines.drainDeadlineSeconds=901', 'ingressPath=unknown']) {
      rejects('helm/perf/jobs', 'pulsemetry-perf-runner', [file, selected], ['job=runner', change]);
    }
    rejects('helm/perf/jobs', 'pulsemetry-perf-runner', [file, selected], ['job=runner', 'ingressPath=internal']);
    rejects('helm/perf/jobs', 'pulsemetry-perf-runner', [file, selected], ['job=runner', 'endpoints.gateway=https://unexpected.example']);
    rejects('helm/perf/jobs', 'pulsemetry-perf-runner', [file, selected], ['job=runner', 'infra.endpoints.gatewayHttps=null']);
    rejects('helm/perf/jobs', 'pulsemetry-perf-runner', [generated('jobs.yaml'), jobValues({ ingressPath: 'alb_https' })], ['job=runner']);
  });

  test('bootstrap은 ready를 선언하지 않고 내부 prepare·smoke의 SHA 귀속 경로만 사용한다', () => {
    const infra = (load(readFileSync(generated('jobs.yaml'), 'utf8')) as any).infra;
    delete infra.msk; infra.contractVersion = 3;
    infra.kafka = { provider: 'strimzi', clusterName: 'soma-376-perf-telemetry', namespace: 'pulsemetry-perf',
      topic: 'pulsemetry-perf-telemetry-ingress', consumerGroup: 'pulsemetry-perf-telemetry-ingest', partitions: 6 };
    const file = join(directory, 'bootstrap-infra.yaml'); writeFileSync(file, dump({ infra }));
    const uri = `s3://${infra.evidenceBucket}/runs/bootstrap/${ENVIRONMENT_ID}/${'b'.repeat(64)}/${'c'.repeat(64)}/`;
    const selected = jobValues({ contractVersion: 3, kafka: infra.kafka, bootstrapMode: true, ingressPath: 'internal',
      run: { experimentId: 'bootstrap', runId: 'm1-smoke-01', testid: 'bootstrap/m1-smoke-01', epochId: 'e1' },
      evidenceUri: `${uri}executions/m1-smoke-01/`,
      bootstrap: { requestSha256: 'b'.repeat(64), provisionalSha256: 'c'.repeat(64), metadataSha256: 'd'.repeat(64),
        evidenceUri: uri, smokeRequestReserve: 100, smokeSlotStart: 0 },
      deadlines: { prepareActiveDeadlineSeconds: 900, smokeActiveDeadlineSeconds: 1020, requiredLifetimeSeconds: 1800 },
    });
    for (const job of ['prepare', 'smoke']) schema(render(job, 'helm/perf/jobs', 'pulsemetry-perf-runner', [file, selected], [`job=${job}`]));
    const smoke = render('smoke', 'helm/perf/jobs', 'pulsemetry-perf-runner', [file, selected], ['job=smoke'])[0];
    expect(smoke.spec.template.spec.containers[0].env).toEqual(expect.arrayContaining([
      { name: 'BOOTSTRAP_EVIDENCE_URI', value: uri }, { name: 'BOOTSTRAP_REQUEST_SHA256', value: 'b'.repeat(64) },
      { name: 'BOOTSTRAP_PROVISIONAL_SHA256', value: 'c'.repeat(64) },
      { name: 'BOOTSTRAP_SMOKE_REQUEST_RESERVE', value: '100' }, { name: 'BOOTSTRAP_SMOKE_SLOT_START', value: '0' },
    ]));
    for (const job of ['runner', 'sentinel', 'verify', 'seed']) rejects('helm/perf/jobs', 'pulsemetry-perf-runner', [file, selected], [`job=${job}`]);
    for (const change of ['ingressPath=alb_https', 'bootstrap.requestSha256=bad', 'bootstrap.smokeSlotStart=101',
      'bootstrap.evidenceUri=s3://other/runs/', 'evidenceUri=s3://other/runs/', 'bootstrap.metadataSha256=null']) {
      rejects('helm/perf/jobs', 'pulsemetry-perf-runner', [file, selected], ['job=smoke', change]);
    }
  });

  test('platform: namespace 4개, StorageClass, pool마다 NodeClass·고정 용량 NodePool', () => {
    const documents = render('perf-platform', 'helm/perf/platform', 'default', [generated('platform.yaml')]);
    schema(documents);
    expect(documents.filter(d => d.kind === 'Namespace').map(d => d.metadata.name).sort())
      .toEqual(['pulsemetry-observability', 'pulsemetry-perf', 'pulsemetry-perf-logs', 'pulsemetry-perf-runner']);
    expect(find(documents, 'StorageClass', 'pulsemetry-perf-gp3').parameters).toMatchObject({ iops: '3000', throughput: '125', tagSpecification_1: `pulsemetry:perf-environment=${ENVIRONMENT_ID}` });
    for (const pool of ['gateway', 'pipeline', 'clickhouse', 'generator', 'observability', 'system']) {
      const nodePool = find(documents, 'NodePool', `perf-${pool}`).spec;
      expect(nodePool.replicas).toBe(1);
      expect(nodePool.limits).toEqual({ nodes: 2 });
      expect(nodePool.disruption).toEqual({ consolidateAfter: 'Never', budgets: [{ nodes: '0' }] });
      expect(nodePool.template.metadata.labels['pulsemetry.io/workload']).toBe(pool);
      expect(nodePool.template.spec.taints).toEqual(pool === 'system' ? undefined : [{ key: 'workload', value: pool, effect: 'NoSchedule' }]);
      const requirement = (key: string) => nodePool.template.spec.requirements.find((item: any) => item.key === key).values;
      expect([requirement('karpenter.sh/capacity-type'), requirement('kubernetes.io/arch'), requirement('topology.kubernetes.io/zone')])
        .toEqual([['on-demand'], ['arm64'], ['ap-northeast-2a']]);
      const nodeClass = find(documents, 'NodeClass', `perf-${pool}`).spec;
      expect(nodeClass.securityGroupSelectorTerms).toHaveLength(2);
      expect(nodeClass.advancedNetworking).toEqual({ associatePublicIPAddress: false });
    }
  });


  test('실측 EKS NodePool schema는 고정 7 pool과 필수 consolidateAfter 누락을 검증한다', () => {
    const provenance = JSON.parse(readFileSync(join(root, 'helm/perf/platform/schemas/SOURCE.json'), 'utf8'));
    expect(createHash('sha256').update(readFileSync(join(root, 'helm/perf/platform/schemas', provenance.file))).digest('hex')).toBe(provenance.sha256);
    const base = load(readFileSync(generated('platform.yaml'), 'utf8')) as any;
    base.pools.kafka = { ...base.pools.gateway, nodes: 3 };
    const input = join(directory, 'strimzi-platform.yaml'); writeFileSync(input, dump(base));
    const pools = render('perf-platform', 'helm/perf/platform', 'default', [input]).filter(d => d.kind === 'NodePool');
    expect(pools).toHaveLength(7);
    expect(pools.reduce((sum: number, pool: any) => sum + pool.spec.replicas, 0)).toBe(9);
    const file = join(directory, 'nodepools.yaml');
    const check = (documents: any[]) => {
      writeFileSync(file, documents.map(document => dump(document)).join('---\n'));
      return run(kubeconform, ['-strict', '-summary', '-schema-location', 'helm/perf/platform/schemas/nodepool_karpenter.sh_v1.json', file]);
    };
    const valid = check(pools);
    expect([valid.status, valid.stderr, valid.stdout]).toEqual([0, '', expect.stringContaining('Valid: 7, Invalid: 0, Errors: 0, Skipped: 0')]);
    const missing = JSON.parse(JSON.stringify(pools[0]));
    delete missing.spec.disruption.consolidateAfter;
    const invalid = check([missing]);
    expect(invalid.status).not.toBe(0);
    expect(invalid.stdout).toContain('consolidateAfter');
    expect(invalid.stdout).toContain('Invalid: 1');
  });

  test('runtime: app·runner SPC와 active kid 하나의 공개키', () => {
    const documents = render('perf-runtime', 'helm/perf/runtime', 'pulsemetry-perf', [generated('runtime.yaml')]);
    schema(documents);
    expect(documents.map(d => `${d.metadata.namespace}/${d.metadata.name}`).sort()).toEqual([
      'pulsemetry-perf-runner/perf-prepare', 'pulsemetry-perf-runner/perf-prepare-jwt', 'pulsemetry-perf-runner/perf-seed',
      'pulsemetry-perf/enrollment-api-runtime', 'pulsemetry-perf/enrollment-api-telemetry-jwt', 'pulsemetry-perf/telemetry-gateway-telemetry-jwt',
      'pulsemetry-perf/telemetry-ingest-runtime', 'pulsemetry-perf/telemetry-ingest-telemetry-jwt',
    ]);
    const objects = (name: string) => find(documents, 'SecretProviderClass', name).spec.parameters.objects;
    expect(objects('perf-prepare-jwt')).toContain('objectAlias: telemetry-jwt-public.pem');
    expect(objects('perf-prepare-jwt')).not.toContain('private-key');
    expect(objects('perf-prepare')).toContain('/rds/verify-');
    expect(objects('perf-seed')).toContain('/rds/seed-');
    expect(objects('telemetry-gateway-telemetry-jwt')).not.toContain('private.pem');
    rejects('helm/perf/runtime', 'pulsemetry-dev', [generated('runtime.yaml')]);
  });

  test('job-access: SA 6개, seed·prepare만 token·RBAC, scale은 enrollment-api만', () => {
    const documents = render('perf-job-access', 'helm/perf/job-access', 'pulsemetry-perf', []);
    schema(documents);
    const accounts = documents.filter(d => d.kind === 'ServiceAccount');
    expect(accounts.map(d => [d.metadata.name, d.automountServiceAccountToken]).sort()).toEqual([
      ['k6-runner', false], ['perf-prepare', true], ['perf-seed', true], ['perf-sentinel', false], ['perf-smoke', false], ['perf-verify', false],
    ]);
    const scale = documents.find(d => d.kind === 'Role' && d.metadata.namespace === 'pulsemetry-perf').rules.find((rule: any) => rule.resources[0] === 'deployments/scale');
    expect(scale).toEqual({ apiGroups: ['apps'], resources: ['deployments/scale'], resourceNames: ['enrollment-api'], verbs: ['get', 'patch'] });
    expect(documents.filter(d => d.kind === 'RoleBinding').map(d => d.subjects[0].name).sort()).toEqual(['perf-prepare', 'perf-prepare', 'perf-seed']);
    rejects('helm/perf/job-access', 'pulsemetry-perf-runner', []);
  });

  test('공유 spring-app chart의 perf 렌더: ClusterIP·perf NodePool·toleration·TGB 없음', () => {
    for (const [name, pool, port] of [['telemetry-gateway', 'gateway', 8082], ['telemetry-ingest', 'pipeline', 4316], ['enrollment-api', 'system', 8080]] as const) {
      const documents = render(name, 'helm/dev/workloads/spring-app', 'pulsemetry-perf', workload(name));
      schema(documents);
      expect(documents.some(d => ['TargetGroupBinding', 'Ingress', 'Secret'].includes(d.kind))).toBe(false);
      const service = find(documents, 'Service', name).spec;
      expect([service.type, service.ports[0].port, service.ports[0].nodePort]).toEqual(['ClusterIP', port, undefined]);
      const pod = find(documents, 'Deployment', name).spec.template.spec;
      expect(pod.nodeSelector).toEqual({ 'kubernetes.io/arch': 'arm64', 'karpenter.sh/nodepool': `perf-${pool}` });
      expect(pod.tolerations).toEqual(pool === 'system' ? undefined : [{ key: 'workload', operator: 'Equal', value: pool, effect: 'NoSchedule' }]);
      expect(pod.containers[0].resources.limits.cpu).toBeUndefined();
    }
    const enrollment = render('enrollment-api', 'helm/dev/workloads/spring-app', 'pulsemetry-perf', workload('enrollment-api'));
    const env = find(enrollment, 'Deployment', 'enrollment-api').spec.template.spec.containers[0].env;
    const spring = JSON.parse(env.find((item: any) => item.name === 'SPRING_APPLICATION_JSON').value);
    expect(spring.pulsemetry['telemetry-jwt']).toMatchObject({ 'active-kid': KID, 'issue-enabled': true });
    expect(env.some((item: any) => /USER_AUTH|OIDC/.test(item.name))).toBe(false);
    expect(render('enrollment-api', 'helm/dev/workloads/spring-app', 'pulsemetry-perf', workload('enrollment-api'), ['replicaCount=0'])
      .find(d => d.kind === 'Deployment').spec.replicas).toBe(0);
  });

  test('공유 spring-app chart는 perf 경계 밖 입력을 거부한다', () => {
    const chart = 'helm/dev/workloads/spring-app';
    rejects(chart, 'pulsemetry-dev', workload('telemetry-gateway'));
    rejects(chart, 'pulsemetry-perf', workload('telemetry-gateway'), ['replicaCount=0']);
    rejects(chart, 'pulsemetry-perf', workload('telemetry-gateway'), ['service.type=NodePort']);
    rejects(chart, 'pulsemetry-perf', workload('telemetry-gateway'), ['nodePort=30082']);
    rejects(chart, 'pulsemetry-perf', workload('telemetry-gateway'), ['placement.nodePool=perf-system']);
    rejects(chart, 'pulsemetry-perf', workload('telemetry-ingest'), ['ingestMode=dual']);
    rejects(chart, 'pulsemetry-perf', workload('telemetry-ingest'), ['kafka.topic=pulsemetry-dev-telemetry-ingress-main']);
    rejects(chart, 'pulsemetry-perf', workload('telemetry-ingest'), ['kafka.iamSessionName=pulsemetry-dev-telemetry-ingest']);
    rejects(chart, 'pulsemetry-perf', workload('enrollment-api'), ['jwt.enabled=true']);
    rejects(chart, 'pulsemetry-perf', [...workload('enrollment-api'), join(root, 'helm/dev/workloads/enrollment-api.yaml')], ['workload=dashboard-api']);
  });

  test('공유 ClickHouse·Kafka 관리 chart의 perf 렌더', () => {
    const clickhouse = render('clickhouse', 'helm/dev/workloads/clickhouse', 'pulsemetry-perf', workload('clickhouse'));
    schema(clickhouse);
    const statefulset = find(clickhouse, 'StatefulSet', 'clickhouse').spec;
    const pod = statefulset.template.spec;
    expect(pod.containers[0].image).toBe(`docker.io/clickhouse/clickhouse-server@${DIGEST('4')}`);
    expect(pod.containers[0].env).toContainEqual({ name: 'CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT', value: '1' });
    expect(pod.nodeSelector).toEqual({ 'kubernetes.io/arch': 'arm64', 'karpenter.sh/nodepool': 'perf-clickhouse', 'topology.kubernetes.io/zone': 'ap-northeast-2a' });
    expect(statefulset.volumeClaimTemplates[0].spec).toMatchObject({ storageClassName: 'pulsemetry-perf-gp3', resources: { requests: { storage: '100Gi' } } });
    rejects('helm/dev/workloads/clickhouse', 'pulsemetry-perf', [join(root, 'helm/perf/workloads/clickhouse.yaml')]);
    const admin = render('telemetry-kafka-admin', 'helm/dev/workloads/telemetry-kafka-admin', 'pulsemetry-perf', workload('telemetry-kafka-admin'));
    schema(admin);
    const job = admin.find(d => d.kind === 'Job');
    expect(job.spec.template.spec.nodeSelector).toEqual({ 'kubernetes.io/arch': 'arm64', 'karpenter.sh/nodepool': 'perf-system' });
    expect(job.spec.template.spec.containers[0].env).toContainEqual({ name: 'PULSEMETRY_KAFKA_TOPIC', value: 'pulsemetry-perf-telemetry-ingress' });
    expect(find(admin, 'ConfigMap', 'telemetry-kafka-admin-client').data['client.properties']).toContain('awsRoleSessionName="pulsemetry-perf-telemetry-kafka-admin"');
    rejects('helm/dev/workloads/telemetry-kafka-admin', 'pulsemetry-perf', workload('telemetry-kafka-admin'), ['topic=pulsemetry-dev-telemetry-ingress-main']);
  });

  const observabilityArchive = join(root, 'helm/observability/pulsemetry-observability/charts/kube-prometheus-stack-81.2.2.tgz');
  (existsSync(observabilityArchive) ? test : test.skip)('관측 chart를 perf values로 재사용한다', () => {
    const documents = render('observability', 'helm/observability/pulsemetry-observability', 'pulsemetry-observability',
      [join(root, 'helm/observability/values-perf.yaml'), generated('observability.yaml')]);
    const prometheus = documents.find(d => d.kind === 'Prometheus').spec;
    expect([prometheus.retention, prometheus.retentionSize, prometheus.enableRemoteWriteReceiver]).toEqual(['7d', '20GB', true]);
    expect(find(documents, 'Service', 'pulsemetry-monitoring-prometheus').spec.ports.some((port: any) => port.port === 9090)).toBe(true);
    expect(documents.some(d => d.kind === 'Service' && d.spec.type && d.spec.type !== 'ClusterIP')).toBe(false);
    const monitors = documents.filter(d => d.kind === 'ServiceMonitor' && d.spec.namespaceSelector?.matchNames);
    expect(monitors.some(d => d.spec.namespaceSelector.matchNames.includes('pulsemetry-perf'))).toBe(true);
  });

  test('Job template: 여섯 Job이 계약 이름·명령·env·마운트·배치를 쓴다', () => {
    const chart = 'helm/perf/jobs';
    const ns = 'pulsemetry-perf-runner';
    const rendered: Record<string, any> = {};
    for (const job of ['prepare', 'smoke', 'sentinel', 'runner', 'verify']) {
      const documents = render(job, chart, ns, [generated('jobs.yaml'), jobValues()], [`job=${job}`]);
      schema(documents);
      expect(documents).toHaveLength(1);
      rendered[job] = documents[0];
    }
    const seed = jobValues({ run: undefined, jobs: undefined, deadlines: undefined, runner: undefined, tools: undefined, rawArchiveUri: undefined });
    const seedValues = JSON.parse(readFileSync(seed, 'utf8'));
    seedValues.evidenceUri = seedValues.evidenceUri.replace(/runs\/.*$/, 'runs/seed/');
    writeFileSync(seed, JSON.stringify(seedValues));
    rendered.seed = render('seed', chart, ns, [generated('jobs.yaml'), seed], ['job=seed'])[0];
    expect(Object.fromEntries(Object.entries(rendered).map(([job, document]) => [job, document.metadata.name]))).toEqual({
      seed: 'perf-seed', prepare: 'prepare-m1-smoke-01', smoke: 'smoke-m1-smoke-01', sentinel: 'sentinel-m1-smoke-01', runner: 'k6-m1-smoke-01', verify: 'verify-m1-smoke-01',
    });
    for (const [job, document] of Object.entries(rendered)) {
      const pod = document.spec.template.spec;
      const container = pod.containers[0];
      const env = Object.fromEntries(container.env.map((item: any) => [item.name, item.value]));
      expect([job, document.spec.backoffLimit, typeof document.spec.activeDeadlineSeconds]).toEqual([job, 0, 'number']);
      expect([job, pod.securityContext.runAsNonRoot, container.securityContext.allowPrivilegeEscalation]).toEqual([job, true, false]);
      expect([job, pod.automountServiceAccountToken]).toEqual([job, ['seed', 'prepare'].includes(job)]);
      expect([job, pod.nodeSelector['karpenter.sh/nodepool']]).toEqual([job, job === 'runner' ? 'perf-generator' : 'perf-system']);
      expect([job, env.EVIDENCE_URI.startsWith('s3://perfevidencestack-evidencebucket-fixture/runs/')]).toEqual([job, true]);
      // 비밀은 env 값으로 넣지 않는다. seed·prepare는 CSI 파일에서 셸로 읽는다.
      for (const name of ['PGPASSWORD', 'SYNTHETIC_SEED_SECRET', 'PGUSER']) expect([job, name, env[name]]).toEqual([job, name, undefined]);
      expect(container.image).toBe(job === 'runner' ? `${REGISTRY}/perf-k6-runner@${DIGEST('5')}` : `${REGISTRY}/perf-tools@${DIGEST('6')}`);
    }
    const env = (job: string) => Object.fromEntries(rendered[job].spec.template.spec.containers[0].env.map((item: any) => [item.name, item.value]));
    const mounts = (job: string) => rendered[job].spec.template.spec.containers[0].volumeMounts.map((item: any) => item.mountPath).sort();
    expect(rendered.runner.spec.template.spec.containers[0].args).toEqual(['run-job']);
    expect(rendered.verify.spec.template.spec.containers[0].command).toEqual(['/opt/perf/bin/perf']);
    expect(rendered.prepare.spec.template.spec.containers[0].args[0]).toContain('exec /opt/perf/bin/perf prepare');
    expect(env('runner')).toMatchObject({ GATEWAY_ENDPOINT: 'http://telemetry-gateway.pulsemetry-perf.svc.cluster.local:8082', TESTID: '0002-perf-smoke/m1-smoke-01', K6_REST_ADDRESS: '127.0.0.1:6565' });
    expect(rendered.runner.spec.template.spec.terminationGracePeriodSeconds).toBe(135);
    expect(rendered.runner.spec.template.spec.volumes.find((v: any) => v.name === 'out').emptyDir).toEqual({ sizeLimit: '2930Mi' });
    expect(rendered.runner.spec.template.spec.volumes.find((v: any) => v.name === 'bundle').secret.defaultMode).toBe(0o400);
    expect(mounts('runner')).toEqual(['/identities', '/inputs', '/out', '/secret']);
    expect(mounts('smoke')).toEqual(['/identities', '/secret']);
    expect(mounts('prepare')).toEqual(['/identities', '/keys', '/mnt/secrets']);
    expect(mounts('seed')).toEqual(['/config', '/mnt/secrets']);
    expect(env('prepare')).toMatchObject({ JWT_KID: KID, JWT_PUBLIC_KEY: '/keys/telemetry-jwt-public.pem', BUNDLE_NAMESPACE: 'pulsemetry-perf-runner', BUNDLE_SECRET: 'run-m1-smoke-01-bundle', ENROLLMENT_DEPLOYMENT: 'enrollment-api', PGSSLMODE: 'require' });
    expect(env('seed')).toMatchObject({ IDENTITIES_NAMESPACE: 'pulsemetry-perf-runner', IDENTITIES_CONFIGMAP: 'perf-identities', SEED_CONFIG: '/config/seed.json' });
    expect(env('sentinel').SENTINEL_DEADLINE_SECONDS).toBe('2280');
    expect(env('verify')).toMatchObject({ RAW_ARCHIVE_URI: 's3://perfdatastack-perfrawsignalbucket-fixture/perf/', ARCHIVE_SAMPLE: '20' });
    expect(env('verify').KAFKA_LAG_QUERY).toBeUndefined();
    expect(env('verify')).toMatchObject({ MSK_CLUSTER_NAME: 'soma-376-perf-telemetry', KAFKA_CONSUMER_GROUP: 'pulsemetry-perf-telemetry-ingest', KAFKA_TOPIC: 'pulsemetry-perf-telemetry-ingress', AWS_REGION: 'ap-northeast-2' });
    expect(env('smoke')).toMatchObject({ CLICKHOUSE_URL: 'http://clickhouse.pulsemetry-perf.svc.cluster.local:8123', CLOCK_SKEW_BOUND_MS: '1000' });
  });

  test('run values 하나를 모든 run Job에 쓰고 이전 run 경로는 prepare만 env로 받는다', () => {
    const previous = 's3://perfevidencestack-evidencebucket-fixture/runs/0002-perf-smoke/m1-smoke-00/';
    const shared = jobValues({ previousEvidenceUri: previous });
    for (const job of ['prepare', 'smoke', 'sentinel', 'runner', 'verify']) {
      const document = render(job, 'helm/perf/jobs', 'pulsemetry-perf-runner', [generated('jobs.yaml'), shared], [`job=${job}`])[0];
      const env = Object.fromEntries(document.spec.template.spec.containers[0].env.map((item: any) => [item.name, item.value]));
      expect([job, env.PREVIOUS_EVIDENCE_URI]).toEqual([job, job === 'prepare' ? previous : undefined]);
    }
  });

  test('Job template은 이 환경과 어긋난 job values를 거부한다', () => {
    const chart = 'helm/perf/jobs';
    const ns = 'pulsemetry-perf-runner';
    const base = generated('jobs.yaml');
    const cases: [string, Record<string, unknown>][] = [
      ['runner', { evidenceUri: 's3://other-bucket/runs/0002-perf-smoke/m1-smoke-01/' }],
      ['runner', { images: { k6Runner: `${REGISTRY}/perf-k6-runner:latest`, perfTools: `${REGISTRY}/perf-tools@${DIGEST('6')}` } }],
      ['runner', { images: { k6Runner: `docker.io/grafana/k6@${DIGEST('5')}`, perfTools: `${REGISTRY}/perf-tools@${DIGEST('6')}` } }],
      ['runner', { runner: { outputSizeLimit: '1024Mi', journalBytesEstimate: 1_000_000_000 } }],
      ['prepare', { enrollment: { deployment: 'enrollment-api', sessionMethod: 'application-name', sessionValue: 'x', jwtKid: 'other-kid' } }],
      ['prepare', { enrollment: { deployment: 'telemetry-gateway', sessionMethod: 'application-name', sessionValue: 'x', jwtKid: KID } }],
      ['verify', { rawArchiveUri: 's3://perfdatastack-perfrawsignalbucket-fixture/' }],
      ['sentinel', { endpoints: { gateway: 'http://x:8082', enrollment: 'http://x:8080', clickhouse: 'http://x:8123', prometheus: 'http://x:9090', remoteWrite: 'http://x:9090/api/v1/write' } }],
      ['runner', { environmentId: 'perf-other' }],
      ['runner', { unknownKey: true }],
      ['prepare', { previousEvidenceUri: 's3://perfevidencestack-evidencebucket-fixture/elsewhere/' }],
      ['runner', { jobs: { runner: 'k6-other' } }],
    ];
    for (const [job, overrides] of cases) rejects(chart, ns, [base, jobValues(overrides)], [`job=${job}`]);
    rejects(chart, 'pulsemetry-perf', [base, jobValues()], ['job=runner']);
    rejects(chart, ns, [base, jobValues()], ['job=dashboard']);
  });
});
