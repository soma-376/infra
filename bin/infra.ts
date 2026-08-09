import { App } from 'aws-cdk-lib/core';
import { loadConfig } from '../lib/prod/config';
import { synthProd } from '../lib/prod/app';

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
  // lib/dev 는 후속 커밋에서 추가된다.
  throw new Error('dev 환경은 아직 구현되지 않았다 (PROJ-37 후속 커밋).');
} else {
  throw new Error(`알 수 없는 env 컨텍스트: ${envName} (dev | prod)`);
}
