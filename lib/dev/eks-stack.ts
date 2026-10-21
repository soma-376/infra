import { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import { IBucket } from 'aws-cdk-lib/aws-s3';
import { DevEksRuntime } from './eks-runtime';
import { DevEksLbc } from './eks-lbc';
import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib/core';
import { IVpc, ISecurityGroup } from 'aws-cdk-lib/aws-ec2';
import { CfnAccessEntry, CfnCluster } from 'aws-cdk-lib/aws-eks';
import { AccountPrincipal, ManagedPolicy, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { DEV_EKS_CLUSTER_NAME, DEV_EKS_OPERATOR_ROLE_NAME, DEV_EKS_VERSION, DevEksConfig } from './eks-config';

export interface DevEksStackProps extends StackProps {
  readonly dbEndpoint: string;
  readonly dbSecret: ISecret;
  readonly tokenHashSecret: ISecret;
  readonly adminApiTokenSecret: ISecret;
  readonly rawSignalBucket: IBucket;
  readonly vpc: IVpc;
  readonly controlPlaneSecurityGroup: ISecurityGroup;
  readonly appNodeSecurityGroup: ISecurityGroup;
  readonly clickhouseNodeSecurityGroup: ISecurityGroup;
  readonly config: DevEksConfig;
}

/** AWS만 선언한다. Kubernetes 적용용 Lambda나 kubectl provider는 만들지 않는다. */
export class DevEksStack extends Stack {
  public readonly cluster: CfnCluster;
  public readonly nodeRole: Role;
  public readonly operatorRole: Role;

  constructor(scope: Construct, id: string, props: DevEksStackProps) {
    super(scope, id, props);
    const clusterRole = new Role(this, 'ClusterRole', {
      assumedBy: new ServicePrincipal('eks.amazonaws.com').withSessionTags(),
      description: 'dev EKS Auto Mode cluster service role',
      managedPolicies: [
        'AmazonEKSClusterPolicy', 'AmazonEKSComputePolicy',
        'AmazonEKSBlockStoragePolicyV2', 'AmazonEKSNetworkingPolicy', 'AmazonEKSLoadBalancingPolicy',
      ].map(name => ManagedPolicy.fromAwsManagedPolicyName(name)),
    });
    this.nodeRole = new Role(this, 'NodeRole', {
      assumedBy: new ServicePrincipal('ec2.amazonaws.com'),
      description: 'dev EKS Auto Mode node role',
      managedPolicies: ['AmazonEKSWorkerNodeMinimalPolicy', 'AmazonEC2ContainerRegistryPullOnly']
        .map(name => ManagedPolicy.fromAwsManagedPolicyName(name)),
    });
    this.cluster = new CfnCluster(this, 'Cluster', {
      name: DEV_EKS_CLUSTER_NAME,
      version: DEV_EKS_VERSION,
      roleArn: clusterRole.roleArn,
      accessConfig: { authenticationMode: 'API', bootstrapClusterCreatorAdminPermissions: false },
      resourcesVpcConfig: {
        subnetIds: props.vpc.publicSubnets.map(subnet => subnet.subnetId),
        securityGroupIds: [props.controlPlaneSecurityGroup.securityGroupId],
        endpointPrivateAccess: true, endpointPublicAccess: true,
        publicAccessCidrs: props.config.publicAccessCidrs,
      },
      // custom NodeClass가 role을 선택한다. 기본 NodePool의 암묵적 AccessEntry와 중복시키지 않는다.
      computeConfig: { enabled: true, nodePools: [] },
      kubernetesNetworkConfig: { ipFamily: 'ipv4', elasticLoadBalancing: { enabled: true } },
      storageConfig: { blockStorage: { enabled: true } },
      bootstrapSelfManagedAddons: false,
      logging: { clusterLogging: { enabledTypes: ['api', 'audit', 'authenticator', 'controllerManager', 'scheduler'].map(type => ({ type })) } },
    });
    // 자동 생성 node entry가 없는 custom NodeClass role을 명시적으로 허용한다.
    new CfnAccessEntry(this, 'NodeAccess', {
      clusterName: this.cluster.ref, principalArn: this.nodeRole.roleArn, type: 'EC2',
      accessPolicies: [{ policyArn: `arn:${this.partition}:eks::aws:cluster-access-policy/AmazonEKSAutoNodePolicy`, accessScope: { type: 'cluster' } }],
    });
    // 같은 계정의 IAM이 운영자를 지정한다. 호출 주체에는 이 role의 sts:AssumeRole 권한이 필요하다.
    this.operatorRole = new Role(this, 'OperatorRole', {
      roleName: DEV_EKS_OPERATOR_ROLE_NAME,
      assumedBy: new AccountPrincipal(this.account),
      description: 'dev EKS operator role for kubectl and Helm',
    });
    this.operatorRole.addToPolicy(new PolicyStatement({
      actions: ['eks:DescribeCluster'], resources: [this.cluster.attrArn],
    }));
    new CfnAccessEntry(this, 'OperatorAccess', {
      clusterName: this.cluster.ref, principalArn: this.operatorRole.roleArn, type: 'STANDARD',
      accessPolicies: [{ policyArn: `arn:${this.partition}:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy`, accessScope: { type: 'cluster' } }],
    });
    new DevEksLbc(this, 'Lbc', { clusterName: this.cluster.ref });
    new DevEksRuntime(this, 'Runtime', {
      clusterName: this.cluster.ref, dbSecret: props.dbSecret,
      tokenHashSecret: props.tokenHashSecret, adminApiTokenSecret: props.adminApiTokenSecret,
      rawSignalBucket: props.rawSignalBucket, archivePrefix: props.config.archivePrefix,
    });

    const outputs: Record<string, string> = {
      DbEndpoint: props.dbEndpoint, DbSecretArn: props.dbSecret.secretArn,
      TokenHashSecretArn: props.tokenHashSecret.secretArn,
      AdminApiTokenSecretArn: props.adminApiTokenSecret.secretArn,
      RawSignalBucketName: props.rawSignalBucket.bucketName,
      EksClusterName: this.cluster.ref, EksClusterEndpoint: this.cluster.attrEndpoint,
      EksRegion: this.region, EksVpcId: props.vpc.vpcId,
      EksSubnetIds: props.vpc.publicSubnets.map(subnet => subnet.subnetId).join(','),
      EksClickhouseAvailabilityZone: props.vpc.publicSubnets[0].availabilityZone,
      EksAppNodeSecurityGroupId: props.appNodeSecurityGroup.securityGroupId,
      EksClickhouseNodeSecurityGroupId: props.clickhouseNodeSecurityGroup.securityGroupId,
      EksControlPlaneSecurityGroupId: props.controlPlaneSecurityGroup.securityGroupId,
      EksNodeRoleArn: this.nodeRole.roleArn, EksNodeRoleName: this.nodeRole.roleName,
      EksOperatorRoleArn: this.operatorRole.roleArn, EksOperatorRoleName: this.operatorRole.roleName,
    };
    for (const [name, value] of Object.entries(outputs)) {
      new CfnOutput(this, name, { value }).overrideLogicalId(name);
    }
  }
}
