import { Match, Template } from 'aws-cdk-lib/assertions';
import { buildDevApp } from '../helpers';

const built = buildDevApp({ devEksEnabled: 'true', devAllowedCidr: '203.0.113.10/32' });
const eks = Template.fromStack(built.eks!);
const network = Template.fromStack(built.network);

test('Grafana credential는 서버 측 생성·Retain이고 전용 두 SA만 관측 역할을 받는다', () => {
  eks.hasResource('AWS::SecretsManager::Secret', {
    DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain',
    Properties: { Name: 'soma-376/dev/observability/grafana-admin', GenerateSecretString: {
      GenerateStringKey: 'password', PasswordLength: 40, SecretStringTemplate: '{}', ExcludePunctuation: true,
    } },
  });
  for (const sa of ['grafana', 'kubernetes-events']) eks.hasResourceProperties('AWS::EKS::PodIdentityAssociation', {
    Namespace: 'pulsemetry-observability', ServiceAccount: sa, DisableSessionTags: false,
  });
  const roles = eks.findResources('AWS::IAM::Role');
  for (const [id, value] of Object.entries(roles) as [string, any][]) {
    if (!id.startsWith('Observability')) continue;
    const condition = value.Properties.AssumeRolePolicyDocument.Statement[0].Condition.StringEquals;
    expect(condition['aws:RequestTag/kubernetes-namespace']).toBe('pulsemetry-observability');
    expect(['grafana', 'kubernetes-events']).toContain(condition['aws:RequestTag/kubernetes-service-account']);
  }
});

test('추가 metrics ingress는 관측 SG로 제한하고 관측 역할에 Kafka 데이터 권한을 주지 않는다', () => {
  const rules = Object.values(network.findResources('AWS::EC2::SecurityGroupIngress')) as any[];
  for (const port of [9404, 9363, 11001, 11002]) {
    const matches = rules.filter(rule => rule.Properties.FromPort === port);
    expect(matches).toHaveLength(1);
    expect(matches[0].Properties.CidrIp).toBeUndefined();
    expect(JSON.stringify(matches[0].Properties.SourceSecurityGroupId)).toContain('DevEksObservabilityNodeSg');
  }
  for (const port of [2020, 9100]) {
    const matches = rules.filter(rule => rule.Properties.FromPort === port);
    expect(matches).toHaveLength(2);
    for (const rule of matches) expect(JSON.stringify(rule.Properties.SourceSecurityGroupId)).toContain('DevEksObservabilityNodeSg');
  }
  const policies = Object.entries(eks.findResources('AWS::IAM::Policy'));
  for (const [id, policy] of policies) if (id.startsWith('Observability')) {
    expect(JSON.stringify(policy)).not.toContain('kafka-cluster:');
    expect(JSON.stringify(policy)).not.toContain('iam:PassRole');
  }
});

test('관측 노드는 Loki 3100을 앱·ClickHouse 노드에서, 플랫폼 trace 4318을 앱 노드에서만 받는다 (ADR-0039)', () => {
  const rules = Object.values(network.findResources('AWS::EC2::SecurityGroupIngress')) as any[];
  const into = (port: number) => rules.filter(rule => rule.Properties.FromPort === port && rule.Properties.ToPort === port);
  const loki = into(3100);
  expect(loki).toHaveLength(2);
  for (const rule of loki) {
    expect(JSON.stringify(rule.Properties.GroupId)).toContain('DevEksObservabilityNodeSg');
    expect(rule.Properties.CidrIp).toBeUndefined();
  }
  expect(loki.map(rule => JSON.stringify(rule.Properties.SourceSecurityGroupId)).sort().join()).toMatch(/DevEksAppNodeSg.*DevEksClickhouseNodeSg/);
  const otlp = into(4318);
  expect(otlp).toHaveLength(1);
  expect(JSON.stringify(otlp[0].Properties.GroupId)).toContain('DevEksObservabilityNodeSg');
  expect(JSON.stringify(otlp[0].Properties.SourceSecurityGroupId)).toContain('DevEksAppNodeSg');
  // 관측 SG로 들어오는 앱·ClickHouse 출처 규칙은 위 셋뿐이다.
  const fromWorkloads = rules.filter(rule => JSON.stringify(rule.Properties.GroupId).includes('DevEksObservabilityNodeSg')
    && /DevEksAppNodeSg|DevEksClickhouseNodeSg/.test(JSON.stringify(rule.Properties.SourceSecurityGroupId)));
  expect(fromWorkloads).toHaveLength(3);
});

test('Grafana는 CloudWatch 지표 조회와 지정 log group 조회 권한만 받는다', () => {
  const [, policy] = Object.entries(eks.findResources('AWS::IAM::Policy')).find(([id]) => id.startsWith('ObservabilityGrafana'))! as [string, any];
  const actions = policy.Properties.PolicyDocument.Statement.flatMap((statement: any) => [statement.Action].flat());
  expect(actions).toEqual(expect.arrayContaining(['cloudwatch:ListMetrics', 'cloudwatch:GetMetricData', 'logs:StartQuery', 'logs:GetQueryResults']));
  // 경보 패널이 없으므로 alarm 조회 권한은 쓰는 곳이 없다.
  expect(actions.filter((action: string) => /^cloudwatch:(DescribeAlarm|PutMetric|Delete|Set)/.test(action))).toEqual([]);
});

test('Grafana의 log 조회 권한은 다섯 log group ARN에만 걸리고 control-plane ARN은 콜론 구분자를 쓴다', () => {
  const [, policy] = Object.entries(eks.findResources('AWS::IAM::Policy')).find(([id]) => id.startsWith('ObservabilityGrafana'))! as [string, any];
  const statement = policy.Properties.PolicyDocument.Statement.find((s: any) => [s.Action].flat().includes('logs:StartQuery'));
  const resources = [statement.Resource].flat();
  expect(resources).toHaveLength(5);
  const rendered = resources.map((resource: any) => JSON.stringify(resource));
  const controlPlane = rendered.filter((text: string) => text.includes('/aws/eks/'));
  expect(controlPlane).toHaveLength(1);
  expect(controlPlane[0]).toContain(':log-group:/aws/eks/');
  expect(controlPlane[0]).toContain('/cluster:*');
  for (const text of rendered) expect(text).not.toContain('log-group//');
  expect(rendered.filter((text: string) => text === '"*"')).toEqual([]);
});

test('시스템 로그는 14일, 진단 bucket은 private·암호화·14일 만료를 보장한다', () => {
  for (const name of ['/eks/dev/observability', '/eks/dev/events']) eks.hasResource('AWS::Logs::LogGroup', {
    DeletionPolicy: 'Retain', Properties: { LogGroupName: name, RetentionInDays: 14 },
  });
  eks.hasResourceProperties('AWS::S3::Bucket', {
    BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] },
    PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
    LifecycleConfiguration: { Rules: Match.arrayWith([Match.objectLike({ ExpirationInDays: 14, Status: 'Enabled' })]) },
  });
  eks.resourceCountIs('AWS::Lambda::Function', 0);
});
