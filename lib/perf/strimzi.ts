import { createHash } from 'node:crypto';
import { fail, isObject, JsonObject } from './deploy-inputs';
import { PERF_MSK, PERF_NAMESPACES } from './config';
import type { KubeItem } from './results';
import type { LoadedPerfProfile } from './profile';

/** dev와 같은 PKCS12·ACL 계약을 perf 이름으로 선언한다. Secret 원문을 읽거나 복제하지 않는다. */
export const PERF_STRIMZI = {
  cluster: PERF_MSK.clusterName,
  namespace: PERF_NAMESPACES.app,
  bootstrap: `${PERF_MSK.clusterName}-kafka-bootstrap.${PERF_NAMESPACES.app}.svc.cluster.local:9093`,
  ca: `${PERF_MSK.clusterName}-cluster-ca-cert`,
  pool: 'dual-role',
  storageClass: 'pulsemetry-perf-kafka-gp3',
} as const;
export const STRIMZI_CLIENT_ROLES = ['gateway', 'ingest', 'topic-admin', 'offset-admin'] as const;
export type StrimziClientRole = typeof STRIMZI_CLIENT_ROLES[number];
export const strimziUser = (role: StrimziClientRole) => `pulsemetry-${role}-perf`;
export interface StrimziTlsClient { readonly clusterCaSecretName: string; readonly userSecretName: string; readonly tlsRevision: string }
export interface PerfStrimziMetadata {
  readonly revision: string;
  readonly clients: Readonly<Record<StrimziClientRole, StrimziTlsClient>>;
}

/** {items:[{metadata:{name,namespace,uid,resourceVersion}}]}만 받는다. data/stringData는 거부한다. */
export function parsePerfStrimziMetadata(value: unknown): PerfStrimziMetadata {
  if (!isObject(value) || Object.keys(value).some(k => k !== 'items') || !Array.isArray(value.items)) fail('strimzi-secrets: metadata items만 필요하다');
  const names = [PERF_STRIMZI.ca, ...STRIMZI_CLIENT_ROLES.map(strimziUser)];
  const metadata = new Map<string, JsonObject>();
  for (const item of value.items) {
    if (!isObject(item) || Object.keys(item).some(k => k !== 'metadata') || !isObject(item.metadata)) fail('strimzi-secrets: Secret 원문은 받지 않는다');
    const m = item.metadata;
    if (Object.keys(m).some(k => !['name', 'namespace', 'uid', 'resourceVersion'].includes(k)) || m.namespace !== PERF_STRIMZI.namespace
      || typeof m.name !== 'string' || !names.includes(m.name) || metadata.has(m.name)
      || typeof m.uid !== 'string' || !m.uid || typeof m.resourceVersion !== 'string' || !/^[0-9]+$/.test(m.resourceVersion)) fail('strimzi-secrets: namespace·name·uid·resourceVersion이 유효해야 한다');
    metadata.set(m.name, m);
  }
  if (metadata.size !== names.length) fail('strimzi-secrets: CA와 역할별 사용자 4개의 metadata가 모두 필요하다');
  const revision = (selected: readonly string[]) => createHash('sha256').update(JSON.stringify(selected.map(name => {
    const m = metadata.get(name)!; return { name, uid: m.uid, resourceVersion: m.resourceVersion };
  }))).digest('hex');
  return {
    revision: revision(names),
    clients: Object.fromEntries(STRIMZI_CLIENT_ROLES.map(role => [role, {
      clusterCaSecretName: PERF_STRIMZI.ca, userSecretName: strimziUser(role), tlsRevision: revision([PERF_STRIMZI.ca, strimziUser(role)]),
    }])) as Record<StrimziClientRole, StrimziTlsClient>,
  };
}

/** 조회한 CR·PVC·PV 상태만 사용한다. 프로필은 실제값 비교에만 쓰고 미관측 상태를 보충하지 않는다. */
export function strimziState(items: KubeItem[], profile: LoadedPerfProfile, metadata: PerfStrimziMetadata, environmentId: string, errors: JsonObject[]) {
  const expected = profile.profile.strimzi!;
  const object = (value: unknown): JsonObject => isObject(value) ? value : {};
  const array = (value: unknown): JsonObject[] => Array.isArray(value) ? value.filter(isObject) : [];
  const find = (kind: string, name: string, namespaced = true) => items.find(item => item.kind === kind && item.metadata.name === name
    && (!namespaced || item.metadata.namespace === PERF_STRIMZI.namespace));
  const error = (code: string, message: string) => errors.push({ code, message });
  const ready = (item: KubeItem | undefined) => !!item && item.status.observedGeneration === item.metadata.generation
    && array(item.status.conditions).some(c => c.type === 'Ready' && c.status === 'True');
  const cluster = find('Kafka', PERF_STRIMZI.cluster);
  const spec = object(cluster?.spec.kafka);
  const listener = array(spec.listeners).find(l => l.name === 'tls');
  const actualListener = array(cluster?.status.listeners).find(l => l.name === 'tls');
  const bootstrap = actualListener?.bootstrapServers;
  if (!ready(cluster)) error('strimzi_not_ready', 'Kafka가 최신 generation Ready가 아니다');
  if (spec.version !== expected.kafka_version || listener?.port !== 9093 || listener?.type !== 'internal' || listener?.tls !== true
    || object(listener?.authentication).type !== 'tls' || object(spec.authorization).type !== 'simple'
    || ![PERF_STRIMZI.bootstrap, PERF_STRIMZI.bootstrap.replace('.svc.cluster.local:', '.svc:')].includes(String(bootstrap))) {
    error('strimzi_transport', 'Kafka version·internal mTLS listener·관측 bootstrap이 프로필과 다르다');
  }
  const pools = items.filter(item => item.kind === 'KafkaNodePool' && item.metadata.namespace === PERF_STRIMZI.namespace
    && object(item.metadata.labels)['strimzi.io/cluster'] === PERF_STRIMZI.cluster);
  const pool = pools.find(item => item.metadata.name === PERF_STRIMZI.pool);
  const storage = object(pool?.spec.storage);
  const volumes = array(storage.volumes);
  const volume = volumes[0];
  const roles = Array.isArray(pool?.spec.roles) ? pool.spec.roles : [];
  if (pools.length !== 1 || !pool || pool.spec.replicas !== expected.broker_count || roles.slice().sort().join() !== 'broker,controller'
    || storage.type !== 'jbod' || volumes.length !== 1 || volume?.id !== 0 || volume.type !== 'persistent-claim'
    || volume.size !== `${expected.volume_gib}Gi` || volume.class !== PERF_STRIMZI.storageClass || volume.deleteClaim !== false
    || !Array.isArray(pool.status.nodeIds) || pool.status.nodeIds.length !== expected.broker_count) {
    error('strimzi_node_pool', 'KafkaNodePool의 replicas·roles·PVC 설정 또는 관측 nodeIds가 프로필과 다르다');
  }
  const claims = items.filter(item => item.kind === 'PersistentVolumeClaim' && item.metadata.namespace === PERF_STRIMZI.namespace
    && String(item.metadata.name).startsWith(`data-0-${PERF_STRIMZI.cluster}-${PERF_STRIMZI.pool}-`));
  const owner = `pulsemetry:perf-environment=${environmentId}`;
  const cleanup: JsonObject[] = items.filter(item => ['Kafka', 'KafkaNodePool', 'KafkaTopic', 'KafkaUser'].includes(item.kind)
    && item.metadata.namespace === PERF_STRIMZI.namespace && (item.metadata.name === PERF_STRIMZI.cluster || object(item.metadata.labels)['strimzi.io/cluster'] === PERF_STRIMZI.cluster))
    .map(item => ({ resource_type: `Kubernetes::${item.kind}`, identifier: `${PERF_STRIMZI.namespace}/${String(item.metadata.name)}`, owner_tag: owner, retain: false, reason: null }));
  if (claims.length !== expected.broker_count) error('strimzi_pvc_count', 'Kafka broker 수와 관측 PVC 수가 다르다');
  const expectedClaims = Array.isArray(pool?.status.nodeIds) ? pool.status.nodeIds.map(id => `data-0-${PERF_STRIMZI.cluster}-${PERF_STRIMZI.pool}-${String(id)}`).sort() : [];
  if (claims.map(c => String(c.metadata.name)).sort().join() !== expectedClaims.join()) error('strimzi_pvc_identity', 'KafkaNodePool nodeIds와 PVC 이름이 일치하지 않는다');
  for (const claim of claims) {
    cleanup.push({ resource_type: 'Kubernetes::PersistentVolumeClaim', identifier: `${PERF_STRIMZI.namespace}/${String(claim.metadata.name)}`, owner_tag: owner, retain: false, reason: null });
    const pv = find('PersistentVolume', String(claim.spec.volumeName), false);
    const csi = object(pv?.spec.csi);
    if (claim.status.phase !== 'Bound' || claim.spec.storageClassName !== PERF_STRIMZI.storageClass
      || object(claim.status.capacity).storage !== `${expected.volume_gib}Gi` || typeof csi.volumeHandle !== 'string') {
      error('strimzi_pvc_not_bound', `${String(claim.metadata.name)}: Bound PVC·크기·StorageClass·PV가 일치하지 않는다`);
    }
    if (pv) cleanup.push({ resource_type: 'Kubernetes::PersistentVolume', identifier: String(pv.metadata.name), owner_tag: owner, retain: false, reason: null });
    if (typeof csi.volumeHandle === 'string') cleanup.push({ resource_type: 'AWS::EC2::Volume', identifier: csi.volumeHandle,
      owner_tag: `pulsemetry:perf-environment=${environmentId}`, retain: false, reason: null });
  }
  const topic = find('KafkaTopic', PERF_MSK.topic);
  const topicConfig = object(topic?.spec.config);
  if (!ready(topic) || topic?.spec.topicName !== PERF_MSK.topic || topic.spec.partitions !== expected.partitions
    || topic.spec.replicas !== expected.replication_factor || topicConfig['min.insync.replicas'] !== expected.min_insync_replicas
    || Number(topicConfig['retention.ms']) !== expected.retention_hours * 3600000 || Number(topicConfig['max.message.bytes']) !== expected.max_message_bytes) {
    error('strimzi_topic', 'KafkaTopic Ready 상태·partition·replica·retention·message 제한이 프로필과 다르다');
  }
  const ref = (name: string, key: string) => ({ provider: 'kubernetes-secret', name, key });
  const clients = STRIMZI_CLIENT_ROLES.map(role => {
    const user = find('KafkaUser', strimziUser(role));
    const auth = object(user?.spec.authorization);
    const acls = array(auth.acls).map(acl => {
      const resource = object(acl.resource);
      return { resource_type: resource.type!, resource_name: resource.type === 'cluster' ? null : resource.name!,
        pattern_type: resource.type === 'cluster' ? null : resource.patternType!, operations: acl.operations! };
    });
    const topicOps = role === 'gateway' ? ['Describe', 'Write'] : role === 'topic-admin' ? ['Describe', 'DescribeConfigs'] : ['Describe', 'Read'];
    const wanted: JsonObject[] = [{ resource_type: 'topic', resource_name: PERF_MSK.topic, pattern_type: 'literal', operations: topicOps }];
    if (role === 'gateway') wanted.push({ resource_type: 'cluster', resource_name: null, pattern_type: null, operations: ['IdempotentWrite'] });
    if (role === 'ingest' || role === 'offset-admin') wanted.push({ resource_type: 'group', resource_name: PERF_MSK.consumerGroup, pattern_type: 'literal', operations: ['Describe', 'Read'] });
    const normalize = (values: JsonObject[]) => values.map(v => JSON.stringify({ ...v, operations: Array.isArray(v.operations) ? v.operations.slice().sort() : v.operations })).sort().join();
    if (!ready(user) || object(user?.spec.authentication).type !== 'tls' || auth.type !== 'simple' || normalize(acls) !== normalize(wanted)
      || array(auth.acls).some(a => a.host !== '*' || (a.type !== undefined && a.type !== 'allow'))) {
      error('strimzi_user_acl', `${strimziUser(role)}: Ready mTLS·역할별 최소 ACL과 다르다`);
    }
    return { role, keystore_secret_ref: ref(strimziUser(role), 'user.p12'), password_secret_ref: ref(strimziUser(role), 'user.password'),
      revision: metadata.clients[role].tlsRevision, acls };
  });
  return {
    kafka: { provider: 'strimzi', namespace: PERF_STRIMZI.namespace, cluster_name: PERF_STRIMZI.cluster,
      kafka_version: spec.version!, broker_count: Number(pool?.spec.replicas), auth: 'mtls', bootstrap_port: 9093, bootstrap_servers: String(bootstrap),
      topic: PERF_MSK.topic, partitions: Number(topic?.spec.partitions), replication_factor: Number(topic?.spec.replicas),
      min_insync_replicas: Number(topicConfig['min.insync.replicas']), retention_ms: Number(topicConfig['retention.ms']),
      max_message_bytes: Number(topicConfig['max.message.bytes']), consumer_group: PERF_MSK.consumerGroup,
      kafka_node_pools: [{ name: PERF_STRIMZI.pool, replicas: Number(pool?.spec.replicas), roles, volume_gib: expected.volume_gib,
        storage_class: String(volume?.class), persistent_volume_claims: claims.map(c => String(c.metadata.name)).sort() }],
      tls: { ca_secret_ref: ref(PERF_STRIMZI.ca, 'ca.p12'), ca_password_secret_ref: ref(PERF_STRIMZI.ca, 'ca.password'), revision: metadata.revision, clients },
    } as JsonObject,
    cleanup,
  };
}
