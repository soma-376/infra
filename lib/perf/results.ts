import { checkBundle, hasSecretLiteral } from './contract/bundle';
import { JsonValue, Schemas, environmentSchemas } from './contract/schema-subset';
import { PERF_GATEWAY_HTTPS } from './edge-config';
import { CONTROL_DB_NAME } from '../common/config';
import { PerfStrimziMetadata, strimziState } from './strimzi';
import {
  PERF_ARCHIVE_PREFIX, PERF_DB_APPLICATION_NAMES, PERF_ENVIRONMENT_TAG, PERF_EVIDENCE_PREFIX, PERF_EVIDENCE_TAG, PERF_MSK,
  PERF_NAMESPACES, PERF_SERVICE_ACCOUNTS, perfNodePoolName, perfSecretName,
} from './config';
import { JsonObject, PerfOutputs, fail, isObject, requiredOutput, sha256 } from './deploy-inputs';
import { LoadedPerfProfile, PERF_POOL_IDS, perfPoolIds, PERF_WORKLOAD_IDS, PerfPoolId, PerfWorkloadId } from './profile';
import { PERF_ENDPOINTS, checkDeployment } from './values';

/**
 * v2 결과 파일 생산자. provisional은 배포 직후, resolved는 readiness smoke 뒤 한 번 만든다.
 * 둘 다 쓰기 전에 공유 schema와 연결 검사(checkBundle)를 통과해야 한다. 이미 있는 파일은 덮어쓰지 않는다(호출자).
 */

export const PERF_LOCK = { namespace: PERF_NAMESPACES.runner, configmap_name: 'perf-run-lock' } as const;
const COMPLETE = new Set(['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'IMPORT_COMPLETE']);
const UTC = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$/;
const SLUG = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function contractEndpoints(outputs?: PerfOutputs): JsonObject {
  if (outputs?.values.GatewayHttpsUrl && outputs.values.GatewayHttpsUrl !== PERF_GATEWAY_HTTPS) fail('GatewayHttpsUrl이 고정 perf HTTPS origin과 다르다');
  return {
    ...(outputs?.values.GatewayHttpsUrl ? { gateway_https: PERF_GATEWAY_HTTPS } : {}),
    gateway: PERF_ENDPOINTS.gateway, enrollment: PERF_ENDPOINTS.enrollment,
    clickhouse_http: PERF_ENDPOINTS.clickhouse, prometheus_remote_write: PERF_ENDPOINTS.remoteWrite,
  };
}

/**
 * 정리 대상과 보존 자원. 스택은 CloudFormation이, 노드·PVC 볼륨은 소유 태그로 찾는다. 현행 Strimzi의 evidence/guard/new ECR도 제거하고 과거 MSK evidence만 보존한다.
 * `scripts/perf-inventory.ts`가 같은 목록으로 삭제 뒤 잔존을 확인한다.
 */
export function cleanupInventory(outputs: PerfOutputs, environmentId: string, extra: JsonObject[] = []): JsonObject[] {
  const owner = `${PERF_ENVIRONMENT_TAG}=${environmentId}`;
  const owned = outputs.values.PerfEvidenceCleanupMode === 'owned-24h';
  const stacks = outputs.stacks.filter(stack => (owned || stack.name !== 'PerfEvidenceStack') && stack.arn !== null).map(stack => ({
    resource_type: 'AWS::CloudFormation::Stack', identifier: stack.arn!, owner_tag: owner, retain: false, reason: null,
  }));
  // CloudFormation 밖에서 Auto Mode·EBS CSI가 만든 자원. 태그가 같으면 이 환경의 것이다.
  const controllers = ['AWS::EC2::Instance', 'AWS::EC2::Volume'].map(type => ({
    resource_type: type, identifier: `tag:${owner}`, owner_tag: owner, retain: false, reason: null,
  }));
  const evidence = {
    resource_type: 'AWS::S3::Bucket', identifier: requiredOutput(outputs, 'EvidenceBucketArn'), owner_tag: `${PERF_EVIDENCE_TAG}=shared`,
    retain: true, reason: 'evidence 보존 기간(프로필 retention.evidence_days) 동안 남긴다. 환경 삭제와 수명을 분리한다',
  };
  const createdEcr = owned ? ['soma-376/perf-k6-runner', 'soma-376/perf-tools'].map(identifier => ({ resource_type: 'AWS::ECR::Repository', identifier, owner_tag: owner, retain: false, reason: null })) : [];
  return [...stacks, ...controllers, ...extra, ...createdEcr, owned ? { ...evidence, owner_tag: owner, retain: false, reason: null } : evidence];
}

function stackSummary(outputs: PerfOutputs, httpsGateway = false, guarded = false): { stacks: JsonObject[]; errors: JsonObject[]; complete: number } {
  const errors: JsonObject[] = [];
  let complete = 0;
  for (const name of ['PerfEvidenceStack', 'PerfNetworkStack', 'PerfDataStack', 'PerfEksStack', ...(httpsGateway ? ['PerfEdgeStack'] : []), ...(guarded ? ['PerfGuardrailStack'] : [])]) {
    const stack = outputs.stacks.find(item => item.name === name);
    if (!stack || stack.arn === null || stack.status === null) {
      errors.push({ code: 'stack_missing', message: `${name}의 describe-stacks 결과(StackId·StackStatus)가 없다` });
    } else if (!COMPLETE.has(stack.status)) {
      errors.push({ code: 'stack_not_complete', message: `${name} 상태가 ${stack.status}다` });
    } else complete++;
  }
  return {
    stacks: outputs.stacks.filter(stack => stack.arn !== null).map(stack => ({ name: stack.name, arn: stack.arn! })),
    errors, complete,
  };
}

function requestField(request: JsonObject, path: string[]): JsonValue | undefined {
  let value: JsonValue | undefined = request;
  for (const key of path) value = isObject(value) ? value[key] : undefined;
  return value;
}

export interface ProvisionalInput {
  readonly request: JsonObject;
  readonly requestSha256: string;
  readonly profile: LoadedPerfProfile;
  readonly outputs: PerfOutputs;
  readonly deploymentId: string;
  readonly createdAt: string;
}

/** `deployment.provisional.json`. 스택이 모두 완료면 deployed_not_ready, 일부면 partial, 아니면 failed다. */
export function buildProvisional(input: ProvisionalInput): JsonObject {
  const { request, outputs } = input;
  if (!SLUG.test(input.deploymentId)) fail('deployment-id: slug가 필요하다');
  if (!UTC.test(input.createdAt)) fail('created-at: UTC ISO 8601(Z)이 필요하다');
  const environmentId = String(requestField(request, ['environment', 'environment_id']));
  const summary = stackSummary(outputs, Boolean(requestField(request, ['infra', 'parameters', 'certificateArn'])), Boolean(requestField(request, ['infra', 'parameters', 'budgetPolicySha256'])));
  const base: JsonObject = {
    schema_version: request.schema_version!, kind: 'environment-provisional',
    request_sha256: input.requestSha256, deployment_id: input.deploymentId, environment_id: environmentId,
    created_at: input.createdAt, infra: requestField(request, ['infra'])!,
  };
  if (summary.errors.length) {
    return {
      ...base, status: summary.complete > 0 ? 'partial' : 'failed',
      cleanup_inventory: summary.stacks.length ? cleanupInventoryLoose(outputs, environmentId) : [],
      errors: summary.errors,
    };
  }
  const deployment = checkDeployment(outputs, input.profile, request);
  return {
    ...base, status: 'deployed_not_ready',
    aws: { region: 'ap-northeast-2', account_ref: requestField(request, ['environment', 'account_ref'])!, stacks: summary.stacks },
    kubernetes: {
      cluster_arn: requiredOutput(outputs, 'EksClusterArn'), cluster_name: deployment.clusterName,
      namespaces: { app: PERF_NAMESPACES.app, observability: PERF_NAMESPACES.observability, runner: PERF_NAMESPACES.runner },
    },
    endpoints: contractEndpoints(outputs),
    lock: { ...PERF_LOCK },
    cleanup_inventory: cleanupInventory(outputs, environmentId),
    errors: [],
  };
}

/** 부분 배포에서는 evidence output이 없을 수 있다. 있는 스택만 정리 대상으로 남긴다. */
function cleanupInventoryLoose(outputs: PerfOutputs, environmentId: string): JsonObject[] {
  return outputs.values.EvidenceBucketArn ? cleanupInventory(outputs, environmentId)
    : cleanupInventory({ ...outputs, values: { ...outputs.values, EvidenceBucketArn: 'unknown' } }, environmentId).filter(item => item.retain === false);
}

/** provisional 단독 검사. resolved가 없으므로 checkBundle 대신 같은 연결 규칙을 직접 적용한다. */
export function checkProvisional(schemas: Schemas, request: JsonObject, requestSha256: string, provisional: JsonObject): string[] {
  const codes = new Set<string>();
  if (environmentSchemas(provisional.schema_version).validate('environment-provisional', provisional).length) codes.add('schema_invalid:provisional');
  if (hasSecretLiteral(provisional)) codes.add('secret_literal:provisional');
  if (provisional.schema_version !== request.schema_version) codes.add('environment_schema_version_mismatch');
  if (provisional.request_sha256 !== requestSha256) codes.add('request_sha256_mismatch:provisional');
  if (provisional.environment_id !== requestField(request, ['environment', 'environment_id'])) codes.add('environment_id_mismatch:provisional');
  for (const field of ['commit', 'profile', 'profile_sha256']) {
    if (requestField(provisional, ['infra', field]) !== requestField(request, ['infra', field])) codes.add(`infra_mismatch:provisional:${field}`);
  }
  return [...codes].sort();
}

// ── resolved ──────────────────────────────────────────────────────────────────────────────────────

/** Kubernetes 수량 → 정수. 계약은 millicore·byte 정수다. */
export function cpuMillicores(quantity: unknown): number | null {
  if (quantity === undefined || quantity === null) return null;
  const match = /^([0-9]+)(m?)$/.exec(String(quantity));
  if (!match) fail(`CPU 수량 형식이 아니다: ${String(quantity)}`);
  return match[2] ? Number(match[1]) : Number(match[1]) * 1000;
}

export function memoryBytes(quantity: unknown): number {
  const match = /^([0-9]+)(Ki|Mi|Gi|Ti)?$/.exec(String(quantity));
  if (!match) fail(`memory 수량 형식이 아니다: ${String(quantity)}`);
  return Number(match[1]) * 1024 ** ({ '': 0, Ki: 1, Mi: 2, Gi: 3, Ti: 4 } as Record<string, number>)[match[2] ?? ''];
}

export interface KubeItem { kind: string; metadata: JsonObject; spec: JsonObject; status: JsonObject; raw: JsonObject }

/** `kubectl get … -o json`의 List(여러 개면 합친다). */
export function kubeItems(documents: readonly JsonValue[]): KubeItem[] {
  const items: KubeItem[] = [];
  for (const document of documents) {
    if (!isObject(document) || !Array.isArray(document.items)) fail('kubernetes: kubectl get -o json의 List가 필요하다');
    for (const item of document.items) {
      if (!isObject(item) || typeof item.kind !== 'string' || !isObject(item.metadata)) fail('kubernetes: kind·metadata가 없는 항목이 있다');
      if (item.kind === 'Secret') fail('kubernetes: Secret 원문 대신 별도 metadata 입력을 사용한다');
      items.push({ kind: item.kind, metadata: item.metadata, spec: isObject(item.spec) ? item.spec : {}, status: isObject(item.status) ? item.status : {}, raw: item });
    }
  }
  return items;
}

function find(items: KubeItem[], kind: string, name: string, namespace?: string): KubeItem | undefined {
  return items.find(item => item.kind === kind && item.metadata.name === name && (namespace === undefined || item.metadata.namespace === namespace));
}

const WORKLOAD_KIND: Record<PerfWorkloadId, 'Deployment' | 'StatefulSet'> = {
  'telemetry-gateway': 'Deployment', 'telemetry-ingest': 'Deployment', 'enrollment-api': 'Deployment', clickhouse: 'StatefulSet',
};

/** 배포된 Pod spec의 환경 변수에서 비교에 영향을 주는 비밀 아닌 설정을 읽는다. */
function workloadSettings(id: PerfWorkloadId, container: JsonObject): JsonObject {
  const env = Object.fromEntries((Array.isArray(container.env) ? container.env : [])
    .filter(isObject).map(item => [String(item.name), typeof item.value === 'string' ? item.value : null]));
  const settings: JsonObject = {};
  if (id === 'clickhouse') return settings;
  const spring = env.SPRING_APPLICATION_JSON ? JSON.parse(env.SPRING_APPLICATION_JSON) : {};
  const telemetry = spring?.pulsemetry?.['telemetry-jwt'];
  if (id === 'enrollment-api') {
    if (typeof telemetry?.['active-kid'] !== 'string') fail('enrollment-api에 telemetry JWT active-kid 설정이 없다');
    settings['telemetryJwt.activeKid'] = telemetry['active-kid'];
    settings['telemetryJwt.issueEnabled'] = telemetry['issue-enabled'] === true;
  }
  if (id === 'telemetry-ingest' && env.PULSEMETRY_INGEST_MODE) settings.ingestMode = env.PULSEMETRY_INGEST_MODE;
  if (env.PULSEMETRY_KAFKA_TOPIC) settings['kafka.topic'] = env.PULSEMETRY_KAFKA_TOPIC;
  if (env.PULSEMETRY_KAFKA_CONSUMER_GROUP) settings['kafka.consumerGroup'] = env.PULSEMETRY_KAFKA_CONSUMER_GROUP;
  if (id !== 'enrollment-api') settings['jvm.gcSafepointLog'] = env.JDK_JAVA_OPTIONS !== undefined && env.JDK_JAVA_OPTIONS !== null;
  return settings;
}

function poolOf(nodeSelector: unknown): PerfPoolId | null {
  const name = isObject(nodeSelector) ? nodeSelector['karpenter.sh/nodepool'] : undefined;
  const pool = typeof name === 'string' ? name.replace(/^perf-/, '') : '';
  return ([...PERF_POOL_IDS, 'kafka'] as readonly string[]).includes(pool) && name === perfNodePoolName(pool as PerfPoolId) ? pool as PerfPoolId : null;
}

function kubernetesState(items: KubeItem[], profile: LoadedPerfProfile, errors: JsonObject[]) {
  const workloads: JsonObject = {};
  for (const id of PERF_WORKLOAD_IDS) {
    const kind = WORKLOAD_KIND[id];
    const item = find(items, kind, id === 'clickhouse' ? 'clickhouse' : id, PERF_NAMESPACES.app);
    if (!item) { errors.push({ code: 'workload_missing', message: `${kind}/${id}가 kubernetes 상태에 없다` }); continue; }
    const pod = isObject(item.spec.template) && isObject(item.spec.template.spec) ? item.spec.template.spec : {};
    const containers = Array.isArray(pod.containers) ? pod.containers.filter(isObject) : [];
    const container = containers.find(c => c.name === id) ?? containers[0];
    if (!container) { errors.push({ code: 'workload_invalid', message: `${id}에 container가 없다` }); continue; }
    const resources = isObject(container.resources) ? container.resources : {};
    const requests = isObject(resources.requests) ? resources.requests : {};
    const limits = isObject(resources.limits) ? resources.limits : {};
    const replicas = typeof item.spec.replicas === 'number' ? item.spec.replicas : 1;
    if (item.status.observedGeneration !== item.metadata.generation || (item.status.readyReplicas ?? 0) !== replicas) {
      errors.push({ code: 'workload_not_ready', message: `${id}: observedGeneration·readyReplicas가 spec과 다르다` });
    }
    const pool = poolOf(pod.nodeSelector);
    if (pool === null) errors.push({ code: 'workload_placement', message: `${id}: perf NodePool nodeSelector가 없다` });
    workloads[id] = {
      kind, namespace: PERF_NAMESPACES.app, name: String(item.metadata.name), uid: String(item.metadata.uid),
      generation: item.metadata.generation as number, replicas, image: String(container.image), node_pool: pool ?? 'unknown',
      resources: {
        cpu_request_millicores: cpuMillicores(requests.cpu)!, memory_request_bytes: memoryBytes(requests.memory),
        cpu_limit_millicores: cpuMillicores(limits.cpu), memory_limit_bytes: memoryBytes(limits.memory),
      },
      settings: workloadSettings(id, container),
    };
  }
  const nodePools: JsonObject = {};
  const nodes = items.filter(item => item.kind === 'Node');
  for (const id of perfPoolIds(profile.profile)) {
    const name = perfNodePoolName(id);
    const pool = find(items, 'NodePool', name);
    if (!pool) { errors.push({ code: 'node_pool_missing', message: `NodePool/${name}가 없다` }); continue; }
    const template = isObject(pool.spec.template) && isObject(pool.spec.template.spec) ? pool.spec.template.spec : {};
    const members = nodes.filter(node => isObject(node.metadata.labels) && node.metadata.labels['karpenter.sh/nodepool'] === name
      && Array.isArray(node.status.conditions) && node.status.conditions.some(c => isObject(c) && c.type === 'Ready' && c.status === 'True'));
    const label = (key: string) => [...new Set(members.map(node => (node.metadata.labels as JsonObject)[key]))];
    const one = (key: string) => {
      const values = label(key);
      if (values.length !== 1) errors.push({ code: 'node_pool_inconsistent', message: `${name}: 노드 ${key} 값이 하나가 아니다` });
      return values.length === 1 ? String(values[0]) : 'unknown';
    };
    const taints = Array.isArray(template.taints) ? template.taints.filter(isObject) : [];
    const budgets = isObject(pool.spec.disruption) && Array.isArray(pool.spec.disruption.budgets) ? pool.spec.disruption.budgets.filter(isObject) : [];
    const nodeClass = isObject(template.nodeClassRef) ? String(template.nodeClassRef.name) : 'unknown';
    nodePools[id] = {
      role: id, node_pool_name: name, node_class_name: nodeClass,
      instance_type: one('node.kubernetes.io/instance-type'), nodes: members.length,
      availability_zone: one('topology.kubernetes.io/zone'), capacity_type: one('karpenter.sh/capacity-type'), architecture: one('kubernetes.io/arch'),
      disruption_budget_nodes: budgets.length === 1 ? String(budgets[0].nodes) : 'unknown',
      taint: taints.length ? taints.map(t => `${t.key}=${t.value ?? ''}:${t.effect}`).join(',') : null,
    };
    if (members.length !== profile.profile.node_pools[id].nodes) {
      errors.push({ code: 'node_pool_size', message: `${name}: Ready 노드 ${members.length}대가 프로필 ${profile.profile.node_pools[id].nodes}대와 다르다` });
    }
  }
  return { workloads, nodePools };
}

function clickhousePvc(items: KubeItem[], errors: JsonObject[]): JsonObject | null {
  const claim = find(items, 'PersistentVolumeClaim', 'data-clickhouse-0', PERF_NAMESPACES.app);
  const volume = claim && typeof claim.spec.volumeName === 'string' ? find(items, 'PersistentVolume', claim.spec.volumeName) : undefined;
  const className = claim ? String(claim.spec.storageClassName) : '';
  const storageClass = find(items, 'StorageClass', className);
  const csi = volume && isObject(volume.spec.csi) ? volume.spec.csi : {};
  const parameters = storageClass && isObject(storageClass.raw.parameters) ? storageClass.raw.parameters : null;
  const capacity = claim && isObject(claim.status.capacity) ? claim.status.capacity.storage : undefined;
  if (!claim || !volume || !parameters || capacity === undefined || typeof csi.volumeHandle !== 'string') {
    errors.push({ code: 'clickhouse_pvc_missing', message: 'ClickHouse PVC·PV·StorageClass 상태가 부족하다' });
    return null;
  }
  return {
    name: 'data-clickhouse-0', storage_class: className, size_bytes: memoryBytes(capacity), volume_id: csi.volumeHandle,
    iops: Number(parameters.iops), throughput_mibps: Number(parameters.throughput),
  };
}

export interface ReadinessInput {
  readonly checked_at: string;
  readonly stages: JsonObject;
  readonly smoke_artifact_ids: string[];
  readonly artifacts: JsonObject[];
  readonly clickhouse_version: string;
}

export function parseReadiness(value: JsonValue): ReadinessInput {
  const keys = ['checked_at', 'stages', 'smoke_artifact_ids', 'artifacts', 'clickhouse_version'];
  if (!isObject(value) || Object.keys(value).sort().join() !== [...keys].sort().join()) fail(`readiness: ${keys.join('·')}만 받는다`);
  if (typeof value.checked_at !== 'string' || !UTC.test(value.checked_at)) fail('readiness.checked_at: UTC가 필요하다');
  if (!isObject(value.stages) || !Array.isArray(value.smoke_artifact_ids) || !Array.isArray(value.artifacts)) fail('readiness: stages·smoke_artifact_ids·artifacts 형식이 아니다');
  if (typeof value.clickhouse_version !== 'string' || !/^[0-9]+\.[0-9]+(\.[0-9]+)*$/.test(value.clickhouse_version)) fail('readiness.clickhouse_version: SELECT version() 결과가 필요하다');
  const ids = new Set(value.artifacts.map(item => (isObject(item) ? item.id : undefined)));
  if (!value.smoke_artifact_ids.every(id => ids.has(id))) fail('readiness: smoke_artifact_ids가 artifacts에 없다');
  return value as unknown as ReadinessInput;
}

export interface ResolvedInput {
  readonly request: JsonObject;
  readonly requestSha256: string;
  readonly provisional: JsonObject;
  readonly provisionalSha256: string;
  readonly profile: LoadedPerfProfile;
  readonly outputs: PerfOutputs;
  readonly kubernetes: KubeItem[];
  readonly mskNodes?: JsonValue;
  readonly strimziMetadata?: PerfStrimziMetadata;
  readonly readiness: ReadinessInput;
  readonly createdAt: string;
}

/** `environment.resolved.json`. 실제 상태가 모자라거나 smoke 단계가 pass가 아니면 failed로 남긴다. */
export function buildResolved(input: ResolvedInput): JsonObject {
  const { request, outputs, profile, readiness } = input;
  if (!UTC.test(input.createdAt)) fail('created-at: UTC ISO 8601(Z)이 필요하다');
  if (input.provisional.status !== 'deployed_not_ready') fail('provisional이 deployed_not_ready가 아니다. resolved ready를 만들 수 없다');
  if (input.provisional.schema_version !== request.schema_version) fail('request·provisional의 환경 계약 버전이 다르다');
  const deployment = checkDeployment(outputs, profile, request);
  const errors: JsonObject[] = [];
  const { workloads, nodePools } = kubernetesState(input.kubernetes, profile, errors);
  const pvc = clickhousePvc(input.kubernetes, errors);
  const strimzi = profile.profile.kafka_provider === 'strimzi';
  if (strimzi ? input.mskNodes !== undefined || !input.strimziMetadata : input.strimziMetadata !== undefined || input.mskNodes === undefined) {
    fail('Kafka provider에 맞는 MSK nodes 또는 Strimzi Secret metadata만 필요하다');
  }
  const brokers = isObject(input.mskNodes) && Array.isArray(input.mskNodes.NodeInfoList)
    ? input.mskNodes.NodeInfoList.filter(node => isObject(node) && node.NodeType === 'BROKER') as JsonObject[] : [];
  const brokerTypes = [...new Set(brokers.map(broker => broker.InstanceType))];
  if (!strimzi && (brokerTypes.length !== 1 || brokerTypes[0] !== profile.profile.msk!.instance_type)) {
    errors.push({ code: 'msk_instance_type', message: `MSK broker 인스턴스 유형이 프로필(${profile.profile.msk!.instance_type})과 다르다` });
  }
  if (!strimzi && brokers.length !== profile.profile.msk!.broker_count) errors.push({ code: 'msk_brokers', message: `MSK broker ${brokers.length}대가 프로필과 다르다` });
  const actualStrimzi = strimzi ? strimziState(input.kubernetes, profile, input.strimziMetadata!, deployment.environmentId, errors) : undefined;
  const failedStages = Object.entries(readiness.stages).filter(([, value]) => value !== 'pass').map(([key]) => key);
  if (failedStages.length) errors.push({ code: 'readiness_not_pass', message: `readiness 단계가 pass가 아니다: ${failedStages.sort().join(', ')}` });
  const parameters = JSON.parse(requiredOutput(outputs, 'PerfInfraParameters'));
  const environmentId = deployment.environmentId;
  const msk = profile.profile.msk!;
  const head: JsonObject = {
    schema_version: request.schema_version!, kind: 'environment-resolved',
    request_sha256: input.requestSha256, provisional_sha256: input.provisionalSha256,
    deployment_id: input.provisional.deployment_id!, environment_id: environmentId, created_at: input.createdAt,
    infra: requestField(request, ['infra'])!,
    aws: input.provisional.aws!,
  };
  // 실패 기록에는 확인한 값만 남긴다. 확인하지 못한 값을 추정해 채우지 않는다.
  if (errors.length) {
    return { ...head, status: 'failed', cleanup_inventory: cleanupInventory(outputs, environmentId), errors };
  }
  const document: JsonObject = {
    ...head, status: 'ready',
    kubernetes: {
      cluster_arn: requiredOutput(outputs, 'EksClusterArn'), cluster_name: deployment.clusterName,
      kubernetes_version: requiredOutput(outputs, 'EksKubernetesVersion'),
      namespaces: { app: PERF_NAMESPACES.app, observability: PERF_NAMESPACES.observability, runner: PERF_NAMESPACES.runner },
      node_pools: nodePools, workloads,
    },
    kafka: actualStrimzi?.kafka ?? {
      ...(request.schema_version === 3 ? { provider: 'msk' } : {}),
      cluster_arn: requiredOutput(outputs, 'MskClusterArn'), kafka_version: msk.kafka_version, broker_count: brokers.length,
      broker_instance_type: String(brokerTypes[0]),
      broker_volume_gib: parameters.mskBrokerVolumeGiB, auth: 'iam-tls', bootstrap_port: 9098,
      topic: PERF_MSK.topic, partitions: msk.partitions, replication_factor: msk.replication_factor,
      min_insync_replicas: msk.min_insync_replicas, retention_ms: msk.retention_hours * 3600 * 1000,
      max_message_bytes: msk.max_message_bytes, consumer_group: PERF_MSK.consumerGroup,
    },
    datastores: {
      rds: {
        arn: requiredOutput(outputs, 'DbInstanceArn'), engine: 'postgres', engine_version: profile.profile.rds.engine_version,
        ...(request.schema_version === 3 ? { endpoint: { host: requiredOutput(outputs, 'DbEndpoint'), port: 5432, database: CONTROL_DB_NAME } } : {}),
        instance_class: profile.profile.rds.instance_class, storage_gib: profile.profile.rds.storage_gib, multi_az: profile.profile.rds.multi_az,
        enrollment_session: { method: 'application-name', value: PERF_DB_APPLICATION_NAMES.enrollment },
      },
      clickhouse: {
        image: (workloads.clickhouse as JsonObject).image!, version: readiness.clickhouse_version, pvc: pvc!,
      },
      raw_signal_bucket: { arn: requiredOutput(outputs, 'RawSignalBucketArn'), prefix: `${PERF_ARCHIVE_PREFIX}/`, retention_days: profile.profile.retention.raw_signal_days },
      evidence_bucket: { arn: requiredOutput(outputs, 'EvidenceBucketArn'), prefix: PERF_EVIDENCE_PREFIX, retention_days: profile.profile.retention.evidence_days },
    },
    endpoints: contractEndpoints(outputs),
    access: {
      operator_role_ref: requiredOutput(outputs, 'EksOperatorRoleName'), verifier_role_ref: requiredOutput(outputs, 'VerifierRoleName'),
      runner_service_account: PERF_SERVICE_ACCOUNTS.runner,
      grafana: {
        namespace: PERF_NAMESPACES.observability, service: 'pulsemetry-grafana',
        admin_secret_ref: { provider: 'aws-secretsmanager', name: perfSecretName(environmentId, 'grafana/admin'), key: 'password' },
      },
    },
    lock: { ...PERF_LOCK },
    observability: {
      prometheus_retention_days: profile.profile.retention.prometheus_days, prometheus_retention_bytes: profile.profile.retention.prometheus_bytes,
      cloudwatch_log_retention_days: profile.profile.retention.cloudwatch_log_days,
      scrape_interval_seconds: profile.profile.observability.scrape_interval_seconds,
    },
    readiness: { checked_at: readiness.checked_at, stages: readiness.stages, smoke_artifact_ids: readiness.smoke_artifact_ids },
    cleanup_inventory: cleanupInventory(outputs, environmentId, [...(actualStrimzi?.cleanup ?? []), {
      resource_type: 'AWS::EC2::Volume', identifier: String(pvc!.volume_id), owner_tag: `${PERF_ENVIRONMENT_TAG}=${environmentId}`, retain: false, reason: null,
    }]),
    artifacts: readiness.artifacts,
    errors: [],
  };
  return document;
}

/** resolved는 request·provisional과 함께 checkBundle을 통과해야 쓴다. 코드가 하나라도 있으면 쓰지 않는다. */
export function checkResolved(schemas: Schemas, files: { request: Uint8Array; provisional: Uint8Array; resolved: Uint8Array }): string[] {
  return checkBundle(schemas, files);
}

export { sha256 };
