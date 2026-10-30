import { CfnPolicy } from 'aws-cdk-lib/aws-iam';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { PerfGuardrailStack } from './guardrail-stack';
import { App, CfnResource, Environment, RemovalPolicy, Tags } from 'aws-cdk-lib/core';
import { applyCommonTags } from '../common/config';
import { PERF_COMMON_TAGS, PERF_ENVIRONMENT_TAG, PERF_STACK_IDS, PerfConfig, perfInfraParameters } from './config';
import { PerfEdgeStack } from './edge-stack';
import { validatePerfEdgeEnvironment } from './edge-config';
import { PerfDataStack } from './data-stack';
import { PerfEksStack } from './eks-stack';
import { PerfEvidenceStack } from './evidence-stack';
import { PerfNetworkStack } from './network-stack';

export interface PerfStacks {
  readonly evidence: PerfEvidenceStack;
  readonly network: PerfNetworkStack;
  readonly data: PerfDataStack;
  readonly eks: PerfEksStack;
  readonly edge?: PerfEdgeStack;
  readonly guardrail?: PerfGuardrailStack;
}

export interface SynthPerfProps {
  readonly env: Environment;
  readonly config: PerfConfig;
}

/**
 * perf 환경 스택을 주어진 App에 조립한다. bin/infra.ts와 테스트가 같은 함수를 거친다.
 *
 * 의존 방향은 `perf -> common` 단방향이다. **`lib/prod/`·`lib/dev/`를 import하지 않는다.** dev의 EKS·MSK 패턴은
 * 같은 결정(ADR-0034·0035·0036)을 따르되 perf 이름·프로필 값으로 다시 선언한다(ADR-0050).
 *
 * 삭제는 Kubernetes TGB 정리 뒤 Edge/EKS → Data(MSK·RDS) → Network 의존의 역순을 따른다. 현행 evidence도 삭제하고 Guardrail은 마지막에 자체 삭제한다.
 */
export function synthPerf(app: App, props: SynthPerfProps): PerfStacks {
  const { env, config } = props;
  const { profile } = config.profile;
  if (env.region !== undefined && env.region !== profile.region) {
    throw new Error(`perf 프로필 리전(${profile.region})과 배포 리전(${env.region})이 다르다`);
  }
  validatePerfEdgeEnvironment(config.edge, env);
  applyCommonTags(app, PERF_COMMON_TAGS);

  const guardrail = config.budget ? new PerfGuardrailStack(app, PERF_STACK_IDS.guardrail, { env, environmentId: config.environmentId, budget: config.budget }) : undefined;
  const evidence = new PerfEvidenceStack(app, PERF_STACK_IDS.evidence, {
    env, retentionDays: profile.retention.evidence_days, ownedCleanup: Boolean(config.budget),
  });
  const network = new PerfNetworkStack(app, PERF_STACK_IDS.network, {
    env, vpcCidr: profile.network.vpc_cidr, nodeAvailabilityZone: profile.availability_zone, natGateways: config.natGateways, kafkaProvider: profile.kafka_provider, httpsGateway: Boolean(config.edge),
  });
  const data = new PerfDataStack(app, PERF_STACK_IDS.data, {
    env, environmentId: config.environmentId, profile, mskBrokerVolumeGiB: config.mskBrokerVolumeGiB,
    vpc: network.vpc, dataSubnets: network.dataSubnets, mskSubnets: network.mskSubnets,
    rdsSecurityGroup: network.rdsSecurityGroup, mskSecurityGroup: network.mskSecurityGroup,
  });
  const eks = new PerfEksStack(app, PERF_STACK_IDS.eks, {
    env, profile, vpc: network.vpc, httpsGateway: Boolean(config.edge), cleanupEnabled: Boolean(config.budget),
    provenance: {
      environmentId: config.environmentId, profilePath: config.profile.path, profileSha256: config.profile.sha256,
      parameters: perfInfraParameters(config),
    },
    controlPlaneSubnets: network.controlPlaneSubnets, nodeSubnets: network.nodeSubnets,
    controlPlaneSecurityGroup: network.controlPlaneSecurityGroup, relaySecurityGroup: network.relaySecurityGroup,
    nodeSecurityGroup: network.nodeSecurityGroup, poolSecurityGroups: network.poolSecurityGroups,
    secrets: {
      db: data.dbSecret, tokenHash: data.tokenHashSecret, adminApiToken: data.adminApiTokenSecret,
      telemetryJwtPrivateKey: data.telemetryJwtPrivateKeySecret, telemetryJwtPublicKeys: data.telemetryJwtPublicKeysSecret,
      syntheticSeed: data.syntheticSeedSecret, seedDb: data.seedDbSecret, verifyDb: data.verifyDbSecret,
      grafanaAdmin: data.grafanaAdminSecret,
    },
    rawSignalBucket: data.rawSignalBucket, evidenceBucket: evidence.bucket,
    msk: data.msk ? { cluster: data.msk, topicArn: data.topicArn!, consumerGroupArn: data.consumerGroupArn!, logGroup: data.mskLogGroup! } : undefined,
  });
  const edge = config.edge ? new PerfEdgeStack(app, PERF_STACK_IDS.edge, { env, vpc: network.vpc, securityGroup: network.albSecurityGroup!, certificateArn: config.edge.certificateArn, ownedCleanup: Boolean(config.budget), natPublicIps: network.natPublicIps }) : undefined;
  // 환경 소유 태그는 지울 스택에만 붙인다. cleanup inventory가 이 태그로 잔존 자원을 찾는다.
  for (const stack of [network, data, eks, ...(edge ? [edge] : [])]) Tags.of(stack).add(PERF_ENVIRONMENT_TAG, config.environmentId);
  if (guardrail) {
    // S3/VPC custom provider의 자동 로그도 CFN이 소유한다. 기본 Lambda 로그를 별도 잔존시키지 않는다.
    for (const stack of [evidence, network, data, eks, ...(edge ? [edge] : [])]) {
      for (const fn of stack.node.findAll().filter((node): node is CfnResource => node instanceof CfnResource && node.cfnResourceType === 'AWS::Lambda::Function')) {
        const name = `soma-376-perf-${stack.stackName.replace(/^Perf|Stack$/g, '').toLowerCase()}-custom-resource`;
        fn.addPropertyOverride('FunctionName', name);
        const logs = new LogGroup(stack, 'ProviderLogs', { logGroupName: `/aws/lambda/${name}`, retention: RetentionDays.ONE_DAY, removalPolicy: RemovalPolicy.DESTROY });
        fn.addPropertyOverride('LoggingConfig', { LogGroup: logs.logGroupName });
        fn.addPropertyOverride('Tags', [{ Key: PERF_ENVIRONMENT_TAG, Value: config.environmentId }, { Key: 'Env', Value: 'perf' }]);
        const role = fn.node.scope?.node.findAll().find((node): node is CfnResource => node instanceof CfnResource && node.cfnResourceType === 'AWS::IAM::Role');
        if (!role) throw new Error('custom resource provider 역할을 찾지 못했다');
        const noCreate = new CfnPolicy(stack, 'ProviderNoImplicitLogs', { policyName: 'NoImplicitCleanupLogGroup', roles: [role.ref], policyDocument: { Version: '2012-10-17', Statement: [{ Effect: 'Deny', Action: 'logs:CreateLogGroup', Resource: '*' }] } });
        fn.node.addDependency(noCreate);
        fn.node.addDependency(logs);
      }
    }
    for (const stack of [evidence, network, data, eks, ...(edge ? [edge] : [])]) stack.addDependency(guardrail);
    for (const stack of [evidence, guardrail]) Tags.of(stack).add(PERF_ENVIRONMENT_TAG, config.environmentId);
  }
  return { evidence, network, data, eks, edge, guardrail };
}
