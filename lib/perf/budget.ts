import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { LoadedPerfProfile } from './profile';
import { parseJsonBytes } from './contract/schema-subset';

export const PERF_ECR_REPOSITORIES = ['soma-376/perf-k6-runner', 'soma-376/perf-tools'] as const;
export const PERF_BUDGET_PATH = 'profiles/perf/readiness-budget-v1.json';
export interface PerfBudget {
  schema_version: 1; kind: 'perf-budget-policy'; profile_sha256: string;
  currency: 'KRW'; budget_total: number; estimated_total: number; actual_billing_verified: false; estimate_note: string;
  ttl_seconds: number; cleanup_start_seconds: number; max_total_requests: number; max_rps: number; max_run_seconds: number;
  max_added_storage_bytes: number; drain_timeout_seconds: number; storage_verify_timeout_seconds: number;
  observation_max_age_seconds: number; disk_free_ratio: number; data_disk_free_bytes: number; generator_disk_free_bytes: number;
  new_ecr_repositories: readonly string[];
}
export interface LoadedPerfBudget { readonly policy: PerfBudget; readonly sha256: string; }

/** 승인 제한은 확장할 수 없다. 새로운 비용/용량 결정은 별도 policy 변경으로 검토한다. */
export function loadPerfBudget(root: string, profile: LoadedPerfProfile, natGateways: number): LoadedPerfBudget {
  const bytes = readFileSync(resolve(root, PERF_BUDGET_PATH));
  const policy = parseJsonBytes(bytes, PERF_BUDGET_PATH) as unknown as PerfBudget;
  const exact = {
    schema_version: 1, kind: 'perf-budget-policy', currency: 'KRW', budget_total: 100000, actual_billing_verified: false,
    ttl_seconds: 86400, cleanup_start_seconds: 79200, max_total_requests: 10000, max_rps: 20, max_run_seconds: 600,
    max_added_storage_bytes: 1073741824, drain_timeout_seconds: 900, storage_verify_timeout_seconds: 900,
    observation_max_age_seconds: 60, disk_free_ratio: 0.2, data_disk_free_bytes: 21474836480, generator_disk_free_bytes: 10737418240,
  };
  if (!policy || typeof policy !== 'object' || Object.entries(exact).some(([key, value]) => (policy as any)[key] !== value)) throw new Error('perf budget 승인 제한이 다르다');
  const keys = [...Object.keys(exact), 'profile_sha256', 'estimated_total', 'estimate_note', 'new_ecr_repositories'].sort();
  if (JSON.stringify(Object.keys(policy).sort()) !== JSON.stringify(keys)) throw new Error('perf budget 입력 key가 다르다');
  if (policy.profile_sha256 !== profile.sha256 || profile.profile.kafka_provider !== 'strimzi' || natGateways !== 1) throw new Error('perf budget은 pin한 Strimzi profile/NAT 1개에만 적용한다');
  if (!Number.isSafeInteger(policy.estimated_total) || policy.estimated_total <= 0 || policy.estimated_total > policy.budget_total || !policy.estimate_note) throw new Error('perf 예상액은 0 초과 승인 예산 이하여야 한다');
  if (JSON.stringify(policy.new_ecr_repositories) !== JSON.stringify(PERF_ECR_REPOSITORIES)) throw new Error('perf 신규 ECR 허용목록이 다르다');
  return { policy, sha256: createHash('sha256').update(bytes).digest('hex') };
}

export interface PerfExecutionObservation {
  readonly environment_id: string;
  readonly policy_sha256: string;
  readonly observed_at: string;
  /** 실제 조회한 CFN/ECR 생성 시각. 이 입력만으로 조회 출처를 인증하지 않으며 원본 SHA를 함께 보관한다. */
  readonly resource_created_at: readonly string[];
  readonly source_sha256: string;
  readonly requests_consumed: number;
  readonly requests_reserved: number;
  readonly planned_requests: number;
  readonly planned_rps: number;
  readonly planned_run_seconds: number;
  readonly added_storage_bytes: number;
  readonly planned_added_storage_bytes: number;
  readonly disks: readonly { role: 'clickhouse' | 'kafka' | 'generator'; identity: string; total_bytes: number; free_bytes: number }[];
}

/** 네트워크 호출 없는 실행 전 gate. 실제 원본 수집/해시와 요청 선점은 호출자가 수행한다. */
export function checkPerfExecution(budget: LoadedPerfBudget, environmentId: string, observation: PerfExecutionObservation, now = Date.now()): void {
  const p = budget.policy;
  const finite = (v: number) => Number.isSafeInteger(v) && v >= 0;
  if (observation.environment_id !== environmentId || observation.policy_sha256 !== budget.sha256 || !/^[a-f0-9]{64}$/.test(observation.source_sha256)) throw new Error('perf 실행 출처/환경/policy가 다르다');
  const observed = Date.parse(observation.observed_at);
  if (!Number.isFinite(observed) || observed > now || now - observed > p.observation_max_age_seconds * 1000) throw new Error('perf 실행 관측이 오래되었거나 미래다');
  if (!observation.resource_created_at.length) throw new Error('실제 자원 생성 시각이 없다');
  const created = observation.resource_created_at.map(value => Date.parse(value));
  if (created.some(value => !Number.isFinite(value) || value > now)) throw new Error('자원 생성 시각이 잘못되었다');
  const counts = [observation.requests_consumed, observation.requests_reserved, observation.planned_requests, observation.planned_rps, observation.planned_run_seconds, observation.added_storage_bytes, observation.planned_added_storage_bytes];
  if (!counts.every(finite) || observation.planned_requests <= 0 || observation.planned_rps <= 0 || observation.planned_run_seconds <= 0) throw new Error('실행 수치가 양의 정수/0 이상의 누적값이어야 한다');
  if (observation.requests_consumed + observation.requests_reserved + observation.planned_requests > p.max_total_requests || observation.planned_rps > p.max_rps || observation.planned_run_seconds > p.max_run_seconds) throw new Error('요청/RPS/실행 시간 상한 초과');
  if (observation.added_storage_bytes + observation.planned_added_storage_bytes > p.max_added_storage_bytes) throw new Error('시험 추가 저장 상한 초과');
  const remaining = observation.planned_run_seconds + p.drain_timeout_seconds + p.storage_verify_timeout_seconds;
  if (now + remaining * 1000 >= Math.min(...created) + p.cleanup_start_seconds * 1000) throw new Error('정리 시작 전 실행/drain/최종검증 여유가 없다');
  const identities = new Set<string>();
  for (const disk of observation.disks) {
    if (!['clickhouse', 'kafka', 'generator'].includes(disk.role) || !disk.identity || identities.has(disk.identity)) throw new Error('디스크 역할/identity 중복 또는 누락');
    identities.add(disk.identity);
    const floor = Math.max(disk.role === 'generator' ? p.generator_disk_free_bytes : p.data_disk_free_bytes, disk.total_bytes * p.disk_free_ratio);
    if (!finite(disk.total_bytes) || !finite(disk.free_bytes) || disk.total_bytes <= 0 || disk.free_bytes > disk.total_bytes || disk.free_bytes < floor) throw new Error('디스크 가용 공간이 승인 하한보다 작다');
  }
  for (const [role, count] of [['clickhouse', 1], ['kafka', 3], ['generator', 1]] as const) {
    if (observation.disks.filter(disk => disk.role === role).length !== count) throw new Error('모든 ClickHouse/Kafka/발생기 디스크 관측이 필요하다');
  }
}
