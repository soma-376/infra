import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib/core';
import { ISecurityGroup, ISubnet, IVpc } from 'aws-cdk-lib/aws-ec2';
import { CfnAccessEntry, CfnCluster } from 'aws-cdk-lib/aws-eks';
import { AccountPrincipal, ManagedPolicy, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { ILogGroup, LogGroup } from 'aws-cdk-lib/aws-logs';
import { BlockPublicAccess, Bucket, BucketEncryption, IBucket } from 'aws-cdk-lib/aws-s3';
import { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import { CfnCluster as MskCluster } from 'aws-cdk-lib/aws-msk';
import { Construct } from 'constructs';
import {
  PERF_EKS_CLUSTER_NAME, PERF_EKS_CONTROL_PLANE_LOG_GROUP, PERF_EKS_OPERATOR_ROLE_NAME, PERF_NAMESPACES,
} from './config';
import { PerfEksLbc } from './eks-lbc';
import { allowPerfAutoModeOwnerTags } from './eks-auto-tags';
import { PerfEksAccess } from './eks-access';
import { PerfEksRelay } from './eks-relay';
import { perfPoolIds, PerfPoolId, PerfProfile } from './profile';
import { perfLogRetention } from './retention';

export interface PerfEksStackProps extends StackProps {
  readonly profile: PerfProfile;
  readonly httpsGateway?: boolean;
  readonly cleanupEnabled?: boolean;
  /** 결과 파일 생산자가 요청과 대조할 배포 입력. 값은 비밀이 아니다. */
  readonly provenance: { readonly environmentId: string; readonly profilePath: string; readonly profileSha256: string; readonly parameters: Readonly<Record<string, string | number>> };
  readonly vpc: IVpc;
  readonly controlPlaneSubnets: readonly ISubnet[];
  readonly nodeSubnets: readonly ISubnet[];
  readonly controlPlaneSecurityGroup: ISecurityGroup;
  readonly relaySecurityGroup: ISecurityGroup;
  readonly nodeSecurityGroup: ISecurityGroup;
  readonly poolSecurityGroups: Readonly<Record<PerfPoolId, ISecurityGroup>>;
  readonly secrets: PerfEksAccessSecrets;
  readonly rawSignalBucket: IBucket;
  readonly evidenceBucket: IBucket;
  readonly msk?: { readonly cluster: MskCluster; readonly topicArn: string; readonly consumerGroupArn: string; readonly logGroup: ILogGroup };
}

type PerfEksAccessSecrets = {
  readonly db: ISecret; readonly tokenHash: ISecret; readonly adminApiToken: ISecret;
  readonly telemetryJwtPrivateKey: ISecret; readonly telemetryJwtPublicKeys: ISecret;
  readonly syntheticSeed: ISecret; readonly seedDb: ISecret; readonly verifyDb: ISecret; readonly grafanaAdmin: ISecret;
};

/**
 * PerfEksStack: private API 전용 EKS Auto Mode cluster, 노드·운영자 역할, SSM relay, Pod Identity와 로그 그룹.
 * AWS만 선언한다. NodeClass·NodePool·workload는 Helm(`helm/perf`)이 소유한다. kubectl provider·Lambda는 없다.
 */
export class PerfEksStack extends Stack {
  public readonly cluster: CfnCluster;
  public readonly nodeRole: Role;
  public readonly operatorRole: Role;
  public readonly access: PerfEksAccess;

  constructor(scope: Construct, id: string, props: PerfEksStackProps) {
    super(scope, id, props);
    if (props.nodeSubnets.length !== 1) throw new Error('perf 노드 subnet은 프로필 AZ의 private subnet 하나다');
    const retention = perfLogRetention(props.profile.retention.cloudwatch_log_days);
    const logGroup = (constructId: string, logGroupName: string) => new LogGroup(this, constructId, {
      logGroupName, retention, removalPolicy: RemovalPolicy.DESTROY,
    });
    // EKS가 쓰기 전에 만들어 보존 기간과 삭제를 소유한다. 없으면 EKS가 무기한 보존 그룹을 만든다.
    const controlPlaneLogs = logGroup('ControlPlaneLogs', PERF_EKS_CONTROL_PLANE_LOG_GROUP);
    const applicationLogs = logGroup('ApplicationLogs', '/eks/perf/application');
    const observabilityLogs = logGroup('ObservabilityLogs', '/eks/perf/observability');
    const eventLogs = logGroup('EventLogs', '/eks/perf/events');

    const clusterRole = new Role(this, 'ClusterRole', {
      assumedBy: new ServicePrincipal('eks.amazonaws.com').withSessionTags(),
      description: 'perf EKS Auto Mode cluster service role',
      // Auto Mode는 compute·block storage·load balancing을 함께 켜야 한다. perf는 LB 자원을 만들지 않는다.
      managedPolicies: [
        'AmazonEKSClusterPolicy', 'AmazonEKSComputePolicy',
        'AmazonEKSBlockStoragePolicyV2', 'AmazonEKSNetworkingPolicy', 'AmazonEKSLoadBalancingPolicy',
      ].map(name => ManagedPolicy.fromAwsManagedPolicyName(name)),
    });
    allowPerfAutoModeOwnerTags(this, clusterRole, props.profile, props.provenance.environmentId);
    this.nodeRole = new Role(this, 'NodeRole', {
      assumedBy: new ServicePrincipal('ec2.amazonaws.com'),
      description: 'perf EKS Auto Mode node role',
      managedPolicies: ['AmazonEKSWorkerNodeMinimalPolicy', 'AmazonEC2ContainerRegistryPullOnly']
        .map(name => ManagedPolicy.fromAwsManagedPolicyName(name)),
    });
    this.cluster = new CfnCluster(this, 'Cluster', {
      name: PERF_EKS_CLUSTER_NAME,
      version: props.profile.kubernetes_version,
      roleArn: clusterRole.roleArn,
      accessConfig: { authenticationMode: 'API', bootstrapClusterCreatorAdminPermissions: false },
      resourcesVpcConfig: {
        subnetIds: props.controlPlaneSubnets.map(subnet => subnet.subnetId),
        securityGroupIds: [props.controlPlaneSecurityGroup.securityGroupId],
        endpointPrivateAccess: true, endpointPublicAccess: false,
      },
      // custom NodeClass가 role을 고른다. 기본 NodePool(general-purpose·system)은 만들지 않는다.
      computeConfig: { enabled: true, nodePools: [] },
      kubernetesNetworkConfig: { ipFamily: 'ipv4', elasticLoadBalancing: { enabled: true } },
      storageConfig: { blockStorage: { enabled: true } },
      bootstrapSelfManagedAddons: false,
      logging: { clusterLogging: { enabledTypes: ['api', 'audit', 'authenticator', 'controllerManager', 'scheduler'].map(type => ({ type })) } },
    });
    this.cluster.node.addDependency(controlPlaneLogs);
    new CfnAccessEntry(this, 'NodeAccess', {
      clusterName: this.cluster.ref, principalArn: this.nodeRole.roleArn, type: 'EC2',
      accessPolicies: [{ policyArn: `arn:${this.partition}:eks::aws:cluster-access-policy/AmazonEKSAutoNodePolicy`, accessScope: { type: 'cluster' } }],
    });
    this.operatorRole = new Role(this, 'OperatorRole', {
      roleName: PERF_EKS_OPERATOR_ROLE_NAME,
      assumedBy: new AccountPrincipal(this.account),
      description: 'perf EKS operator role for kubectl, Helm and evidence',
    });
    this.operatorRole.addToPolicy(new PolicyStatement({ actions: ['eks:DescribeCluster'], resources: [this.cluster.attrArn] }));
    // 생성기 입력(get-bootstrap-brokers·list-nodes)과 결과 파일의 MSK 상태 조회만 연다.
    if (props.msk) this.operatorRole.addToPolicy(new PolicyStatement({
      actions: ['kafka:GetBootstrapBrokers', 'kafka:ListNodes', 'kafka:DescribeClusterV2'], resources: [props.msk.cluster.attrArn],
    }));
    new CfnAccessEntry(this, 'OperatorAccess', {
      clusterName: this.cluster.ref, principalArn: this.operatorRole.roleArn, type: 'STANDARD',
      accessPolicies: [{ policyArn: `arn:${this.partition}:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy`, accessScope: { type: 'cluster' } }],
    });
    // NodeDiagnostic bundle 업로드 대상(ADR-0037과 같은 방식). 환경과 함께 지운다.
    const diagnostics = new Bucket(this, 'Diagnostics', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL, encryption: BucketEncryption.S3_MANAGED, enforceSSL: true,
      lifecycleRules: [{ expiration: Duration.days(props.profile.retention.cloudwatch_log_days), abortIncompleteMultipartUploadAfter: Duration.days(1) }],
      autoDeleteObjects: true, removalPolicy: RemovalPolicy.DESTROY,
    });
    this.operatorRole.addToPolicy(new PolicyStatement({
      actions: ['s3:PutObject', 's3:GetObject'], resources: [diagnostics.arnForObjects('nodes/*')],
    }));
    const relay = new PerfEksRelay(this, 'Relay', {
      vpc: props.vpc, subnet: props.nodeSubnets[0], securityGroup: props.relaySecurityGroup,
      clusterEndpoint: this.cluster.attrEndpoint, operatorRole: this.operatorRole, cleanupEnabled: props.cleanupEnabled,
    });
    if (props.cleanupEnabled) {
      relay.role.addToPolicy(new PolicyStatement({ actions: ['eks:DescribeCluster'], resources: [this.cluster.attrArn] }));
      new CfnAccessEntry(this, 'CleanupAccess', { clusterName: this.cluster.ref, principalArn: relay.role.roleArn, type: 'STANDARD', accessPolicies: [{ policyArn: `arn:${this.partition}:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy`, accessScope: { type: 'cluster' } }] });
    }
    if (props.httpsGateway) new PerfEksLbc(this, 'Lbc', { clusterName: this.cluster.ref });
    this.access = new PerfEksAccess(this, 'Access', {
      clusterName: this.cluster.ref, operatorRole: this.operatorRole, secrets: props.secrets,
      rawSignalBucket: props.rawSignalBucket, evidenceBucket: props.evidenceBucket,
      msk: props.msk ? { clusterArn: props.msk.cluster.attrArn, topicArn: props.msk.topicArn, consumerGroupArn: props.msk.consumerGroupArn } : undefined,
      logGroups: {
        application: applicationLogs, observability: observabilityLogs, events: eventLogs,
        ...(props.msk ? { broker: props.msk.logGroup } : {}), controlPlane: controlPlaneLogs,
      },
    });

    const outputs: Record<string, string> = {
      EksClusterName: this.cluster.ref, EksClusterArn: this.cluster.attrArn, EksClusterEndpoint: this.cluster.attrEndpoint,
      EksKubernetesVersion: props.profile.kubernetes_version, EksRegion: this.region, EksVpcId: props.vpc.vpcId,
      EksNodeSubnetIds: props.nodeSubnets.map(subnet => subnet.subnetId).join(','),
      EksNodeAvailabilityZone: props.profile.availability_zone,
      EksNodeSecurityGroupId: props.nodeSecurityGroup.securityGroupId,
      EksControlPlaneSecurityGroupId: props.controlPlaneSecurityGroup.securityGroupId,
      EksNodeRoleArn: this.nodeRole.roleArn, EksNodeRoleName: this.nodeRole.roleName,
      EksOperatorRoleArn: this.operatorRole.roleArn, EksOperatorRoleName: this.operatorRole.roleName,
      EksRelayInstanceId: relay.instance.instanceId, EksRelaySessionDocumentName: relay.sessionDocument.ref,
      EksControlPlaneLogGroupName: controlPlaneLogs.logGroupName,
      ApplicationLogGroupName: applicationLogs.logGroupName, ObservabilityLogGroupName: observabilityLogs.logGroupName,
      KubernetesEventsLogGroupName: eventLogs.logGroupName, DiagnosticsBucketName: diagnostics.bucketName,
      PerfEnvironmentId: props.provenance.environmentId, PerfProfilePath: props.provenance.profilePath,
      PerfProfileSha256: props.provenance.profileSha256, PerfInfraParameters: JSON.stringify(props.provenance.parameters),
      AppNamespace: PERF_NAMESPACES.app, ObservabilityNamespace: PERF_NAMESPACES.observability,
      RunnerNamespace: PERF_NAMESPACES.runner, LogsNamespace: PERF_NAMESPACES.logs,
      ...Object.fromEntries(perfPoolIds(props.profile).map(pool => [
        `${pool.charAt(0).toUpperCase()}${pool.slice(1)}PoolSecurityGroupId`, props.poolSecurityGroups[pool].securityGroupId,
      ])),
    };
    for (const [name, value] of Object.entries(outputs)) new CfnOutput(this, name, { value }).overrideLogicalId(name);
  }
}
