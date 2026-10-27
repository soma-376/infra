#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dump, load, JSON_SCHEMA } from 'js-yaml';
import runtimeInputs from '../lib/dev/runtime-input.cjs';
const { parseRuntimeInputs, oidcClientBindings } = runtimeInputs;

export function parseRuntimeValues(text) {
  let value;
  try { value = load(text, { schema: JSON_SCHEMA }); }
  catch { throw new Error('runtime-values는 중복 키 없는 단일 YAML 문서여야 한다'); }
  return parseRuntimeInputs(value, { eks: true });
}

// CDK output과 대조하는 계약 상수다. lib/dev/eks-config.ts와 같은 값이며 테스트가 일치를 고정한다. (ADR-0035·0036)
export const TELEMETRY_CONTRACT = {
  gatewayNodePort: '30082',
  sessions: {
    MskGatewaySessionName: 'pulsemetry-dev-telemetry-gateway',
    MskIngestSessionName: 'pulsemetry-dev-telemetry-ingest',
    MskTopicAdminSessionName: 'pulsemetry-dev-telemetry-kafka-admin',
    MskOffsetAdminSessionName: 'pulsemetry-dev-telemetry-kafka-offsets',
  },
};

/**
 * 운영자가 `aws kafka get-bootstrap-brokers --cluster-arn <MskClusterArn>`로 받은 JSON을 검사한다.
 * SASL/IAM 주소 하나만 허용하고 public·평문·TLS 전용 주소가 섞이면 거부한다. 9098·리전·같은 cluster 주소만 대조한다.
 * 주소는 API가 준 그대로 쓴다. MSK는 cluster 이름을 DNS에 그대로 넣지 않고(`lab-blog` → `labblog`) 목록이 모든 broker를
 * 담는다고 보장하지 않는다. 그래서 cluster 이름으로 호스트를 추정하거나 broker 수를 강제하지 않는다. broker 수·AZ는 CDK가 고정한다.
 */
export function parseMskBootstrap(text, region) {
  let value;
  try {
    value = JSON.parse(text);
    load(text, { schema: JSON_SCHEMA }); // JSON.parse가 허용하는 중복 키도 거부한다.
  } catch { throw new Error('msk-bootstrap: 중복 키 없는 get-bootstrap-brokers JSON이 필요하다'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('msk-bootstrap: JSON object가 필요하다');
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== 'BootstrapBrokerStringSaslIam') {
    throw new Error('msk-bootstrap: BootstrapBrokerStringSaslIam만 허용한다. public·평문·TLS·SCRAM 주소가 있으면 cluster 설정을 확인한다');
  }
  const brokers = String(value.BootstrapBrokerStringSaslIam).split(',');
  const pattern = new RegExp(`^b-([0-9]+)\\.([A-Za-z0-9-]+\\.[a-z0-9]+\\.c[0-9]+)\\.kafka\\.${region}\\.amazonaws\\.com:9098$`);
  const parsed = brokers.map(broker => pattern.exec(broker));
  // cluster의 broker는 3대다(DEV_EKS_MSK). 목록은 그중 일부일 수 있으므로 1~3개를 받는다.
  if (brokers.length > 3 || parsed.some(match => !match)) throw new Error('msk-bootstrap: 리전의 9098 broker 주소 1~3개가 필요하다');
  if (new Set(parsed.map(match => match[1])).size !== brokers.length || new Set(parsed.map(match => match[2])).size !== 1) {
    throw new Error('msk-bootstrap: broker가 중복 없이 같은 cluster 주소에 있어야 한다');
  }
  return [...brokers].sort().join(',');
}

/** 전체 list-nodes 결과에서 실제 broker만 읽는다. bootstrap은 일부 broker일 수 있다. */
export function parseMskNodes(text, region, bootstrapServers) {
  let value;
  try { value = JSON.parse(text); load(text, { schema: JSON_SCHEMA }); }
  catch { throw new Error('msk-nodes: 중복 키 없는 list-nodes JSON이 필요하다'); }
  if (!value || !Array.isArray(value.NodeInfoList) || value.NextToken) throw new Error('msk-nodes: pagination이 끝난 NodeInfoList가 필요하다');
  const suffix = bootstrapServers.split(',')[0].replace(/^b-[0-9]+\./, '').replace(/:9098$/, '');
  const nodes = value.NodeInfoList.filter(node => node.NodeType === 'BROKER' && node.BrokerNodeInfo);
  if (nodes.length !== 3) throw new Error('msk-nodes: broker 3개 전체가 필요하다');
  const hosts = nodes.map(node => {
    const broker = node.BrokerNodeInfo;
    if (![1, 2, 3].includes(broker.BrokerId) || !Array.isArray(broker.Endpoints) || !broker.Endpoints.length) throw new Error('msk-nodes: broker ID·endpoint가 올바르지 않다');
    const expected = `b-${broker.BrokerId}.${suffix}`;
    const hosts = broker.Endpoints.map(endpoint => typeof endpoint === 'string' ? endpoint.replace(/:9098$/, '') : '');
    if (!hosts.every(host => host === expected) || !expected.endsWith(`.kafka.${region}.amazonaws.com`)) throw new Error('msk-nodes: bootstrap과 같은 cluster의 내부 broker DNS만 허용한다');
    return expected;
  });
  if (new Set(hosts).size !== 3) throw new Error('msk-nodes: broker가 중복된다');
  return hosts.sort();
}

// AWS API·Secret 읽기 없이 배포 output 참조를 Helm values로 변환한다.
export function collectOutputs(document) {
  const result = {};
  const add = (key, value) => {
    if (typeof value !== 'string' || !value.trim() || /[\r\n\u0000]/.test(value) || /\$\{Token\[/.test(value)) {
      throw new Error(`${key}: 배포된 output의 비어 있지 않은 문자열이 필요하다`);
    }
    if (result[key] !== undefined && result[key] !== value) throw new Error(`${key}: output 값이 충돌한다`);
    result[key] = value;
  };
  if (Array.isArray(document.Stacks)) {
    for (const stack of document.Stacks) for (const output of stack.Outputs ?? []) add(output.OutputKey, output.OutputValue);
  } else {
    for (const outputs of Object.values(document)) {
      if (!outputs || typeof outputs !== 'object' || Array.isArray(outputs)) throw new Error('CDK --outputs-file 형식이 필요하다');
      for (const [key, value] of Object.entries(outputs)) add(key, value);
    }
  }
  return result;
}

function image(value, label) {
  const match = /^([a-zA-Z0-9._:\/-]+)@(sha256:[a-f0-9]{64})$/.exec(value ?? '');
  if (!match) throw new Error(`${label}: repository@sha256:<64자리 lowercase hex> 이미지가 필요하다`);
  if (!match[1].includes('/') || match[1].includes('://')) throw new Error(`${label}: registry/repository가 필요하다`);
  return { repository: match[1], digest: match[2] };
}

// 원본은 CDK가 만든 key→ARN output뿐이다. 별도 ARN 입력으로 IAM 경계를 넓히지 않는다.
function oidcValues(oidc, outputs, existingSecrets) {
  if (!oidc?.enabled) return { enabled: false };
  const source = outputs.OidcClientSecretArns;
  let declared;
  try {
    declared = JSON.parse(source);
    load(source, { schema: JSON_SCHEMA }); // JSON.parse가 허용하는 중복 키도 거부한다.
  } catch { throw new Error('OidcClientSecretArns: 중복 키 없는 CDK JSON output이 필요하다'); }
  if (!declared || typeof declared !== 'object' || Array.isArray(declared)) throw new Error('OidcClientSecretArns: key→ARN 맵이 필요하다');
  const account = /^arn:aws:secretsmanager:ap-northeast-2:([0-9]{12}):secret:.+$/.exec(outputs.DbSecretArn)?.[1];
  if (!account) throw new Error('OidcClientSecretArns: 기존 dev Secret과 계정·리전을 확인할 수 없다');
  const arns = new Set(existingSecrets);
  for (const [key, value] of Object.entries(declared)) {
    if (!/^[A-Za-z0-9_-]+$/.test(key) || typeof value !== 'string' ||
        !new RegExp(`^arn:aws:secretsmanager:ap-northeast-2:${account}:secret:soma-376/dev/oidc/clients/${key}-[A-Za-z0-9]{6}$`).test(value) || arns.has(value)) {
      throw new Error('OidcClientSecretArns: CDK 소유의 독립된 dev client Secret ARN이 필요하다');
    }
    arns.add(value);
  }
  const clients = oidcClientBindings(oidc).map(client => {
    if (!Object.hasOwn(declared, client.key)) throw new Error('OidcClientSecretArns: 선택한 client key의 배포 output이 없다');
    return { ...client, secretArn: declared[client.key] };
  });
  return { ...oidc, clients };
}

export function generateValues(document, images, runtimeInput, mskBootstrapText, mskNodesText) {
  const runtime = parseRuntimeInputs(runtimeInput, { eks: true });
  const outputs = collectOutputs(document);
  const required = key => {
    if (!outputs[key]) throw new Error(`${key}: 배포 output이 없다`);
    return outputs[key];
  };
  const arn = (key, service) => {
    const value = required(key);
    if (!new RegExp(`^arn:aws:${service}:[a-z0-9-]+:[0-9]{12}:.+$`).test(value)) throw new Error(`${key}: ${service} ARN 참조가 필요하다`);
    return value;
  };
  const region = required('EksRegion');
  if (region !== 'ap-northeast-2') throw new Error('EksRegion은 ap-northeast-2여야 한다');
  const prefix = required('ArchivePrefix');
  if (!['eks_validation', 'eks'].includes(prefix)) throw new Error('ArchivePrefix는 eks_validation 또는 eks여야 한다');
  const clusterName = required('EksClusterName');
  const vpcId = required('EksVpcId');
  if (!/^vpc-[a-f0-9]+$/.test(vpcId)) throw new Error('EksVpcId가 올바르지 않다');
  const endpoint = required('DbEndpoint');
  if (!/^[a-zA-Z0-9.-]+$/.test(endpoint)) throw new Error('DbEndpoint는 hostname이어야 한다');
  const publicBaseUrl = required('ValidationPublicBaseUrl');
  // ADR-0040: 기존 HTTP ALB fallback과 명시한 HTTPS 공개 origin을 모두 전달한다.
  let publicOrigin;
  try { publicOrigin = new URL(publicBaseUrl); } catch { /* 아래에서 동일한 입력 오류로 처리한다. */ }
  if (!/^https?:\/\/[a-zA-Z0-9.-]+$/.test(publicBaseUrl) || publicOrigin?.origin !== publicBaseUrl) {
    throw new Error('ValidationPublicBaseUrl은 경로·인증정보·port·query·fragment 없는 HTTP/HTTPS origin이어야 한다');
  }
  const appSg = required('EksAppNodeSecurityGroupId');
  const chSg = required('EksClickhouseNodeSecurityGroupId');
  if (![appSg, chSg].every(id => /^sg-[a-f0-9]+$/.test(id))) throw new Error('EKS node SG ID가 올바르지 않다');
  const subnetIds = required('EksSubnetIds').split(',').map(id => id.trim());
  if (subnetIds.length < 2 || !subnetIds.every(id => /^subnet-[a-f0-9]+$/.test(id))) throw new Error('서로 다른 AZ의 subnet ID가 2개 이상 필요하다');
  if (new Set(subnetIds).size !== subnetIds.length) throw new Error('EksSubnetIds가 중복된다');
  const zone = required('EksClickhouseAvailabilityZone');
  if (!/^ap-northeast-2[a-z]$/.test(zone)) throw new Error('ClickHouse AZ가 올바르지 않다');
  const nodeRoleName = required('EksNodeRoleName');
  if (!/^[a-zA-Z0-9_+=,.@-]{1,64}$/.test(nodeRoleName)) throw new Error('EksNodeRoleName은 IAM role 이름이어야 한다');
  const bucket = required('RawSignalBucketName');
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error('RawSignalBucketName이 올바르지 않다');
  const dashboardNodePort = required('EksDashboardApiNodePort');
  if (dashboardNodePort !== '30081') throw new Error('EksDashboardApiNodePort는 30081이어야 한다');
  const gatewayNodePort = required('EksTelemetryGatewayNodePort');
  if (gatewayNodePort !== TELEMETRY_CONTRACT.gatewayNodePort) throw new Error('EksTelemetryGatewayNodePort는 30082여야 한다');
  // MSK: stage·topic·group은 archive prefix와 같은 입력에서 정해진다. 세션 이름은 역할 trust 조건과 같아야 한다.
  const stage = prefix === 'eks' ? 'main' : 'validation';
  if (required('MskStage') !== stage) throw new Error('MskStage가 ArchivePrefix와 다르다');
  const topic = required('MskTopicName'), consumerGroup = required('MskConsumerGroupName');
  if (topic !== `pulsemetry-dev-telemetry-ingress-${stage}` || consumerGroup !== `pulsemetry-dev-telemetry-ingest-${stage}`) {
    throw new Error('MSK topic·consumer group이 stage 계약과 다르다');
  }
  const mskClusterName = required('MskClusterName');
  if (!/^[a-z0-9-]{1,64}$/.test(mskClusterName)) throw new Error('MskClusterName이 올바르지 않다');
  const mskAccount = new RegExp(`^arn:aws:kafka:${region}:([0-9]{12}):cluster/${mskClusterName}/[A-Za-z0-9-]+$`).exec(required('MskClusterArn'))?.[1];
  if (!mskAccount) throw new Error('MskClusterArn이 MskClusterName·리전과 다르다');
  const mskRole = key => {
    const value = required(key);
    if (!new RegExp(`^arn:aws:iam::${mskAccount}:role/[A-Za-z0-9+=,.@_/-]{1,512}$`).test(value)) throw new Error(`${key}: 같은 계정의 IAM role ARN이 필요하다`);
    return value;
  };
  const mskRoles = Object.fromEntries(['MskGatewayRoleArn', 'MskIngestRoleArn', 'MskTopicAdminRoleArn', 'MskOffsetAdminRoleArn'].map(key => [key, mskRole(key)]));
  if (new Set(Object.values(mskRoles)).size !== 4) throw new Error('workload별 MSK 역할은 서로 달라야 한다');
  for (const [key, value] of Object.entries(TELEMETRY_CONTRACT.sessions)) {
    if (required(key) !== value) throw new Error(`${key}가 MSK 역할 trust의 고정 세션 이름과 다르다`);
  }
  const bootstrapServers = parseMskBootstrap(mskBootstrapText ?? '', region);
  const mskBrokers = parseMskNodes(mskNodesText ?? '', region, bootstrapServers);
  const obsSg = required('ObservabilityNodeSecurityGroupId');
  if (!/^sg-[a-f0-9]{8}([a-f0-9]{9})?$/.test(obsSg)) throw new Error('ObservabilityNodeSecurityGroupId가 올바르지 않다');
  if (required('ObservabilityNamespace') !== 'pulsemetry-observability') throw new Error('ObservabilityNamespace가 계약과 다르다');
  // ALB의 OTLP 대상과 ingest 모드가 맞아야 수집이 끊기지 않는다. 전환·복구 순서를 이 검사로 강제한다. (ADR-0036)
  const otlpTarget = required('ValidationOtlpTarget');
  const allowedModes = { ingest: ['http', 'dual'], gateway: ['dual', 'kafka'] }[otlpTarget];
  if (!allowedModes) throw new Error('ValidationOtlpTarget은 ingest 또는 gateway여야 한다');
  if (!allowedModes.includes(runtime.ingestMode)) {
    throw new Error(`ValidationOtlpTarget=${otlpTarget}에서는 ingestMode ${allowedModes.join('|')}만 허용한다`);
  }
  const auth = runtime.userAuth;
  const authSettings = { issuer: auth.issuer, audience: auth.audience, allowedOrigins: auth.allowedOrigins };
  const jwt = signer => ({ enabled: true, secretProviderClass: `${signer ? 'enrollment-api' : 'dashboard-api'}-jwt`, publicVersionId: auth.publicVersionId, publicKeys: auth.publicKeys, ...(signer ? { privateVersionId: auth.privateVersionId, activeKid: auth.activeKid } : {}) });
  const dashboardFiles = ['RDS', 'CLICKHOUSE'].flatMap(store => ['SOURCE', 'CACHE'].flatMap(role => ['USERNAME', 'PASSWORD'].map(field => `PULSEMETRY_DASHBOARD_${store}_${role}_${field}`)));
  const dashboardSecrets = { dashboardRdsSourceArn: arn('DashboardRdsSourceSecretArn', 'secretsmanager'), dashboardRdsCacheArn: arn('DashboardRdsCacheSecretArn', 'secretsmanager'), dashboardClickHouseSourceArn: arn('DashboardClickHouseSourceSecretArn', 'secretsmanager'), dashboardClickHouseCacheArn: arn('DashboardClickHouseCacheSecretArn', 'secretsmanager'), userJwtPrivateKeyArn: arn('UserJwtPrivateKeySecretArn', 'secretsmanager'), userJwtPublicKeysArn: arn('UserJwtPublicKeysSecretArn', 'secretsmanager') };
  // telemetry JWT 원본은 DevDataStack output이다. 생성기에는 Data·EKS·Edge output을 함께 전달한다.
  const telemetrySecrets = { telemetryJwtPrivateKeyArn: arn('TelemetryJwtPrivateKeySecretArn', 'secretsmanager'), telemetryJwtPublicKeysArn: arn('TelemetryJwtPublicKeysSecretArn', 'secretsmanager') };
  const allSecrets = [...Object.values(dashboardSecrets), ...Object.values(telemetrySecrets), ...['DbSecretArn', 'TokenHashSecretArn', 'AdminApiTokenSecretArn'].map(required)];
  if (new Set(allSecrets).size !== allSecrets.length) throw new Error('DB 계정·JWT·기존 인증 Secret 원본은 서로 달라야 한다');
  const oidc = oidcValues(runtime.oidc, outputs, allSecrets);
  const commonFiles = ['PULSEMETRY_DB_USERNAME', 'PULSEMETRY_DB_PASSWORD', 'PULSEMETRY_TOKEN_HASH_SECRET'];
  const binding = key => [{ stage: 'validation', targetGroupARN: arn(key, 'elasticloadbalancing'), confirmExclusiveOwnership: true }];
  const telemetry = runtime.telemetryJwt;
  const telemetryJwt = workload => ({
    enabled: true, secretProviderClass: `${workload}-telemetry-jwt`, publicVersionId: telemetry.publicVersionId, publicKeys: telemetry.publicKeys,
    ...(workload === 'enrollment-api' ? { privateVersionId: telemetry.privateVersionId, activeKid: telemetry.activeKid, issueEnabled: telemetry.issueEnabled } : {}),
  });
  const kafka = workload => ({
    enabled: true, bootstrapServers, topic,
    ...(workload === 'telemetry-ingest' ? { consumerGroup } : {}),
    iamRoleArn: mskRoles[workload === 'telemetry-ingest' ? 'MskIngestRoleArn' : 'MskGatewayRoleArn'],
    iamSessionName: required(workload === 'telemetry-ingest' ? 'MskIngestSessionName' : 'MskGatewaySessionName'),
  });
  const consumer = ['dual', 'kafka'].includes(runtime.ingestMode);
  const jvm = runtime.jvmGcSafepointLog ? { jvm: { gcSafepointLog: true } } : {};
  // 플랫폼 trace는 관측 namespace의 고정 Collector 주소로만 보낸다. 끄면 values에 넣지 않아 Pod template이 바뀌지 않는다. (ADR-0039)
  const tracing = runtime.platformTracing?.enabled
    ? { tracing: { enabled: true, endpoint: PLATFORM_TRACE_ENDPOINT, sampleProbability: String(runtime.platformTracing.sampleProbability ?? 0.1), cluster: clusterName } }
    : {};
  const values = {
    'base.yaml': { nodeRoleName, subnetIds, appNodeSecurityGroupId: appSg, clickhouseNodeSecurityGroupId: chSg, clickhouseAvailabilityZone: zone, observabilityNodeSecurityGroupId: obsSg },
    'lbc.yaml': { clusterName, region, vpcId },
    'runtime.yaml': {
      region, secrets: { dbArn: arn('DbSecretArn', 'secretsmanager'), tokenHashArn: arn('TokenHashSecretArn', 'secretsmanager'), adminApiTokenArn: arn('AdminApiTokenSecretArn', 'secretsmanager'), ...dashboardSecrets, ...telemetrySecrets },
      userAuth: { privateVersionId: auth.privateVersionId, publicVersionId: auth.publicVersionId, activeKid: auth.activeKid, publicKeys: auth.publicKeys },
      telemetryJwt: { privateVersionId: telemetry.privateVersionId, publicVersionId: telemetry.publicVersionId, activeKid: telemetry.activeKid, publicKeys: telemetry.publicKeys },
      oidc,
    },
    'enrollment-api.yaml': {
      image: image(images.enrollment, 'enrollment image'), vpcId, jwt: jwt(true), userAuth: { ...authSettings, ...(auth.allowedRedirectUris ? { allowedRedirectUris: auth.allowedRedirectUris } : {}) }, oidc,
      runtime: { enabled: true, secretProviderClass: 'enrollment-api-runtime', requiredFiles: [...commonFiles, 'PULSEMETRY_ADMIN_API_TOKEN', ...(oidc.enabled ? oidc.clients.map(client => client.alias) : [])] },
      telemetryJwt: telemetryJwt('enrollment-api'),
      env: { PULSEMETRY_DB_URL: `jdbc:postgresql://${endpoint}:5432/controlplane`, PULSEMETRY_PUBLIC_BASE_URL: publicBaseUrl, PULSEMETRY_BINARIES_DIR: '/app/binaries', PULSEMETRY_MANAGEMENT_ENABLED: String(runtime.dashboard.managementEnabled), PULSEMETRY_MAIL_ENABLED: String(runtime.dashboard.mailEnabled) },
      targetGroupBindings: binding('ValidationEnrollmentApiTargetGroupArn'),
    },
    'telemetry-ingest.yaml': {
      image: image(images.ingest, 'ingest image'), vpcId, metrics: { enabled: true }, ...jvm, ...tracing,
      runtime: { enabled: true, secretProviderClass: 'telemetry-ingest-runtime', requiredFiles: commonFiles },
      ingestMode: runtime.ingestMode, telemetryJwt: telemetryJwt('telemetry-ingest'),
      ...(consumer ? { kafka: kafka('telemetry-ingest') } : {}),
      env: { PULSEMETRY_OBSERVABILITY_ENVIRONMENT: 'dev', PULSEMETRY_DB_URL: `jdbc:postgresql://${endpoint}:5432/controlplane`, PULSEMETRY_ARCHIVE_TYPE: 's3', PULSEMETRY_ARCHIVE_BUCKET: bucket, PULSEMETRY_ARCHIVE_PREFIX: prefix, AWS_REGION: region, PULSEMETRY_CLICKHOUSE_URL: 'http://clickhouse.pulsemetry-dev.svc.cluster.local:8123', PULSEMETRY_CLICKHOUSE_DATABASE: 'default' },
      // kafka 모드는 외부 OTLP 노출을 없애고 내부 health ClusterIP만 둔다.
      ...(runtime.ingestMode === 'kafka'
        ? { service: { type: 'ClusterIP' }, targetGroupBindings: [] }
        : { targetGroupBindings: binding('ValidationTelemetryIngestTargetGroupArn') }),
    },
    'telemetry-gateway.yaml': {
      image: image(images.gateway, 'gateway image'), vpcId, metrics: { enabled: true }, ...jvm, ...tracing, nodePort: Number(gatewayNodePort),
      telemetryJwt: telemetryJwt('telemetry-gateway'), kafka: kafka('telemetry-gateway'),
      env: { AWS_REGION: region, PULSEMETRY_OBSERVABILITY_ENVIRONMENT: 'dev' },
      targetGroupBindings: binding('ValidationTelemetryGatewayTargetGroupArn'),
    },
    'telemetry-kafka-admin.yaml': {
      region, bootstrapServers, stage, topic, consumerGroup,
      topicAdmin: { roleArn: mskRoles.MskTopicAdminRoleArn, sessionName: required('MskTopicAdminSessionName') },
      offsetAdmin: { roleArn: mskRoles.MskOffsetAdminRoleArn, sessionName: required('MskOffsetAdminSessionName') },
    },
    'dashboard-api.yaml': {
      image: image(images.dashboard, 'dashboard image'), vpcId, nodePort: Number(dashboardNodePort),
      runtime: { enabled: true, secretProviderClass: 'dashboard-api-runtime', requiredFiles: dashboardFiles },
      jwt: jwt(false), userAuth: authSettings,
      env: { ...runtime.dashboard.settings, PULSEMETRY_DASHBOARD_PORT: '8081', PULSEMETRY_MANAGEMENT_ENABLED: String(runtime.dashboard.managementEnabled), PULSEMETRY_MAIL_ENABLED: String(runtime.dashboard.mailEnabled), PULSEMETRY_DASHBOARD_RDS_SOURCE_URL: `jdbc:postgresql://${endpoint}:5432/controlplane`, PULSEMETRY_DASHBOARD_RDS_CACHE_URL: `jdbc:postgresql://${endpoint}:5432/controlplane`, PULSEMETRY_DASHBOARD_CLICKHOUSE_SOURCE_URL: 'http://clickhouse.pulsemetry-dev.svc.cluster.local:8123', PULSEMETRY_DASHBOARD_CLICKHOUSE_SOURCE_DATABASE: 'default', PULSEMETRY_DASHBOARD_CLICKHOUSE_CACHE_URL: 'http://clickhouse.pulsemetry-dev.svc.cluster.local:8123', PULSEMETRY_DASHBOARD_CLICKHOUSE_CACHE_DATABASE: 'dashboard_cache' }, targetGroupBindings: binding('ValidationDashboardApiTargetGroupArn'),
    },
    // 구 CDK output으로도 먼저 Helm TGB를 제거할 수 있다. ClickHouse 공개 TG 참조는 소비하지 않는다. (ADR-0038)
    'clickhouse.yaml': { availabilityZone: zone, observability: { enabled: true } },
    'fluent-bit.yaml': { env: [{ name: 'AWS_REGION', value: region }, { name: 'APPLICATION_LOG_GROUP', value: required('ApplicationLogGroupName') }, { name: 'OBSERVABILITY_LOG_GROUP', value: required('ObservabilityLogGroupName') }, { name: 'CLUSTER_NAME', value: clusterName }] },
    'ascp.yaml': { awsRegion: region },
    'observability.yaml': { global: { pulsemetry: {
      environment: 'dev', targetNamespace: 'pulsemetry-dev', region, clusterName, mskBrokers,
      grafanaAdminSecretArn: arn('GrafanaAdminSecretArn', 'secretsmanager'), mskClusterName,
      applicationLogGroup: required('ApplicationLogGroupName'), brokerLogGroup: required('MskBrokerLogGroupName'),
      controlPlaneLogGroup: required('EksControlPlaneLogGroupName'),
      observabilityLogGroup: required('ObservabilityLogGroupName'), kubernetesEventsLogGroup: required('KubernetesEventsLogGroupName'),
      diagnosticsBucket: required('DiagnosticsBucketName'), topic, consumerGroup,
    } }, monitoring: Object.fromEntries([
      ['kubelet', ['serviceMonitor']], ['prometheus', ['serviceMonitor']],
      ['prometheusOperator', ['serviceMonitor']], ['grafana', ['serviceMonitor']],
      ['kube-state-metrics', ['prometheus', 'monitor']], ['prometheus-node-exporter', ['prometheus', 'monitor']],
    ].map(([name, path]) => {
      // upstream chart의 relabelings는 tpl로 평가되지 않으므로 output에서 실제 문자열을 채운다.
      const relabelings = [{ targetLabel: 'cluster', replacement: clusterName }, { targetLabel: 'environment', replacement: 'dev' }];
      return [name, path.reduceRight((value, key) => ({ [key]: value }), { relabelings })];
    })) },
  };
  const groups = ['ValidationEnrollmentApiTargetGroupArn', 'ValidationTelemetryIngestTargetGroupArn', 'ValidationDashboardApiTargetGroupArn', 'ValidationTelemetryGatewayTargetGroupArn'].map(required);
  if (new Set(groups).size !== groups.length) throw new Error('네 앱 TG ARN은 서로 달라야 한다');
  if (required('ApplicationLogGroupName') !== '/eks/dev/application') throw new Error('ApplicationLogGroupName이 런타임 계약과 다르다');
  return values;
}

const PLATFORM_TRACE_ENDPOINT = 'http://pulsemetry-otel-platform.pulsemetry-observability.svc:4318/v1/traces';

const OPTIONS = ['--outputs', '--output-dir', '--enrollment-image', '--ingest-image', '--dashboard-image', '--gateway-image', '--runtime-values', '--msk-bootstrap', '--msk-nodes'];

export function main(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!OPTIONS.includes(argv[i]) || !argv[i + 1]) throw new Error('사용법: node scripts/eks-values.mjs --outputs <cdk-output.json> --output-dir <dir> --enrollment-image <repository@sha256:digest> --ingest-image <repository@sha256:digest> --dashboard-image <repository@sha256:digest> --gateway-image <repository@sha256:digest> --runtime-values <runtime.yaml> --msk-bootstrap <get-bootstrap-brokers.json> --msk-nodes <list-nodes.json>');
    if (options[argv[i]]) throw new Error(`${argv[i]} 옵션이 중복된다`);
    options[argv[i]] = argv[i + 1];
  }
  for (const name of OPTIONS) if (!options[name]) throw new Error(`${name} 옵션이 필요하다`);
  const images = { enrollment: options['--enrollment-image'], ingest: options['--ingest-image'], dashboard: options['--dashboard-image'], gateway: options['--gateway-image'] };
  const values = generateValues(JSON.parse(readFileSync(options['--outputs'], 'utf8')), images, parseRuntimeValues(readFileSync(options['--runtime-values'], 'utf8')), readFileSync(options['--msk-bootstrap'], 'utf8'), readFileSync(options['--msk-nodes'], 'utf8'));
  const dir = resolve(options['--output-dir']);
  mkdirSync(dir, { recursive: true });
  for (const [filename, value] of Object.entries(values)) {
    writeFileSync(resolve(dir, filename), '# CDK output 참조에서 생성했다. Secret 값을 넣지 않는다.\n' + dump(value, { noRefs: true, lineWidth: -1 }), { mode: 0o600 });
  }
  console.log(`${Object.keys(values).length}개 values 파일 생성: ${dir}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
