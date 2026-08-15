import { App, Environment } from 'aws-cdk-lib/core';
import { applyCommonTags } from '../common/config';
import { CicdConfig, CICD_COMMON_TAGS } from './config';
import { DeployStack } from './deploy-stack';

/**
 * cicd 스택 1개. CLI 와 테스트가 같은 조립 결과를 공유하기 위한 반환 타입이다.
 */
export interface CicdStacks {
  readonly deploy: DeployStack;
}

export interface SynthCicdProps {
  readonly env: Environment;
  readonly config: CicdConfig;
}

/**
 * cicd 환경의 단일 스택을 주어진 App 에 조립한다 (ADR-0024 1번).
 *
 * bin/infra.ts(CLI)와 test/helpers.ts(테스트)가 모두 이 함수를 거치므로 양쪽 산출물이
 * 갈라질 수 없다 (ADR-0021 1번).
 *
 * 스택 ID `DeployStack` 은 CloudFormation 스택 이름이며 계정 + 리전에서 유일해야 한다.
 * prod 는 접두사가 없고 dev 는 `Dev` 접두사를 쓰므로 세 환경의 스택 이름 집합은 겹치지 않는다.
 *
 * **`lib/prod/` 도 `lib/dev/` 도 import 하지 않는다.** dev/prod 4-스택을 여기서 조립하지도
 * 않는다 - `-c env=cicd` 로 `cdk deploy --all` 을 돌렸을 때 앱 인프라가 딸려가면 안 되고,
 * 반대로 무인자 `cdk deploy --all`(= prod)이 이 스택을 건드려서도 안 된다. IAM 변경과 앱
 * 인프라 변경이 서로 다른 배포에 속하는 것이 이 분리의 목적이다.
 */
export function synthCicd(app: App, props: SynthCicdProps): CicdStacks {
  const { env, config } = props;

  // IAM 리소스에는 비용이 없으므로 여기서 공통 태그는 비용 축이 아니라 소유권 표시다.
  applyCommonTags(app, CICD_COMMON_TAGS);

  const deploy = new DeployStack(app, 'DeployStack', { env, config });

  return { deploy };
}
