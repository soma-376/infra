import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkBundle } from '../../lib/perf/contract/bundle';
import { Schemas } from '../../lib/perf/contract/schema-subset';
import { PERF_CONTRACT_SCHEMAS } from '../../lib/perf/deploy-inputs';
import { main as provisional } from '../../scripts/perf-provisional';
import { main as resolve } from '../../scripts/perf-resolve';
import { main as inventory } from '../../scripts/perf-inventory';
import { ACCOUNT, DIGEST, ENVIRONMENT_ID, KID, MSK_NODES, REGISTRY, describeStacks, perfRequest, kubernetesState } from './perf-fixtures';

const schemas = new Schemas(PERF_CONTRACT_SCHEMAS);
let directory: string;
const path = (name: string) => join(directory, name);
const json = (name: string, value: unknown) => { writeFileSync(path(name), JSON.stringify(value, null, 2)); return path(name); };
const stacks = describeStacks();

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'perf-results-'));
  writeFileSync(path('request.json'), perfRequest());
  json('stacks.json', stacks);
  json('nodes.json', MSK_NODES);
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
const silence = () => jest.spyOn(console, 'log').mockImplementation(() => undefined);

describe('perf-provisional', () => {
  const args = (out = path('provisional.json'), stacksFile = path('stacks.json')) => [
    '--request', path('request.json'), '--stacks', stacksFile, '--deployment-id', `${ENVIRONMENT_ID}-d1`, '--created-at', '2026-11-01T01:00:00Z', '--out', out,
  ];

  test('완료된 스택에서 deployed_not_ready를 만들고 공유 schema·연결 규칙을 통과한다', () => {
    silence();
    expect(provisional(args())).toBe('deployed_not_ready');
    const document = JSON.parse(readFileSync(path('provisional.json'), 'utf8'));
    expect(schemas.validate('environment-provisional', document)).toEqual([]);
    expect(document.request_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(document.endpoints).toEqual({
      gateway: 'http://telemetry-gateway.pulsemetry-perf.svc.cluster.local:8082',
      enrollment: 'http://enrollment-api.pulsemetry-perf.svc.cluster.local:8080',
      clickhouse_http: 'http://clickhouse.pulsemetry-perf.svc.cluster.local:8123',
      prometheus_remote_write: 'http://pulsemetry-monitoring-prometheus.pulsemetry-observability.svc.cluster.local:9090/api/v1/write',
    });
    expect(document.lock).toEqual({ namespace: 'pulsemetry-perf-runner', configmap_name: 'perf-run-lock' });
    expect(document.aws.stacks.map((stack: any) => stack.name)).toEqual(['PerfEvidenceStack', 'PerfNetworkStack', 'PerfDataStack', 'PerfEksStack']);
    const retained = document.cleanup_inventory.filter((item: any) => item.retain);
    expect(retained.map((item: any) => item.resource_type)).toEqual(['AWS::S3::Bucket']);
    expect(document.cleanup_inventory.filter((item: any) => item.resource_type === 'AWS::CloudFormation::Stack')).toHaveLength(3);
  });

  test('이미 있는 결과 파일을 덮어쓰지 않는다', () => {
    silence();
    provisional(args());
    const before = readFileSync(path('provisional.json'));
    expect(() => provisional(args())).toThrow(/EEXIST/);
    expect(readFileSync(path('provisional.json'))).toEqual(before);
  });

  test('일부 스택이 실패하면 오류와 함께 partial을 남긴다', () => {
    silence();
    const file = json('partial.json', describeStacks({ PerfEksStack: 'CREATE_FAILED' }));
    expect(provisional(args(path('partial-provisional.json'), file))).toBe('partial');
    const document = JSON.parse(readFileSync(path('partial-provisional.json'), 'utf8'));
    expect(document.errors).toEqual([{ code: 'stack_not_complete', message: 'PerfEksStack 상태가 CREATE_FAILED다' }]);
    expect(schemas.validate('environment-provisional', document)).toEqual([]);
  });

  test('outputs-file만으로는 stack ARN이 없어 deployed_not_ready를 만들지 않는다', () => {
    silence();
    const outputsFile = json('outputs.json', Object.fromEntries(stacks.Stacks.map(stack => [stack.StackName, Object.fromEntries(stack.Outputs.map(o => [o.OutputKey, o.OutputValue]))])));
    expect(provisional(args(path('o.json'), outputsFile))).toBe('failed');
  });
});


const READINESS = {
  checked_at: '2026-11-01T01:55:00Z',
  stages: { iam_tls: 'pass', secret_supply: 'pass', auth: 'pass', observability: 'pass', storage: 'pass' },
  smoke_artifact_ids: ['smoke-readiness'],
  artifacts: [{ id: 'smoke-readiness', role: 'smoke', uri: 's3://perfevidencestack-evidencebucket-fixture/runs/0001-readiness/r1/smoke.json', sha256: 'a'.repeat(64), bytes: 2048, media_type: 'application/json', retained_until: '2027-01-30T00:00:00Z' }],
  clickhouse_version: '24.8.14.39',
};

describe('perf-resolve', () => {
  function prepare(kube = kubernetesState(), readiness: object = READINESS) {
    silence();
    provisional(['--request', path('request.json'), '--stacks', path('stacks.json'), '--deployment-id', `${ENVIRONMENT_ID}-d1`, '--created-at', '2026-11-01T01:00:00Z', '--out', path('provisional.json')]);
    json('kube.json', kube);
    json('readiness.json', readiness);
    return ['--request', path('request.json'), '--provisional', path('provisional.json'), '--stacks', path('stacks.json'), '--kubernetes', path('kube.json'),
      '--msk-nodes', path('nodes.json'), '--readiness', path('readiness.json'), '--created-at', '2026-11-01T02:00:00Z', '--out', path('resolved.json')];
  }

  test('실제 상태가 요청 용량과 같으면 ready를 만들고 request·provisional·resolved 연결 코드가 없다', () => {
    expect(resolve(prepare())).toBe('ready');
    const files = { request: readFileSync(path('request.json')), provisional: readFileSync(path('provisional.json')), resolved: readFileSync(path('resolved.json')) };
    expect(checkBundle(schemas, files)).toEqual([]);
    const document = JSON.parse(files.resolved.toString());
    expect(document.kubernetes.workloads['enrollment-api'].settings).toEqual({ 'telemetryJwt.activeKid': KID, 'telemetryJwt.issueEnabled': true });
    expect(document.datastores.rds.enrollment_session).toEqual({ method: 'application-name', value: 'pulsemetry-enrollment-api' });
    expect(document.datastores.evidence_bucket).toEqual({ arn: 'arn:aws:s3:::perfevidencestack-evidencebucket-fixture', prefix: 'runs/', retention_days: 90 });
    expect(document.datastores.raw_signal_bucket.prefix).toBe('perf/');
    expect(document.kafka).toMatchObject({ broker_count: 3, broker_instance_type: 'kafka.m7g.large', retention_ms: 259200000, bootstrap_port: 9098 });
    expect(document.kubernetes.node_pools.generator).toMatchObject({ taint: 'workload=generator:NoSchedule', disruption_budget_nodes: '0', nodes: 1 });
    expect(document.kubernetes.node_pools.system.taint).toBeNull();
    expect(document.cleanup_inventory).toContainEqual(expect.objectContaining({ resource_type: 'AWS::EC2::Volume', identifier: 'vol-0123456789abcdef0' }));
    expect(document.access.verifier_role_ref).toBe('PerfEksStack-VerifierRoleName-fixture');
  });

  test('readiness 단계가 pass가 아니면 failed로 남기고 종료 코드 3이다', () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const readiness = { ...READINESS, stages: { ...READINESS.stages, storage: 'fail' } };
    expect(resolve(prepare(kubernetesState(), readiness))).toBe('failed');
    expect(process.exitCode).toBe(3);
    process.exitCode = 0;
    const document = JSON.parse(readFileSync(path('resolved.json'), 'utf8'));
    expect(document.errors).toEqual([{ code: 'readiness_not_pass', message: 'readiness 단계가 pass가 아니다: storage' }]);
    expect(document.kubernetes).toBeUndefined();
    expect(schemas.validate('environment-resolved', document)).toEqual([]);
  });

  test('노드 수가 프로필과 다르면 ready로 만들지 않는다', () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const kube = kubernetesState(items => items.push({ ...items.find(i => i.metadata.name === 'node-gateway'), metadata: { name: 'node-gateway-2', labels: items.find(i => i.metadata.name === 'node-gateway').metadata.labels } }));
    expect(resolve(prepare(kube))).toBe('failed');
    process.exitCode = 0;
    expect(JSON.parse(readFileSync(path('resolved.json'), 'utf8')).errors[0].code).toBe('node_pool_size');
  });

  test('배포 이미지가 요청과 다르면 bundle 검사로 쓰지 않는다', () => {
    const kube = kubernetesState(items => { items.find(i => i.metadata.name === 'telemetry-gateway').spec.template.spec.containers[0].image = `${REGISTRY}/telemetry-gateway@${DIGEST('9')}`; });
    expect(() => resolve(prepare(kube))).toThrow(/image_mismatch:telemetry-gateway/);
    expect(existsSync(path('resolved.json'))).toBe(false);
  });
});

describe('perf-inventory', () => {
  const tagged = (resources: { arn: string; tags: Record<string, string> }[]) => json('tagged.json', {
    ResourceTagMappingList: resources.map(resource => ({ ResourceARN: resource.arn, Tags: Object.entries(resource.tags).map(([Key, Value]) => ({ Key, Value })) })),
  });
  const deleted = () => json('deleted.json', { Stacks: ['PerfNetworkStack', 'PerfDataStack', 'PerfEksStack'].map(name => ({ StackName: name, StackStatus: 'DELETE_COMPLETE' })) });

  test('evidence만 남고 소유 태그 자원·스택이 없으면 정리 완료다', () => {
    silence();
    tagged([{ arn: 'arn:aws:s3:::perfevidencestack-evidencebucket-fixture', tags: { 'pulsemetry:perf-evidence': 'shared' } }]);
    expect(inventory(['--environment-id', ENVIRONMENT_ID, '--tagged', path('tagged.json'), '--stacks', deleted()])).toBe(true);
  });

  test('남은 EBS 볼륨과 삭제 실패 스택을 잔존으로 보고한다', () => {
    silence();
    tagged([{ arn: `arn:aws:ec2:ap-northeast-2:${ACCOUNT}:volume/vol-0123456789abcdef0`, tags: { 'pulsemetry:perf-environment': ENVIRONMENT_ID } }]);
    const stacksFile = json('failed.json', { Stacks: [{ StackName: 'PerfDataStack', StackStatus: 'DELETE_FAILED', StackId: 'arn:aws:cloudformation:ap-northeast-2:111111111111:stack/PerfDataStack/x' }] });
    expect(inventory(['--environment-id', ENVIRONMENT_ID, '--tagged', path('tagged.json'), '--stacks', stacksFile])).toBe(false);
    expect(process.exitCode).toBe(3);
    process.exitCode = 0;
  });

  test('다른 환경 태그가 섞인 조회 결과는 거부한다', () => {
    tagged([{ arn: 'arn:aws:ec2:ap-northeast-2:111111111111:volume/vol-1', tags: { 'pulsemetry:perf-environment': 'perf-other' } }]);
    expect(() => inventory(['--environment-id', ENVIRONMENT_ID, '--tagged', path('tagged.json')])).toThrow(/다른 환경/);
  });
});
