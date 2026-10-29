import { DevEksStack } from './eks-stack';
import { App, Environment } from 'aws-cdk-lib/core';
import { applyCommonTags } from '../common/config';
import { DevConfig, DEV_COMMON_TAGS } from './config';
import { DevNetworkStack } from './network-stack';
import { DevDataStack } from './data-stack';
import { DevEdgeStack } from './edge-stack';
import { validateDevEdgeEnvironment } from './edge-config';

/**
 * EKS 전용 dev 4스택. CLI와 테스트가 같은 조립 결과를 공유한다.
 */
export interface DevStacks {
  readonly eks: DevEksStack;
  readonly network: DevNetworkStack;
  readonly data: DevDataStack;
  readonly edge: DevEdgeStack;
}

export interface SynthDevProps {
  readonly env: Environment;
  readonly config: DevConfig;
}

/**
 * dev 환경의 Network·Data·Edge·EKS 네 스택을 주어진 App에 조립한다.
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
  validateDevEdgeEnvironment(config.edge, env);

  // 전 스택의 태그 지원 리소스에 공통 태그를 전파한다 (비용 배분/소유권 식별용).
  // Cost Explorer 에서 Env=dev 가 이 환경의 비용 축이 된다.
  applyCommonTags(app, DEV_COMMON_TAGS);

  const network = new DevNetworkStack(app, 'DevNetworkStack', {
    env,
    allowedCidrs: config.allowedCidrs,
    eksHttpsEnabled: config.edge.eksCertificateArn !== undefined,
    kafkaProvider: config.eks.kafkaProvider,
    mskRetirementStage: config.eks.mskRetirementStage,
  });

  const data = new DevDataStack(app, 'DevDataStack', {
    env,
    vpc: network.vpc,
    rdsSecurityGroup: network.rdsSecurityGroup,
    dbRelaySecurityGroup: network.dbRelaySecurityGroup,
    oidcClientKeys: config.oidcClientKeys,
  });

  const edge = new DevEdgeStack(app, 'DevEdgeStack', {
    env,
    edge: config.edge,
    vpc: network.vpc,
    eksValidationAlbSecurityGroup: network.eksValidationAlbSecurityGroup,
    eksOtlpTarget: config.eks.otlpTarget,
    // listener 참조가 있어야 Gateway TG health check가 시작된다. 외부 수집은 ingest에 유지한다. (ADR-0049)
    eksPrepareGateway: config.eks.kafkaProvider === 'strimzi' && config.eks.archivePrefix === 'eks' && config.eks.otlpTarget === 'ingest',
    dbEndpoint: data.dbEndpoint,
    dbSecretArn: data.dbSecretArn,
    tokenHashSecretArn: data.tokenHashSecretArn,
    adminApiTokenSecretArn: data.adminApiTokenSecretArn,
  });

  const eks = new DevEksStack(app, 'DevEksStack', {
    env, vpc: network.vpc, config: config.eks,
    dbEndpoint: data.dbEndpoint, dbSecret: data.dbSecret,
    tokenHashSecret: data.tokenHashSecret, adminApiTokenSecret: data.adminApiTokenSecret,
    dashboardRdsSourceSecret: data.dashboardRdsSourceSecret,
    dashboardRdsCacheSecret: data.dashboardRdsCacheSecret,
    dashboardClickHouseSourceSecret: data.dashboardClickHouseSourceSecret,
    dashboardClickHouseCacheSecret: data.dashboardClickHouseCacheSecret,
    managementResponseKeySecret: data.managementResponseKeySecret,
    mailEncryptionKeySecret: data.mailEncryptionKeySecret,
    userJwtPrivateKeySecret: data.userJwtPrivateKeySecret,
    userJwtPublicKeysSecret: data.userJwtPublicKeysSecret,
    telemetryJwtPrivateKeySecret: data.telemetryJwtPrivateKeySecret,
    telemetryJwtPublicKeysSecret: data.telemetryJwtPublicKeysSecret,
    oidcClientSecrets: data.oidcClientSecrets,
    rawSignalBucket: data.rawSignalBucket,
    controlPlaneSecurityGroup: network.eksControlPlaneSecurityGroup,
    appNodeSecurityGroup: network.eksAppNodeSecurityGroup,
    clickhouseNodeSecurityGroup: network.eksClickhouseNodeSecurityGroup,
    relaySecurityGroup: network.eksRelaySecurityGroup,
    observabilityNodeSecurityGroup: network.eksObservabilityNodeSecurityGroup,
    mskSubnets: network.mskSubnets, mskSecurityGroup: network.mskSecurityGroup,
    kafkaNodeSecurityGroup: network.eksKafkaNodeSecurityGroup,
  });

  return { network, data, edge, eks };
}
