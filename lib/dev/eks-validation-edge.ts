import { CfnOutput, Tags } from 'aws-cdk-lib/core';
import { ISecurityGroup, IVpc, SubnetType } from 'aws-cdk-lib/aws-ec2';
import { ApplicationLoadBalancer, ApplicationProtocol, ApplicationTargetGroup, TargetType } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { CfnWebACLAssociation } from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';
import { DEV_DEREGISTRATION_DELAY } from './config';
import { installDevAppRoutes } from './app-routing';
import { DEV_EKS_CLUSTER_NAME, DEV_EKS_NODE_PORTS, DevEksOtlpTarget } from './eks-config';
import { DEV_EKS_TARGET_GROUP_CLUSTER_TAG } from './eks-lbc';
import { addDevAppListener, DevAppListenerOptions } from './app-listener';

export interface DevEksValidationEdgeProps extends DevAppListenerOptions {
  readonly vpc: IVpc;
  readonly securityGroup: ISecurityGroup;
  readonly webAclArn: string;
  /** 기본 ingest. gateway는 priority 1 OTLP 규칙의 대상만 바꾼다. (ADR-0036) */
  readonly otlpTarget?: DevEksOtlpTarget;
}

/** EKS 단독 전환 뒤에도 기존 검증 경로의 construct ID·TG 이름·output을 보존한다. */
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
        deregistrationDelay: DEV_DEREGISTRATION_DELAY,
        healthCheck: { path, healthyHttpCodes: '200', port: 'traffic-port' },
      });
      // 이름과 태그 양쪽으로 LBC 등록 대상을 제한한다.
      Tags.of(group).add(DEV_EKS_TARGET_GROUP_CLUSTER_TAG, DEV_EKS_CLUSTER_NAME);
      return group;
    };
    const ingest = tg('IngestTg', 'ingest', DEV_EKS_NODE_PORTS.ingest, '/api/v1/healthz', TargetType.INSTANCE);
    const enrollment = tg('EnrollmentTg', 'enroll', DEV_EKS_NODE_PORTS.enrollment, '/api/v1/healthz', TargetType.INSTANCE);
    const dashboard = tg('DashboardTg', 'dashboard', DEV_EKS_NODE_PORTS.dashboard, '/api/v1/healthz', TargetType.INSTANCE);
    // Gateway TG는 대상과 무관하게 항상 둔다. TGB가 미리 node를 등록하고 전환은 규칙 대상만 바꾼다.
    const gateway = tg('GatewayTg', 'gateway', DEV_EKS_NODE_PORTS.gateway, '/api/v1/healthz', TargetType.INSTANCE);
    const otlpTarget = props.otlpTarget ?? 'ingest';
    const http = addDevAppListener(alb, 'Http', props);
    // EKS는 기존 path/method/preflight 계약을 서로 독립된 TG에 연결한다. OTLP 규칙 ID는 대상과 무관하다.
    installDevAppRoutes(this, http, { enrollment, dashboard, ingest: otlpTarget === 'gateway' ? gateway : ingest }, 'Otlp');
    new CfnWebACLAssociation(this, 'WafAssociation', { resourceArn: alb.loadBalancerArn, webAclArn: props.webAclArn });
    for (const [name, value] of Object.entries({
      ValidationAlbArn: alb.loadBalancerArn,
      ValidationPublicBaseUrl: `http://${alb.loadBalancerDnsName}`,
      ValidationTelemetryIngestTargetGroupArn: ingest.targetGroupArn,
      ValidationEnrollmentApiTargetGroupArn: enrollment.targetGroupArn,
      ValidationDashboardApiTargetGroupArn: dashboard.targetGroupArn,
      ValidationTelemetryGatewayTargetGroupArn: gateway.targetGroupArn,
      // values 생성기가 ingest 모드와 현재 OTLP 대상의 호환을 검사한다.
      ValidationOtlpTarget: otlpTarget,
    })) new CfnOutput(this, name, { value }).overrideLogicalId(name);
  }
}
