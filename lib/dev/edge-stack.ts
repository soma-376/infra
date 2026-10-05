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
import { DEV_DEREGISTRATION_DELAY } from './config';

export interface DevEdgeStackProps extends StackProps {
  readonly vpc: IVpc;
  readonly albSecurityGroup: ISecurityGroup;
  /** 정확한 OTLP 세 경로의 타깃. */
  readonly telemetryIngestService: Ec2Service;
  /** enrollment와 bootstrap 경로가 공유하는 타깃. */
  readonly enrollmentApiService: Ec2Service;
  readonly clickhouseService: Ec2Service;
  /** RDS 엔드포인트 호스트명 (CfnOutput 용). */
  readonly dbEndpoint: string;
  /** RDS 마스터 시크릿 ARN (CfnOutput 용). */
  readonly dbSecretArn: string;
  /** 토큰 해시 키 ARN (CfnOutput 용). 신규 두 Spring 앱이 공유한다. (ADR-0026) */
  readonly tokenHashSecretArn: string;
  /** enrollment-api 관리자 토큰 Secret ARN. 값은 출력하지 않는다. */
  readonly adminApiTokenSecretArn: string;
}

/**
 * DevEdgeStack: internet-facing ALB(리스너 2개) + CfnOutput.
 *
 * **Cognito / CloudFront / 프론트엔드 S3 를 만들지 않는다. 의도적 생략이다.**
 * dev 프론트엔드는 로컬에서 띄워 이 ALB 를 향하게 한다 - 프론트 개발 중에는
 * 어차피 로컬 dev server 를 쓰고, CloudFront 배포는 캐시 무효화까지 붙어 개발
 * 루프를 느리게 만든다. Cognito 를 만들지 않는 덕에 ADR-0021 Constraints 의
 * "Cognito 도메인 prefix 충돌"이 애초에 발생하지 않는다. (ADR-0022 8번)
 *
 * `:80`은 정확한 OTLP 세 경로를 telemetry-ingest로, enrollment·bootstrap
 * 경로를 enrollment-api로 전달한다. 인증을 우회하던 `:4318`과 기존
 * `/api/*` 리스너 규칙은 제거했다. (ADR-0026)
 */
export class DevEdgeStack extends Stack {
  /** enrollment-api 응답에 넣을 실제 ALB HTTP base URL. */
  public readonly publicBaseUrl: string;

  constructor(scope: Construct, id: string, props: DevEdgeStackProps) {
    super(scope, id, props);

    const alb = new ApplicationLoadBalancer(this, 'DevAlb', {
      vpc: props.vpc,
      internetFacing: true,
      securityGroup: props.albSecurityGroup,
      vpcSubnets: { subnetType: SubnetType.PUBLIC },
    });
    this.publicBaseUrl = `http://${alb.loadBalancerDnsName}`;

    this.buildAppListener(props, alb);
    this.buildClickhouseListener(props, alb);

    new CfnOutput(this, 'AlbDnsName', { value: alb.loadBalancerDnsName });
    new CfnOutput(this, 'OtlpEndpoint', {
      value: `http://${alb.loadBalancerDnsName}/v1/traces`,
    });
    new CfnOutput(this, 'ClickhouseDebugUrl', {
      value: `http://${alb.loadBalancerDnsName}:${PORTS.clickhouseHttp}`,
    });
    new CfnOutput(this, 'RdsEndpoint', { value: props.dbEndpoint });
    new CfnOutput(this, 'RdsSecretArn', { value: props.dbSecretArn });
    // enrollment-api가 발급한 토큰과 telemetry-ingest가 받은 토큰을 같은 키로
    // HMAC 해시한다. **ARN 만 노출하며 값은 Secrets Manager 밖으로 나오지 않는다.**
    // (ADR-0026)
    new CfnOutput(this, 'TokenHashSecretArn', {
      value: props.tokenHashSecretArn,
    });
    new CfnOutput(this, 'AdminApiTokenSecretArn', {
      value: props.adminApiTokenSecretArn,
    });
  }

  /**
   * :80 리스너 - 정확한 앱 경로만 각 배포 단위로 전달한다.
   *
   * 기본 액션은 fixed-response 404 다(운영 모드 B 와 같은 형태). 명시 규칙에
   * 걸리지 않은 요청이 어느 백엔드로도 새지 않게 한다. (ADR-0026)
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

    // 신규 두 Spring 태스크는 bridge + 동적 host port를 쓰므로 ALB에
    // 호스트 인스턴스 타깃으로 등록한다. (ADR-0026)
    const telemetryIngestTargetGroup = new ApplicationTargetGroup(
      this,
      'DevTelemetryIngestTg',
      {
        vpc: props.vpc,
        port: PORTS.telemetryIngest,
        protocol: ApplicationProtocol.HTTP,
        targetType: TargetType.INSTANCE,
        deregistrationDelay: DEV_DEREGISTRATION_DELAY,
        healthCheck: {
          path: '/api/v1/healthz',
          healthyHttpCodes: '200',
        },
      },
    );
    telemetryIngestTargetGroup.addTarget(
      props.telemetryIngestService.loadBalancerTarget({
        containerName: 'telemetry-ingest',
        containerPort: PORTS.telemetryIngest,
      }),
    );

    const enrollmentApiTargetGroup = new ApplicationTargetGroup(
      this,
      'DevEnrollmentApiTg',
      {
        vpc: props.vpc,
        port: PORTS.enrollmentApi,
        protocol: ApplicationProtocol.HTTP,
        targetType: TargetType.INSTANCE,
        deregistrationDelay: DEV_DEREGISTRATION_DELAY,
        healthCheck: {
          path: '/api/v1/healthz',
          healthyHttpCodes: '200',
        },
      },
    );
    enrollmentApiTargetGroup.addTarget(
      props.enrollmentApiService.loadBalancerTarget({
        containerName: 'enrollment-api',
        containerPort: PORTS.enrollmentApi,
      }),
    );

    listener.addAction('DevOtlpForward', {
      priority: 1,
      conditions: [
        ListenerCondition.pathPatterns([
          '/v1/traces',
          '/v1/metrics',
          '/v1/logs',
        ]),
      ],
      action: ListenerAction.forward([telemetryIngestTargetGroup]),
    });
    listener.addAction('DevEnrollmentForward', {
      priority: 3,
      conditions: [
        ListenerCondition.pathPatterns([
          '/api/v1/enroll',
          '/api/v1/installations/*',
          '/api/v1/invitations*',
          '/api/v1/auth/*',
          '/api/v1/manifest',
        ]),
      ],
      action: ListenerAction.forward([enrollmentApiTargetGroup]),
    });
    listener.addAction('DevBootstrapForward', {
      priority: 4,
      conditions: [
        ListenerCondition.pathPatterns(['/windows', '/unix', '/bin/*']),
      ],
      action: ListenerAction.forward([enrollmentApiTargetGroup]),
    });
    listener.addAction('DevEnrollmentManagementForward', {
      priority: 5,
      conditions: [
        ListenerCondition.pathPatterns([
          '/api/v1/organizations/*',
          '/api/v1/inquiries',
          '/api/v1/check-updates',
        ]),
      ],
      action: ListenerAction.forward([enrollmentApiTargetGroup]),
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
      // 장시간 연결과 쿼리 특성을 별도로 검증하기 전까지 AWS 기본값 300초를
      // 유지한다. 일반 HTTP 타깃의 MVP 초기값 60초를 여기까지 넓히지 않는다.
      // (ADR-0025)
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
