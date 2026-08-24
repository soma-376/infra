import { App } from 'aws-cdk-lib/core';
import { loadConfig } from '../lib/prod/config';
import { synthProd } from '../lib/prod/app';
import { loadDevConfig } from '../lib/dev/config';
import { synthDev } from '../lib/dev/app';
import { loadCicdConfig } from '../lib/cicd/config';
import { synthCicd } from '../lib/cicd/app';

const app = new App();

// 환경 분기는 `-c env=<이름>` 하나로만 한다. 지정하지 않으면 prod 다.
const envName = (app.node.tryGetContext('env') as string | undefined) ?? 'prod';

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

if (envName === 'prod') {
  synthProd(app, { env, config: loadConfig(app) });
} else if (envName === 'dev') {
  // loadDevConfig 는 App 노드의 context 를 읽으므로 App 생성 이후여야 한다.
  synthDev(app, { env, config: loadDevConfig(app) });
} else if (envName === 'cicd') {
  // 배포 역할 스택만 조립한다. dev/prod 4-스택은 여기 없다 - IAM 변경과 앱 인프라
  // 변경이 같은 `cdk deploy` 에 섞이지 않게 하는 것이 이 분리의 목적이다. (ADR-0024 1번)
  synthCicd(app, { env, config: loadCicdConfig(app) });
} else {
  throw new Error(`알 수 없는 env 컨텍스트: ${envName} (dev | prod | cicd)`);
}
