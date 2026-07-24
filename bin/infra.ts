#!/opt/homebrew/opt/node/bin/node
import { App } from 'aws-cdk-lib/core';
import { applyCommonTags, loadConfig } from '../lib/config';
import { NetworkStack } from '../lib/network-stack';
import { DataStack } from '../lib/data-stack';
import { ApplicationStack } from '../lib/application-stack';
import { EdgeStack } from '../lib/edge-stack';

const app = new App();
const config = loadConfig(app);

// 전 스택의 태그 지원 리소스에 공통 태그를 전파한다 (비용 배분/소유권 식별용).
applyCommonTags(app);

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

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
  rawSignalBucket: data.rawSignalBucket,
  collectorSecurityGroup: network.collectorSecurityGroup,
  dashboardSecurityGroup: network.dashboardSecurityGroup,
  clickhouseSecurityGroup: network.clickhouseSecurityGroup,
});

new EdgeStack(app, 'EdgeStack', {
  env,
  vpc: network.vpc,
  collectorService: application.collectorService,
  dashboardService: application.dashboardService,
  albSecurityGroup: network.albSecurityGroup,
  edge: config.edge,
});
