import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { load, loadAll, dump } from 'js-yaml';
import { Template } from 'aws-cdk-lib/assertions';
import { buildPerfApp } from '../helpers';
import { collectPerfOutputs, parsePerfRuntimeInput, parseInputYaml, sha256 } from '../../lib/perf/deploy-inputs';
import { loadPerfProfile, parsePerfProfile } from '../../lib/perf/profile';
import { PERF_STRIMZI, STRIMZI_CLIENT_ROLES, parsePerfStrimziMetadata, strimziUser, strimziState } from '../../lib/perf/strimzi';
import { buildProvisional, buildResolved, kubeItems, checkResolved } from '../../lib/perf/results';
import { generatePerfFoundationValues, generatePerfValues } from '../../lib/perf/values';
import { main as valuesCli } from '../../scripts/perf-values';
import { environmentSchemas } from '../../lib/perf/contract/schema-subset';
import { describeStacks, perfRequest, kubernetesState, RUNTIME_VALUES, ENVIRONMENT_ID } from './perf-fixtures';

const root = resolve(__dirname, '../..');
const profilePath = 'profiles/perf/strimzi-fixed-v1.json';
const profile = loadPerfProfile(profilePath, root);
const metadataDocument = () => ({ items: [PERF_STRIMZI.ca, ...STRIMZI_CLIENT_ROLES.map(strimziUser)].map((name, i) => ({ metadata: { name, namespace: 'pulsemetry-perf', uid: `uid-${i}`, resourceVersion: String(i + 1) } })) });
const metadata = () => parsePerfStrimziMetadata(metadataDocument());
const requestBytes = perfRequest(undefined, profilePath);
const request = JSON.parse(requestBytes.toString());
const outputs = collectPerfOutputs([describeStacks({}, { perfProfile: profilePath })]);
const generated = () => generatePerfValues({ request, outputs, profile, runtime: parsePerfRuntimeInput(parseInputYaml(RUNTIME_VALUES, 'runtime')), strimziMetadata: metadata() });

test('Strimzi 프로필은 Kafka 전용 3대와 generator 전용 1대를 분리하고 MSK 혼합을 거부한다', () => {
  expect(profile.profile.node_pools.kafka).toMatchObject({ nodes: 3, instance_type: 'm7g.large', dedicated: true });
  expect(profile.profile.node_pools.generator.nodes).toBe(1);
  const bad = JSON.parse(readFileSync(resolve(root, profilePath), 'utf8'));
  bad.msk = {};
  expect(() => parsePerfProfile(bad)).toThrow();
  delete bad.msk; bad.node_pools.kafka.nodes = 2;
  expect(() => parsePerfProfile(bad)).toThrow();
});

test('Strimzi 스택은 MSK·Kafka IAM·MSK subnet 없이 별도 EKS/RDS/VPC를 만든다', () => {
  const built = buildPerfApp({ perfProfile: profilePath });
  Template.fromStack(built.data).resourceCountIs('AWS::MSK::Cluster', 0);
  Template.fromStack(built.data).resourceCountIs('AWS::RDS::DBInstance', 1);
  Template.fromStack(built.eks).resourceCountIs('AWS::EKS::Cluster', 1);
  const templates = [built.network, built.data, built.eks].map(stack => Template.fromStack(stack).toJSON());
  expect(JSON.stringify(templates)).not.toMatch(/kafka-cluster:|kafka:GetBootstrapBrokers|MskSecurityGroup|MskBrokerLog/);
  expect(Template.fromStack(built.network).findOutputs('PoolKafkaSecurityGroupId')).toBeDefined();
});

test('Secret metadata는 원문·중복·다른 namespace·누락을 거부하고 revision 변경을 반영한다', () => {
  for (const mutate of [
    (doc: any) => { doc.items[0].data = { key: 'not-accepted' }; },
    (doc: any) => { doc.items.push(doc.items[0]); },
    (doc: any) => { doc.items[0].metadata.namespace = 'pulsemetry-dev'; },
    (doc: any) => { doc.items.pop(); },
  ]) { const doc = metadataDocument(); mutate(doc); expect(() => parsePerfStrimziMetadata(doc)).toThrow(); }
  const doc = metadataDocument(); doc.items[1].metadata.resourceVersion = '99';
  const changed = parsePerfStrimziMetadata(doc);
  expect(changed.revision).not.toBe(metadata().revision);
  expect(changed.clients.gateway.tlsRevision).not.toBe(metadata().clients.gateway.tlsRevision);
  expect(changed.clients.ingest.tlsRevision).toBe(metadata().clients.ingest.tlsRevision);
});

test('v3 values에는 mTLS 참조와 provider가 있고 MSK 입력을 섞지 않는다', () => {
  const values = generated() as any;
  expect(values['jobs.yaml'].infra).toMatchObject({ contractVersion: 3, kafka: { provider: 'strimzi', namespace: 'pulsemetry-perf', partitions: 6 } });
  expect(values['jobs.yaml'].infra.msk).toBeUndefined();
  expect(values['telemetry-gateway.yaml'].kafka).toMatchObject({ security: 'mtls', ...metadata().clients.gateway });
  expect(values['platform.yaml'].pools.kafka.nodes).toBe(3);
  expect(() => generatePerfValues({ request, outputs, profile, runtime: parsePerfRuntimeInput(parseInputYaml(RUNTIME_VALUES, 'runtime')), strimziMetadata: metadata(), bootstrapServers: 'b-1:9098' })).toThrow();
});

test('최초 foundation은 실제 Secret metadata 없이 platform·Kafka만 만들고 full 결과와 같다', () => {
  const initial = generatePerfFoundationValues({ request, outputs, profile });
  expect(Object.keys(initial).sort()).toEqual(['kafka-strimzi.yaml', 'platform.yaml']);
  const full = generated();
  for (const name of Object.keys(initial)) expect(initial[name]).toEqual(full[name]);
  expect(() => generatePerfValues({ request, outputs, profile, runtime: parsePerfRuntimeInput(parseInputYaml(RUNTIME_VALUES, 'runtime')) })).toThrow(/metadata/);
  const changed = structuredClone(request); changed.environment.environment_id = 'perf-other';
  expect(() => generatePerfFoundationValues({ request: changed, outputs, profile })).toThrow(/environment_id/);
});

test('foundation CLI는 runtime 혼합·알 수 없는 단계·MSK·이전 출력 폴더를 거부한다', () => {
  const directory = mkdtempSync(join(tmpdir(), 'perf-foundation-'));
  const write = (name: string, value: string) => { const file = join(directory, name); writeFileSync(file, value); return file; };
  const args = ['--request', write('request.json', requestBytes.toString()), '--outputs', write('stacks.json', JSON.stringify(describeStacks({}, { perfProfile: profilePath }))), '--output-dir', join(directory, 'foundation')];
  const quiet = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    expect(() => valuesCli([...args, '--phase', 'other'])).toThrow(/--phase/);
    expect(() => valuesCli([...args, '--phase', 'foundation', '--strimzi-secrets', 'unused.json'])).toThrow(/foundation/);
    expect(valuesCli([...args, '--phase', 'foundation']).sort()).toEqual(['kafka-strimzi.yaml', 'platform.yaml']);
    expect(readdirSync(join(directory, 'foundation')).sort()).toEqual(['kafka-strimzi.yaml', 'platform.yaml']);
    expect(() => valuesCli([...args, '--phase', 'foundation'])).toThrow(/빈 디렉터리/);
    write('request.json', perfRequest().toString()); write('stacks.json', JSON.stringify(describeStacks()));
    expect(() => valuesCli([...args, '--phase', 'foundation'])).toThrow(/Strimzi/);
  } finally { quiet.mockRestore(); rmSync(directory, { recursive: true, force: true }); }
});

const helm = process.env.HELM_BIN;
(helm ? describe : describe.skip)('perf Strimzi Helm과 실제 상태 resolver', () => {
  function render(chart: string, values: unknown, namespace = 'pulsemetry-perf') {
    const result = spawnSync(helm!, ['template', 'perf-test', chart, '--namespace', namespace, '--kube-version', '1.36.0', '-f', '-'], { cwd: root, input: dump(values), encoding: 'utf8' });
    expect([result.status, result.stderr]).toEqual([0, '']);
    return loadAll(result.stdout).filter(Boolean) as any[];
  }
  function state() {
    const documents = render('helm/dev/kafka', (generated() as any)['kafka-strimzi.yaml']);
    for (const doc of documents) {
      doc.metadata.generation = 1;
      doc.status = { observedGeneration: 1, conditions: [{ type: 'Ready', status: 'True' }] };
      if (doc.kind === 'Kafka') doc.status.listeners = [{ name: 'tls', bootstrapServers: PERF_STRIMZI.bootstrap }];
      if (doc.kind === 'KafkaNodePool') doc.status.nodeIds = [0, 1, 2];
    }
    const items = kubernetesState().items;
    items.push(...documents);
    const pool = structuredClone(items.find(i => i.kind === 'NodePool' && i.metadata.name === 'perf-gateway'));
    pool.metadata.name = 'perf-kafka'; pool.spec.replicas = 3; pool.spec.template.spec.nodeClassRef.name = 'perf-kafka'; pool.spec.template.spec.taints[0].value = 'kafka'; items.push(pool);
    for (let n = 0; n < 3; n++) {
      const node = structuredClone(items.find(i => i.kind === 'Node' && i.metadata.name === 'node-gateway'));
      node.metadata.name = `node-kafka-${n}`; node.metadata.labels['karpenter.sh/nodepool'] = 'perf-kafka'; items.push(node);
      items.push({ kind: 'PersistentVolumeClaim', metadata: { name: `data-0-${PERF_STRIMZI.cluster}-dual-role-${n}`, namespace: 'pulsemetry-perf' }, spec: { storageClassName: PERF_STRIMZI.storageClass, volumeName: `pv-kafka-${n}` }, status: { phase: 'Bound', capacity: { storage: '100Gi' } } });
      items.push({ kind: 'PersistentVolume', metadata: { name: `pv-kafka-${n}` }, spec: { csi: { volumeHandle: `vol-0123456789abcdef${n}` } } });
    }
    return items;
  }
  test('공유 chart는 1 topic·4 TLS User·최소 ACL과 perf 고정 placement로 렌더된다', () => {
    const values = generated() as any;
    const documents = render('helm/dev/kafka', values['kafka-strimzi.yaml']);
    expect(documents.filter(d => d.kind === 'KafkaUser')).toHaveLength(4);
    expect(documents.filter(d => d.kind === 'KafkaTopic')).toHaveLength(1);
    for (const app of ['telemetry-gateway', 'telemetry-ingest', 'enrollment-api']) {
      const docs = render('helm/dev/workloads/spring-app', { ...(load(readFileSync(resolve(root, `helm/perf/workloads/${app}.yaml`), 'utf8')) as object), ...values[`${app}.yaml`] });
      expect(docs.find(d => d.kind === 'Deployment').metadata.namespace).toBe('pulsemetry-perf');
    }
    render('helm/dev/workloads/telemetry-kafka-admin', { ...(load(readFileSync(resolve(root, 'helm/perf/workloads/telemetry-kafka-admin.yaml'), 'utf8')) as object), ...values['telemetry-kafka-admin.yaml'] });
    render('helm/dev/workloads/clickhouse', { ...(load(readFileSync(resolve(root, 'helm/perf/workloads/clickhouse.yaml'), 'utf8')) as object), ...values['clickhouse.yaml'] });
    render('helm/perf/platform', values['platform.yaml'], 'default');
    const observations = render('helm/observability/pulsemetry-observability', values['observability.yaml'], 'pulsemetry-observability');
    expect(observations.find(d => d.kind === 'PodMonitor' && d.metadata.name === 'strimzi-jmx').spec.namespaceSelector.matchNames).toEqual(['pulsemetry-perf']);
  });
  test('실제 CR·PVC 상태와 metadata가 일치하면 strict v3 bundle을 통과한다', () => {
    const provisional = buildProvisional({ request, requestSha256: sha256(requestBytes), profile, outputs, deploymentId: `${ENVIRONMENT_ID}-d1`, createdAt: '2026-11-01T00:00:00Z' });
    const provisionalBytes = Buffer.from(JSON.stringify(provisional));
    const resolved = buildResolved({ request, requestSha256: sha256(requestBytes), profile, outputs, provisional, provisionalSha256: sha256(provisionalBytes),
      kubernetes: kubeItems([{ items: state() }]), strimziMetadata: metadata(), createdAt: '2026-11-01T01:00:00Z', readiness: {
        checked_at: '2026-11-01T00:59:00Z', stages: { kafka_transport: 'pass', secret_supply: 'pass', auth: 'pass', observability: 'pass', storage: 'pass' },
        smoke_artifact_ids: ['smoke'], artifacts: [{ id: 'smoke', role: 'smoke', uri: 's3://example/runs/smoke.json', sha256: 'a'.repeat(64), bytes: 1, media_type: 'application/json', retained_until: '2026-11-02T00:00:00Z' }], clickhouse_version: '24.8.14.39',
      } });
    expect(resolved.errors).toEqual([]);
    expect(resolved.status).toBe('ready');
    expect(checkResolved(environmentSchemas(3), { request: requestBytes, provisional: provisionalBytes, resolved: Buffer.from(JSON.stringify(resolved)) })).toEqual([]);
  });
  test.each(['PVC', 'ACL', 'generation', 'bootstrap'])('%s 관측이 다르면 오류를 반환한다', reason => {
    const items = state();
    if (reason === 'PVC') items.find(i => i.kind === 'PersistentVolumeClaim' && i.metadata.name.includes('dual-role')).status.phase = 'Pending';
    if (reason === 'ACL') items.find(i => i.kind === 'KafkaUser').spec.authorization.acls[0].operations = ['All'];
    if (reason === 'generation') items.find(i => i.kind === 'Kafka').status.observedGeneration = 0;
    if (reason === 'bootstrap') items.find(i => i.kind === 'Kafka').status.listeners[0].bootstrapServers = 'wrong:9093';
    const errors: any[] = [];
    strimziState(kubeItems([{ items }]), profile, metadata(), ENVIRONMENT_ID, errors);
    expect(errors.length).toBeGreaterThan(0);
  });
});
