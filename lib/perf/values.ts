import { PERF_STRIMZI, PerfStrimziMetadata } from './strimzi';
import { JsonObject, PerfOutputs, PerfRuntimeInput, fail, isObject, requiredOutput } from './deploy-inputs';
import {
  PERF_ARCHIVE_PREFIX, PERF_DB_APPLICATION_NAMES, PERF_EKS_CLUSTER_NAME, PERF_EVIDENCE_PREFIX, PERF_MSK, PERF_MSK_SESSION_NAMES,
  PERF_NAMESPACES, PERF_PORTS, PERF_SERVICE_ACCOUNTS, perfInfraParameters, perfNodePoolName, perfSecretName,
} from './config';
import { LoadedPerfProfile, PERF_JOB_IDS, perfPoolIds, PerfJobId, PerfPoolId, PerfWorkloadId, cpuQuantity, memoryQuantity } from './profile';

/**
 * CDK output·프로필·요청 이미지·MSK 조회 결과를 perf Helm values로 바꾼다. Secret 값은 넣지 않는다.
 * 같은 함수가 resolved의 endpoint·Service 이름도 정하므로 chart와 결과 파일이 어긋나지 않는다.
 */

const svc = (name: string, namespace: string, port: number) => `http://${name}.${namespace}.svc.cluster.local:${port}`;

/** 계약 `endpoints`와 Job values의 Service 주소. Prometheus 이름은 관측 chart의 fullnameOverride다. */
export const PERF_ENDPOINTS = {
  gateway: svc('telemetry-gateway', PERF_NAMESPACES.app, PERF_PORTS.gateway),
  enrollment: svc('enrollment-api', PERF_NAMESPACES.app, PERF_PORTS.enrollment),
  clickhouse: svc('clickhouse', PERF_NAMESPACES.app, PERF_PORTS.clickhouseHttp),
  prometheus: svc('pulsemetry-monitoring-prometheus', PERF_NAMESPACES.observability, PERF_PORTS.prometheus),
  remoteWrite: `${svc('pulsemetry-monitoring-prometheus', PERF_NAMESPACES.observability, PERF_PORTS.prometheus)}/api/v1/write`,
} as const;

/** 앱 이미지 키. request `images`의 키이고 Helm values로 옮긴다. */
const APP_IMAGES = ['enrollment-api', 'telemetry-gateway', 'telemetry-ingest', 'clickhouse'] as const;

/** request secret_references 키 → CDK output 키·Secret 이름. 요청이 가리키는 원본이 이 환경의 것인지 대조한다. */
export const PERF_SECRET_REFERENCES: Readonly<Record<string, { output: string; name: string }>> = {
  'telemetry-jwt-private-key': { output: 'TelemetryJwtPrivateKeySecretArn', name: 'telemetry-jwt/private-key' },
  'telemetry-jwt-public-keys': { output: 'TelemetryJwtPublicKeysSecretArn', name: 'telemetry-jwt/public-keys' },
  'token-hash-secret': { output: 'TokenHashSecretArn', name: 'enrollment/token-hash-secret' },
  'enrollment-admin-token': { output: 'AdminApiTokenSecretArn', name: 'enrollment/admin-token' },
  'rds-credentials': { output: 'DbSecretArn', name: 'rds/master' },
  'grafana-admin': { output: 'GrafanaAdminSecretArn', name: 'grafana/admin' },
  'synthetic-seed-secret': { output: 'SyntheticSeedSecretArn', name: 'synthetic/seed-secret' },
};

export interface PerfDeployment {
  readonly account: string;
  readonly environmentId: string;
  readonly clusterName: string;
}

const SECRET_ARN = (account: string, environmentId: string, name: string) =>
  new RegExp(`^arn:aws:secretsmanager:ap-northeast-2:${account}:secret:${perfSecretName(environmentId, name).replace(/[.]/g, '\\.')}-[A-Za-z0-9]{6}$`);

/** output이 프로필·요청과 같은 배포에서 나왔는지 확인하고 계정·환경을 돌려준다. */
export function checkDeployment(outputs: PerfOutputs, profile: LoadedPerfProfile, request: JsonObject): PerfDeployment {
  const provider = profile.profile.kafka_provider ?? 'msk';
  if (request.schema_version === 2 && provider !== 'msk') fail('Strimzi는 v3 환경 계약이 필요하다');
  if (request.schema_version === 3 && (!isObject(request.kafka) || request.kafka.provider !== provider)) fail('request Kafka provider가 프로필과 다르다');
  const environmentId = requiredOutput(outputs, 'PerfEnvironmentId');
  const requested = isObject(request.environment) ? request.environment.environment_id : undefined;
  if (requested !== environmentId) fail(`request environment_id(${String(requested)})가 배포(${environmentId})와 다르다`);
  if (requiredOutput(outputs, 'PerfProfilePath') !== profile.path || requiredOutput(outputs, 'PerfProfileSha256') !== profile.sha256) {
    fail('배포된 프로필 경로·SHA-256이 입력 프로필과 다르다');
  }
  const infra = isObject(request.infra) ? request.infra : {};
  if (infra.profile !== profile.path || infra.profile_sha256 !== profile.sha256) fail('request infra.profile·profile_sha256이 입력 프로필과 다르다');
  const deployed = JSON.parse(requiredOutput(outputs, 'PerfInfraParameters'));
  if (JSON.stringify(sortKeys(infra.parameters)) !== JSON.stringify(sortKeys(deployed))) fail('request infra.parameters가 배포 입력과 다르다');
  const clusterName = requiredOutput(outputs, 'EksClusterName');
  if (clusterName !== PERF_EKS_CLUSTER_NAME) fail(`EksClusterName은 ${PERF_EKS_CLUSTER_NAME}이어야 한다`);
  const account = /^arn:aws:eks:ap-northeast-2:([0-9]{12}):cluster\//.exec(requiredOutput(outputs, 'EksClusterArn'))?.[1];
  if (!account) fail('EksClusterArn이 서울 리전 EKS ARN이 아니다');
  if (requiredOutput(outputs, 'EksRegion') !== 'ap-northeast-2') fail('EksRegion은 ap-northeast-2여야 한다');
  // 요청의 Secret 참조가 이 환경의 원본 이름인지 대조한다. 값은 읽지 않는다.
  const references = isObject(request.secret_references) ? request.secret_references : {};
  for (const [key, { output, name }] of Object.entries(PERF_SECRET_REFERENCES)) {
    const arn = requiredOutput(outputs, output, SECRET_ARN(account, environmentId, name));
    const reference = references[key];
    if (!isObject(reference) || reference.provider !== 'aws-secretsmanager' || reference.key !== null
      || reference.name !== perfSecretName(environmentId, name)) {
      fail(`request secret_references.${key}는 ${perfSecretName(environmentId, name)}(aws-secretsmanager, key null)여야 한다`);
    }
    void arn;
  }
  return { account, environmentId, clusterName };
}

function sortKeys(value: unknown): unknown {
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]));
}

function image(value: unknown, label: string): { repository: string; digest: string } {
  const match = /^([a-z0-9][a-z0-9.-]*(?::[0-9]{1,5})?\/[a-z0-9][a-z0-9._/-]*)@(sha256:[0-9a-f]{64})$/.exec(typeof value === 'string' ? value : '');
  if (!match) fail(`${label}: registry/repository@sha256:<digest> 이미지가 필요하다`);
  return { repository: match[1], digest: match[2] };
}

function resources(profile: LoadedPerfProfile, id: PerfWorkloadId) {
  const workload = profile.profile.workloads[id];
  return {
    requests: { cpu: cpuQuantity(workload.cpu_request_millicores), memory: memoryQuantity(workload.memory_request_bytes) },
    // null은 chart 기본값(limits.cpu)을 지운다. CPU limit 없음이 프로필 값이다.
    limits: { cpu: workload.cpu_limit_millicores === null ? null : cpuQuantity(workload.cpu_limit_millicores), memory: memoryQuantity(workload.memory_limit_bytes) },
  };
}

function placement(profile: LoadedPerfProfile, id: PerfWorkloadId) {
  const pool = profile.profile.workloads[id].node_pool;
  return { nodePool: perfNodePoolName(pool), taint: profile.profile.node_pools[pool].dedicated ? pool : null };
}

export interface PerfValuesInput {
  readonly outputs: PerfOutputs;
  readonly profile: LoadedPerfProfile;
  readonly request: JsonObject;
  readonly runtime: PerfRuntimeInput;
  readonly bootstrapServers?: string;
  readonly mskBrokers?: readonly string[];
  readonly strimziMetadata?: PerfStrimziMetadata;
}

/** 파일 이름 → values. 입력 순서는 helm/perf/README.md의 설치 순서와 같다. */
export function generatePerfValues(input: PerfValuesInput): Record<string, Record<string, unknown>> {
  const { outputs, profile, request, runtime } = input;
  const deployment = checkDeployment(outputs, profile, request);
  const p = profile.profile;
  const strimzi = p.kafka_provider === 'strimzi';
  if (strimzi && (!input.strimziMetadata || input.bootstrapServers || input.mskBrokers)) fail('Strimzi에는 metadata만 공급하며 MSK 입력은 금지한다');
  if (!strimzi && (!input.bootstrapServers || !input.mskBrokers || input.strimziMetadata)) fail('MSK에는 bootstrap·nodes가 필요하며 Strimzi metadata는 금지한다');
  const bootstrapServers = strimzi ? PERF_STRIMZI.bootstrap : input.bootstrapServers!;
  const out = (key: string, pattern?: RegExp) => requiredOutput(outputs, key, pattern);
  const sg = /^sg-[a-f0-9]{8,17}$/;
  const images = isObject(request.images) ? request.images : {};
  const appImages = Object.fromEntries(APP_IMAGES.map(key => [key, image(images[key], `request images.${key}`)]));
  const dbEndpoint = out('DbEndpoint', /^[a-z0-9.-]+\.rds\.amazonaws\.com$/);
  const jdbc = (application: string) => `jdbc:postgresql://${dbEndpoint}:${PERF_PORTS.postgres}/controlplane?ApplicationName=${application}`;
  const roleArn = (key: string) => out(key, new RegExp(`^arn:aws:iam::${deployment.account}:role/[A-Za-z0-9+=,.@_/-]{1,512}$`));
  const mskRoles = strimzi ? undefined : { gateway: roleArn('MskGatewayRoleArn'), ingest: roleArn('MskIngestRoleArn'), topicAdmin: roleArn('MskTopicAdminRoleArn'), offsetAdmin: roleArn('MskOffsetAdminRoleArn') };
  if (mskRoles && new Set(Object.values(mskRoles)).size !== 4) fail('workload별 MSK 역할은 서로 달라야 한다');
  if (mskRoles) for (const [key, session] of Object.entries(PERF_MSK_SESSION_NAMES)) {
    const output = `Msk${key.charAt(0).toUpperCase()}${key.slice(1)}SessionName`;
    if (out(output) !== session) fail(`${output}가 MSK 역할 trust의 고정 세션 이름과 다르다`);
  }
  if (strimzi && (out('KafkaProvider') !== 'strimzi' || out('KafkaClusterName') !== PERF_STRIMZI.cluster || out('KafkaTopicName') !== PERF_MSK.topic || out('KafkaConsumerGroupName') !== PERF_MSK.consumerGroup)) fail('Strimzi 배포 이름이 perf 계약과 다르다');
  if (!strimzi && (out('MskTopicName') !== PERF_MSK.topic || out('MskConsumerGroupName') !== PERF_MSK.consumerGroup || out('MskClusterName') !== PERF_MSK.clusterName)) {
    fail('MSK topic·group·cluster 이름이 perf 계약과 다르다');
  }
  const rawBucket = out('RawSignalBucketName', /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/);
  const evidenceBucket = out('EvidenceBucketName', /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/);
  if (out('EvidencePrefix') !== PERF_EVIDENCE_PREFIX) fail(`EvidencePrefix는 ${PERF_EVIDENCE_PREFIX}여야 한다`);
  const telemetry = runtime.telemetryJwt;
  const telemetryJwt = (workload: 'enrollment-api' | 'telemetry-gateway' | 'telemetry-ingest') => ({
    enabled: true, secretProviderClass: `${workload}-telemetry-jwt`, publicVersionId: telemetry.publicVersionId, publicKeys: telemetry.publicKeys,
    ...(workload === 'enrollment-api' ? { privateVersionId: telemetry.privateVersionId, activeKid: telemetry.activeKid, issueEnabled: true } : {}),
  });
  const kafka = (workload: 'gateway' | 'ingest') => ({
    enabled: true, bootstrapServers, topic: PERF_MSK.topic,
    ...(workload === 'ingest' ? { consumerGroup: PERF_MSK.consumerGroup } : {}),
    ...(strimzi ? { security: 'mtls', ...input.strimziMetadata!.clients[workload] } : { iamRoleArn: mskRoles![workload], iamSessionName: PERF_MSK_SESSION_NAMES[workload] }),
  });
  const jvm = runtime.jvmGcSafepointLog ? { jvm: { gcSafepointLog: true } } : {};
  const commonFiles = ['PULSEMETRY_DB_USERNAME', 'PULSEMETRY_DB_PASSWORD', 'PULSEMETRY_TOKEN_HASH_SECRET'];
  const pools = Object.fromEntries(perfPoolIds(p).map(id => {
    const pool = p.node_pools[id];
    const key = `${id.charAt(0).toUpperCase()}${id.slice(1)}PoolSecurityGroupId`;
    return [id, { securityGroupId: out(key, sg), instanceType: pool.instance_type, nodes: pool.nodes, dedicated: pool.dedicated, ephemeralStorageGiB: pool.ephemeral_storage_gib }];
  }));
  const subnetIds = out('EksNodeSubnetIds').split(',');
  if (subnetIds.length !== 1 || !/^subnet-[a-f0-9]{8,17}$/.test(subnetIds[0])) fail('EksNodeSubnetIds는 노드 AZ의 subnet 하나다');
  if (out('EksNodeAvailabilityZone') !== p.availability_zone) fail('EksNodeAvailabilityZone이 프로필 AZ와 다르다');
  const jobs = Object.fromEntries(PERF_JOB_IDS.map((id: PerfJobId) => {
    const job = p.jobs[id];
    const pool: PerfPoolId = job.node_pool;
    return [id, {
      serviceAccount: PERF_SERVICE_ACCOUNTS[id],
      nodePool: perfNodePoolName(pool), taint: p.node_pools[pool].dedicated ? pool : null,
      cpu: cpuQuantity(job.cpu_request_millicores), memory: memoryQuantity(job.memory_request_bytes), memoryLimit: memoryQuantity(job.memory_limit_bytes),
      // job values에 deadline이 없는 환경 단위 Job의 상한이다(seed 30분, readiness smoke 15분).
      ...(id === 'seed' ? { activeDeadlineSeconds: 1800 } : id === 'smoke' ? { activeDeadlineSeconds: 900 } : {}),
    }];
  }));
  const registry = `${deployment.account}.dkr.ecr.ap-northeast-2.amazonaws.com/soma-376`;
  const observabilityRelabel = [{ targetLabel: 'cluster', replacement: deployment.clusterName }, { targetLabel: 'environment', replacement: 'perf' }];

  return {
    ...(strimzi ? { 'kafka-strimzi.yaml': { environment: 'perf', clusterName: PERF_STRIMZI.cluster, stage: 'perf', availabilityZone: p.availability_zone, volumeGiB: p.strimzi!.volume_gib } } : {}),
    'platform.yaml': {
      environmentId: deployment.environmentId, nodeRoleName: out('EksNodeRoleName', /^[A-Za-z0-9_+=,.@-]{1,64}$/),
      availabilityZone: p.availability_zone, subnetIds, nodeSecurityGroupId: out('EksNodeSecurityGroupId', sg), pools,
      clickhouseStorage: { iops: p.clickhouse.iops, throughputMiBps: p.clickhouse.throughput_mibps }, disruptionBudgetNodes: '0',
    },
    'runtime.yaml': {
      region: 'ap-northeast-2',
      secrets: {
        dbArn: out('DbSecretArn'), tokenHashArn: out('TokenHashSecretArn'), adminApiTokenArn: out('AdminApiTokenSecretArn'),
        telemetryJwtPrivateKeyArn: out('TelemetryJwtPrivateKeySecretArn'), telemetryJwtPublicKeysArn: out('TelemetryJwtPublicKeysSecretArn'),
        syntheticSeedArn: out('SyntheticSeedSecretArn'), seedDbArn: out('SeedDbSecretArn'), verifyDbArn: out('VerifyDbSecretArn'),
      },
      telemetryJwt: { privateVersionId: telemetry.privateVersionId, publicVersionId: telemetry.publicVersionId, activeKid: telemetry.activeKid, publicKeys: telemetry.publicKeys },
    },
    'enrollment-api.yaml': {
      image: appImages['enrollment-api'], replicaCount: runtime.enrollmentReplicas, resources: resources(profile, 'enrollment-api'),
      placement: placement(profile, 'enrollment-api'),
      runtime: { enabled: true, secretProviderClass: 'enrollment-api-runtime', requiredFiles: [...commonFiles, 'PULSEMETRY_ADMIN_API_TOKEN'] },
      // 앱 기본값(false)이면 ptt_가 발급된다. 준비 절차는 JWT를 받아야 한다(PLAN §4.3 3단계).
      telemetryJwt: telemetryJwt('enrollment-api'),
      env: {
        PULSEMETRY_DB_URL: jdbc(PERF_DB_APPLICATION_NAMES.enrollment), PULSEMETRY_PUBLIC_BASE_URL: PERF_ENDPOINTS.enrollment,
        PULSEMETRY_BINARIES_DIR: '/app/binaries', PULSEMETRY_MANAGEMENT_ENABLED: 'false', PULSEMETRY_MAIL_ENABLED: 'false',
      },
    },
    'telemetry-ingest.yaml': {
      image: appImages['telemetry-ingest'], resources: resources(profile, 'telemetry-ingest'), placement: placement(profile, 'telemetry-ingest'), ...jvm,
      runtime: { enabled: true, secretProviderClass: 'telemetry-ingest-runtime', requiredFiles: commonFiles },
      telemetryJwt: telemetryJwt('telemetry-ingest'), kafka: kafka('ingest'),
      env: {
        PULSEMETRY_OBSERVABILITY_ENVIRONMENT: 'perf', PULSEMETRY_INGEST_PORT: String(PERF_PORTS.ingest),
        PULSEMETRY_DB_URL: jdbc(PERF_DB_APPLICATION_NAMES.ingest), PULSEMETRY_ARCHIVE_TYPE: 's3', PULSEMETRY_ARCHIVE_BUCKET: rawBucket,
        PULSEMETRY_ARCHIVE_PREFIX: PERF_ARCHIVE_PREFIX, AWS_REGION: 'ap-northeast-2',
        PULSEMETRY_CLICKHOUSE_URL: PERF_ENDPOINTS.clickhouse, PULSEMETRY_CLICKHOUSE_DATABASE: 'default',
      },
    },
    'telemetry-gateway.yaml': {
      image: appImages['telemetry-gateway'], resources: resources(profile, 'telemetry-gateway'), placement: placement(profile, 'telemetry-gateway'), ...jvm,
      telemetryJwt: telemetryJwt('telemetry-gateway'), kafka: kafka('gateway'),
      env: { AWS_REGION: 'ap-northeast-2', PULSEMETRY_OBSERVABILITY_ENVIRONMENT: 'perf' },
    },
    'clickhouse.yaml': {
      image: appImages.clickhouse, availabilityZone: p.availability_zone,
      storage: { className: p.clickhouse.storage_class, size: `${p.clickhouse.volume_gib}Gi` }, resources: resources(profile, 'clickhouse'),
    },
    'telemetry-kafka-admin.yaml': {
      region: 'ap-northeast-2', bootstrapServers,
      ...(strimzi ? { provider: 'strimzi', topicInit: { enabled: false }, tls: input.strimziMetadata!.clients['offset-admin'], topicAdmin: { roleArn: '', sessionName: '' }, offsetAdmin: { roleArn: '', sessionName: '' } } : {
        topicAdmin: { roleArn: mskRoles!.topicAdmin, sessionName: PERF_MSK_SESSION_NAMES.topicAdmin },
        offsetAdmin: { roleArn: mskRoles!.offsetAdmin, sessionName: PERF_MSK_SESSION_NAMES.offsetAdmin },
      }),
    },
    'observability.yaml': {
      global: { pulsemetry: {
        environment: 'perf', targetNamespace: PERF_NAMESPACES.app, region: 'ap-northeast-2', clusterName: deployment.clusterName,
        kafkaProvider: strimzi ? 'strimzi' : 'msk', ...(strimzi ? { kafkaClusterName: PERF_STRIMZI.cluster } : {}), mskBrokers: [...(input.mskBrokers ?? [])], grafanaAdminSecretArn: out('GrafanaAdminSecretArn'), mskClusterName: PERF_MSK.clusterName,
        applicationLogGroup: out('ApplicationLogGroupName'), brokerLogGroup: strimzi ? '' : out('MskBrokerLogGroupName'),
        controlPlaneLogGroup: out('EksControlPlaneLogGroupName'), observabilityLogGroup: out('ObservabilityLogGroupName'),
        kubernetesEventsLogGroup: out('KubernetesEventsLogGroupName'), diagnosticsBucket: out('DiagnosticsBucketName'),
        topic: PERF_MSK.topic, consumerGroup: PERF_MSK.consumerGroup,
      } },
      // upstream chart의 relabelings는 tpl로 평가되지 않으므로 실제 문자열을 넣는다(scripts/eks-values.mjs와 같은 방식).
      monitoring: Object.fromEntries([
        ['kubelet', ['serviceMonitor']], ['prometheus', ['serviceMonitor']], ['prometheusOperator', ['serviceMonitor']],
        ['grafana', ['serviceMonitor']], ['kube-state-metrics', ['prometheus', 'monitor']], ['prometheus-node-exporter', ['prometheus', 'monitor']],
      ].map(([name, path]) => [name, (path as string[]).reduceRight<Record<string, unknown>>((value, key) => ({ [key]: value }), { relabelings: observabilityRelabel })])),
    },
    'jobs.yaml': {
      infra: {
        ...(request.schema_version === 3 ? { contractVersion: 3 } : {}),
        region: 'ap-northeast-2', environmentId: deployment.environmentId, cluster: deployment.clusterName,
        namespaces: { app: PERF_NAMESPACES.app, runner: PERF_NAMESPACES.runner },
        evidenceBucket, evidencePrefix: PERF_EVIDENCE_PREFIX, rawArchiveUri: `s3://${rawBucket}/${PERF_ARCHIVE_PREFIX}/`,
        endpoints: { ...PERF_ENDPOINTS }, database: { host: dbEndpoint, port: PERF_PORTS.postgres, name: 'controlplane' },
        telemetryJwtActiveKid: telemetry.activeKid,
        // verify가 CloudWatch SumOffsetLag(Cluster Name·Consumer Group·Topic)로 drain을 확인한다.
        ...(strimzi ? { kafka: { provider: 'strimzi', clusterName: PERF_STRIMZI.cluster, namespace: PERF_STRIMZI.namespace, partitions: profile.profile.strimzi!.partitions, consumerGroup: PERF_MSK.consumerGroup, topic: PERF_MSK.topic } } : { msk: { ...(request.schema_version === 3 ? { partitions: p.msk!.partitions } : {}), clusterName: PERF_MSK.clusterName, consumerGroup: PERF_MSK.consumerGroup, topic: PERF_MSK.topic } }),
        imageRepositories: { k6Runner: `${registry}/perf-k6-runner`, perfTools: `${registry}/perf-tools` },
        jobs,
      },
    },
  };
}

/** 생성 파일 머리말. 값이 아닌 참조만 담았다는 것을 남긴다. */
export const GENERATED_HEADER = '# scripts/perf-values.ts가 CDK output 참조·프로필에서 생성했다. Secret 값을 넣지 않는다.\n';

export { perfInfraParameters };
