import { App, Environment } from 'aws-cdk-lib/core';
import { applyCommonTags } from '../common/config';
import { COMMON_TAGS, InfraConfig } from './config';
import { NetworkStack } from './network-stack';
import { DataStack } from './data-stack';
import { ApplicationStack } from './application-stack';
import { EdgeStack } from './edge-stack';

/**
 * prod 스택 4개. CLI 와 테스트가 같은 조립 결과를 공유하기 위한 반환 타입이다.
 */
export interface ProdStacks {
  readonly network: NetworkStack;
  readonly data: DataStack;
  readonly application: ApplicationStack;
  readonly edge: EdgeStack;
}

export interface SynthProdProps {
  readonly env: Environment;
  readonly config: InfraConfig;
}

/**
 * prod 환경의 4-스택을 주어진 App 에 조립한다.
 *
 * bin/infra.ts(CLI)와 test/helpers.ts(테스트)가 모두 이 함수를 거치므로
 * 양쪽 산출물이 갈라질 수 없다. 스택 ID 와 props 전달 순서는 합성 산출물에
 * 그대로 반영되므로 바꾸지 않는다.
 */
export function synthProd(app: App, props: SynthProdProps): ProdStacks {
  const { env, config } = props;

  // 전 스택의 태그 지원 리소스에 공통 태그를 전파한다 (비용 배분/소유권 식별용).
  applyCommonTags(app, COMMON_TAGS);

  const network = new NetworkStack(app, 'NetworkStack', { env });

  const data = new DataStack(app, 'DataStack', {
    env,
    vpc: network.vpc,
    auroraSecurityGroup: network.auroraSecurityGroup,
  });

  const application = new ApplicationStack(app, 'ApplicationStack', {
    env,
    vpc: network.vpc,
    dbSecret: data.dbSecret,
    postProcessorPgDsnSecret: data.postProcessorPgDsnSecret,
    rawSignalBucket: data.rawSignalBucket,
    collectorSecurityGroup: network.collectorSecurityGroup,
    dashboardSecurityGroup: network.dashboardSecurityGroup,
    clickhouseSecurityGroup: network.clickhouseSecurityGroup,
  });

  const edge = new EdgeStack(app, 'EdgeStack', {
    env,
    vpc: network.vpc,
    collectorService: application.collectorService,
    dashboardService: application.dashboardService,
    albSecurityGroup: network.albSecurityGroup,
    edge: config.edge,
  });

  return { network, data, application, edge };
}
