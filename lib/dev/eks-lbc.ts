import { ArnFormat, CfnOutput, Stack } from 'aws-cdk-lib/core';
import { CfnPodIdentityAssociation } from 'aws-cdk-lib/aws-eks';
import { PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export const DEV_EKS_LBC_SERVICE_ACCOUNT = 'aws-load-balancer-controller';
export const DEV_EKS_LBC_NAMESPACE = 'kube-system';
export const DEV_EKS_TARGET_GROUP_PREFIX = 'soma-376-dev-eks-';
export const DEV_EKS_TARGET_GROUP_CLUSTER_TAG = 'pulsemetry:eks-cluster';

export interface DevEksLbcProps {
  readonly clusterName: string;
  readonly namespace?: string;
}

/**
 * CDK가 소유한 dev EKS TG의 target 등록만 허용한다(ADR-0028).
 *
 * Edge의 TG construct를 참조하지 않고 같은 계정·리전의 이름 접두사와 소유 태그로
 * 제한하므로 EKS → Edge 의존을 만들지 않는다. ALB/TG/listener·SG 쓰기 권한은 없다.
 * Helm이 ServiceAccount를 만들고 Pod Identity가 이 역할을 연결한다.
 */
export class DevEksLbc extends Construct {
  public readonly role: Role;
  public readonly association: CfnPodIdentityAssociation;

  constructor(scope: Construct, id: string, props: DevEksLbcProps) {
    super(scope, id);
    const stack = Stack.of(this);
    const namespace = props.namespace ?? DEV_EKS_LBC_NAMESPACE;
    const clusterArn = stack.formatArn({
      service: 'eks',
      resource: 'cluster',
      resourceName: props.clusterName,
      arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
    });

    this.role = new Role(this, 'Role', {
      description: 'Register dev EKS targets in CDK-owned target groups only',
      assumedBy: new ServicePrincipal('pods.eks.amazonaws.com')
        .withSessionTags()
        .withConditions({
          StringEquals: {
            'aws:RequestTag/eks-cluster-arn': clusterArn,
            'aws:RequestTag/kubernetes-namespace': namespace,
            'aws:RequestTag/kubernetes-service-account': DEV_EKS_LBC_SERVICE_ACCOUNT,
          },
        }),
    });

    // 고정 v3.6.0의 TGB webhook/health 조회, IP target의 VPC CIDR 확인,
    // networking 미지정 TGB도 수행하는 SG GC 조회에 필요한 읽기 API만 허용한다.
    // 이 Describe API는 IAM resource-level 권한을 지원하지 않는다.
    this.role.addToPolicy(new PolicyStatement({
      actions: [
        'elasticloadbalancing:DescribeTargetGroups',
        'elasticloadbalancing:DescribeTargetHealth',
        'ec2:DescribeVpcs',
        'ec2:DescribeSecurityGroups',
      ],
      resources: ['*'],
      conditions: { StringEquals: { 'aws:RequestedRegion': stack.region } },
    }));

    this.role.addToPolicy(new PolicyStatement({
      actions: [
        'elasticloadbalancing:RegisterTargets',
        'elasticloadbalancing:DeregisterTargets',
      ],
      resources: [stack.formatArn({
        service: 'elasticloadbalancing',
        resource: 'targetgroup',
        resourceName: `${DEV_EKS_TARGET_GROUP_PREFIX}*/*`,
        arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
      })],
      conditions: {
        StringEquals: {
          [`aws:ResourceTag/${DEV_EKS_TARGET_GROUP_CLUSTER_TAG}`]: props.clusterName,
          'aws:RequestedRegion': stack.region,
        },
      },
    }));

    this.association = new CfnPodIdentityAssociation(this, 'PodIdentity', {
      clusterName: props.clusterName,
      namespace,
      serviceAccount: DEV_EKS_LBC_SERVICE_ACCOUNT,
      roleArn: this.role.roleArn,
      // trust가 EKS session tag를 검사하므로 비활성화하면 역할을 맡을 수 없다.
      disableSessionTags: false,
    });

    const output = new CfnOutput(this, 'RoleArn', {
      value: this.role.roleArn,
      description: 'Pod Identity role for the Helm OSS AWS Load Balancer Controller',
    });
    output.overrideLogicalId('EksLbcRoleArn');
  }
}
