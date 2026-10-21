import { App } from 'aws-cdk-lib/core';

export const DEV_EKS_CLUSTER_NAME = 'soma-376-dev-eks';
export const DEV_EKS_OPERATOR_ROLE_NAME = 'soma-376-dev-eks-operator';
export const DEV_EKS_RELAY_INSTANCE_TYPE = 't4g.micro';
export const DEV_EKS_RELAY_SESSION_DOCUMENT_NAME = 'soma-376-dev-eks-api-tunnel';
export const DEV_EKS_NAMESPACE = 'pulsemetry-dev';
export const DEV_EKS_VERSION = '1.36';
export const DEV_EKS_NODE_PORTS = { ingest: 30416, enrollment: 30080, dashboard: 30081, gateway: 30082 } as const;

/**
 * MSK broker 전용 subnet. VPC의 `maxAzs: 2` public subnet과 별개로 EKS 활성화 시에만 만든다.
 * local route만 가지며 VPC subnet 선택에 포함되지 않는다. (ADR-0035)
 */
export const DEV_EKS_MSK_SUBNETS = [
  { cidrBlock: '10.1.32.0/24', availabilityZone: 'ap-northeast-2a' },
  { cidrBlock: '10.1.33.0/24', availabilityZone: 'ap-northeast-2b' },
  { cidrBlock: '10.1.34.0/24', availabilityZone: 'ap-northeast-2c' },
] as const;

/** MSK SASL/IAM over TLS의 VPC 내부 broker 포트다. (ADR-0035) */
export const DEV_EKS_MSK_IAM_PORT = 9098;

/** MSK Provisioned 고정값. 이름을 바꾸면 cluster·configuration이 교체된다. (ADR-0035) */
export const DEV_EKS_MSK = {
  clusterName: 'soma-376-dev-telemetry',
  configurationName: 'soma-376-dev-telemetry',
  kafkaVersion: '3.9.x.kraft',
  instanceType: 'kafka.m7g.large',
  brokerCount: 3,
  volumeSizeGiB: 100,
  logGroupName: '/aws/vendedlogs/msk/soma-376-dev-telemetry',
} as const;

/** producer 12 MiB record에 batch 여유를 둔 broker·topic·replica fetch 상한(13 MiB)이다. */
export const DEV_EKS_MSK_MAX_MESSAGE_BYTES = 13 * 1024 * 1024;

/** MSK 기본 unclean leader election(true)을 끄고 auto create를 막는다. topic 관리 Job이 같은 값을 대조한다. */
export const DEV_EKS_MSK_SERVER_PROPERTIES: Readonly<Record<string, string>> = {
  'auto.create.topics.enable': 'false',
  'default.replication.factor': '3',
  'min.insync.replicas': '2',
  'num.partitions': '6',
  'unclean.leader.election.enable': 'false',
  'message.max.bytes': String(DEV_EKS_MSK_MAX_MESSAGE_BYTES),
  'replica.fetch.max.bytes': String(DEV_EKS_MSK_MAX_MESSAGE_BYTES),
  'log.retention.hours': '72',
};

/** archive prefix와 topic/group·IAM 범위를 같은 입력으로 바꾼다. 검증과 본 수집 데이터가 섞이지 않게 한다. */
export type DevTelemetryStage = 'validation' | 'main';
export function devTelemetryStage(archivePrefix: DevEksConfig['archivePrefix']): DevTelemetryStage {
  if (archivePrefix === 'eks_validation') return 'validation';
  if (archivePrefix === 'eks') return 'main';
  throw new Error('EKS archivePrefix는 eks_validation 또는 eks여야 한다');
}
export const devTelemetryTopicName = (stage: DevTelemetryStage) => `pulsemetry-dev-telemetry-ingress-${stage}`;
export const devTelemetryConsumerGroupName = (stage: DevTelemetryStage) => `pulsemetry-dev-telemetry-ingest-${stage}`;

/**
 * MSK 전용 역할을 assume할 때의 고정 세션 이름이다. Pod Identity 자격이 갱신돼도 MSK 재인증 주체가
 * 바뀌지 않게 한다. 역할 trust가 이 값만 허용한다. (ADR-0036)
 */
export const DEV_EKS_TELEMETRY_SESSION_NAMES = {
  gateway: 'pulsemetry-dev-telemetry-gateway',
  ingest: 'pulsemetry-dev-telemetry-ingest',
  topicAdmin: 'pulsemetry-dev-telemetry-kafka-admin',
  offsetAdmin: 'pulsemetry-dev-telemetry-kafka-offsets',
} as const;

/** Helm이 만드는 ServiceAccount 이름이다. Pod Identity association과 같아야 한다. */
export const DEV_EKS_TELEMETRY_SERVICE_ACCOUNTS = {
  gateway: 'telemetry-gateway',
  topicAdmin: 'telemetry-kafka-admin',
  offsetAdmin: 'telemetry-kafka-offsets',
} as const;

export interface DevEksConfig {
  readonly enabled: boolean;
  readonly archivePrefix: 'eks_validation' | 'eks';
}

/** 무인자 synth는 기존 ECS만 유지한다. 활성화 입력 오타는 조용히 기본값으로 바꾸지 않는다. */
export function loadDevEksConfig(app: App): DevEksConfig {
  if (app.node.tryGetContext('devEksApiAllowedCidrs') !== undefined) {
    throw new Error('devEksApiAllowedCidrs는 제거되었습니다. 해당 context를 삭제하고 SSM 릴레이 터널로 private EKS API에 접근하세요');
  }
  const raw = app.node.tryGetContext('devEksEnabled');
  if (raw !== undefined && ![true, false, 'true', 'false'].includes(raw)) {
    throw new Error('devEksEnabled는 true 또는 false여야 한다');
  }
  const enabled = raw === true || raw === 'true';
  if (!enabled) return { enabled: false, archivePrefix: 'eks_validation' };
  const archivePrefix = app.node.tryGetContext('devEksArchivePrefix') ?? 'eks_validation';
  if (archivePrefix !== 'eks_validation' && archivePrefix !== 'eks') {
    throw new Error('devEksArchivePrefix는 eks_validation 또는 eks여야 한다');
  }
  return { enabled, archivePrefix };
}
