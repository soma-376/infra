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
