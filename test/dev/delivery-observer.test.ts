import { Template } from 'aws-cdk-lib/assertions';
import { buildCicdApp, buildDevApp, TEST_ENV } from '../helpers';
import { DELIVERY_CONTRACT as D } from '../../lib/common/delivery-contract';

function rolePolicies(template: Template, name: string) {
  const resources = template.toJSON().Resources;
  const found = Object.entries(resources).find(([, value]: any) => value.Type === 'AWS::IAM::Role' && value.Properties.RoleName === name) as [string, any];
  if (!found) throw new Error('역할 누락: ' + name);
  const statements = Object.values(template.findResources('AWS::IAM::Policy'))
    .filter(policy => policy.Properties.Roles?.some((ref: any) => ref.Ref === found[0]))
    .flatMap(policy => policy.Properties.PolicyDocument.Statement);
  return { role: found[1].Properties, statements, actions: statements.flatMap(s => s.Action).sort() };
}

describe('PROJ-311 게시·관측 역할 경계', () => {
  const dev = buildDevApp();
  const eks = Template.fromStack(dev.eks), data = Template.fromStack(dev.data);
  test('promotion은 정확한 Environment OIDC와 4 ECR 읽기·별도 조회 역할만 가진다', () => {
    const { role, statements, actions } = rolePolicies(Template.fromStack(buildCicdApp().deploy), D.promotionRoleName);
    expect(role.AssumeRolePolicyDocument.Statement[0].Condition.StringEquals).toEqual({
      'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
      'token.actions.githubusercontent.com:sub': 'repo:soma-376@297555253/pulsemetry-backend@1325324450:environment:dev-gitops',
    });
    expect(actions).toEqual(['ecr:BatchGetImage', 'ecr:DescribeImages', 'ecr:GetAuthorizationToken', 'ecr:GetDownloadUrlForLayer', 'sts:AssumeRole']);
    expect(statements.filter(s => s.Resource === '*')).toEqual([{ Effect: 'Allow', Action: 'ecr:GetAuthorizationToken', Resource: '*' }]);
    expect(actions.some(action => /Put|Upload|Initiate|Complete|Delete/.test(action))).toBe(false);
    expect(statements.find(s => ([].concat(s.Action) as string[]).includes('sts:AssumeRole')).Resource).toBe(
      `arn:aws:iam::${TEST_ENV.account}:role/${D.observerRoleName}`);
    expect(statements.find(s => ([].concat(s.Action) as string[]).includes('ecr:DescribeImages')).Resource).toHaveLength(4);
  });
  test('EKS observer는 Secret 읽기·SSM 임의명령·클러스터 관리 정책을 갖지 않는다', () => {
    const { role, actions } = rolePolicies(eks, D.observerRoleName);
    expect(role.AssumeRolePolicyDocument.Statement[0].Principal.AWS).toBe(`arn:aws:iam::${TEST_ENV.account}:role/${D.promotionRoleName}`);
    expect(actions).toEqual(['eks:DescribeCluster', 'ssm:ResumeSession', 'ssm:StartSession', 'ssm:StartSession', 'ssm:TerminateSession', 'ssmmessages:OpenDataChannel']);
    expect(role.ManagedPolicyArns).toBeUndefined();
    eks.hasResourceProperties('AWS::EKS::AccessEntry', { KubernetesGroups: [D.kubernetesGroup], Type: 'STANDARD' });
  });
  test('검증 전용 Pod identity·DB reader·Secret 권한과 outputs를 만들지 않는다', () => {
    const identities = Object.values(eks.findResources('AWS::EKS::PodIdentityAssociation'));
    expect(identities.some(identity => identity.Properties.ServiceAccount === 'deployment-verifier')).toBe(false);
    for (const template of [eks, data]) {
      expect(JSON.stringify(template.toJSON())).not.toContain('deployment-verifier');
      expect(JSON.stringify(template.toJSON())).not.toContain('soma-376-dev-delivery-db-reader');
    }
    expect(eks.findOutputs('DeploymentVerifierRoleArn')).toEqual({});
    expect(data.findOutputs('DeliveryDbReaderRoleArn')).toEqual({});
    const operator = rolePolicies(data, 'soma-376-dev-db-operator');
    expect(operator.actions).toEqual(['ssm:ResumeSession', 'ssm:StartSession', 'ssm:StartSession', 'ssm:TerminateSession', 'ssmmessages:OpenDataChannel']);
  });
});
