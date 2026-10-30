import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { buildPerfApp, PERF_TEST_ENVIRONMENT_ID } from '../helpers';

const built = buildPerfApp();
const evidence = Template.fromStack(built.evidence);
const network = Template.fromStack(built.network);
const data = Template.fromStack(built.data);
const eks = Template.fromStack(built.eks);

/** CloudFormation 참조 객체를 비교하기 쉬운 문자열로 바꾼다. */
const text = (value: unknown) => JSON.stringify(value);

function logicalId(template: Template, type: string, description: string): string {
  const ids = Object.keys(template.findResources(type, { Properties: { GroupDescription: description } }));
  expect(ids).toHaveLength(1);
  return ids[0];
}

function ingressRules(): { to: string; from: string; port: number; protocol: string }[] {
  const groups = network.findResources('AWS::EC2::SecurityGroup');
  const name = (ref: any) => groups[ref?.['Fn::GetAtt']?.[0]]?.Properties.GroupDescription ?? text(ref);
  return Object.values(network.findResources('AWS::EC2::SecurityGroupIngress')).map((rule: any) => ({
    to: name(rule.Properties.GroupId), from: name(rule.Properties.SourceSecurityGroupId ?? rule.Properties.CidrIp),
    port: rule.Properties.FromPort, protocol: rule.Properties.IpProtocol,
  }));
}

test('perf는 evidence·network·data·eks 네 스택이며 dev·prod 스택을 조립하지 않는다', () => {
  const names = built.app.synth().stacks.map(stack => stack.stackName).sort();
  expect(names).toEqual(['PerfDataStack', 'PerfEksStack', 'PerfEvidenceStack', 'PerfNetworkStack']);
  const eksArtifact = built.app.synth().getStackArtifact(built.eks.artifactId);
  expect(eksArtifact.dependencies.map(dep => dep.id).filter(id => !id.endsWith('.assets')).sort()).toEqual(['PerfDataStack', 'PerfEvidenceStack', 'PerfNetworkStack']);
});

test('lib/perf는 lib/dev·lib/prod·lib/cicd를 import하지 않는다', () => {
  const directory = resolve(__dirname, '../../lib/perf');
  const files = readdirSync(directory, { recursive: true }).map(String).filter(name => name.endsWith('.ts'));
  for (const name of files) {
    const source = readFileSync(join(directory, name), 'utf8');
    expect([name, /from '\.\.\/(\.\.\/)?(dev|prod|cicd)\//.test(source)]).toEqual([name, false]);
  }
});

test('evidence bucket만 Retain이며 versioning·90일 만료·공개 차단을 쓴다', () => {
  evidence.hasResource('AWS::S3::Bucket', {
    DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain',
    Properties: Match.objectLike({
      VersioningConfiguration: { Status: 'Enabled' },
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
      LifecycleConfiguration: { Rules: ['runs/', 'environments/'].map(prefix => Match.objectLike({
        Prefix: prefix, ExpirationInDays: 90, NoncurrentVersionExpiration: { NoncurrentDays: 90 }, Status: 'Enabled',
      })) },
    }),
  });
  evidence.hasOutput('EvidencePrefix', { Value: 'runs/' });
  // 환경 소유 태그는 evidence에 붙지 않는다. 환경을 지워도 증거는 남는다.
  const tags = Object.values(evidence.findResources('AWS::S3::Bucket'))[0].Properties.Tags;
  expect(tags).toEqual(expect.arrayContaining([{ Key: 'pulsemetry:perf-evidence', Value: 'shared' }, { Key: 'Env', Value: 'perf' }]));
  expect(tags.some((tag: any) => tag.Key === 'pulsemetry:perf-environment')).toBe(false);
  for (const template of [network, data, eks]) {
    for (const [id, resource] of Object.entries(template.findResources('AWS::S3::Bucket'))) {
      expect([id, resource.DeletionPolicy]).toEqual([id, 'Delete']);
    }
  }
});

test('독립 VPC: 10.2.0.0/16, 3 AZ subnet, NAT 1개, S3 gateway endpoint, public IP 자동 할당 없음', () => {
  network.hasResourceProperties('AWS::EC2::VPC', { CidrBlock: '10.2.0.0/16' });
  network.resourceCountIs('AWS::EC2::NatGateway', 1);
  network.resourceCountIs('AWS::EC2::Subnet', 9);
  network.hasResourceProperties('AWS::EC2::VPCEndpoint', { VpcEndpointType: 'Gateway', ServiceName: Match.objectLike({}) });
  for (const subnet of Object.values(network.findResources('AWS::EC2::Subnet'))) {
    expect(subnet.Properties.MapPublicIpOnLaunch ?? false).toBe(false);
  }
  const nat = Object.values(network.findResources('AWS::EC2::NatGateway'))[0];
  const subnetId = nat.Properties.SubnetId.Ref;
  expect(network.toJSON().Resources[subnetId].Properties.AvailabilityZone).toBe('ap-northeast-2a');
  expect(Template.fromStack(buildPerfApp({ perfNatGateways: 3 }).network).resourceCountIs('AWS::EC2::NatGateway', 3));
});

test('SG는 Network에만 있고 CIDR ingress가 없다', () => {
  network.resourceCountIs('AWS::EC2::SecurityGroup', 11);
  for (const template of [evidence, data, eks]) {
    template.resourceCountIs('AWS::EC2::SecurityGroup', 0);
    template.resourceCountIs('AWS::EC2::SecurityGroupIngress', 0);
  }
  for (const rule of Object.values(network.findResources('AWS::EC2::SecurityGroupIngress'))) {
    expect(rule.Properties.CidrIp).toBeUndefined();
    expect(rule.Properties.CidrIpv6).toBeUndefined();
  }
  for (const group of Object.values(network.findResources('AWS::EC2::SecurityGroup'))) {
    expect(group.Properties.SecurityGroupIngress).toBeUndefined();
  }
});

test('업무 포트는 출발 pool을 지정해 연다', () => {
  const rules = ingressRules();
  const has = (to: string, from: string, port: number) => expect(rules).toContainEqual(expect.objectContaining({ to, from, port }));
  has('perf EKS gateway node pool', 'perf EKS generator node pool', 8082);
  has('perf EKS observability node pool', 'perf EKS generator node pool', 9090);
  has('perf EKS observability node pool', 'perf EKS system node pool', 9090);
  has('perf EKS gateway node pool', 'perf EKS observability node pool', 9404);
  has('perf EKS pipeline node pool', 'perf EKS observability node pool', 9404);
  has('perf EKS clickhouse node pool', 'perf EKS pipeline node pool', 8123);
  has('perf EKS clickhouse node pool', 'perf EKS pipeline node pool', 9000);
  has('perf EKS clickhouse node pool', 'perf EKS system node pool', 8123);
  has('perf EKS clickhouse node pool', 'perf EKS observability node pool', 9363);
  has('perf EKS control plane', 'perf EKS API SSM relay', 443);
  has('perf EKS control plane', 'perf EKS nodes common', 443);
  has('perf EKS nodes common', 'perf EKS control plane', 10250);
  const sources = (to: string, port?: number) => rules.filter(rule => rule.to === to && (port === undefined || rule.port === port)).map(rule => rule.from).sort();
  // runner(generator)에는 MSK·DB 경로가 없다. MSK는 Gateway·Consumer·관리 Job만, RDS는 Consumer·system만 받는다.
  expect(sources('perf MSK brokers', 9098)).toEqual(['perf EKS gateway node pool', 'perf EKS pipeline node pool', 'perf EKS system node pool']);
  expect(sources('perf MSK brokers').filter(from => !from.includes('observability')).length).toBe(3);
  expect(rules.filter(rule => rule.to === 'perf MSK brokers' && rule.from.includes('observability')).map(rule => rule.port).sort()).toEqual([11001, 11002]);
  expect(sources('perf RDS PostgreSQL')).toEqual(['perf EKS pipeline node pool', 'perf EKS system node pool']);
  expect(sources('perf EKS gateway node pool')).toEqual(['perf EKS gateway node pool', 'perf EKS generator node pool', 'perf EKS observability node pool', 'perf EKS system node pool']);
  has('perf EKS gateway node pool', 'perf EKS system node pool', 8082);
  expect(rules.filter(rule => rule.from === 'perf EKS generator node pool' && rule.to !== 'perf EKS generator node pool').map(rule => `${rule.to}:${rule.port}`).sort())
    .toEqual(['perf EKS gateway node pool:8082', 'perf EKS observability node pool:9090']);
  // relay는 HTTPS egress만 가진다.
  const relay = logicalId(network, 'AWS::EC2::SecurityGroup', 'perf EKS API SSM relay');
  const egress = Object.values(network.findResources('AWS::EC2::SecurityGroupEgress')).filter((rule: any) => rule.Properties.GroupId['Fn::GetAtt'][0] === relay);
  expect(egress.map((rule: any) => [rule.Properties.CidrIp, rule.Properties.FromPort])).toEqual([['0.0.0.0/0', 443]]);
});

test('RDS는 private·암호화·단일 AZ db.t4g.medium PostgreSQL 16.13이다', () => {
  data.hasResourceProperties('AWS::RDS::DBInstance', {
    Engine: 'postgres', EngineVersion: '16.13', DBInstanceClass: 'db.t4g.medium', AllocatedStorage: '20', StorageType: 'gp3',
    PubliclyAccessible: false, StorageEncrypted: true, MultiAZ: false, AvailabilityZone: 'ap-northeast-2a', DBName: 'controlplane',
    DeletionProtection: false, BackupRetentionPeriod: 0,
  });
});

test('RDS subnet group은 서로 다른 AZ의 private subnet 3개를 가리킨다', () => {
  // cfn validate W9007(SubnetIds 중복)은 Fn::GetStackOutput 참조를 풀지 못한 오탐이다. 실제 대상이 서로 다른지 확인한다.
  const ids = Object.values(data.findResources('AWS::RDS::DBSubnetGroup'))[0].Properties.SubnetIds;
  const outputs = ids.map((id: any) => id['Fn::GetStackOutput']);
  expect(outputs.every((output: any) => output.StackName === 'PerfNetworkStack')).toBe(true);
  const network_ = network.toJSON();
  const subnets = outputs.map((output: any) => network_.Resources[network_.Outputs[output.OutputName].Value.Ref].Properties);
  expect(new Set(outputs.map((output: any) => output.OutputName)).size).toBe(3);
  expect(subnets.map((subnet: any) => subnet.AvailabilityZone)).toEqual(['ap-northeast-2a', 'ap-northeast-2b', 'ap-northeast-2c']);
  expect(new Set(subnets.map((subnet: any) => subnet.CidrBlock)).size).toBe(3);
});

test('MSK는 프로필 값의 IAM 전용 3 broker이고 broker volume은 입력으로 바꾼다', () => {
  data.hasResourceProperties('AWS::MSK::Cluster', {
    ClusterName: 'soma-376-perf-telemetry', KafkaVersion: '3.9.x.kraft', NumberOfBrokerNodes: 3,
    BrokerNodeGroupInfo: Match.objectLike({ InstanceType: 'kafka.m7g.large', StorageInfo: { EBSStorageInfo: { VolumeSize: 100 } } }),
    ClientAuthentication: { Sasl: { Iam: { Enabled: true }, Scram: { Enabled: false } }, Unauthenticated: { Enabled: false } },
    EncryptionInfo: { EncryptionInTransit: { ClientBroker: 'TLS', InCluster: true } },
  });
  const properties = Object.values(data.findResources('AWS::MSK::Configuration'))[0].Properties.ServerProperties.split('\n').sort();
  expect(properties).toEqual([
    'auto.create.topics.enable=false', 'default.replication.factor=3', 'log.retention.hours=72', 'message.max.bytes=13631488',
    'min.insync.replicas=2', 'num.partitions=6', 'replica.fetch.max.bytes=13631488', 'unclean.leader.election.enable=false',
  ]);
  Template.fromStack(buildPerfApp({ perfMskBrokerVolumeGiB: 250 }).data).hasResourceProperties('AWS::MSK::Cluster', {
    BrokerNodeGroupInfo: Match.objectLike({ StorageInfo: { EBSStorageInfo: { VolumeSize: 250 } } }),
  });
});

test('환경 Secret 9개는 environment ID를 이름에 넣고 사용자 JWT·OIDC·dashboard 원본은 없다', () => {
  const names = Object.values(data.findResources('AWS::SecretsManager::Secret')).map((secret: any) => secret.Properties.Name).sort();
  expect(names).toEqual([
    'enrollment/admin-token', 'enrollment/token-hash-secret', 'grafana/admin', 'rds/master', 'rds/seed', 'rds/verify',
    'synthetic/seed-secret', 'telemetry-jwt/private-key', 'telemetry-jwt/public-keys',
  ].map(name => `soma-376/perf/${PERF_TEST_ENVIRONMENT_ID}/${name}`).sort());
  for (const [id, secret] of Object.entries(data.findResources('AWS::SecretsManager::Secret'))) {
    expect([id, secret.DeletionPolicy]).toEqual([id, 'Delete']);
  }
  // telemetry JWT 키는 운영자가 등록한다. 서버 측 생성 값이 없다.
  for (const name of ['telemetry-jwt/private-key', 'telemetry-jwt/public-keys']) {
    data.hasResourceProperties('AWS::SecretsManager::Secret', Match.objectLike({
      Name: `soma-376/perf/${PERF_TEST_ENVIRONMENT_ID}/${name}`, GenerateSecretString: Match.absent(), SecretString: Match.absent(),
    }));
  }
  data.hasResourceProperties('AWS::SecretsManager::Secret', {
    Name: `soma-376/perf/${PERF_TEST_ENVIRONMENT_ID}/rds/seed`,
    GenerateSecretString: Match.objectLike({ SecretStringTemplate: '{"username":"perf_seed"}', GenerateStringKey: 'password' }),
  });
  data.hasResource('AWS::S3::Bucket', { Properties: Match.objectLike({ LifecycleConfiguration: { Rules: [Match.objectLike({ ExpirationInDays: 7 })] } }) });
});

test('EKS는 private API 전용 Auto Mode이고 control plane 로그 그룹을 먼저 만든다', () => {
  eks.hasResourceProperties('AWS::EKS::Cluster', {
    Name: 'soma-376-perf-eks', Version: '1.36',
    AccessConfig: { AuthenticationMode: 'API', BootstrapClusterCreatorAdminPermissions: false },
    ComputeConfig: { Enabled: true, NodePools: [] },
    ResourcesVpcConfig: Match.objectLike({ EndpointPrivateAccess: true, EndpointPublicAccess: false, PublicAccessCidrs: Match.absent() }),
  });
  const cluster = Object.values(eks.findResources('AWS::EKS::Cluster'))[0];
  const logs = eks.findResources('AWS::Logs::LogGroup');
  const controlPlane = Object.keys(logs).find(id => logs[id].Properties.LogGroupName === '/aws/eks/soma-376-perf-eks/cluster');
  expect(cluster.DependsOn).toContain(controlPlane);
  for (const group of Object.values(logs)) expect([group.Properties.LogGroupName, group.Properties.RetentionInDays]).toEqual([group.Properties.LogGroupName, 14]);
  eks.resourceCountIs('AWS::EKS::AccessEntry', 2);
  // relay는 노드 AZ의 private subnet에 public IP 없이 둔다.
  const relay = Object.values(eks.findResources('AWS::EC2::Instance'))[0].Properties;
  expect(relay.InstanceType).toBe('t4g.micro');
  expect(relay.NetworkInterfaces).toHaveLength(1);
  expect(relay.NetworkInterfaces[0].AssociatePublicIpAddress).toBe(false);
  expect(text(relay.NetworkInterfaces[0].SubnetId)).toContain('perfprivateSubnet1');
});

test('EKS output은 결과 파일 생산자가 요청과 대조할 배포 입력을 낸다', () => {
  eks.hasOutput('PerfEnvironmentId', { Value: PERF_TEST_ENVIRONMENT_ID });
  eks.hasOutput('PerfProfilePath', { Value: 'profiles/perf/fixed-v1.json' });
  eks.hasOutput('PerfProfileSha256', { Value: Match.stringLikeRegexp('^[0-9a-f]{64}$') });
  eks.hasOutput('PerfInfraParameters', { Value: JSON.stringify({ environmentId: PERF_TEST_ENVIRONMENT_ID, natGateways: 1, mskBrokerVolumeGiB: 100, clickhouseVolumeGiB: 100 }) });
});

test('Pod Identity는 namespace·ServiceAccount 하나씩 14개다', () => {
  const pairs = Object.values(eks.findResources('AWS::EKS::PodIdentityAssociation'))
    .map((association: any) => `${association.Properties.Namespace}/${association.Properties.ServiceAccount}`).sort();
  expect(pairs).toEqual([
    'pulsemetry-observability/grafana', 'pulsemetry-observability/kubernetes-events', 'pulsemetry-perf-logs/fluent-bit',
    'pulsemetry-perf-runner/k6-runner', 'pulsemetry-perf-runner/perf-prepare', 'pulsemetry-perf-runner/perf-seed',
    'pulsemetry-perf-runner/perf-sentinel', 'pulsemetry-perf-runner/perf-smoke', 'pulsemetry-perf-runner/perf-verify',
    'pulsemetry-perf/enrollment-api', 'pulsemetry-perf/telemetry-gateway', 'pulsemetry-perf/telemetry-ingest',
    'pulsemetry-perf/telemetry-kafka-admin', 'pulsemetry-perf/telemetry-kafka-offsets',
  ]);
});

/** Pod Identity association의 ServiceAccount로 역할 정책 문장을 모은다. */
function statementsFor(serviceAccount: string): any[] {
  const resources = eks.toJSON().Resources;
  const association = Object.values(eks.findResources('AWS::EKS::PodIdentityAssociation'))
    .find((item: any) => item.Properties.ServiceAccount === serviceAccount)!;
  const roleId = association.Properties.RoleArn['Fn::GetAtt'][0];
  return Object.values(resources).filter((resource: any) => resource.Type === 'AWS::IAM::Policy'
    && resource.Properties.Roles.some((ref: any) => ref.Ref === roleId))
    .flatMap((policy: any) => policy.Properties.PolicyDocument.Statement);
}
const actions = (statements: any[]) => statements.flatMap(statement => [statement.Action].flat()).sort();

test('runner는 evidence runs/* 조건부 PutObject만 갖는다', () => {
  const statements = statementsFor('k6-runner');
  expect(actions(statements)).toEqual(['s3:PutObject']);
  expect(statements[0].Condition).toEqual({ Null: { 's3:if-none-match': 'false' }, Bool: { 'aws:SecureTransport': 'true' } });
  expect(text(statements[0].Resource)).toContain('/runs/*');
  expect(text(statements)).not.toMatch(/kafka|secretsmanager|rds|environments/);
});

test('verify는 evidence Get/Put·목록, raw signal 표본 GET, Kafka lag 지표 읽기만 갖는다', () => {
  const statements = statementsFor('perf-verify');
  expect([...new Set(actions(statements))]).toEqual(['cloudwatch:GetMetricStatistics', 's3:GetObject', 's3:ListBucket', 's3:PutObject']);
  expect(text(statements)).not.toMatch(/kafka-cluster|secretsmanager|DeleteObject/);
  // GetMetricStatistics는 리소스 수준 권한이 없다. 리전만 제한한다.
  expect(statements.find(statement => statement.Action === 'cloudwatch:GetMetricStatistics')).toMatchObject({
    Resource: '*', Condition: { StringEquals: { 'aws:RequestedRegion': 'ap-northeast-2' } },
  });
  const list = statements.find(statement => statement.Action === 's3:ListBucket');
  expect(list.Condition.StringLike).toEqual({ 's3:prefix': ['runs/*'] });
  const reads = text(statements.filter(statement => statement.Action === 's3:GetObject').map(statement => statement.Resource));
  expect(reads).toContain('/runs/*');
  expect(reads).toContain('/perf/*');
});

test('prepare는 JWT 공개키·검증 DB·seed secret만 읽고 개인키를 받지 않는다', () => {
  const statements = statementsFor('perf-prepare');
  const secrets = statements.find(statement => [statement.Action].flat().includes('secretsmanager:GetSecretValue'));
  const read = text(secrets.Resource);
  expect(read).toContain('PerfVerifyDbSecret');
  expect(read).toContain('PerfSyntheticSeedSecret');
  expect(read).toContain('PerfTelemetryJwtPublicKeysSecret');
  expect(read).not.toContain('PrivateKey');
  expect(read).not.toContain('PerfSeedDbSecret');
  expect(actions(statements)).toEqual(['s3:GetObject', 's3:PutObject', 'secretsmanager:DescribeSecret', 'secretsmanager:GetSecretValue']);
});

test('telemetry JWT 개인키는 enrollment만 읽는다', () => {
  for (const account of ['telemetry-gateway', 'telemetry-ingest', 'perf-seed', 'perf-prepare', 'perf-smoke', 'perf-sentinel', 'k6-runner', 'perf-verify']) {
    expect([account, text(statementsFor(account)).includes('PerfTelemetryJwtPrivateKeySecret')]).toEqual([account, false]);
  }
  expect(text(statementsFor('enrollment-api'))).toContain('PerfTelemetryJwtPrivateKeySecret');
});

test('sentinel·seed는 evidence 조건부 PutObject만, smoke는 그에 더해 raw 표본 GET을 쓰고 seed는 seed DB 계정만 읽는다', () => {
  expect(actions(statementsFor('perf-sentinel'))).toEqual(['s3:PutObject']);
  // smoke는 storage 단계에서 archive 표본을 GET한다. raw prefix만 읽는다.
  const smoke = statementsFor('perf-smoke');
  expect(actions(smoke)).toEqual(['s3:GetObject', 's3:PutObject']);
  expect(text(smoke.find(statement => statement.Action === 's3:GetObject').Resource)).toContain('/perf/*');
  const seed = text(statementsFor('perf-seed'));
  expect(seed).toContain('PerfSeedDbSecret');
  expect(seed).not.toContain('PerfVerifyDbSecret');
  // DB master(`PerfPostgresSecret...`)는 enrollment·Consumer만 읽는다.
  expect(seed).not.toMatch(/PerfPostgresSecret/);
  expect(text(statementsFor('enrollment-api'))).toMatch(/PerfPostgresSecret/);
  expect(text(statementsFor('telemetry-ingest'))).toMatch(/PerfPostgresSecret/);
});

test('MSK 전용 역할은 대응 Pod 역할만 고정 세션 이름으로 assume한다', () => {
  for (const session of ['gateway', 'ingest', 'kafka-admin', 'kafka-offsets']) {
    eks.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: Match.objectLike({ Statement: Match.arrayWith([Match.objectLike({
        Action: 'sts:AssumeRole', Condition: { StringEquals: { 'sts:RoleSessionName': `pulsemetry-perf-telemetry-${session}` } },
      })]) }),
    });
  }
  const gateway = text(eks.toJSON().Resources);
  expect(gateway).toContain('pulsemetry-perf-telemetry-ingress');
  expect(gateway).not.toMatch(/pulsemetry-dev/);
});

test('IAM Description은 Latin-1(ASCII)이다', () => {
  for (const template of [network, data, eks]) {
    for (const role of Object.values(template.findResources('AWS::IAM::Role'))) {
      const description = role.Properties.Description;
      if (description !== undefined) expect(description).toMatch(/^[\x20-\x7e]+$/);
    }
  }
});

test('환경 스택 자원에 environment 소유 태그가 붙는다', () => {
  network.hasResourceProperties('AWS::EC2::VPC', { Tags: Match.arrayWith([{ Key: 'pulsemetry:perf-environment', Value: PERF_TEST_ENVIRONMENT_ID }]) });
  data.hasResourceProperties('AWS::RDS::DBInstance', { Tags: Match.arrayWith([{ Key: 'pulsemetry:perf-environment', Value: PERF_TEST_ENVIRONMENT_ID }]) });
  eks.hasResourceProperties('AWS::EKS::Cluster', { Tags: Match.arrayWith([{ Key: 'pulsemetry:perf-environment', Value: PERF_TEST_ENVIRONMENT_ID }]) });
});

test('프로필 리전과 다른 배포 리전은 거부한다', () => {
  const { App } = require('aws-cdk-lib/core');
  const { synthPerf } = require('../../lib/perf/app');
  const { loadPerfConfig } = require('../../lib/perf/config');
  const app = new App({ context: { perfEnvironmentId: 'perf-x' } });
  expect(() => synthPerf(app, { env: { account: '111111111111', region: 'us-east-1' }, config: loadPerfConfig(app) })).toThrow(/리전/);
});
