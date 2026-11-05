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
    expect(statements.find(s => ([].concat(s.Action) as string[]).includes('sts:AssumeRole')).Resource.sort()).toEqual([
      `arn:aws:iam::${TEST_ENV.account}:role/${D.observerRoleName}`,
      `arn:aws:iam::${TEST_ENV.account}:role/${D.databaseReaderRoleName}`,
    ].sort());
    expect(statements.find(s => ([].concat(s.Action) as string[]).includes('ecr:DescribeImages')).Resource).toHaveLength(4);
  });
  test('EKS observer는 Secret 읽기·SSM 임의명령·클러스터 관리 정책을 갖지 않는다', () => {
    const { role, actions } = rolePolicies(eks, D.observerRoleName);
    expect(role.AssumeRolePolicyDocument.Statement[0].Principal.AWS).toBe(`arn:aws:iam::${TEST_ENV.account}:role/${D.promotionRoleName}`);
    expect(actions).toEqual(['eks:DescribeCluster', 'ssm:ResumeSession', 'ssm:StartSession', 'ssm:StartSession', 'ssm:TerminateSession', 'ssmmessages:OpenDataChannel']);
    expect(role.ManagedPolicyArns).toBeUndefined();
    eks.hasResourceProperties('AWS::EKS::AccessEntry', { KubernetesGroups: [D.kubernetesGroup], Type: 'STANDARD' });
  });
  test('DB 역할은 고정 터널과 별도 DB reader Secret만 읽는다', () => {
    const { statements, actions } = rolePolicies(data, D.databaseReaderRoleName);
    expect(actions).not.toEqual(expect.arrayContaining(['rds:*', 'secretsmanager:ListSecrets', 'ssm:SendCommand']));
    const secret = statements.find(s => ([].concat(s.Action) as string[]).includes('secretsmanager:GetSecretValue'));
    expect(secret.Resource).toBe(`arn:aws:secretsmanager:${TEST_ENV.region}:${TEST_ENV.account}:secret:pulsemetry/dev/deployment-verifier-db-reader-??????`);
    const metadata = statements.find(s => s.Action === 'secretsmanager:DescribeSecret');
    expect(metadata.Resource).toHaveLength(13);
    expect(JSON.stringify(metadata.Resource)).not.toContain('*');
    expect(statements.filter(s => ([].concat(s.Action) as string[]).includes('secretsmanager:GetSecretValue'))).toHaveLength(1);
  });
  test('검증 Pod는 ListBucket 최대 한 key만 받고 object data·쓰기는 없다', () => {
    const policies = Object.values(eks.findResources('AWS::IAM::Policy')).flatMap(p => p.Properties.PolicyDocument.Statement);
    const list = policies.find(s => ([].concat(s.Action) as string[]).includes('s3:ListBucket'));
    expect(list.Condition).toEqual({ StringLike: { 's3:prefix': 'eks_validation/claude_code/logs/*' }, NumericLessThanEquals: { 's3:max-keys': '1' } });
    const identities = Object.values(eks.findResources('AWS::EKS::PodIdentityAssociation'));
    expect(identities.filter(i => i.Properties.ServiceAccount === 'deployment-verifier')).toHaveLength(1);
  });
  test('검증 Pod는 자기 fixture 원문과 정확한 앱 Secret 버전 metadata만 읽는다', () => {
    const identity = Object.values(eks.findResources('AWS::EKS::PodIdentityAssociation'))
      .find(item => item.Properties.ServiceAccount === D.serviceAccount)!;
    const roleId = identity.Properties.RoleArn['Fn::GetAtt'][0];
    const statements = Object.values(eks.findResources('AWS::IAM::Policy'))
      .filter(policy => policy.Properties.Roles?.some((ref: any) => ref.Ref === roleId))
      .flatMap(policy => policy.Properties.PolicyDocument.Statement);
    const value = statements.filter(s => ([].concat(s.Action) as string[]).includes('secretsmanager:GetSecretValue'));
    expect(value).toHaveLength(1);
    expect(value[0].Resource).toBe(`arn:aws:secretsmanager:${TEST_ENV.region}:${TEST_ENV.account}:secret:${D.probeSecretName}-??????`);
    const metadata = statements.filter(s => s.Action === 'secretsmanager:DescribeSecret');
    expect(metadata).toHaveLength(1);
    expect(metadata[0].Resource).toHaveLength(13);
    expect(JSON.stringify(metadata[0].Resource)).not.toMatch(/[?*]/);
    expect(statements.flatMap(s => s.Action).sort()).toEqual([
      's3:ListBucket', 'secretsmanager:DescribeSecret', 'secretsmanager:DescribeSecret', 'secretsmanager:GetSecretValue',
    ]);
  });
});
