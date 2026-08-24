import * as fs from 'fs';
import * as path from 'path';
import { App } from 'aws-cdk-lib/core';
import { EdgeConfig } from '../lib/prod/config';
import { synthProd } from '../lib/prod/app';
import { NetworkStack } from '../lib/prod/network-stack';
import { DataStack } from '../lib/prod/data-stack';
import { ApplicationStack } from '../lib/prod/application-stack';
import { EdgeStack } from '../lib/prod/edge-stack';
import { loadDevConfig } from '../lib/dev/config';
import { synthDev } from '../lib/dev/app';
import { DevNetworkStack } from '../lib/dev/network-stack';
import { DevDataStack } from '../lib/dev/data-stack';
import { DevApplicationStack } from '../lib/dev/application-stack';
import { DevEdgeStack } from '../lib/dev/edge-stack';
import { loadCicdConfig } from '../lib/cicd/config';
import { synthCicd } from '../lib/cicd/app';
import { DeployStack } from '../lib/cicd/deploy-stack';

export const TEST_ENV = { account: '111111111111', region: 'ap-northeast-2' };

const DEFAULT_EDGE: EdgeConfig = {
  cognitoDomainPrefix: 'test-prefix',
};

export interface BuiltApp {
  app: App;
  network: NetworkStack;
  data: DataStack;
  application: ApplicationStack;
  edge: EdgeStack;
}

/**
 * 고정 env 로 4-스택을 조립하는 테스트 팩토리.
 * edgeConfig 를 주면 EdgeStack 모드(A/B)를 제어한다.
 */
/**
 * cdk.json 의 context(피처 플래그 포함)를 로드한다. bare `new App()` 은 이를
 * 자동으로 읽지 않아 CLI synth 와 산출물이 달라지므로(예: ASG 가 LaunchTemplate
 * 대신 LaunchConfiguration 생성), 테스트에서도 동일 context 를 주입한다.
 */
function loadCdkContext(): Record<string, unknown> {
  const cdkJsonPath = path.join(__dirname, '..', 'cdk.json');
  const cdkJson = JSON.parse(fs.readFileSync(cdkJsonPath, 'utf-8'));
  return cdkJson.context ?? {};
}

export function buildApp(edgeConfig: EdgeConfig = DEFAULT_EDGE): BuiltApp {
  const app = new App({ context: loadCdkContext() });
  // 스택 조립과 공통 태그 적용은 bin/infra.ts 와 같은 `synthProd` 를 거친다.
  // 손으로 복제하면 CLI synth 결과와 조용히 갈라진다.
  const stacks = synthProd(app, {
    env: TEST_ENV,
    config: { edge: edgeConfig },
  });

  return { app, ...stacks };
}

export interface BuiltDevApp {
  app: App;
  network: DevNetworkStack;
  data: DevDataStack;
  application: DevApplicationStack;
  edge: DevEdgeStack;
}

/**
 * 고정 env 로 dev 4-스택을 조립하는 테스트 팩토리.
 *
 * `context` 로 dev context 키(`devAllowedCidr`, `devAppAsgMaxCapacity`,
 * `devImageTag`)를 주입한다 - CLI 의 `-c key=value` 와 같은 자리다. cdk.json 의
 * 피처 플래그 위에 덮어쓰므로 위 `buildApp()` 과 같은 합성 조건을 공유한다.
 *
 * 스택 조립은 bin/infra.ts(CLI)와 같은 `synthDev` 를 거친다. 손으로 복제하면
 * CLI synth 결과와 조용히 갈라지며, 그게 ADR-0021 이 없앤 문제다.
 */
export function buildDevApp(
  context: Record<string, unknown> = {},
): BuiltDevApp {
  const app = new App({ context: { ...loadCdkContext(), ...context } });
  const stacks = synthDev(app, {
    env: TEST_ENV,
    config: loadDevConfig(app),
  });

  return { app, ...stacks };
}

export interface BuiltCicdApp {
  app: App;
  deploy: DeployStack;
}

/**
 * 고정 env 로 cicd 단일 스택을 조립하는 테스트 팩토리.
 *
 * `context` 로 `githubOidcProviderArn` 을 주입한다 - CLI 의 `-c key=value` 와 같은 자리다.
 * 주지 않으면 OIDC 공급자를 새로 만드는 기본 경로가 합성된다.
 *
 * `loadCdkContext()` 재사용은 선택이 아니다. `@aws-cdk/aws-iam:minimizePolicies` 와
 * `@aws-cdk/core:enablePartitionLiterals` 가 IAM 산출물의 형태를 바꾸므로, bare `App` 을
 * 쓰면 이 스위트만 CLI synth 와 다른 템플릿을 보게 된다.
 *
 * 스택 조립은 bin/infra.ts(CLI)와 같은 `synthCicd` 를 거친다 (ADR-0021 1번).
 */
export function buildCicdApp(
  context: Record<string, unknown> = {},
): BuiltCicdApp {
  const app = new App({ context: { ...loadCdkContext(), ...context } });
  const stacks = synthCicd(app, {
    env: TEST_ENV,
    config: loadCicdConfig(app),
  });

  return { app, ...stacks };
}

/** 모드 A(HTTPS + ALB 인증) EdgeConfig. */
export const MODE_A_EDGE: EdgeConfig = {
  certificateArn:
    'arn:aws:acm:ap-northeast-2:111111111111:certificate/dummy-cert-id',
  domainName: 'example.com',
  cognitoDomainPrefix: 'test-prefix',
};
