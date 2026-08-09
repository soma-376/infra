import * as fs from 'fs';
import * as path from 'path';
import { App } from 'aws-cdk-lib/core';
import { EdgeConfig } from '../lib/prod/config';
import { synthProd } from '../lib/prod/app';
import { NetworkStack } from '../lib/prod/network-stack';
import { DataStack } from '../lib/prod/data-stack';
import { ApplicationStack } from '../lib/prod/application-stack';
import { EdgeStack } from '../lib/prod/edge-stack';

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

/** 모드 A(HTTPS + ALB 인증) EdgeConfig. */
export const MODE_A_EDGE: EdgeConfig = {
  certificateArn:
    'arn:aws:acm:ap-northeast-2:111111111111:certificate/dummy-cert-id',
  domainName: 'example.com',
  cognitoDomainPrefix: 'test-prefix',
};
