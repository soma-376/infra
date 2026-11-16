import { Template } from 'aws-cdk-lib/assertions';
import { DELIVERY_CONTRACT as D } from '../../lib/common/delivery-contract';
import { VALUES_SYNC_CONTRACT } from '../../lib/common/values-sync-contract';
import { ECR_REPOS } from '../../lib/common/config';
import { buildCicdApp, TEST_ENV } from '../helpers';

describe('infra GitOps 전용 읽기 역할', () => {
  const stack = buildCicdApp().deploy;
  const template = Template.fromStack(stack);
  const entry = Object.entries(template.findResources('AWS::IAM::Role')).find(([, resource]) => resource.Properties.RoleName === D.infraRoleName)!;
  const role = entry[1].Properties;
  const statements = Object.values(template.findResources('AWS::IAM::Policy'))
    .filter(policy => policy.Properties.Roles?.some((value: any) => value.Ref === entry[0]))
    .flatMap(policy => policy.Properties.PolicyDocument.Statement);
  const statement = (action: string) => statements.find(value => [value.Action].flat().includes(action));

  test('고정 infra repository ID와 전용 Environment만 신뢰한다', () => {
    expect(D.infraRoleName).toBe('soma-376-infra-dev-gitops');
    expect(D.infraEnvironment).toBe('infra-dev-gitops');
    expect(role.AssumeRolePolicyDocument.Statement).toEqual([{
      Effect: 'Allow', Action: 'sts:AssumeRoleWithWebIdentity',
      Principal: { Federated: { Ref: Object.keys(template.findResources('AWS::IAM::OIDCProvider'))[0] } },
      Condition: { StringEquals: {
        'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        'token.actions.githubusercontent.com:sub': 'repo:soma-376@297555253/infra@1310491235:environment:infra-dev-gitops',
      } },
    }]);
    expect(role.MaxSessionDuration).toBe(3600);
    expect(role.ManagedPolicyArns).toBeUndefined();
    expect(role.Description).toMatch(/^[\x20-\x7e]+$/);
    template.hasOutput('InfraGitOpsRoleArn', { Value: { 'Fn::GetAtt': [entry[0], 'Arn'] } });
  });

  test('dev 4개 스택·4개 ECR 읽기와 두 전용 역할 assume만 허용한다', () => {
    expect(statements.flatMap(value => [value.Action].flat()).sort()).toEqual([
      'cloudformation:DescribeStacks', 'cloudformation:GetTemplate',
      'ecr:DescribeImages', 'ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer', 'ecr:GetAuthorizationToken', 'sts:AssumeRole',
    ].sort());
    expect([...statement('cloudformation:DescribeStacks').Resource].sort()).toEqual([
      'DevNetworkStack', 'DevDataStack', 'DevEdgeStack', 'DevEksStack',
    ].map(name => `arn:aws:cloudformation:${TEST_ENV.region}:${TEST_ENV.account}:stack/${name}/*`).sort());
    expect([...statement('ecr:DescribeImages').Resource].sort()).toEqual([
      ECR_REPOS.enrollmentApi, ECR_REPOS.telemetryIngest, ECR_REPOS.telemetryGateway, ECR_REPOS.dashboardApi,
    ].map(name => `arn:aws:ecr:${TEST_ENV.region}:${TEST_ENV.account}:repository/${name}`).sort());
    expect([...statement('sts:AssumeRole').Resource].sort()).toEqual([D.observerRoleName, VALUES_SYNC_CONTRACT.readerRoleName]
      .map(name => `arn:aws:iam::${TEST_ENV.account}:role/${name}`).sort());
    expect(statements.filter(value => value.Resource === '*')).toEqual([
      { Effect: 'Allow', Action: 'ecr:GetAuthorizationToken', Resource: '*' },
    ]);
  });
});
