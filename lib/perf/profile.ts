import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { load, JSON_SCHEMA } from 'js-yaml';

/**
 * perf 고정 용량 프로필(`profiles/perf/*.json`). CDK 합성·Helm values·결과 파일 생산자가 같은 값을 읽는다.
 * 수치는 첫 측정을 시작할 가설이다(PLAN §4.1). 파일 바이트의 SHA-256이 request/resolved `infra.profile_sha256`이다.
 */

export const PERF_POOL_IDS = ['gateway', 'pipeline', 'clickhouse', 'generator', 'observability', 'system'] as const;
export type PerfPoolId = typeof PERF_POOL_IDS[number] | 'kafka';
export const perfPoolIds = (profile: PerfProfile): readonly PerfPoolId[] => profile.kafka_provider === 'strimzi' ? [...PERF_POOL_IDS, 'kafka'] : PERF_POOL_IDS;
export const kafkaProfile = (profile: PerfProfile) => profile.kafka_provider === 'strimzi' ? profile.strimzi! : profile.msk!;
export const PERF_WORKLOAD_IDS = ['telemetry-gateway', 'telemetry-ingest', 'clickhouse', 'enrollment-api'] as const;
export type PerfWorkloadId = typeof PERF_WORKLOAD_IDS[number];
export const PERF_JOB_IDS = ['seed', 'prepare', 'smoke', 'sentinel', 'runner', 'verify'] as const;
export type PerfJobId = typeof PERF_JOB_IDS[number];

export interface PerfNodePool {
  readonly role: PerfPoolId;
  readonly instance_type: string;
  readonly nodes: number;
  readonly capacity_type: 'on-demand';
  readonly architecture: 'arm64';
  /** true면 `workload=<role>:NoSchedule` taint로 다른 Pod를 막는다. system pool만 false다. */
  readonly dedicated: boolean;
  readonly ephemeral_storage_gib: number;
}

export interface PerfWorkload {
  readonly node_pool: PerfPoolId;
  readonly replicas: number;
  readonly cpu_request_millicores: number;
  readonly memory_request_bytes: number;
  readonly cpu_limit_millicores: number | null;
  readonly memory_limit_bytes: number;
}

export interface PerfJob {
  readonly node_pool: PerfPoolId;
  readonly cpu_request_millicores: number;
  readonly memory_request_bytes: number;
  readonly memory_limit_bytes: number;
}

export interface PerfProfile {
  readonly schema_version: 1 | 2;
  readonly kafka_provider?: 'strimzi';
  readonly kind: 'perf-profile';
  readonly id: string;
  readonly status: 'hypothesis' | 'ready';
  readonly note: string;
  readonly region: 'ap-northeast-2';
  readonly availability_zone: string;
  readonly kubernetes_version: string;
  readonly network: { readonly vpc_cidr: string; readonly nat_gateways: number };
  readonly node_pools: Readonly<Record<PerfPoolId, PerfNodePool>>;
  readonly workloads: Readonly<Record<PerfWorkloadId, PerfWorkload>>;
  readonly jobs: Readonly<Record<PerfJobId, PerfJob>>;
  readonly clickhouse: { readonly storage_class: string; readonly volume_gib: number; readonly iops: number; readonly throughput_mibps: number };
  readonly rds: { readonly engine_version: '16.13'; readonly instance_class: string; readonly storage_gib: number; readonly multi_az: boolean };
  readonly msk?: {
    readonly kafka_version: string; readonly broker_count: 3; readonly instance_type: string; readonly volume_gib: number;
    readonly partitions: number; readonly replication_factor: number; readonly min_insync_replicas: number;
    readonly retention_hours: number; readonly max_message_bytes: number;
  };
  readonly strimzi?: {
    readonly kafka_version: '4.2.2'; readonly broker_count: 3; readonly volume_gib: number;
    readonly partitions: 6; readonly replication_factor: 3; readonly min_insync_replicas: 2;
    readonly retention_hours: 72; readonly max_message_bytes: number;
    readonly storage_class: 'pulsemetry-perf-kafka-gp3';
  };
  readonly retention: {
    readonly evidence_days: number; readonly raw_signal_days: number; readonly prometheus_days: number;
    readonly prometheus_bytes: number; readonly cloudwatch_log_days: number;
  };
  readonly observability: { readonly scrape_interval_seconds: number };
}

export interface LoadedPerfProfile {
  readonly profile: PerfProfile;
  /** 저장소 루트 기준 경로. request/resolved의 `infra.profile`과 같은 값이다. */
  readonly path: string;
  readonly sha256: string;
}

/** CloudWatch Logs가 허용하는 보존 일수 중 이 프로필에 쓸 수 있는 값. */
const LOG_RETENTION_DAYS = [1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365];

function fail(field: string, reason: string): never {
  throw new Error(`perf 프로필 ${field}: ${reason}`);
}

function object(value: unknown, field: string, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(field, '객체가 필요하다');
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter(key => !keys.includes(key));
  if (unknown.length) fail(field, `알 수 없는 키 ${unknown.sort().join(', ')}`);
  const missing = keys.filter(key => !Object.hasOwn(record, key));
  if (missing.length) fail(field, `필수 키 누락 ${missing.join(', ')}`);
  return record;
}

function integer(value: unknown, field: string, minimum = 1, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(field, `${minimum} 이상 ${maximum} 이하의 정수가 필요하다`);
  }
  return value;
}

function text(value: unknown, field: string, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) fail(field, `형식 ${pattern} 이 필요하다`);
  return value;
}

function constant<T>(value: unknown, field: string, expected: T): T {
  if (value !== expected) fail(field, `${JSON.stringify(expected)}이어야 한다`);
  return expected;
}

/** 계약 schema의 instance_type·availability_zone 형식과 같다. */
const INSTANCE_TYPE = /^[a-z][a-z0-9-]*\.[a-z0-9]+$/;
const ARM64_FAMILY = /^[a-z][a-z0-9]*g[a-z0-9]*\.[a-z0-9]+$/;

export function parsePerfProfile(value: unknown): PerfProfile {
  const strimzi = !!value && typeof value === 'object' && (value as Record<string, unknown>).kafka_provider === 'strimzi';
  const root = object(value, '(root)', [
    'schema_version', 'kind', 'id', 'status', 'note', 'region', 'availability_zone', 'kubernetes_version', 'network',
    'node_pools', 'workloads', 'jobs', 'clickhouse', 'rds', ...(strimzi ? ['kafka_provider', 'strimzi'] : ['msk']), 'retention', 'observability',
  ]);
  constant(root.schema_version, 'schema_version', strimzi ? 2 : 1);
  constant(root.kind, 'kind', 'perf-profile');
  text(root.id, 'id', /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/);
  if (root.status !== 'hypothesis' && root.status !== 'ready') fail('status', 'hypothesis 또는 ready여야 한다');
  text(root.note, 'note', /\S/);
  constant(root.region, 'region', 'ap-northeast-2');
  const zone = text(root.availability_zone, 'availability_zone', /^ap-northeast-2[a-d]$/);
  text(root.kubernetes_version, 'kubernetes_version', /^1\.36$/);

  const network = object(root.network, 'network', ['vpc_cidr', 'nat_gateways']);
  const cidr = text(network.vpc_cidr, 'network.vpc_cidr', /^10\.([0-9]{1,3})\.0\.0\/16$/);
  // prod(10.0)·dev(10.1)와 겹치지 않는 /16만 받는다.
  const second = Number(/^10\.([0-9]+)\./.exec(cidr)![1]);
  if (second < 2 || second > 255) fail('network.vpc_cidr', 'prod·dev와 겹치지 않는 10.2.0.0/16 이상이어야 한다');
  integer(network.nat_gateways, 'network.nat_gateways', 1, 3);

  const poolIds = strimzi ? [...PERF_POOL_IDS, 'kafka'] : PERF_POOL_IDS;
  const pools = object(root.node_pools, 'node_pools', poolIds);
  for (const id of poolIds) {
    const field = `node_pools.${id}`;
    const pool = object(pools[id], field, ['role', 'instance_type', 'nodes', 'capacity_type', 'architecture', 'dedicated', 'ephemeral_storage_gib']);
    constant(pool.role, `${field}.role`, id);
    const type = text(pool.instance_type, `${field}.instance_type`, INSTANCE_TYPE);
    if (!ARM64_FAMILY.test(type)) fail(`${field}.instance_type`, 'Graviton(ARM64) 인스턴스 계열이 필요하다');
    integer(pool.nodes, `${field}.nodes`, 1, 3);
    if (id === 'kafka') { constant(pool.nodes, `${field}.nodes`, 3); constant(type, `${field}.instance_type`, 'm7g.large'); }
    constant(pool.capacity_type, `${field}.capacity_type`, 'on-demand');
    constant(pool.architecture, `${field}.architecture`, 'arm64');
    if (typeof pool.dedicated !== 'boolean') fail(`${field}.dedicated`, 'boolean이 필요하다');
    // system pool은 시스템 구성요소·준비 도구가 함께 쓰므로 taint를 두지 않는다. 나머지는 전용이다.
    if (pool.dedicated !== (id !== 'system')) fail(`${field}.dedicated`, id === 'system' ? 'system pool은 false다' : '측정·관측 pool은 true다');
    integer(pool.ephemeral_storage_gib, `${field}.ephemeral_storage_gib`, 20, 500);
  }

  const workloads = object(root.workloads, 'workloads', PERF_WORKLOAD_IDS);
  const placement: Record<PerfWorkloadId, PerfPoolId> = {
    'telemetry-gateway': 'gateway', 'telemetry-ingest': 'pipeline', clickhouse: 'clickhouse', 'enrollment-api': 'system',
  };
  for (const id of PERF_WORKLOAD_IDS) {
    const field = `workloads.${id}`;
    const workload = object(workloads[id], field, [
      'node_pool', 'replicas', 'cpu_request_millicores', 'memory_request_bytes', 'cpu_limit_millicores', 'memory_limit_bytes',
    ]);
    constant(workload.node_pool, `${field}.node_pool`, placement[id]);
    // 첫 프로필은 workload마다 단일 replica다. enrollment의 실행 중 0은 준비 절차가 만든다(PLAN §5).
    constant(workload.replicas, `${field}.replicas`, 1);
    integer(workload.cpu_request_millicores, `${field}.cpu_request_millicores`, 100, 64_000);
    const request = integer(workload.memory_request_bytes, `${field}.memory_request_bytes`, 256 * 2 ** 20);
    if (workload.cpu_limit_millicores !== null) integer(workload.cpu_limit_millicores, `${field}.cpu_limit_millicores`, 100, 64_000);
    const limit = integer(workload.memory_limit_bytes, `${field}.memory_limit_bytes`, 256 * 2 ** 20);
    if (limit < request) fail(`${field}.memory_limit_bytes`, 'memory request보다 작을 수 없다');
    if (request % 2 ** 20 || limit % 2 ** 20) fail(field, 'memory는 MiB 단위여야 한다');
  }

  const jobs = object(root.jobs, 'jobs', PERF_JOB_IDS);
  for (const id of PERF_JOB_IDS) {
    const field = `jobs.${id}`;
    const job = object(jobs[id], field, ['node_pool', 'cpu_request_millicores', 'memory_request_bytes', 'memory_limit_bytes']);
    // 측정 Pod와 겹치지 않게 runner만 generator pool, 나머지는 system pool이다(perf-jobs.md §2).
    constant(job.node_pool, `${field}.node_pool`, id === 'runner' ? 'generator' : 'system');
    integer(job.cpu_request_millicores, `${field}.cpu_request_millicores`, 50, 64_000);
    const request = integer(job.memory_request_bytes, `${field}.memory_request_bytes`, 64 * 2 ** 20);
    const limit = integer(job.memory_limit_bytes, `${field}.memory_limit_bytes`, 64 * 2 ** 20);
    if (limit < request) fail(`${field}.memory_limit_bytes`, 'memory request보다 작을 수 없다');
    if (request % 2 ** 20 || limit % 2 ** 20) fail(field, 'memory는 MiB 단위여야 한다');
  }

  const clickhouse = object(root.clickhouse, 'clickhouse', ['storage_class', 'volume_gib', 'iops', 'throughput_mibps']);
  constant(clickhouse.storage_class, 'clickhouse.storage_class', 'pulsemetry-perf-gp3');
  integer(clickhouse.volume_gib, 'clickhouse.volume_gib', 20, 16_384);
  // gp3 기준선 이상, 볼륨 크기 비율 상한(500 IOPS/GiB, 0.25 MiBps/IOPS) 이하만 받는다.
  const iops = integer(clickhouse.iops, 'clickhouse.iops', 3000, 16_000);
  if (iops > (clickhouse.volume_gib as number) * 500) fail('clickhouse.iops', '볼륨 GiB당 500 IOPS를 넘을 수 없다');
  const throughput = integer(clickhouse.throughput_mibps, 'clickhouse.throughput_mibps', 125, 1000);
  if (throughput > iops / 4) fail('clickhouse.throughput_mibps', 'IOPS의 1/4(MiB/s)을 넘을 수 없다');

  const rds = object(root.rds, 'rds', ['engine_version', 'instance_class', 'storage_gib', 'multi_az']);
  constant(rds.engine_version, 'rds.engine_version', '16.13');
  text(rds.instance_class, 'rds.instance_class', /^db\.[a-z0-9]*g[a-z0-9]*\.[a-z0-9]+$/);
  integer(rds.storage_gib, 'rds.storage_gib', 20, 1000);
  if (typeof rds.multi_az !== 'boolean') fail('rds.multi_az', 'boolean이 필요하다');

  const msk = object(strimzi ? root.strimzi : root.msk, strimzi ? 'strimzi' : 'msk', [
    'kafka_version', 'broker_count', ...(strimzi ? ['storage_class'] : ['instance_type']), 'volume_gib', 'partitions', 'replication_factor',
    'min_insync_replicas', 'retention_hours', 'max_message_bytes',
  ]);
  text(msk.kafka_version, 'kafka.kafka_version', strimzi ? /^4\.2\.2$/ : /^3\.9\.x\.kraft$/);
  if (strimzi) constant(msk.storage_class, 'strimzi.storage_class', 'pulsemetry-perf-kafka-gp3');
  // broker 3대·3 AZ는 MSK subnet·생성기 검사와 같은 고정값이다(ADR-0035).
  constant(msk.broker_count, 'msk.broker_count', 3);
  if (!strimzi) text(msk.instance_type, 'msk.instance_type', /^kafka\.m7g\.(large|xlarge|2xlarge)$/);
  integer(msk.volume_gib, 'msk.volume_gib', 1, 16_384);
  constant(msk.partitions, 'msk.partitions', 6);
  constant(msk.replication_factor, 'msk.replication_factor', 3);
  constant(msk.min_insync_replicas, 'msk.min_insync_replicas', 2);
  // topic 관리 Job(topic-init.sh)이 retention.ms=259200000(72h)을 대조한다. 바꾸려면 script와 함께 바꾼다.
  constant(msk.retention_hours, 'msk.retention_hours', 72);
  constant(msk.max_message_bytes, 'msk.max_message_bytes', 13 * 1024 * 1024);

  const retention = object(root.retention, 'retention', ['evidence_days', 'raw_signal_days', 'prometheus_days', 'prometheus_bytes', 'cloudwatch_log_days']);
  integer(retention.evidence_days, 'retention.evidence_days', 1, 3650);
  integer(retention.raw_signal_days, 'retention.raw_signal_days', 1, 365);
  // Prometheus chart가 7d/20GB로 고정돼 있다. 다른 값은 chart values와 함께 바꾼다(ADR-0037).
  constant(retention.prometheus_days, 'retention.prometheus_days', 7);
  constant(retention.prometheus_bytes, 'retention.prometheus_bytes', 20_000_000_000);
  if (!LOG_RETENTION_DAYS.includes(retention.cloudwatch_log_days as number)) fail('retention.cloudwatch_log_days', `CloudWatch 보존 일수 ${LOG_RETENTION_DAYS.join('|')} 중 하나다`);

  const observability = object(root.observability, 'observability', ['scrape_interval_seconds']);
  constant(observability.scrape_interval_seconds, 'observability.scrape_interval_seconds', 10);

  if (!/^ap-northeast-2[a-c]$/.test(zone)) fail('availability_zone', 'MSK 3 AZ(2a·2b·2c) 중 하나여야 한다');
  return root as unknown as PerfProfile;
}

/** 파일 바이트를 그대로 해시하고 중복 키 없는 JSON만 받는다. */
export function loadPerfProfile(file: string, repositoryRoot: string): LoadedPerfProfile {
  const absolute = resolve(repositoryRoot, file);
  const path = relative(repositoryRoot, absolute).split('\\').join('/');
  if (isAbsolute(path) || !/^profiles\/perf\/[a-z0-9-]+\.json$/.test(path)) {
    throw new Error(`perf 프로필은 저장소의 profiles/perf/<id>.json이어야 한다: ${file}`);
  }
  const bytes = readFileSync(absolute);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
    load(bytes.toString('utf8'), { schema: JSON_SCHEMA }); // JSON.parse가 허용하는 중복 키를 거부한다.
  } catch {
    throw new Error(`perf 프로필은 중복 키 없는 JSON이어야 한다: ${path}`);
  }
  const profile = parsePerfProfile(value);
  if (`profiles/perf/${profile.id}.json` !== path) throw new Error(`perf 프로필 id(${profile.id})가 파일 이름과 다르다: ${path}`);
  return { profile, path, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/** Kubernetes 수량 표기. 프로필의 byte·millicore 정수를 Helm values로 옮길 때 쓴다. */
export function cpuQuantity(millicores: number): string {
  return millicores % 1000 === 0 ? String(millicores / 1000) : `${millicores}m`;
}

export function memoryQuantity(bytes: number): string {
  if (bytes % 2 ** 30 === 0) return `${bytes / 2 ** 30}Gi`;
  if (bytes % 2 ** 20 === 0) return `${bytes / 2 ** 20}Mi`;
  throw new Error(`memory는 MiB 단위여야 한다: ${bytes}`);
}
