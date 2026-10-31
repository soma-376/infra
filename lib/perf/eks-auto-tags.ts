import { ArnFormat, Stack } from 'aws-cdk-lib/core';
import { PolicyStatement, Role } from 'aws-cdk-lib/aws-iam';
import { PERF_EKS_CLUSTER_NAME, PERF_ENVIRONMENT_TAG, perfNodePoolName } from './config';
import { PerfProfile, perfPoolIds } from './profile';

/**
 * AWS 관리형 Auto Mode 정책의 tag-key 제한에 perf 소유 태그만 보완한다.
 * 생성 시 CreateTags는 기존 관리형 정책이 허용한다. 기존 자원 태그 변경/삭제 권한은 추가하지 않는다.
 * https://docs.aws.amazon.com/eks/latest/userguide/auto-cluster-iam-role.html#tag-prop
 */
export function allowPerfAutoModeOwnerTags(stack: Stack, role: Role, profile: PerfProfile, environmentId: string): void {
  const resource = (type: string) => stack.formatArn({ service: 'ec2', resource: type, resourceName: '*', arnFormat: ArnFormat.SLASH_RESOURCE_NAME });
  const pools = perfPoolIds(profile);
  const names = pools.map(perfNodePoolName);
  const requiredTags = {
    'aws:RequestedRegion': stack.region,
    'aws:PrincipalTag/eks:eks-cluster-name': PERF_EKS_CLUSTER_NAME,
    'aws:RequestTag/eks:eks-cluster-name': PERF_EKS_CLUSTER_NAME,
    [`aws:RequestTag/${PERF_ENVIRONMENT_TAG}`]: environmentId,
  };
  role.addToPolicy(new PolicyStatement({
    sid: 'PerfOwnedAutoModeCompute',
    actions: ['ec2:CreateFleet', 'ec2:RunInstances', 'ec2:CreateLaunchTemplate'],
    resources: ['instance', 'fleet', 'launch-template', 'volume', 'network-interface'].map(resource),
    conditions: {
      StringEquals: { ...requiredTags, 'aws:RequestTag/pulsemetry:perf-pool': pools,
        'aws:RequestTag/eks:kubernetes-node-class-name': names,
        // 실제 NodeClass 최초 권한 검사에는 NodePool이 아직 없어 빈 값이 전달된다.
        'aws:RequestTag/eks:kubernetes-node-pool-name': ['', ...names] },
      'ForAllValues:StringEquals': { 'aws:TagKeys': ['eks:eks-cluster-name', 'eks:kubernetes-node-class-name',
        'eks:kubernetes-node-pool-name', `kubernetes.io/cluster/${PERF_EKS_CLUSTER_NAME}`,
        PERF_ENVIRONMENT_TAG, 'pulsemetry:perf-pool', 'aws:ec2:managed-launch'] },
    },
  }));
  role.addToPolicy(new PolicyStatement({
    sid: 'PerfOwnedAutoModeVolume', actions: ['ec2:CreateVolume'], resources: [resource('volume')],
    conditions: {
      StringEquals: requiredTags,
      // StorageClass는 owner만 붙인다. compute 전용 pool 태그를 PVC에 요구하지 않는다.
      'ForAllValues:StringLike': { 'aws:TagKeys': ['eks:eks-cluster-name', 'CSIVolumeName', 'ebs.csi.eks.amazonaws.com/cluster',
        `kubernetes.io/cluster/${PERF_EKS_CLUSTER_NAME}`, 'kubernetes.io/created-for/*', 'Name', 'KubernetesCluster', PERF_ENVIRONMENT_TAG] },
    },
  }));
  role.addToPolicy(new PolicyStatement({
    sid: 'PerfOwnedAutoModeNetworkInterface', actions: ['ec2:CreateNetworkInterface'], resources: [resource('network-interface')],
    conditions: {
      StringEquals: requiredTags,
      StringEqualsIfExists: { 'aws:RequestTag/pulsemetry:perf-pool': pools },
      StringLike: { 'aws:RequestTag/eks:kubernetes-cni-node-name': '*' },
      'ForAllValues:StringEquals': { 'aws:TagKeys': ['eks:eks-cluster-name', 'eks:kubernetes-cni-node-name',
        'sgp.eks.amazonaws.com/instance-id', 'sgp.eks.amazonaws.com/trunk-eni-id', 'sgp.eks.amazonaws.com/vlan-id',
        'sgp.eks.amazonaws.com/managed', 'sgp.eks.amazonaws.com/policy-ref', PERF_ENVIRONMENT_TAG, 'pulsemetry:perf-pool'] },
    },
  }));
}
