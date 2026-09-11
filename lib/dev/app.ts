import { App, Environment } from 'aws-cdk-lib/core';
import { applyCommonTags } from '../common/config';
import { DevConfig, DEV_COMMON_TAGS } from './config';
import { DevNetworkStack } from './network-stack';
import { DevDataStack } from './data-stack';
import { DevApplicationStack } from './application-stack';
import { DevEdgeStack } from './edge-stack';

/**
 * dev 스택 4개. CLI 와 테스트가 같은 조립 결과를 공유하기 위한 반환 타입이다.
 */
export interface DevStacks {
  readonly network: DevNetworkStack;
  readonly data: DevDataStack;
  readonly application: DevApplicationStack;
  readonly edge: DevEdgeStack;
}

export interface SynthDevProps {
  readonly env: Environment;
  readonly config: DevConfig;
}

/**
 * dev 환경의 4-스택을 주어진 App 에 조립한다.
 *
 * bin/infra.ts(CLI)와 후속 커밋의 테스트 픽스처가 모두 이 함수를 거치므로 양쪽
 * 산출물이 갈라질 수 없다. 스택 ID 와 props 전달 순서는 합성 산출물에 그대로
 * 반영되므로 바꾸지 않는다.
 *
 * **스택 ID 의 `Dev` 접두사가 두 환경이 서로를 덮어쓰지 않게 하는 유일한 장치다.**
 * CDK 는 스택 ID 를 CloudFormation 스택 이름으로 그대로 쓰고, 스택 이름은 계정 +
 * 리전에서 유일해야 한다. 접두사를 빼면 `cdk deploy -c env=dev` 가 운영
 * `NetworkStack` 을 dev 템플릿으로 업데이트한다 - 실수가 아니라 CloudFormation 의
 * 정상 동작이며 그래서 더 위험하다. (ADR-0021 3번)
 *
 * 의존 방향은 `dev -> common` 단방향이다. **`lib/prod/` 에서 import 하지 않는다** -
 * 이 규칙 하나가 "dev 를 고치다가 운영이 깨진다"를 컴파일 타임에 차단한다.
 * (ADR-0021 2번)
 */
export function synthDev(app: App, props: SynthDevProps): DevStacks {
  const { env, config } = props;

  // 전 스택의 태그 지원 리소스에 공통 태그를 전파한다 (비용 배분/소유권 식별용).
  // Cost Explorer 에서 Env=dev 가 이 환경의 비용 축이 된다.
  applyCommonTags(app, DEV_COMMON_TAGS);

  const network = new DevNetworkStack(app, 'DevNetworkStack', {
    env,
    allowedCidrs: config.allowedCidrs,
  });

  const data = new DevDataStack(app, 'DevDataStack', {
    env,
    vpc: network.vpc,
    rdsSecurityGroup: network.rdsSecurityGroup,
  });

  const application = new DevApplicationStack(app, 'DevApplicationStack', {
    env,
    vpc: network.vpc,
    devConfig: config,
    dbEndpoint: data.dbEndpoint,
    dbSecret: data.dbSecret,
    adminApiTokenSecret: data.adminApiTokenSecret,
    postProcessorPgDsnSecret: data.postProcessorPgDsnSecret,
    authProxyDatabaseUrlSecret: data.authProxyDatabaseUrlSecret,
    tokenHashSecret: data.tokenHashSecret,
    rawSignalBucket: data.rawSignalBucket,
    appHostSecurityGroup: network.appHostSecurityGroup,
    collectorSecurityGroup: network.collectorSecurityGroup,
    clickhouseSecurityGroup: network.clickhouseSecurityGroup,
  });

  const edge = new DevEdgeStack(app, 'DevEdgeStack', {
    env,
    vpc: network.vpc,
    albSecurityGroup: network.albSecurityGroup,
    collectorService: application.collectorService,
    authProxyService: application.authProxyService,
    telemetryIngestService: application.telemetryIngestService,
    enrollmentApiService: application.enrollmentApiService,
    dashboardService: application.dashboardService,
    clickhouseService: application.clickhouseService,
    dbEndpoint: data.dbEndpoint,
    dbSecretArn: data.dbSecretArn,
    tokenHashSecretArn: data.tokenHashSecretArn,
    adminApiTokenSecretArn: data.adminApiTokenSecretArn,
  });

  // enrollment-api가 응답에 넣는 설치 URL은 실제 ALB DNS와 같아야 한다. Edge가 ALB를
  // 만든 뒤 application의 컨테이너 정의에 weak cross-stack reference로 연결한다.
  application.bindEnrollmentPublicBaseUrl(edge.publicBaseUrl);

  return { network, data, application, edge };
}
