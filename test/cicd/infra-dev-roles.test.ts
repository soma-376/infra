import { Template } from 'aws-cdk-lib/assertions';
import { INFRA_DEV_CICD } from '../../lib/cicd/infra-dev-roles';
import { buildCicdApp } from '../helpers';

interface PermissionStatement {
  readonly Action: string | string[];
  readonly Resource: string | string[];
  readonly Effect: string;
  readonly Condition?: Record<string, Record<string, string>>;
}

interface RoleResource {
  readonly Properties: {
    readonly RoleName: string;
    readonly Description: string;
    readonly MaxSessionDuration: number;
    readonly ManagedPolicyArns?: unknown;
    readonly Policies?: unknown;
    readonly AssumeRolePolicyDocument: {
      readonly Statement: {
        readonly Action: string;
        readonly Effect: string;
        readonly Principal: { readonly Federated: unknown };
        readonly Condition: Record<string, Record<string, string | string[]>>;
      }[];
    };
  };
}

interface PolicyResource {
  readonly Properties: {
    readonly Roles: { readonly Ref: string }[];
    readonly PolicyDocument: { readonly Statement: PermissionStatement[] };
  };
}

const asArray = <T>(value: T | T[]): T[] => Array.isArray(value) ? value : [value];
const STACK_ARNS = ['DevNetworkStack', 'DevDataStack', 'DevEdgeStack', 'DevEksStack']
  .map(name => `arn:aws:cloudformation:ap-northeast-2:111111111111:stack/${name}/*`);
const LEGACY_STACK_ARN = 'arn:aws:cloudformation:ap-northeast-2:111111111111:stack/DevApplicationStack/*';

describe('infra dev CloudFormation 역할 (ADR-0048)', () => {
  const { deploy } = buildCicdApp();
  const template = Template.fromStack(deploy);
  const roleNames = [INFRA_DEV_CICD.diffRoleName, INFRA_DEV_CICD.deployRoleName];

  const role = (name: string): [string, RoleResource] => {
    const found = Object.entries(template.findResources('AWS::IAM::Role'))
      .find(([, resource]) => resource.Properties.RoleName === name);
    expect(found).toBeDefined();
    return found as [string, RoleResource];
  };
  const statements = (name: string): PermissionStatement[] => {
    const [id] = role(name);
    return (Object.values(template.findResources('AWS::IAM::Policy')) as PolicyResource[])
      .filter(resource => resource.Properties.Roles.some(reference => reference.Ref === id))
      .flatMap(resource => resource.Properties.PolicyDocument.Statement);
  };
  const resourcesFor = (name: string, action: string): string[] => statements(name)
    .filter(statement => asArray(statement.Action).includes(action))
    .flatMap(statement => asArray(statement.Resource))
    .sort();
  const actionsFor = (name: string): string[] => [...new Set(statements(name)
    .flatMap(statement => asArray(statement.Action)))].sort();

  test.each([
    [INFRA_DEV_CICD.diffRoleName, ['infra-dev-pr-plan', 'infra-dev-plan']],
    [INFRA_DEV_CICD.deployRoleName, ['infra-dev-deploy']],
  ] as const)('%s는 infra 저장소의 지정 Environment subject만 신뢰한다', (name, environments) => {
    const trust = role(name)[1].Properties.AssumeRolePolicyDocument.Statement;
    expect(trust).toHaveLength(1);
    expect(trust[0].Effect).toBe('Allow');
    expect(trust[0].Action).toBe('sts:AssumeRoleWithWebIdentity');
    expect(Object.keys(trust[0].Condition)).toEqual(['StringEquals']);
    expect(trust[0].Condition.StringEquals['token.actions.githubusercontent.com:aud']).toBe('sts.amazonaws.com');
    expect(asArray(trust[0].Condition.StringEquals['token.actions.githubusercontent.com:sub']).sort()).toEqual(
      environments.map(environment => `repo:soma-376@297555253/infra@1310491235:environment:${environment}`).sort(),
    );
    const [providerId] = Object.keys(template.findResources('AWS::IAM::OIDCProvider'));
    expect(trust[0].Principal.Federated).toEqual({ Ref: providerId });
  });

  test.each(roleNames)('%s는 1시간 세션과 영문 description을 쓰고 managed policy를 추가하지 않는다', name => {
    const properties = role(name)[1].Properties;
    expect(properties.MaxSessionDuration).toBe(3600);
    expect(properties.Description).toMatch(/^[\x20-\x7e]+$/);
    expect(properties.ManagedPolicyArns).toBeUndefined();
    expect(properties.Policies).toBeUndefined();
  });

  test.each(roleNames)('%s는 네 dev 스택의 baseline과 과거 Application의 존재만 읽는다', name => {
    expect(resourcesFor(name, 'cloudformation:GetTemplate')).toEqual([...STACK_ARNS].sort());
    expect(resourcesFor(name, 'cloudformation:DescribeStacks')).toEqual([...STACK_ARNS, LEGACY_STACK_ARN].sort());
  });

  test.each(roleNames)('%s의 유일한 전체 리소스 권한은 서울 AZ 조회다', name => {
    const wildcard = statements(name).filter(statement => asArray(statement.Resource).includes('*'));
    expect(wildcard).toHaveLength(1);
    expect(asArray(wildcard[0].Action)).toEqual(['ec2:DescribeAvailabilityZones']);
    expect(wildcard[0].Condition).toEqual({ StringEquals: { 'aws:RequestedRegion': 'ap-northeast-2' } });
  });

  test('diff에는 직접 조회 세 액션만 있고 AssumeRole·Secret·쓰기 권한이 없다', () => {
    expect(actionsFor(INFRA_DEV_CICD.diffRoleName)).toEqual([
      'cloudformation:DescribeStacks', 'cloudformation:GetTemplate', 'ec2:DescribeAvailabilityZones',
    ].sort());
  });

  test('deploy는 dev 배포 결과 조회와 기존 bootstrap 역할 세 개 진입만 더한다', () => {
    expect(actionsFor(INFRA_DEV_CICD.deployRoleName)).toEqual([
      'cloudformation:DescribeStackEvents', 'cloudformation:DescribeStacks', 'cloudformation:GetTemplate',
      'ec2:DescribeAvailabilityZones', 'sts:AssumeRole',
    ].sort());
    expect(resourcesFor(INFRA_DEV_CICD.deployRoleName, 'cloudformation:DescribeStackEvents')).toEqual([...STACK_ARNS].sort());
    expect(resourcesFor(INFRA_DEV_CICD.deployRoleName, 'sts:AssumeRole')).toEqual([
      'arn:aws:iam::111111111111:role/cdk-hnb659fds-deploy-role-111111111111-ap-northeast-2',
      'arn:aws:iam::111111111111:role/cdk-hnb659fds-file-publishing-role-111111111111-ap-northeast-2',
      'arn:aws:iam::111111111111:role/cdk-hnb659fds-lookup-role-111111111111-ap-northeast-2',
    ].sort());
  });

  test('기존 앱 역할 맵과 신규 역할 속성을 분리하고 고정 output을 제공한다', () => {
    expect(Object.keys(deploy.deployRoles)).toHaveLength(4);
    expect(deploy.resolve(deploy.infraDevRoles.diff.roleArn)).toEqual({ 'Fn::GetAtt': [role(INFRA_DEV_CICD.diffRoleName)[0], 'Arn'] });
    expect(deploy.resolve(deploy.infraDevRoles.deploy.roleArn)).toEqual({ 'Fn::GetAtt': [role(INFRA_DEV_CICD.deployRoleName)[0], 'Arn'] });
    for (const [name, output] of [
      [INFRA_DEV_CICD.diffRoleName, 'InfraDevDiffRoleArn'],
      [INFRA_DEV_CICD.deployRoleName, 'InfraDevDeployRoleArn'],
    ]) {
      expect(template.findOutputs(output)[output].Value).toEqual({ 'Fn::GetAtt': [role(name)[0], 'Arn'] });
    }
  });
});
