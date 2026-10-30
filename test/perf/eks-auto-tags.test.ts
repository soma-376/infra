import { Template } from 'aws-cdk-lib/assertions';
import { buildPerfApp, TEST_ENV } from '../helpers';
import { ENVIRONMENT_ID } from './perf-fixtures';

const profile = 'profiles/perf/strimzi-fixed-v1.json';
const cluster = 'soma-376-perf-eks';
const owner = 'pulsemetry:perf-environment';
const pools = ['gateway', 'pipeline', 'clickhouse', 'generator', 'observability', 'system', 'kafka'];
const arn = (kind: string) => `arn:aws:ec2:${TEST_ENV.region}:${TEST_ENV.account}:${kind}/*`;

test('Auto Mode 추가 권한은 고정 owner·cluster·서울·계정 및 생성 자원으로 제한한다', () => {
  const template = Template.fromStack(buildPerfApp({ perfProfile: profile }).eks);
  const statements = Object.values(template.findResources('AWS::IAM::Policy')).flatMap((p: any) => p.Properties.PolicyDocument.Statement);
  const owned = statements.filter((s: any) => s.Sid?.startsWith('PerfOwnedAutoMode'));
  expect(owned).toHaveLength(3);
  for (const statement of owned) {
    expect(statement.Effect).toBe('Allow');
    expect(statement.Condition.StringEquals).toMatchObject({
      'aws:RequestedRegion': TEST_ENV.region,
      'aws:PrincipalTag/eks:eks-cluster-name': cluster,
      'aws:RequestTag/eks:eks-cluster-name': cluster,
      [`aws:RequestTag/${owner}`]: ENVIRONMENT_ID,
    });
    for (const resource of [statement.Resource].flat()) expect(resource).toMatch(/^arn:aws:ec2:ap-northeast-2:111111111111:[a-z-]+\/\*$/);
  }
  // 태그 수정/삭제, snapshot/copy 등 실제 부팅에 필요 없는 권한을 추가하지 않는다.
  expect(owned.flatMap((s: any) => s.Action).sort()).toEqual([
    'ec2:CreateFleet', 'ec2:CreateLaunchTemplate', 'ec2:CreateNetworkInterface', 'ec2:CreateVolume', 'ec2:RunInstances',
  ]);
  const compute = owned.find((s: any) => s.Sid === 'PerfOwnedAutoModeCompute');
  expect(compute.Resource.sort()).toEqual(['instance', 'fleet', 'launch-template', 'volume', 'network-interface'].map(arn).sort());
  expect(compute.Condition.StringEquals['aws:RequestTag/pulsemetry:perf-pool'].sort()).toEqual([...pools].sort());
  expect(compute.Condition.StringEquals['aws:RequestTag/eks:kubernetes-node-class-name'].sort()).toEqual(pools.map(p => `perf-${p}`).sort());
  // NodeClass 최초 검사만 빈 pool 값을 사용한다. dev/임의 pool wildcard는 허용하지 않는다.
  expect(compute.Condition.StringEquals['aws:RequestTag/eks:kubernetes-node-pool-name'].sort()).toEqual(['', ...pools.map(p => `perf-${p}`)].sort());
  expect(compute.Condition['ForAllValues:StringEquals']['aws:TagKeys'].sort()).toEqual([
    'eks:eks-cluster-name', 'eks:kubernetes-node-class-name', 'eks:kubernetes-node-pool-name',
    `kubernetes.io/cluster/${cluster}`, owner, 'pulsemetry:perf-pool', 'aws:ec2:managed-launch',
  ].sort());
});

test('PVC는 owner만으로 생성하고 추가 ENI도 기존 CNI tag와 owner 범위를 넘지 않는다', () => {
  const template = Template.fromStack(buildPerfApp({ perfProfile: profile }).eks);
  const statements = Object.values(template.findResources('AWS::IAM::Policy')).flatMap((p: any) => p.Properties.PolicyDocument.Statement);
  const volume = statements.find((s: any) => s.Sid === 'PerfOwnedAutoModeVolume');
  expect(volume.Resource).toBe(arn('volume'));
  expect(volume.Condition.StringEquals['aws:RequestTag/pulsemetry:perf-pool']).toBeUndefined();
  expect(volume.Condition['ForAllValues:StringLike']['aws:TagKeys'].sort()).toEqual([
    'eks:eks-cluster-name', 'CSIVolumeName', 'ebs.csi.eks.amazonaws.com/cluster', `kubernetes.io/cluster/${cluster}`,
    'kubernetes.io/created-for/*', 'Name', 'KubernetesCluster', owner,
  ].sort());
  const network = statements.find((s: any) => s.Sid === 'PerfOwnedAutoModeNetworkInterface');
  expect(network.Resource).toBe(arn('network-interface'));
  expect(network.Condition.StringLike).toEqual({ 'aws:RequestTag/eks:kubernetes-cni-node-name': '*' });
  expect(network.Condition.StringEqualsIfExists['aws:RequestTag/pulsemetry:perf-pool'].sort()).toEqual([...pools].sort());
  expect(network.Condition['ForAllValues:StringEquals']['aws:TagKeys'].sort()).toEqual([
    'eks:eks-cluster-name', 'eks:kubernetes-cni-node-name', 'sgp.eks.amazonaws.com/instance-id',
    'sgp.eks.amazonaws.com/trunk-eni-id', 'sgp.eks.amazonaws.com/vlan-id', 'sgp.eks.amazonaws.com/managed',
    'sgp.eks.amazonaws.com/policy-ref', owner, 'pulsemetry:perf-pool',
  ].sort());
});

test('정리 guard는 실제 NodeRole을 SSM에 고정하고 자동 profile/LT 조회만 추가한다', () => {
  const built = buildPerfApp({ perfProfile: profile });
  const guard = Template.fromStack(built.guardrail!);
  const document: any = Object.values(guard.findResources('AWS::SSM::Document'))[0];
  expect(document.Properties.Content.parameters.nodeRoleName).toMatchObject({ type: 'String', allowedPattern: '^PerfEksStack-NodeRole[A-Za-z0-9-]+$' });
  expect(JSON.stringify(document.Properties.Content.mainSteps)).toContain("export PERF_CLEANUP_NODE_ROLE='{{ nodeRoleName }}'");
  const statements = Object.values(guard.findResources('AWS::IAM::Policy')).flatMap((p: any) => p.Properties.PolicyDocument.Statement);
  const iam = statements.filter((s: any) => [s.Action].flat().some((a: string) => a.startsWith('iam:')));
  expect(iam).toHaveLength(1);
  expect(iam[0]).toEqual({ Effect: 'Allow', Action: 'iam:ListInstanceProfilesForRole', Resource: `arn:aws:iam::${TEST_ENV.account}:role/PerfEksStack-NodeRole*` });
  const ec2 = statements.find((s: any) => [s.Action].flat().includes('ec2:DescribeLaunchTemplates'));
  expect(ec2.Condition).toEqual({ StringEquals: { 'aws:RequestedRegion': TEST_ENV.region } });
  expect(JSON.stringify(statements)).not.toMatch(/DeleteLaunchTemplate|DeleteInstanceProfile|RemoveRoleFromInstanceProfile/);
  expect(built.app.synth().getStackArtifact('PerfGuardrailStack').dependencies.filter(d => !d.id.endsWith('.assets'))).toHaveLength(0);
});
