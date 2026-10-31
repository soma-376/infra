import { createHash } from 'node:crypto';
import { ContractError, JsonValue, Schemas, environmentSchemas, jsonEqual, parseJsonBytes } from './schema-subset';

/**
 * request·provisional·resolved·lock 파일 바이트 사이의 연결 검사. load-tests `tools/contract.py`의
 * `check_bundle`과 같은 오류 코드를 낸다. 실행 중 실제 상태 대조는 load-tests preflight가 따로 한다.
 */

export type BundleFile = 'request' | 'provisional' | 'resolved' | 'lock';
export type BundleBytes = Partial<Record<BundleFile, Uint8Array>>;

const FILES: readonly BundleFile[] = ['request', 'provisional', 'resolved', 'lock'];
const SCHEMA_OF: Record<BundleFile, string> = {
  request: 'environment-request',
  provisional: 'environment-provisional',
  resolved: 'environment-resolved',
  lock: 'environment-lock',
};

/** 비밀 원문 모양. 키와 값을 모두 검사하며 일치한 원문은 출력하지 않는다. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /eyJ[A-Za-z0-9_-]{10,}\./u,
  /ptt_[A-Za-z0-9_-]{20,}/u,
  /pit_[A-Za-z0-9_-]{20,}/u,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /AKIA[0-9A-Z]{16}/u,
];

type JsonObject = { [key: string]: JsonValue };

function asObject(value: JsonValue | undefined): JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
}

export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hasSecretLiteral(value: JsonValue): boolean {
  if (typeof value === 'string') return SECRET_PATTERNS.some(pattern => pattern.test(value));
  if (Array.isArray(value)) return value.some(hasSecretLiteral);
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).some(([key, item]) => hasSecretLiteral(key) || hasSecretLiteral(item));
  }
  return false;
}

export function checkBundle(schemas: Schemas, files: BundleBytes): string[] {
  const codes = new Set<string>();
  const documents: Partial<Record<BundleFile, JsonObject>> = {};
  for (const name of FILES) {
    const data = files[name];
    if (data === undefined) continue;
    let document: JsonValue;
    try {
      document = parseJsonBytes(data, name);
    } catch (error) {
      if (!(error instanceof ContractError)) throw error;
      codes.add(`json_invalid:${name}`);
      continue;
    }
    let selected = schemas;
    try { selected = environmentSchemas(asObject(document).schema_version); } catch (error) {
      if (!(error instanceof ContractError)) throw error;
      codes.add(`schema_version_unsupported:${name}`);
    }
    if (selected.validate(SCHEMA_OF[name], document).length > 0) codes.add(`schema_invalid:${name}`);
    if (hasSecretLiteral(document)) codes.add(`secret_literal:${name}`);
    documents[name] = asObject(document);
  }
  const versions = new Set(Object.values(documents).map(d => d!.schema_version).filter(v => typeof v === 'number' || typeof v === 'string'));
  if (versions.size > 1) codes.add('environment_schema_version_mismatch');
  const { request, resolved, provisional, lock } = documents;
  if (request === undefined || resolved === undefined) {
    codes.add('bundle_incomplete');
    return [...codes].sort();
  }
  if (request.status !== 'ready') codes.add('request_not_ready');
  const requestSha = sha256Hex(files.request!);
  // Python 검사기의 None처럼 없는 값과 null을 같게 본다.
  const environmentId = asObject(request.environment).environment_id ?? null;
  for (const name of ['provisional', 'resolved'] as const) {
    const document = documents[name];
    if (document === undefined) continue;
    if (document.request_sha256 !== requestSha) codes.add(`request_sha256_mismatch:${name}`);
    if ((document.environment_id ?? null) !== environmentId) codes.add(`environment_id_mismatch:${name}`);
    const infra = document.infra;
    const requested = request.infra;
    if (isPlainObject(infra) && isPlainObject(requested)) {
      for (const field of ['commit', 'profile', 'profile_sha256']) {
        if ((infra[field] ?? null) !== (requested[field] ?? null)) codes.add(`infra_mismatch:${name}:${field}`);
      }
    }
  }
  if (resolved.status === 'ready') {
    if (provisional === undefined) {
      codes.add('provisional_missing');
    } else {
      if (provisional.status !== 'deployed_not_ready') codes.add('provisional_not_ready');
      if (resolved.provisional_sha256 !== sha256Hex(files.provisional!)) codes.add('provisional_sha256_mismatch');
      if ((provisional.deployment_id ?? null) !== (resolved.deployment_id ?? null)) codes.add('deployment_id_mismatch:provisional');
    }
    for (const code of compareCapacity(request, resolved)) codes.add(code);
    if (request.schema_version === 3 && resolved.schema_version === 3 && ![...codes].some(code => code.startsWith('schema_invalid:'))) for (const code of compareKafka(request, resolved)) codes.add(code);
  }
  if (lock !== undefined) {
    if ((lock.environment_id ?? null) !== environmentId) codes.add('environment_id_mismatch:lock');
    if ((lock.deployment_id ?? null) !== (resolved.deployment_id ?? null)) codes.add('deployment_id_mismatch:lock');
  }
  return [...codes].sort();
}

function isPlainObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 요청한 고정 용량·이미지와 확정 결과를 대조한다. */
function compareCapacity(request: JsonObject, resolved: JsonObject): Set<string> {
  const codes = new Set<string>();
  const images = asObject(request.images);
  const capacity = asObject(request.capacity);
  const kubernetes = asObject(resolved.kubernetes);
  const pools = asObject(kubernetes.node_pools);
  for (const [poolId, expectedValue] of Object.entries(asObject(capacity.node_pools))) {
    const expected = asObject(expectedValue);
    if (!Object.hasOwn(pools, poolId)) { codes.add(`node_pool_missing:${poolId}`); continue; }
    const actual = asObject(pools[poolId]);
    for (const field of ['role', 'instance_type', 'nodes', 'availability_zone', 'capacity_type', 'architecture']) {
      if (!jsonEqual(actual[field] ?? null, expected[field] ?? null)) codes.add(`node_pool_mismatch:${poolId}:${field}`);
    }
  }
  const workloads = asObject(kubernetes.workloads);
  for (const [workloadId, expectedValue] of Object.entries(asObject(capacity.workloads))) {
    const expected = asObject(expectedValue);
    if (!Object.hasOwn(workloads, workloadId)) { codes.add(`workload_missing:${workloadId}`); continue; }
    const actual = asObject(workloads[workloadId]);
    if ((actual.node_pool ?? null) !== (expected.node_pool ?? null)) codes.add(`workload_mismatch:${workloadId}:node_pool`);
    if (!jsonEqual(actual.replicas ?? null, expected.replicas ?? null)) codes.add(`workload_mismatch:${workloadId}:replicas`);
    const resources = asObject(actual.resources);
    for (const field of ['cpu_request_millicores', 'memory_request_bytes', 'cpu_limit_millicores', 'memory_limit_bytes']) {
      if (!jsonEqual(resources[field] ?? null, expected[field] ?? null)) codes.add(`workload_mismatch:${workloadId}:${field}`);
    }
    if (Object.hasOwn(images, workloadId) && (actual.image ?? null) !== images[workloadId]) codes.add(`image_mismatch:${workloadId}`);
  }
  const clickhouse = asObject(asObject(resolved.datastores).clickhouse).image ?? null;
  if (Object.hasOwn(images, 'clickhouse') && clickhouse !== images.clickhouse) codes.add('image_mismatch:datastores.clickhouse');
  return codes;
}

/** canonical tools/contract.py compare_kafka와 같은 의미/오류 코드를 유지한다. */
function compareKafka(request: JsonObject, resolved: JsonObject): Set<string> {
  const codes = new Set<string>();
  const kafka = asObject(resolved.kafka);
  if (asObject(request.kafka).provider !== kafka.provider) codes.add('kafka_provider_mismatch');
  const counts = [kafka.min_insync_replicas, kafka.replication_factor, kafka.broker_count];
  if (counts.every(v => typeof v === 'number' && Number.isInteger(v)) && !(1 <= Number(counts[0]) && Number(counts[0]) <= Number(counts[1]) && Number(counts[1]) <= Number(counts[2]))) codes.add('kafka_replication_invalid');
  if (kafka.provider !== 'strimzi') return codes;
  const bootstrap = `${String(kafka.cluster_name)}-kafka-bootstrap.${String(kafka.namespace)}.svc`;
  if (![`${bootstrap}:9093`, `${bootstrap}.cluster.local:9093`].includes(String(kafka.bootstrap_servers))) codes.add('kafka_bootstrap_identity_mismatch');
  const pools = Array.isArray(kafka.kafka_node_pools) ? kafka.kafka_node_pools.map(asObject) : [];
  if (new Set(pools.map(p => p.name)).size !== pools.length) codes.add('kafka_node_pool_duplicate');
  const brokers = pools.filter(p => Array.isArray(p.roles) && p.roles.includes('broker') && typeof p.replicas === 'number' && Number.isInteger(p.replicas)).reduce((n, p) => n + Number(p.replicas), 0);
  if (brokers !== kafka.broker_count) codes.add('kafka_broker_count_mismatch');
  const pvcs: JsonValue[] = [];
  for (const pool of pools) {
    const claims = Array.isArray(pool.persistent_volume_claims) ? pool.persistent_volume_claims : [];
    pvcs.push(...claims);
    if (claims.length !== pool.replicas) codes.add('kafka_pvc_count_mismatch');
  }
  if (new Set(pvcs).size !== pvcs.length) codes.add('kafka_pvc_duplicate');
  const tls = asObject(kafka.tls);
  const clients = Array.isArray(tls.clients) ? tls.clients.map(asObject) : [];
  if (!jsonEqual(clients.map(c => String(c.role)).sort(), ['gateway','ingest','topic-admin','offset-admin'].sort())) codes.add('kafka_tls_client_roles_invalid');
  const pairs = [[asObject(tls.ca_secret_ref), asObject(tls.ca_password_secret_ref)], ...clients.map(c => [asObject(c.keystore_secret_ref), asObject(c.password_secret_ref)])];
  if (pairs.some(([a, b]) => a.name !== b.name)) codes.add('kafka_tls_secret_pair_mismatch');
  if (!Object.values(asObject(asObject(request.capacity).node_pools)).some(p => asObject(p).role === 'kafka')) codes.add('kafka_capacity_missing');
  return codes;
}
