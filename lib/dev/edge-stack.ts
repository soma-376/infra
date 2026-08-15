import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import { ISecurityGroup, IVpc, SubnetType } from 'aws-cdk-lib/aws-ec2';
import { Ec2Service } from 'aws-cdk-lib/aws-ecs';
import {
  ApplicationLoadBalancer,
  ApplicationProtocol,
  ApplicationTargetGroup,
  ListenerAction,
  ListenerCondition,
  TargetType,
} from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { PORTS } from '../common/config';

export interface DevEdgeStackProps extends StackProps {
  readonly vpc: IVpc;
  readonly albSecurityGroup: ISecurityGroup;
  readonly collectorService: Ec2Service;
  /** 인증 프록시. `:80` 의 `/v1/*` 가 향하는 곳이다. (ADR-0023) */
  readonly authProxyService: Ec2Service;
  readonly dashboardService: Ec2Service;
  readonly clickhouseService: Ec2Service;
  /** RDS 엔드포인트 호스트명 (CfnOutput 용). */
  readonly dbEndpoint: string;
  /** RDS 마스터 시크릿 ARN (CfnOutput 용). */
  readonly dbSecretArn: string;
  /** 토큰 해시 키 ARN (CfnOutput 용). enrollment 서버에 전달한다. (ADR-0023) */
  readonly tokenHashSecretArn: string;
}

/**
 * DevEdgeStack: internet-facing ALB(리스너 3개) + CfnOutput.
 *
 * **Cognito / CloudFront / 프론트엔드 S3 를 만들지 않는다. 의도적 생략이다.**
 * dev 프론트엔드는 로컬에서 띄워 이 ALB 를 향하게 한다 - 프론트 개발 중에는
 * 어차피 로컬 dev server 를 쓰고, CloudFront 배포는 캐시 무효화까지 붙어 개발
 * 루프를 느리게 만든다. Cognito 를 만들지 않는 덕에 ADR-0021 Constraints 의
 * "Cognito 도메인 prefix 충돌"이 애초에 발생하지 않는다. (ADR-0022 8번)
 *
 * **`:80` 의 `/v1/*` 는 auth-proxy 가 받는다** (ADR-0023). `/api/*` 와 `:8123`,
 * 그리고 `:4318` 디버그 리스너에는 여전히 인증이 없으므로, 그 경로들의 방어선은
 * `DevAlbSg` 의 허용 CIDR 하나뿐이다 (`infra:dev-open-ingress` 경고 참조).
 */
export class DevEdgeStack extends Stack {
  constructor(scope: Construct, id: string, props: DevEdgeStackProps) {
    super(scope, id, props);

    const alb = new ApplicationLoadBalancer(this, 'DevAlb', {
      vpc: props.vpc,
      internetFacing: true,
      securityGroup: props.albSecurityGroup,
      vpcSubnets: { subnetType: SubnetType.PUBLIC },
    });

    this.buildAppListener(props, alb);
    this.buildOtlpDebugListener(props, alb);
    this.buildClickhouseListener(props, alb);

    new CfnOutput(this, 'AlbDnsName', { value: alb.loadBalancerDnsName });
    new CfnOutput(this, 'OtlpEndpoint', {
      value: `http://${alb.loadBalancerDnsName}/v1/traces`,
    });
    // 인증 없이 Collector 로 직행한다. auth-proxy 장애와 파이프라인 장애를 가르는
    // 용도이며 정상 경로가 아니다. (ADR-0023 3번)
    new CfnOutput(this, 'OtlpDebugEndpoint', {
      value: `http://${alb.loadBalancerDnsName}:${PORTS.otlp}/v1/traces`,
    });
    new CfnOutput(this, 'ApiEndpoint', {
      value: `http://${alb.loadBalancerDnsName}/api`,
    });
    new CfnOutput(this, 'ClickhouseDebugUrl', {
      value: `http://${alb.loadBalancerDnsName}:${PORTS.clickhouseHttp}`,
    });
    new CfnOutput(this, 'RdsEndpoint', { value: props.dbEndpoint });
    new CfnOutput(this, 'RdsSecretArn', { value: props.dbSecretArn });
    // enrollment 서버가 토큰을 발급할 때 같은 키로 HMAC 해시해야 auth-proxy 의 조회가
    // 성립한다. **ARN 만 노출하며 값은 Secrets Manager 밖으로 나오지 않는다.**
    // (ADR-0023 4번)
    new CfnOutput(this, 'TokenHashSecretArn', {
      value: props.tokenHashSecretArn,
    });
  }

  /**
   * :80 리스너 - `/v1/*` 는 auth-proxy, `/api/*` 는 dashboard.
   *
   * 기본 액션은 fixed-response 404 다(운영 모드 B 와 같은 형태). 두 경로 규칙에
   * 걸리지 않은 요청이 어느 백엔드로도 새지 않게 한다.
   */
  private buildAppListener(
    props: DevEdgeStackProps,
    alb: ApplicationLoadBalancer,
  ): void {
    const listener = alb.addListener('DevHttpListener', {
      port: PORTS.http,
      protocol: ApplicationProtocol.HTTP,
      // **`open: false` 를 빼면 `devAllowedCidr` 이 무의미해진다.** CDK 의
      // `addListener` 기본값(`open: true`)은 리스너 포트를 `0.0.0.0/0` 에 여는
      // 인그레스를 ALB SG 에 자동으로 추가한다. 운영에서는 `NetworkStack` 이 이미
      // anyIpv4 룰을 갖고 있어 dedup 되지만, dev 는 CIDR 을 좁히는 것이 목적이라
      // 그 자동 룰이 좁힌 룰 옆에 그대로 남아 전면 공개로 되돌린다.
      // 인바운드는 전부 `DevNetworkStack` 이 정한다. (ADR-0022 2번/9번)
      open: false,
      defaultAction: ListenerAction.fixedResponse(404, {
        contentType: 'text/plain',
        messageBody: 'Not Found',
      }),
    });

    // auth-proxy 태스크는 bridge + 동적 포트라 호스트 인스턴스로 등록된다
    // -> target type instance. `DevDashboardTg` 와 같은 사정이며, 네트워크 모드가
    // 타깃 타입을 결정하는 것이지 선택의 문제가 아니다. (ADR-0022 8번, ADR-0023 2번)
    //
    // **이 타깃 그룹이 Collector 를 대신해 `/v1/*` 를 받는다.** 인증 없이 Collector 로
    // 직행하던 기존 경로는 아래 `:4318` 디버그 리스너로 옮겼다. (ADR-0023 3번)
    const authProxyTargetGroup = new ApplicationTargetGroup(
      this,
      'DevAuthProxyTg',
      {
        vpc: props.vpc,
        port: PORTS.authProxy,
        protocol: ApplicationProtocol.HTTP,
        targetType: TargetType.INSTANCE,
        // 앱이 `GET /health` 에 200 JSON 을 준다
        // (`apps/auth-proxy/src/health/health.routes.ts`). collector·dashboard 와 달리
        // 전용 헬스 엔드포인트가 있으므로 matcher 를 넓히지 않고 기본값(200)을 쓴다.
        healthCheck: { path: '/health' },
      },
    );
    authProxyTargetGroup.addTarget(
      props.authProxyService.loadBalancerTarget({
        containerName: 'auth-proxy',
        containerPort: PORTS.authProxy,
      }),
    );

    // dashboard 태스크는 bridge + 동적 포트라 호스트 인스턴스로 등록된다
    // -> target type instance. 네트워크 모드가 타깃 타입을 결정하는 것이지
    // 선택의 문제가 아니다. (ADR-0022 8번)
    const dashboardTargetGroup = new ApplicationTargetGroup(
      this,
      'DevDashboardTg',
      {
        vpc: props.vpc,
        port: PORTS.apiServer,
        protocol: ApplicationProtocol.HTTP,
        targetType: TargetType.INSTANCE,
        // Spring Boot 는 루트 매핑이 없으면 404 를 반환한다. ALB 기본 matcher(200)를
        // 그대로 두면 타깃이 영영 healthy 가 되지 않아 ECS 재시작 루프에 빠진다.
        // 앱이 actuator 를 노출하는 것이 확인되면 path 를 좁힌다. 운영과 같은 값이다.
        healthCheck: { path: '/', healthyHttpCodes: '200-404' },
      },
    );
    dashboardTargetGroup.addTarget(
      props.dashboardService.loadBalancerTarget({
        containerName: 'api-server',
        containerPort: PORTS.apiServer,
      }),
    );

    listener.addAction('DevOtlpForward', {
      priority: 1,
      conditions: [ListenerCondition.pathPatterns(['/v1/*'])],
      action: ListenerAction.forward([authProxyTargetGroup]),
    });
    listener.addAction('DevApiForward', {
      priority: 2,
      conditions: [ListenerCondition.pathPatterns(['/api/*'])],
      action: ListenerAction.forward([dashboardTargetGroup]),
    });
  }

  /**
   * :4318 리스너 - 인증을 거치지 않는 Collector 직행 경로 (ADR-0023 3번).
   *
   * **왜 경로가 아니라 포트로 나누는가.** ALB 의 forward 액션은 URL 을 재작성하지
   * 않는다. `/debug/v1/*` 같은 prefix 를 쓰면 Collector 가 `/debug/v1/traces` 를 그대로
   * 받고 OTLP 리시버가 404 를 낸다. 포트로 나누면 경로가 `/v1/traces` 그대로 유지된다.
   * 아래 `:8123` ClickHouse 리스너와 정확히 같은 패턴이다.
   *
   *   curl -X POST "http://<alb>:4318/v1/traces" -d '{"resourceSpans":[]}'
   *
   * **인증 우회 경로다.** auth-proxy 가 죽었는지 파이프라인이 죽었는지를 가르기 위해
   * 의도적으로 남긴 것이며, 방어선은 `devAllowedCidr` 하나뿐이다. 기본값 0.0.0.0/0
   * 이면 인증 없는 OTLP 수신구가 인터넷에 열리고 `infra:dev-open-ingress` 경고가
   * 이를 알린다. (ADR-0022 9번)
   */
  private buildOtlpDebugListener(
    props: DevEdgeStackProps,
    alb: ApplicationLoadBalancer,
  ): void {
    // collector 태스크는 awsvpc 라 자기 ENI 의 IP 로 등록된다 -> target type ip.
    const targetGroup = new ApplicationTargetGroup(this, 'DevCollectorTg', {
      vpc: props.vpc,
      port: PORTS.otlp,
      protocol: ApplicationProtocol.HTTP,
      targetType: TargetType.IP,
      // OTLP 수신 루트(4318 /)는 404 를 반환하므로 정상 코드 범위를 넓힌다.
      // 운영과 같은 값이다.
      healthCheck: { path: '/', healthyHttpCodes: '200-404' },
    });
    targetGroup.addTarget(
      props.collectorService.loadBalancerTarget({
        containerName: 'otel-collector',
        containerPort: PORTS.otlp,
      }),
    );

    alb.addListener('DevOtlpDebugListener', {
      port: PORTS.otlp,
      protocol: ApplicationProtocol.HTTP,
      // 위 :80 리스너와 같은 이유로 자동 인그레스를 끈다. 이 포트는 인증을 우회하므로
      // 여기서 전면 공개가 새면 auth-proxy 를 둔 의미가 사라진다. (ADR-0022 2번/9번)
      open: false,
      defaultAction: ListenerAction.forward([targetGroup]),
    });
  }

  /**
   * :8123 리스너 - ClickHouse 직접 쿼리용.
   *
   * **이 리스너를 두는 이유는 EC2 인스턴스의 퍼블릭 IP 가 인스턴스 교체마다
   * 바뀌기 때문이다**(ADR-0010 이 운영에서 EIP 를 두지 않기로 한 것과 같은 사정).
   * ALB DNS 이름은 고정이므로 이것이 **안정적인 ClickHouse 주소**를 제공한다.
   *
   *   curl "http://<alb>:8123/?query=SELECT%201"
   *
   * ClickHouse 는 `/ping` 에 200 OK 를 주므로 헬스체크 경로를 좁힐 수 있다.
   * (ADR-0022 8번)
   */
  private buildClickhouseListener(
    props: DevEdgeStackProps,
    alb: ApplicationLoadBalancer,
  ): void {
    // ClickHouse 태스크도 awsvpc 라 target type ip 다.
    const targetGroup = new ApplicationTargetGroup(this, 'DevClickhouseTg', {
      vpc: props.vpc,
      port: PORTS.clickhouseHttp,
      protocol: ApplicationProtocol.HTTP,
      targetType: TargetType.IP,
      healthCheck: { path: '/ping' },
    });
    targetGroup.addTarget(
      props.clickhouseService.loadBalancerTarget({
        containerName: 'clickhouse',
        containerPort: PORTS.clickhouseHttp,
      }),
    );

    alb.addListener('DevClickhouseListener', {
      port: PORTS.clickhouseHttp,
      protocol: ApplicationProtocol.HTTP,
      // 위 :80 리스너와 같은 이유로 자동 인그레스를 끈다. 8123 은 비밀번호 없는
      // ClickHouse 로 직결되므로 여기서 전면 공개가 새면 피해가 가장 크다.
      open: false,
      defaultAction: ListenerAction.forward([targetGroup]),
    });
  }
}
