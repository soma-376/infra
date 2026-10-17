import { Match, Template } from 'aws-cdk-lib/assertions';
import { buildDevApp, TEST_ENV } from '../helpers';

export const EKS_CONTEXT = {
  devEksEnabled: true,
  devEksApiAllowedCidrs: '203.0.113.10/32',
};

test('기본 구성은 EKS 및 EKS 전용 SG를 생성하지 않는다', () => {
  const built = buildDevApp();
  expect(built.eks).toBeUndefined();
  Template.fromStack(built.network).resourceCountIs('AWS::EC2::SecurityGroup', 4);
  expect(built.app.synth().stacks).toHaveLength(4);
});

test('Auto Mode 5스택과 명시적인 operator/node 접근만 구성한다', () => {
  const built = buildDevApp(EKS_CONTEXT);
  const template = Template.fromStack(built.eks!);
  template.hasResourceProperties('AWS::EKS::Cluster', {
    Name: 'soma-376-dev-eks', Version: '1.36',
    AccessConfig: { AuthenticationMode: 'API', BootstrapClusterCreatorAdminPermissions: false },
    ComputeConfig: { Enabled: true, NodePools: [] },
    BootstrapSelfManagedAddons: false,
    ResourcesVpcConfig: Match.objectLike({ EndpointPrivateAccess: true, EndpointPublicAccess: true, PublicAccessCidrs: ['203.0.113.10/32'] }),
    StorageConfig: { BlockStorage: { Enabled: true } },
    KubernetesNetworkConfig: { IpFamily: 'ipv4', ElasticLoadBalancing: { Enabled: true } },
  });
  template.hasOutput('EksDashboardApiNodePort', { Value: '30081' });
  template.resourceCountIs('AWS::EKS::AccessEntry', 2);
  template.hasResourceProperties('AWS::EKS::AccessEntry', {
    Type: 'EC2', AccessPolicies: [{ AccessScope: { Type: 'cluster' }, PolicyArn: 'arn:aws:eks::aws:cluster-access-policy/AmazonEKSAutoNodePolicy' }],
  });
  template.resourceCountIs('AWS::Lambda::Function', 0);
  const assembly = built.app.synth();
  expect(assembly.stacks).toHaveLength(5);
  const artifact = assembly.getStackArtifact(built.eks!.artifactId);
  const dependencyIds = artifact.dependencies.map(dep => dep.id);
  expect(dependencyIds).toContain('DevNetworkStack');
  expect(dependencyIds).not.toContain('DevApplicationStack');
  expect(dependencyIds).not.toContain('DevEdgeStack');
});

test('운영자 role을 생성하고 같은 계정 trust와 클러스터 관리 범위를 연결한다', () => {
  const built = buildDevApp(EKS_CONTEXT);
  const template = Template.fromStack(built.eks!);
  const roleIds = Object.keys(template.findResources('AWS::IAM::Role', {
    Properties: { RoleName: 'soma-376-dev-eks-operator' },
  }));
  expect(roleIds).toHaveLength(1);
  const roleId = roleIds[0];
  const role = template.toJSON().Resources[roleId].Properties;
  expect(role.ManagedPolicyArns).toBeUndefined();
  expect(role.Policies).toBeUndefined();
  const attachedPolicies = Object.values(template.findResources('AWS::IAM::Policy'))
    .filter((resource: any) => resource.Properties.Roles?.some((ref: any) => ref.Ref === roleId));
  expect(attachedPolicies).toHaveLength(1);
  const clusterId = Object.keys(template.findResources('AWS::EKS::Cluster'))[0];
  template.hasResourceProperties('AWS::IAM::Role', {
    RoleName: 'soma-376-dev-eks-operator',
    AssumeRolePolicyDocument: {
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Action: 'sts:AssumeRole', Principal: { AWS: `arn:aws:iam::${TEST_ENV.account}:root` } }],
    },
  });
  template.hasResourceProperties('AWS::IAM::Policy', {
    Roles: [{ Ref: roleId }],
    PolicyDocument: {
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Action: 'eks:DescribeCluster', Resource: { 'Fn::GetAtt': [clusterId, 'Arn'] } }],
    },
  });
  template.hasResourceProperties('AWS::EKS::AccessEntry', {
    Type: 'STANDARD', PrincipalArn: { 'Fn::GetAtt': [roleId, 'Arn'] },
    AccessPolicies: [{ AccessScope: { Type: 'cluster' }, PolicyArn: 'arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy' }],
  });
  template.hasOutput('EksOperatorRoleArn', { Value: { 'Fn::GetAtt': [roleId, 'Arn'] } });
  template.hasOutput('EksOperatorRoleName', { Value: { Ref: roleId } });
});

test('추가 SG 규칙은 Network에만 생기고 기존 리소스 속성은 보존한다', () => {
  const before = buildDevApp();
  const after = buildDevApp(EKS_CONTEXT);
  for (const key of ['network', 'data', 'application', 'edge'] as const) {
    const baseline = Template.fromStack(before[key]).toJSON();
    const changed = Template.fromStack(after[key]).toJSON();
    for (const [id, resource] of Object.entries(baseline.Resources)) expect(changed.Resources[id]).toEqual(resource);
    if (key !== 'network') expect(Object.values(changed.Resources).filter((r: any) => r.Type.startsWith('AWS::EC2::SecurityGroup'))).toEqual([]);
  }
  const network = Template.fromStack(after.network);
  network.resourceCountIs('AWS::EC2::SecurityGroup', 8);
  for (const port of [30416, 30080, 8123, 5432, 9443, 10250]) {
    network.hasResourceProperties('AWS::EC2::SecurityGroupIngress', { FromPort: port, ToPort: port, SourceSecurityGroupId: Match.anyValue() });
  }
});

test.each([
  {devEksEnabled: 'typo'},
  {devEksEnabled: true},
  {...EKS_CONTEXT, devEksApiAllowedCidrs: '0.0.0.0/0'},
  {...EKS_CONTEXT, devEksApiAllowedCidrs: 'wrong/32'},
  {...EKS_CONTEXT, devEksApiAllowedCidrs: '203.0.113.1/33'},
  {...EKS_CONTEXT, devEksArchivePrefix: 'eks_validation/'},
])('활성화 필수 입력과 prefix 오류를 거부한다: %j', context => {
  expect(() => buildDevApp(context)).toThrow(/devEks/);
});
