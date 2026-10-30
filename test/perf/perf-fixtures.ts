import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildPerfApp, PERF_TEST_ENVIRONMENT_ID } from '../helpers';
import { loadPerfProfile } from '../../lib/perf/profile';

/**
 * perf 생성기·결과 파일 생산자 테스트의 합성 입력. 실제 합성 템플릿의 Output 키에서 describe-stacks 결과를 만든다.
 * 그래서 CDK output 이름이 바뀌면 생성기 테스트가 함께 깨진다. 값은 형식만 맞춘 가짜이며 AWS 배포 결과가 아니다.
 */
export const ACCOUNT = '111111111111';
export const ENVIRONMENT_ID = PERF_TEST_ENVIRONMENT_ID;
export const ROOT = resolve(__dirname, '../..');
export const COPY = join(ROOT, 'test/fixtures/perf-contract-v2');
export const DIGEST = (character: string) => `sha256:${character.repeat(64)}`;
export const REGISTRY = `${ACCOUNT}.dkr.ecr.ap-northeast-2.amazonaws.com/soma-376`;
export const KID = 'telemetry-2026.11';

const SECRET_NAMES: Record<string, string> = {
  DbSecretArn: 'rds/master', TokenHashSecretArn: 'enrollment/token-hash-secret', AdminApiTokenSecretArn: 'enrollment/admin-token',
  TelemetryJwtPrivateKeySecretArn: 'telemetry-jwt/private-key', TelemetryJwtPublicKeysSecretArn: 'telemetry-jwt/public-keys',
  SyntheticSeedSecretArn: 'synthetic/seed-secret', SeedDbSecretArn: 'rds/seed', VerifyDbSecretArn: 'rds/verify', GrafanaAdminSecretArn: 'grafana/admin',
};

function fixtureValue(key: string, index: number): string {
  if (SECRET_NAMES[key]) return `arn:aws:secretsmanager:ap-northeast-2:${ACCOUNT}:secret:soma-376/perf/${ENVIRONMENT_ID}/${SECRET_NAMES[key]}-AbC${String(index).padStart(3, '0')}`;
  if (key.endsWith('RoleArn')) return `arn:aws:iam::${ACCOUNT}:role/PerfEksStack-${key}-fixture`;
  if (key.endsWith('RoleName')) return `PerfEksStack-${key}-fixture`;
  if (key.endsWith('SecurityGroupId')) return `sg-0123456789abcd${index.toString(16).padStart(3, '0')}`;
  const fixed: Record<string, string> = {
    DbEndpoint: 'perfpostgres.abcdefghijkl.ap-northeast-2.rds.amazonaws.com',
    DbInstanceArn: `arn:aws:rds:ap-northeast-2:${ACCOUNT}:db:perfpostgres-fixture`,
    MskClusterArn: `arn:aws:kafka:ap-northeast-2:${ACCOUNT}:cluster/soma-376-perf-telemetry/0d5e7a10-1b2c-4d3e-8f90-a1b2c3d4e5f6-2`,
    RawSignalBucketName: 'perfdatastack-perfrawsignalbucket-fixture', RawSignalBucketArn: 'arn:aws:s3:::perfdatastack-perfrawsignalbucket-fixture',
    EvidenceBucketName: 'perfevidencestack-evidencebucket-fixture', EvidenceBucketArn: 'arn:aws:s3:::perfevidencestack-evidencebucket-fixture',
    EksClusterName: 'soma-376-perf-eks', EksClusterArn: `arn:aws:eks:ap-northeast-2:${ACCOUNT}:cluster/soma-376-perf-eks`,
    EksClusterEndpoint: 'https://ABCDEF.gr7.ap-northeast-2.eks.amazonaws.com', EksRegion: 'ap-northeast-2',
    EksVpcId: 'vpc-0123456789abcdef0', EksNodeSubnetIds: 'subnet-0123456789abcdef0', EksRelayInstanceId: 'i-0123456789abcdef0',
    DiagnosticsBucketName: 'perfeksstack-diagnostics-fixture',
    MskBrokerLogGroupName: '/aws/vendedlogs/msk/soma-376-perf-telemetry', EksControlPlaneLogGroupName: '/aws/eks/soma-376-perf-eks/cluster',
    ApplicationLogGroupName: '/eks/perf/application', ObservabilityLogGroupName: '/eks/perf/observability',
    KubernetesEventsLogGroupName: '/eks/perf/events', EksRelaySessionDocumentName: 'soma-376-perf-eks-api-tunnel',
  };
  if (fixed[key]) return fixed[key];
  throw new Error(`fixture 값이 없는 output: ${key}`);
}

/** 합성 템플릿의 Output으로 describe-stacks 형식을 만든다. literal 값은 그대로 쓴다. */
export function describeStacks(status: Record<string, string> = {}, context: Record<string, unknown> = {}) {
  const { app } = buildPerfApp(context);
  let index = 0;
  return {
    Stacks: app.synth().stacks.map((stack, stackIndex) => ({
      StackName: stack.stackName,
      StackId: `arn:aws:cloudformation:ap-northeast-2:${ACCOUNT}:stack/${stack.stackName}/0d5e7a10-1b2c-4d3e-8f90-a1b2c3d4e5f${stackIndex}`,
      StackStatus: status[stack.stackName] ?? 'CREATE_COMPLETE',
      Outputs: Object.entries(stack.template.Outputs ?? {})
        .filter(([key]) => !/^(PublishOutput|Export)/.test(key))
        .map(([key, output]: [string, any]) => ({ OutputKey: key, OutputValue: typeof output.Value === 'string' ? output.Value : fixtureValue(key, index++) })),
    })),
  };
}

const profile = () => loadPerfProfile('profiles/perf/fixed-v1.json', ROOT);

/** 공유 사본의 ready M1 request를 이 프로필·환경 Secret 이름으로 맞춘 것. schema는 그대로 통과해야 한다. */
export function perfRequest(overrides: (request: any) => void = () => undefined, profilePath = 'profiles/perf/fixed-v1.json'): Buffer {
  const request = JSON.parse(readFileSync(join(COPY, 'fixtures/bundle/bundle-ok/request.json'), 'utf8'));
  const loaded = loadPerfProfile(profilePath, ROOT);
  request.infra.profile = profilePath;
  request.environment.environment_id = ENVIRONMENT_ID;
  request.infra.profile_sha256 = loaded.sha256;
  request.infra.parameters = { environmentId: ENVIRONMENT_ID, natGateways: 1, mskBrokerVolumeGiB: 100, clickhouseVolumeGiB: 100 };
  request.images = {
    'enrollment-api': `${REGISTRY}/enrollment-api@${DIGEST('1')}`, 'telemetry-gateway': `${REGISTRY}/telemetry-gateway@${DIGEST('2')}`,
    'telemetry-ingest': `${REGISTRY}/telemetry-ingest@${DIGEST('3')}`, clickhouse: `docker.io/clickhouse/clickhouse-server@${DIGEST('4')}`,
    'k6-runner': `${REGISTRY}/perf-k6-runner@${DIGEST('5')}`, 'perf-tools': `${REGISTRY}/perf-tools@${DIGEST('6')}`,
  };
  for (const ref of Object.values(request.secret_references) as any[]) {
    ref.name = ref.name.replace('soma-376/perf/', `soma-376/perf/${ENVIRONMENT_ID}/`);
  }
  // 요청 용량은 프로필과 같아야 resolved 대조를 통과한다.
  const { node_pools: pools, workloads } = loaded.profile;
  request.capacity.node_pools = Object.fromEntries(Object.entries(pools).map(([id, pool]) => [id, {
    role: pool.role, instance_type: pool.instance_type, nodes: pool.nodes, availability_zone: loaded.profile.availability_zone,
    capacity_type: pool.capacity_type, architecture: pool.architecture,
  }]));
  request.capacity.workloads = Object.fromEntries(Object.entries(workloads).map(([id, workload]) => [id, { ...workload }]));
  if (loaded.profile.kafka_provider === 'strimzi') {
    request.schema_version = 3; request.kafka = { provider: 'strimzi' };
    request.infra.parameters = { environmentId: ENVIRONMENT_ID, natGateways: 1, kafkaProvider: 'strimzi', kafkaVolumeGiB: 100, clickhouseVolumeGiB: 100 };
  }
  overrides(request);
  return Buffer.from(JSON.stringify(request, null, 2) + '\n');
}

export const RUNTIME_VALUES = `telemetryJwt:
  privateVersionId: 0123456789abcdef0123456789abcdef
  publicVersionId: fedcba9876543210fedcba9876543210
  activeKid: ${KID}
  publicKeys:
    - kid: ${KID}
      alias: telemetry-2026-11.pem
enrollmentReplicas: 1
jvmGcSafepointLog: false
`;

const BROKERS = [1, 2, 3].map(n => `b-${n}.soma376perftelemetry.abc123.c2.kafka.ap-northeast-2.amazonaws.com`);
export const MSK_BOOTSTRAP = { BootstrapBrokerStringSaslIam: BROKERS.map(host => `${host}:9098`).join(',') };
export const MSK_NODES = {
  NodeInfoList: BROKERS.map((host, index) => ({
    NodeType: 'BROKER', InstanceType: 'kafka.m7g.large',
    BrokerNodeInfo: { BrokerId: index + 1, Endpoints: [host] },
  })),
};

/** readiness 뒤 kubectl get -o json이 돌려줄 최소 상태. 프로필과 같은 용량을 쓴다. */
export function kubernetesState(mutate: (items: any[]) => void = () => undefined) {
  const pools = ['gateway', 'pipeline', 'clickhouse', 'generator', 'observability', 'system'];
  const types: Record<string, string> = { gateway: 'm7g.large', pipeline: 'm7g.large', clickhouse: 'r7g.large', generator: 'c7g.large', observability: 'm7g.large', system: 'm7g.large' };
  const items: any[] = [];
  for (const pool of pools) {
    items.push({ kind: 'NodePool', metadata: { name: `perf-${pool}` }, spec: {
      replicas: 1, disruption: { budgets: [{ nodes: '0' }] },
      template: { spec: { nodeClassRef: { name: `perf-${pool}` }, taints: pool === 'system' ? undefined : [{ key: 'workload', value: pool, effect: 'NoSchedule' }] } },
    } });
    items.push({ kind: 'Node', metadata: { name: `node-${pool}`, labels: {
      'karpenter.sh/nodepool': `perf-${pool}`, 'node.kubernetes.io/instance-type': types[pool], 'topology.kubernetes.io/zone': 'ap-northeast-2a',
      'karpenter.sh/capacity-type': 'on-demand', 'kubernetes.io/arch': 'arm64',
    } }, status: { conditions: [{ type: 'Ready', status: 'True' }] } });
  }
  const deployment = (name: string, pool: string, image: string, cpu: string, memory: string, env: any[] = []) => ({
    kind: name === 'clickhouse' ? 'StatefulSet' : 'Deployment',
    metadata: { name, namespace: 'pulsemetry-perf', uid: `0d5e7a10-1b2c-4d3e-8f90-a1b2c3d4e5f${pools.indexOf(pool)}`, generation: 2 },
    spec: { replicas: 1, template: { spec: { nodeSelector: { 'karpenter.sh/nodepool': `perf-${pool}` }, containers: [{ name, image, env, resources: { requests: { cpu, memory }, limits: { memory } } }] } } },
    status: { observedGeneration: 2, readyReplicas: 1 },
  });
  const spring = JSON.stringify({ pulsemetry: { 'telemetry-jwt': { 'active-kid': KID, 'issue-enabled': true } } });
  items.push(
    deployment('telemetry-gateway', 'gateway', `${REGISTRY}/telemetry-gateway@${DIGEST('2')}`, '1500m', '4Gi', [{ name: 'PULSEMETRY_KAFKA_TOPIC', value: 'pulsemetry-perf-telemetry-ingress' }]),
    deployment('telemetry-ingest', 'pipeline', `${REGISTRY}/telemetry-ingest@${DIGEST('3')}`, '1500m', '4Gi', [{ name: 'PULSEMETRY_INGEST_MODE', value: 'kafka' }]),
    deployment('enrollment-api', 'system', `${REGISTRY}/enrollment-api@${DIGEST('1')}`, '500m', '1Gi', [{ name: 'SPRING_APPLICATION_JSON', value: spring }]),
    deployment('clickhouse', 'clickhouse', `docker.io/clickhouse/clickhouse-server@${DIGEST('4')}`, '1500m', '12Gi'),
    { kind: 'PersistentVolumeClaim', metadata: { name: 'data-clickhouse-0', namespace: 'pulsemetry-perf' }, spec: { storageClassName: 'pulsemetry-perf-gp3', volumeName: 'pv-ch' }, status: { capacity: { storage: '100Gi' } } },
    { kind: 'PersistentVolume', metadata: { name: 'pv-ch' }, spec: { csi: { volumeHandle: 'vol-0123456789abcdef0' } } },
    { kind: 'StorageClass', metadata: { name: 'pulsemetry-perf-gp3' }, parameters: { iops: '3000', throughput: '125' } },
  );
  mutate(items);
  return { apiVersion: 'v1', kind: 'List', items };
}
