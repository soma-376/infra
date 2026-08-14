import {
  Annotations,
  CfnOutput,
  RemovalPolicy,
  Stack,
  StackProps,
} from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import { ISecurityGroup, IVpc } from 'aws-cdk-lib/aws-ec2';
import { FargateService } from 'aws-cdk-lib/aws-ecs';
import { Certificate, ICertificate } from 'aws-cdk-lib/aws-certificatemanager';
import {
  OAuthScope,
  UserPool,
  UserPoolClient,
  UserPoolDomain,
} from 'aws-cdk-lib/aws-cognito';
import {
  ApplicationListener,
  ApplicationLoadBalancer,
  ApplicationProtocol,
  ApplicationTargetGroup,
  ListenerAction,
  ListenerCondition,
  TargetType,
} from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { AuthenticateCognitoAction } from 'aws-cdk-lib/aws-elasticloadbalancingv2-actions';
import { Distribution, ViewerProtocolPolicy } from 'aws-cdk-lib/aws-cloudfront';
import { S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { BlockPublicAccess, Bucket } from 'aws-cdk-lib/aws-s3';
import { PORTS } from '../common/config';
import { EdgeConfig, SUBNET_GROUP } from './config';

export interface EdgeStackProps extends StackProps {
  readonly vpc: IVpc;
  readonly collectorService: FargateService;
  readonly dashboardService: FargateService;
  readonly albSecurityGroup: ISecurityGroup;
  readonly edge: EdgeConfig;
}

/**
 * EdgeStack: Cognito, ALB(모드 분기 리스너), CloudFront + frontend 버킷.
 *
 * 모드 A(certificateArn 제공): 443 HTTPS 리스너 + /v1/* jwt-validation +
 * /api/* authenticate-cognito + 80->443 redirect.
 * 모드 B(미제공): 80 HTTP 리스너, 인증 없이 forward + synth 경고.
 */
export class EdgeStack extends Stack {
  constructor(scope: Construct, id: string, props: EdgeStackProps) {
    super(scope, id, props);

    const isHttps = Boolean(props.edge.certificateArn);

    const alb = new ApplicationLoadBalancer(this, 'Alb', {
      vpc: props.vpc,
      internetFacing: true,
      securityGroup: props.albSecurityGroup,
      vpcSubnets: { subnetGroupName: SUBNET_GROUP.public },
    });

    const { userPool, userPoolClient, userPoolDomain } = this.buildCognito(
      props,
      alb,
    );

    const otlpTargetGroup = this.buildOtlpTargetGroup(props);
    const dashboardTargetGroup = this.buildDashboardTargetGroup(props);

    if (isHttps) {
      this.buildHttpsListener(props, alb, {
        otlpTargetGroup,
        dashboardTargetGroup,
        userPool,
        userPoolClient,
        userPoolDomain,
      });
    } else {
      this.buildHttpListener(alb, otlpTargetGroup, dashboardTargetGroup);
    }

    const distribution = this.buildFrontend();

    new CfnOutput(this, 'AlbDnsName', { value: alb.loadBalancerDnsName });
    new CfnOutput(this, 'CloudFrontDomain', {
      value: distribution.distributionDomainName,
    });
    new CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', {
      value: userPoolClient.userPoolClientId,
    });
  }

  private buildCognito(
    props: EdgeStackProps,
    alb: ApplicationLoadBalancer,
  ): {
    userPool: UserPool;
    userPoolClient: UserPoolClient;
    userPoolDomain: UserPoolDomain;
  } {
    const userPool = new UserPool(this, 'UserPool', {
      selfSignUpEnabled: false,
      removalPolicy: RemovalPolicy.DESTROY, // MVP
    });

    const userPoolDomain = userPool.addDomain('UserPoolDomain', {
      cognitoDomain: { domainPrefix: props.edge.cognitoDomainPrefix },
    });

    const callbackBase = props.edge.domainName
      ? `https://${props.edge.domainName}`
      : `https://${alb.loadBalancerDnsName}`;

    const userPoolClient = userPool.addClient('UserPoolClient', {
      generateSecret: true, // ALB 연동 필수
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [OAuthScope.OPENID, OAuthScope.EMAIL],
        callbackUrls: [`${callbackBase}/oauth2/idpresponse`],
      },
    });

    return { userPool, userPoolClient, userPoolDomain };
  }

  private buildOtlpTargetGroup(
    props: EdgeStackProps,
  ): ApplicationTargetGroup {
    const tg = new ApplicationTargetGroup(this, 'OtlpTargetGroup', {
      vpc: props.vpc,
      port: PORTS.otlp,
      protocol: ApplicationProtocol.HTTP,
      targetType: TargetType.IP, // awsvpc / Fargate
      // OTLP 수신 루트(4318 /)는 404 를 반환하므로 정상 코드 범위를 넓힌다.
      healthCheck: { path: '/', healthyHttpCodes: '200-404' },
    });
    tg.addTarget(
      props.collectorService.loadBalancerTarget({
        containerName: 'otel-collector',
        containerPort: PORTS.otlp,
      }),
    );
    return tg;
  }

  private buildDashboardTargetGroup(
    props: EdgeStackProps,
  ): ApplicationTargetGroup {
    const tg = new ApplicationTargetGroup(this, 'DashboardTargetGroup', {
      vpc: props.vpc,
      port: PORTS.apiServer,
      protocol: ApplicationProtocol.HTTP,
      targetType: TargetType.IP,
      // Spring Boot 는 루트 매핑이 없으면 404 를 반환한다. ALB 기본 matcher(200)를
      // 그대로 두면 타깃이 영영 healthy 가 되지 않아 ECS 재시작 루프에 빠진다.
      // 앱이 actuator 를 노출하는 것이 확인되면 path 를 /actuator/health 로 좁힌다.
      healthCheck: { path: '/', healthyHttpCodes: '200-404' },
    });
    tg.addTarget(
      props.dashboardService.loadBalancerTarget({
        containerName: 'api-server',
        containerPort: PORTS.apiServer,
      }),
    );
    return tg;
  }

  private buildHttpsListener(
    props: EdgeStackProps,
    alb: ApplicationLoadBalancer,
    ctx: {
      otlpTargetGroup: ApplicationTargetGroup;
      dashboardTargetGroup: ApplicationTargetGroup;
      userPool: UserPool;
      userPoolClient: UserPoolClient;
      userPoolDomain: UserPoolDomain;
    },
  ): void {
    const certificate: ICertificate = Certificate.fromCertificateArn(
      this,
      'Certificate',
      props.edge.certificateArn!,
    );

    const listener = alb.addListener('HttpsListener', {
      port: PORTS.https,
      protocol: ApplicationProtocol.HTTPS,
      certificates: [certificate],
      defaultAction: ListenerAction.fixedResponse(404, {
        contentType: 'text/plain',
        messageBody: 'Not Found',
      }),
    });

    const issuer = ctx.userPool.userPoolProviderUrl;

    // Rule 1: /v1/* (OTLP) -> jwt-validation 후 forward. jwt-validation 은 HTTPS
    // 리스너에서만 유효하므로 이 액션은 반드시 모드 A 에서만 붙인다 (ADR-0008).
    listener.addAction('OtlpJwt', {
      priority: 1,
      conditions: [ListenerCondition.pathPatterns(['/v1/*'])],
      action: ListenerAction.authenticateJwt({
        issuer,
        jwksEndpoint: `${issuer}/.well-known/jwks.json`,
        next: ListenerAction.forward([ctx.otlpTargetGroup]),
      }),
    });

    // Rule 2: /api/* -> authenticate-cognito(브라우저 리다이렉트) 후 forward.
    listener.addAction('ApiCognito', {
      priority: 2,
      conditions: [ListenerCondition.pathPatterns(['/api/*'])],
      action: new AuthenticateCognitoAction({
        userPool: ctx.userPool,
        userPoolClient: ctx.userPoolClient,
        userPoolDomain: ctx.userPoolDomain,
        next: ListenerAction.forward([ctx.dashboardTargetGroup]),
      }),
    });

    // 80 -> 443 redirect.
    alb.addListener('HttpRedirect', {
      port: PORTS.http,
      protocol: ApplicationProtocol.HTTP,
      defaultAction: ListenerAction.redirect({
        protocol: 'HTTPS',
        port: String(PORTS.https),
        permanent: true,
      }),
    });
  }

  private buildHttpListener(
    alb: ApplicationLoadBalancer,
    otlpTargetGroup: ApplicationTargetGroup,
    dashboardTargetGroup: ApplicationTargetGroup,
  ): void {
    const listener: ApplicationListener = alb.addListener('HttpListener', {
      port: PORTS.http,
      protocol: ApplicationProtocol.HTTP,
      defaultAction: ListenerAction.fixedResponse(404, {
        contentType: 'text/plain',
        messageBody: 'Not Found',
      }),
    });

    listener.addAction('OtlpForward', {
      priority: 1,
      conditions: [ListenerCondition.pathPatterns(['/v1/*'])],
      action: ListenerAction.forward([otlpTargetGroup]),
    });
    listener.addAction('ApiForward', {
      priority: 2,
      conditions: [ListenerCondition.pathPatterns(['/api/*'])],
      action: ListenerAction.forward([dashboardTargetGroup]),
    });

    Annotations.of(this).addWarningV2(
      'infra:edge-no-auth',
      'ALB certificateArn 미제공: HTTP 폴백으로 ALB 단 인증이 비활성화되었다. ' +
        '앱 레이어(Spring Security + Cognito JWT, Collector auth extension)에서 ' +
        '인증을 검증해야 한다 (ADR-0008 폴백).',
    );
  }

  private buildFrontend(): Distribution {
    const frontendBucket = new Bucket(this, 'FrontendBucket', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      autoDeleteObjects: true, // MVP
      removalPolicy: RemovalPolicy.DESTROY,
    });

    return new Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(frontendBucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      defaultRootObject: 'index.html',
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html' },
      ],
    });
  }
}
