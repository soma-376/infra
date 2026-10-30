import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps, Tags } from 'aws-cdk-lib/core';
import { ISecurityGroup, IVpc, SubnetType } from 'aws-cdk-lib/aws-ec2';
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager';
import { ApplicationLoadBalancer, ApplicationProtocol, ApplicationTargetGroup, ListenerAction, ListenerCondition, SslPolicy, TargetType } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { CfnWebACLAssociation } from 'aws-cdk-lib/aws-wafv2';
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { PERF_EKS_CLUSTER_NAME } from './config';
import { PERF_GATEWAY_HOST, PERF_GATEWAY_HTTPS, PERF_GATEWAY_NODE_PORT, PERF_GATEWAY_TG_NAME, PERF_OTLP_PATHS, PERF_TG_CLUSTER_TAG } from './edge-config';
import { PerfWaf } from './waf';

export interface PerfEdgeStackProps extends StackProps {
  readonly vpc: IVpc;
  readonly securityGroup: ISecurityGroup;
  readonly certificateArn: string;
  readonly natPublicIps: readonly string[];
}
/** 같은 Gateway의 외부 경로. ACM 원본/DNS는 소유하지 않으며 SG 규칙은 Network가 관리한다. */
export class PerfEdgeStack extends Stack {
  constructor(scope: Construct, id: string, props: PerfEdgeStackProps) {
    super(scope, id, props);
    const alb = new ApplicationLoadBalancer(this, 'Alb', { vpc: props.vpc, internetFacing: true, securityGroup: props.securityGroup,
      vpcSubnets: { subnetType: SubnetType.PUBLIC }, http2Enabled: true, idleTimeout: Duration.seconds(60), dropInvalidHeaderFields: true });
    const group = new ApplicationTargetGroup(this, 'Gateway', { vpc: props.vpc, targetGroupName: PERF_GATEWAY_TG_NAME,
      port: PERF_GATEWAY_NODE_PORT, protocol: ApplicationProtocol.HTTP, targetType: TargetType.INSTANCE,
      deregistrationDelay: Duration.seconds(60), healthCheck: { path: '/api/v1/healthz', port: 'traffic-port', healthyHttpCodes: '200' } });
    group.setAttribute('stickiness.enabled', 'false');
    group.setAttribute('load_balancing.algorithm.type', 'round_robin');
    group.setAttribute('slow_start.duration_seconds', '0');
    Tags.of(group).add(PERF_TG_CLUSTER_TAG, PERF_EKS_CLUSTER_NAME);
    const listener = alb.addListener('Https', { port: 443, protocol: ApplicationProtocol.HTTPS, open: false,
      certificates: [Certificate.fromCertificateArn(this, 'SharedCertificate', props.certificateArn)], sslPolicy: SslPolicy.TLS13_RES,
      defaultAction: ListenerAction.fixedResponse(404, { contentType: 'text/plain', messageBody: 'Not found' }) });
    listener.addAction('Otlp', { priority: 1, conditions: [ListenerCondition.hostHeaders([PERF_GATEWAY_HOST]), ListenerCondition.httpRequestMethods(['POST']), ListenerCondition.pathPatterns([...PERF_OTLP_PATHS])], action: ListenerAction.forward([group]) });
    const logs = new Bucket(this, 'AccessLogs', { encryption: BucketEncryption.S3_MANAGED, blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true, removalPolicy: RemovalPolicy.DESTROY, lifecycleRules: [{ expiration: Duration.days(1), abortIncompleteMultipartUploadAfter: Duration.days(1) }] });
    alb.logAccessLogs(logs, 'alb');
    const waf = new PerfWaf(this, 'Waf', { sourceCidrs: props.natPublicIps.map(ip => `${ip}/32`) });
    new CfnWebACLAssociation(this, 'WafAssociation', { resourceArn: alb.loadBalancerArn, webAclArn: waf.webAcl.attrArn });
    for (const [name, value] of Object.entries({ GatewayHttpsUrl: PERF_GATEWAY_HTTPS, PerfAlbArn: alb.loadBalancerArn, PerfAlbDnsName: alb.loadBalancerDnsName,
      PerfGatewayTargetGroupArn: group.targetGroupArn, PerfGatewayNodePort: String(PERF_GATEWAY_NODE_PORT), PerfWafArn: waf.webAcl.attrArn,
      PerfWafLogGroupName: waf.logGroup.logGroupName, PerfAlbAccessLogBucket: logs.bucketName, PerfNatPublicIps: props.natPublicIps.join(','),
      PerfCertificateArn: props.certificateArn, PerfDnsCnameName: PERF_GATEWAY_HOST })) new CfnOutput(this, name, { value }).overrideLogicalId(name);
  }
}
