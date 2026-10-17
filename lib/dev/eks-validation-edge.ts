import { CfnOutput, Duration, Tags } from 'aws-cdk-lib/core';
import { ISecurityGroup, IVpc, SubnetType } from 'aws-cdk-lib/aws-ec2';
import { ApplicationLoadBalancer, ApplicationProtocol, ApplicationTargetGroup, ListenerAction, TargetType } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { CfnWebACLAssociation } from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';
import { DEV_DEREGISTRATION_DELAY } from './config';
import { installDevAppRoutes } from './app-routing';
import { DEV_EKS_CLUSTER_NAME, DEV_EKS_NODE_PORTS } from './eks-config';
import { DEV_EKS_TARGET_GROUP_CLUSTER_TAG } from './eks-lbc';

export interface DevEksValidationEdgeProps {
  readonly vpc: IVpc;
  readonly securityGroup: ISecurityGroup;
  readonly webAclArn: string;
}

/** ECS의 기존 construct ID/forwarding은 그대로 두고 별도 검증 자리를 추가한다. */
export class DevEksValidationEdge extends Construct {
  constructor(scope: Construct, id: string, props: DevEksValidationEdgeProps) {
    super(scope, id);
    const alb = new ApplicationLoadBalancer(this, 'Alb', {
      vpc: props.vpc, internetFacing: true, securityGroup: props.securityGroup,
      vpcSubnets: { subnetType: SubnetType.PUBLIC },
    });
    const tg = (id: string, name: string, port: number, path: string, type: TargetType) => {
      const group = new ApplicationTargetGroup(this, id, {
        vpc: props.vpc, targetGroupName: `soma-376-dev-eks-${name}-v`,
        port, protocol: ApplicationProtocol.HTTP, targetType: type,
        deregistrationDelay: type === TargetType.IP ? Duration.seconds(300) : DEV_DEREGISTRATION_DELAY,
        healthCheck: { path, healthyHttpCodes: '200', port: 'traffic-port' },
      });
      // 이름과 태그 양쪽으로 LBC 등록 대상을 제한한다. 기존 ECS TG에는 붙이지 않는다.
      Tags.of(group).add(DEV_EKS_TARGET_GROUP_CLUSTER_TAG, DEV_EKS_CLUSTER_NAME);
      return group;
    };
    const ingest = tg('IngestTg', 'ingest', DEV_EKS_NODE_PORTS.ingest, '/api/v1/healthz', TargetType.INSTANCE);
    const enrollment = tg('EnrollmentTg', 'enroll', DEV_EKS_NODE_PORTS.enrollment, '/api/v1/healthz', TargetType.INSTANCE);
    const dashboard = tg('DashboardTg', 'dashboard', DEV_EKS_NODE_PORTS.dashboard, '/api/v1/healthz', TargetType.INSTANCE);
    const clickhouse = tg('ClickhouseTg', 'ch', 8123, '/ping', TargetType.IP);
    const http = alb.addListener('Http', {
      port: 80, protocol: ApplicationProtocol.HTTP, open: false,
      defaultAction: ListenerAction.fixedResponse(404, { contentType: 'text/plain', messageBody: 'Not Found' }),
    });
    // ECS와 EKS는 같은 path/method/preflight 계약을 서로 독립된 TG에 연결한다.
    installDevAppRoutes(this, http, { enrollment, dashboard, ingest }, 'Otlp');
    alb.addListener('Clickhouse', { port: 8123, protocol: ApplicationProtocol.HTTP, open: false, defaultAction: ListenerAction.forward([clickhouse]) });
    new CfnWebACLAssociation(this, 'WafAssociation', { resourceArn: alb.loadBalancerArn, webAclArn: props.webAclArn });
    for (const [name, value] of Object.entries({
      ValidationAlbArn: alb.loadBalancerArn,
      ValidationPublicBaseUrl: `http://${alb.loadBalancerDnsName}`,
      ValidationClickhouseUrl: `http://${alb.loadBalancerDnsName}:8123`,
      ValidationTelemetryIngestTargetGroupArn: ingest.targetGroupArn,
      ValidationEnrollmentApiTargetGroupArn: enrollment.targetGroupArn,
      ValidationDashboardApiTargetGroupArn: dashboard.targetGroupArn,
      ValidationClickhouseTargetGroupArn: clickhouse.targetGroupArn,
    })) new CfnOutput(this, name, { value }).overrideLogicalId(name);
  }
}
