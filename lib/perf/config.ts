import { loadPerfEdgeConfig, PerfEdgeConfig, PERF_GATEWAY_HTTPS } from './edge-config';
import { resolve } from 'node:path';
import { App } from 'aws-cdk-lib/core';
import { LoadedPerfProfile, PerfPoolId, loadPerfProfile, kafkaProfile } from './profile';

/**
 * perf 스택 공통 태그. `Org`·`ManagedBy`는 prod·dev와 같고 `Env`만 갈린다(ADR-0021 4번과 같은 방식).
 * 환경 소유 태그(`PERF_ENVIRONMENT_TAG`)는 환경 스택에만 붙이고 evidence 스택에는 붙이지 않는다.
 */
export const PERF_COMMON_TAGS: Readonly<Record<string, string>> = {
  Org: 'soma-376',
  Env: 'perf',
  ManagedBy: 'cdk',
};

/** cleanup inventory의 `owner_tag`가 이 키와 environment ID를 쓴다. */
export const PERF_ENVIRONMENT_TAG = 'pulsemetry:perf-environment';
/** 환경보다 오래 사는 evidence 자원의 소유 태그다. */
export const PERF_EVIDENCE_TAG = 'pulsemetry:perf-evidence';

/**
 * 스택 ID. `Perf` 접두사가 prod·dev 스택 이름과의 충돌을 막는다(ADR-0021 3번).
 * evidence 스택은 환경을 지워도 남는다. 나머지 셋은 environment마다 새로 만들고 지운다.
 */
export const PERF_STACK_IDS = {
  evidence: 'PerfEvidenceStack',
  network: 'PerfNetworkStack',
  data: 'PerfDataStack',
  eks: 'PerfEksStack',
  edge: 'PerfEdgeStack',
} as const;

export const PERF_EKS_CLUSTER_NAME = 'soma-376-perf-eks';
export const PERF_EKS_OPERATOR_ROLE_NAME = 'soma-376-perf-eks-operator';
export const PERF_EKS_RELAY_INSTANCE_TYPE = 't4g.micro';
export const PERF_EKS_RELAY_SESSION_DOCUMENT_NAME = 'soma-376-perf-eks-api-tunnel';
/** EKS가 control plane 로그를 쓰는 이름이다. 미리 만들어 보존 기간·삭제를 CDK가 소유한다. */
export const PERF_EKS_CONTROL_PLANE_LOG_GROUP = `/aws/eks/${PERF_EKS_CLUSTER_NAME}/cluster`;

/** Kubernetes namespace. app·observability·runner는 계약 `kubernetes.namespaces`와 같다. */
export const PERF_NAMESPACES = {
  app: 'pulsemetry-perf',
  observability: 'pulsemetry-observability',
  runner: 'pulsemetry-perf-runner',
  logs: 'pulsemetry-perf-logs',
} as const;

/** Helm이 만드는 ServiceAccount 이름. Pod Identity association과 같아야 한다. */
export const PERF_SERVICE_ACCOUNTS = {
  enrollment: 'enrollment-api',
  ingest: 'telemetry-ingest',
  gateway: 'telemetry-gateway',
  topicAdmin: 'telemetry-kafka-admin',
  offsetAdmin: 'telemetry-kafka-offsets',
  seed: 'perf-seed',
  prepare: 'perf-prepare',
  smoke: 'perf-smoke',
  sentinel: 'perf-sentinel',
  runner: 'k6-runner',
  verify: 'perf-verify',
  fluentBit: 'fluent-bit',
  grafana: 'grafana',
  events: 'kubernetes-events',
} as const;

/** MSK 이름. 이름을 바꾸면 cluster·configuration이 교체된다. */
export const PERF_MSK = {
  clusterName: 'soma-376-perf-telemetry',
  configurationName: 'soma-376-perf-telemetry',
  logGroupName: '/aws/vendedlogs/msk/soma-376-perf-telemetry',
  topic: 'pulsemetry-perf-telemetry-ingress',
  consumerGroup: 'pulsemetry-perf-telemetry-ingest',
} as const;

/** MSK SASL/IAM over TLS의 VPC 내부 broker 포트다(ADR-0035와 같은 값). */
export const PERF_MSK_IAM_PORT = 9098;

/** MSK 전용 역할을 assume할 때의 고정 세션 이름. 역할 trust가 이 값만 허용한다(ADR-0036과 같은 방식). */
export const PERF_MSK_SESSION_NAMES = {
  gateway: 'pulsemetry-perf-telemetry-gateway',
  ingest: 'pulsemetry-perf-telemetry-ingest',
  topicAdmin: 'pulsemetry-perf-telemetry-kafka-admin',
  offsetAdmin: 'pulsemetry-perf-telemetry-kafka-offsets',
} as const;

/** 컨테이너·서비스 포트. */
export const PERF_PORTS = {
  gateway: 8082,
  enrollment: 8080,
  ingest: 4316,
  appMetrics: 9404,
  clickhouseHttp: 8123,
  clickhouseNative: 9000,
  clickhouseMetrics: 9363,
  prometheus: 9090,
  postgres: 5432,
  kubelet: 10250,
  nodeExporter: 9100,
  fluentBitMetrics: 2020,
  dns: 53,
  mskJmxExporter: 11001,
  mskNodeExporter: 11002,
} as const;

/** ingest가 raw signal을 쓰는 prefix. 계약 `datastores.raw_signal_bucket.prefix`는 `perf/`다. */
export const PERF_ARCHIVE_PREFIX = 'perf';
/** evidence bucket의 시험 증거 prefix. job-values가 `<prefix><experiment>/<run>/`을 만든다. */
export const PERF_EVIDENCE_PREFIX = 'runs/';
/** 환경 단위 smoke 증거는 운영자가 쓴다. Job 역할은 이 prefix에 쓰지 못한다. */
export const PERF_ENVIRONMENT_EVIDENCE_PREFIX = 'environments/';

/** enrollment DB 세션을 `pg_stat_activity.application_name`으로 가려낸다(PLAN §5 발급과 인계 4단계). */
export const PERF_DB_APPLICATION_NAMES = {
  enrollment: 'pulsemetry-enrollment-api',
  ingest: 'pulsemetry-telemetry-ingest',
} as const;

/** seed·검증 DB 계정의 사용자 이름. 실제 role·권한은 운영자가 런북대로 만든다. */
export const PERF_DB_USERS = { seed: 'perf_seed', verify: 'perf_verify' } as const;

/** Auto Mode NodePool·NodeClass 이름. resolved `node_pool_name`·`node_class_name`이다. */
export const perfNodePoolName = (pool: PerfPoolId) => `perf-${pool}`;
export const PERF_NODE_CLASS_NAME = 'perf-arm64';

/** environment ID를 넣은 Secret 이름. 지운 환경의 이름을 다시 쓰지 않는다. */
export function perfSecretName(environmentId: string, name: string): string {
  return `soma-376/perf/${environmentId}/${name}`;
}

export interface PerfConfig {
  /** 계약 `environment.environment_id`. 소유 태그·Secret 이름에 들어간다. */
  readonly environmentId: string;
  readonly edge?: PerfEdgeConfig;
  readonly profile: LoadedPerfProfile;
  /** 프로필 기본값을 덮어쓴 배포 입력. 계약 `infra.parameters`에 그대로 기록한다. */
  readonly natGateways: number;
  readonly mskBrokerVolumeGiB: number;
}

/** 계약 slug 형식. 63자 상한은 Secret·태그 길이에도 맞는다. */
const ENVIRONMENT_ID = /^perf-[a-z0-9]([a-z0-9-]{0,40}[a-z0-9])?$/;

function contextInteger(app: App, key: string, fallback: number, minimum: number, maximum: number): number {
  const raw = app.node.tryGetContext(key);
  if (raw === undefined) return fallback;
  const value = typeof raw === 'number' ? raw : /^[0-9]+$/.test(String(raw)) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${key}는 ${minimum} 이상 ${maximum} 이하의 정수여야 한다`);
  }
  return value;
}

/**
 * `-c env=perf`의 입력. environment ID는 필수다. 오타나 빈 값을 조용히 기본값으로 바꾸지 않는다.
 * 프로필은 저장소의 `profiles/perf/`에서만 읽는다.
 */
export function loadPerfConfig(app: App, repositoryRoot = resolve(__dirname, '../..')): PerfConfig {
  const environmentId = app.node.tryGetContext('perfEnvironmentId');
  if (typeof environmentId !== 'string' || !ENVIRONMENT_ID.test(environmentId)) {
    throw new Error('perfEnvironmentId는 perf-로 시작하는 소문자·숫자·하이픈 slug(최대 47자)여야 한다');
  }
  const profile = loadPerfProfile(app.node.tryGetContext('perfProfile') ?? 'profiles/perf/fixed-v1.json', repositoryRoot);
  if (profile.profile.kafka_provider === 'strimzi' && app.node.tryGetContext('perfMskBrokerVolumeGiB') !== undefined) throw new Error('Strimzi 프로필은 perfMskBrokerVolumeGiB를 받지 않는다');
  return {
    environmentId,
    edge: loadPerfEdgeConfig(app),
    profile,
    natGateways: contextInteger(app, 'perfNatGateways', profile.profile.network.nat_gateways, 1, 3),
    mskBrokerVolumeGiB: contextInteger(app, 'perfMskBrokerVolumeGiB', kafkaProfile(profile.profile).volume_gib, 1, 16_384),
  };
}

/** 계약 `infra.parameters`. 이름은 camelCase이며 값은 문자열·숫자만 쓴다. */
export function perfInfraParameters(config: PerfConfig): Record<string, string | number> {
  return {
    environmentId: config.environmentId,
    ...(config.edge ? { certificateArn: config.edge.certificateArn, gatewayHttps: PERF_GATEWAY_HTTPS } : {}),
    natGateways: config.natGateways,
    ...(config.profile.profile.kafka_provider === 'strimzi' ? { kafkaProvider: 'strimzi', kafkaVolumeGiB: config.profile.profile.strimzi!.volume_gib } : { mskBrokerVolumeGiB: config.mskBrokerVolumeGiB }),
    clickhouseVolumeGiB: config.profile.profile.clickhouse.volume_gib,
  };
}
