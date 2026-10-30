import { App, Environment, Tags } from 'aws-cdk-lib/core';
import { applyCommonTags } from '../common/config';
import { PERF_COMMON_TAGS, PERF_ENVIRONMENT_TAG, PERF_STACK_IDS, PerfConfig, perfInfraParameters } from './config';
import { PerfDataStack } from './data-stack';
import { PerfEksStack } from './eks-stack';
import { PerfEvidenceStack } from './evidence-stack';
import { PerfNetworkStack } from './network-stack';

export interface PerfStacks {
  readonly evidence: PerfEvidenceStack;
  readonly network: PerfNetworkStack;
  readonly data: PerfDataStack;
  readonly eks: PerfEksStack;
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
 * 삭제 순서는 manifest 의존의 역순인 EKS → Data(MSK·RDS) → Network다. evidence 스택은 남긴다.
 */
export function synthPerf(app: App, props: SynthPerfProps): PerfStacks {
  const { env, config } = props;
  const { profile } = config.profile;
  if (env.region !== undefined && env.region !== profile.region) {
    throw new Error(`perf 프로필 리전(${profile.region})과 배포 리전(${env.region})이 다르다`);
  }
  applyCommonTags(app, PERF_COMMON_TAGS);

  const evidence = new PerfEvidenceStack(app, PERF_STACK_IDS.evidence, {
    env, retentionDays: profile.retention.evidence_days,
  });
  const network = new PerfNetworkStack(app, PERF_STACK_IDS.network, {
    env, vpcCidr: profile.network.vpc_cidr, nodeAvailabilityZone: profile.availability_zone, natGateways: config.natGateways, kafkaProvider: profile.kafka_provider,
  });
  const data = new PerfDataStack(app, PERF_STACK_IDS.data, {
    env, environmentId: config.environmentId, profile, mskBrokerVolumeGiB: config.mskBrokerVolumeGiB,
    vpc: network.vpc, dataSubnets: network.dataSubnets, mskSubnets: network.mskSubnets,
    rdsSecurityGroup: network.rdsSecurityGroup, mskSecurityGroup: network.mskSecurityGroup,
  });
  const eks = new PerfEksStack(app, PERF_STACK_IDS.eks, {
    env, profile, vpc: network.vpc,
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
  // 환경 소유 태그는 지울 스택에만 붙인다. cleanup inventory가 이 태그로 잔존 자원을 찾는다.
  for (const stack of [network, data, eks]) Tags.of(stack).add(PERF_ENVIRONMENT_TAG, config.environmentId);
  return { evidence, network, data, eks };
}
