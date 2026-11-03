import { Template } from 'aws-cdk-lib/assertions';
import { buildCicdApp, buildDevApp, buildPerfApp, TEST_ENV } from '../helpers';

describe('generated values 전용 EKS reader', () => {
  const { eks } = buildDevApp();
  const template = Template.fromStack(eks);
  const resources = template.toJSON().Resources;
  const roleName = 'soma-376-dev-eks-values-reader';
  const role = Object.entries(resources).find(([, value]: any) => value.Type === 'AWS::IAM::Role' && value.Properties.RoleName === roleName) as [string, any] | undefined;
  const statements = () => Object.values(template.findResources('AWS::IAM::Policy'))
    .filter(policy => policy.Properties.Roles?.some((ref: any) => ref.Ref === role?.[0]))
    .flatMap(policy => policy.Properties.PolicyDocument.Statement);
  const clusterId = Object.keys(template.findResources('AWS::EKS::Cluster'))[0];
  const relayId = Object.keys(template.findResources('AWS::EC2::Instance'))[0];
  const documentId = Object.keys(template.findResources('AWS::SSM::Document'))[0];
  const arn = (service: string, resource: string, id: string) => ({
    'Fn::Join': ['', [`arn:aws:${service}:${TEST_ENV.region}:${TEST_ENV.account}:${resource}/`, { Ref: id }]],
  });

  test('기존 deploy 역할 하나만 reader를 AssumeRole하고 관리 정책은 없다', () => {
    expect(role).toBeDefined();
    expect(role![1].Properties).toMatchObject({
      RoleName: roleName, MaxSessionDuration: 3600,
      AssumeRolePolicyDocument: { Statement: [{
        Effect: 'Allow', Action: 'sts:AssumeRole',
        Principal: { AWS: `arn:aws:iam::${TEST_ENV.account}:role/soma-376-infra-dev-deploy` },
      }] },
    });
    expect(role![1].Properties.ManagedPolicyArns).toBeUndefined();
    expect(role![1].Properties.Description).toMatch(/^[\x20-\x7e]+$/);
    const access = Object.values(template.findResources('AWS::EKS::AccessEntry'))
      .filter(entry => entry.Properties.PrincipalArn['Fn::GetAtt']?.[0] === role![0]);
    expect(access).toHaveLength(1);
    const { Tags: _tags, ...properties } = access[0].Properties;
    expect(properties).toEqual({
        ClusterName: { Ref: clusterId }, PrincipalArn: { 'Fn::GetAtt': [role![0], 'Arn'] },
        Type: 'STANDARD', KubernetesGroups: ['pulsemetry:dev:generated-values-reader'],
    });
    template.hasOutput('EksValuesReaderRoleArn', { Value: { 'Fn::GetAtt': [role![0], 'Arn'] } });
  });

  test('클러스터 조회와 기존 릴레이·문서·호출자 세션만 허용한다', () => {
    expect(statements().flatMap(statement => statement.Action).sort()).toEqual([
      'eks:DescribeCluster', 'ssm:StartSession', 'ssm:StartSession',
      'ssmmessages:OpenDataChannel', 'ssm:ResumeSession', 'ssm:TerminateSession',
    ].sort());
    expect(statements()).toEqual(expect.arrayContaining([
      { Effect: 'Allow', Action: 'eks:DescribeCluster', Resource: { 'Fn::GetAtt': [clusterId, 'Arn'] } },
      { Effect: 'Allow', Action: 'ssm:StartSession', Resource: arn('ec2', 'instance', relayId),
        Condition: { BoolIfExists: { 'ssm:SessionDocumentAccessCheck': 'true' } } },
      { Effect: 'Allow', Action: 'ssm:StartSession', Resource: arn('ssm', 'document', documentId) },
      { Effect: 'Allow', Action: 'ssmmessages:OpenDataChannel',
        Resource: `arn:aws:ssm:${TEST_ENV.region}:${TEST_ENV.account}:session/\${aws:userid}-*` },
      { Effect: 'Allow', Action: ['ssm:ResumeSession', 'ssm:TerminateSession'],
        Resource: `arn:aws:ssm:${TEST_ENV.region}:${TEST_ENV.account}:session/*`,
        Condition: { StringEquals: {
          'ssm:resourceTag/aws:ssmmessages:session-id': '${aws:userid}',
          'ssm:resourceTag/aws:ssmmessages:target-id': { Ref: relayId },
        } } },
    ]));
    template.resourceCountIs('AWS::EC2::Instance', 1);
    template.resourceCountIs('AWS::SSM::Document', 1);
    template.resourceCountIs('AWS::EKS::AccessEntry', 3);
  });

  test('DeployStack은 역할 6개를 유지하고 perf에는 reader를 만들지 않는다', () => {
    const cicd = Template.fromStack(buildCicdApp().deploy);
    cicd.resourceCountIs('AWS::IAM::Role', 6);
    const perf = Template.fromStack(buildPerfApp().eks);
    expect(Object.values(perf.findResources('AWS::IAM::Role')).some(value => value.Properties.RoleName === roleName)).toBe(false);
  });
});
