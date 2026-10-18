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
  return parseRuntimeInputs(value);
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

export function generateValues(document, enrollmentImage, ingestImage, dashboardImage, runtimeInput) {
  const runtime = parseRuntimeInputs(runtimeInput);
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
  if (!/^http:\/\/[a-zA-Z0-9.-]+$/.test(publicBaseUrl)) throw new Error('ValidationPublicBaseUrl은 검증 ALB의 HTTP 주소여야 한다');
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
  const auth = runtime.userAuth;
  const authSettings = { issuer: auth.issuer, audience: auth.audience, allowedOrigins: auth.allowedOrigins };
  const jwt = signer => ({ enabled: true, secretProviderClass: `${signer ? 'enrollment-api' : 'dashboard-api'}-jwt`, publicVersionId: auth.publicVersionId, publicKeys: auth.publicKeys, ...(signer ? { privateVersionId: auth.privateVersionId, activeKid: auth.activeKid } : {}) });
  const dashboardFiles = ['RDS', 'CLICKHOUSE'].flatMap(store => ['SOURCE', 'CACHE'].flatMap(role => ['USERNAME', 'PASSWORD'].map(field => `PULSEMETRY_DASHBOARD_${store}_${role}_${field}`)));
  const dashboardSecrets = { dashboardRdsSourceArn: arn('DashboardRdsSourceSecretArn', 'secretsmanager'), dashboardRdsCacheArn: arn('DashboardRdsCacheSecretArn', 'secretsmanager'), dashboardClickHouseSourceArn: arn('DashboardClickHouseSourceSecretArn', 'secretsmanager'), dashboardClickHouseCacheArn: arn('DashboardClickHouseCacheSecretArn', 'secretsmanager'), userJwtPrivateKeyArn: arn('UserJwtPrivateKeySecretArn', 'secretsmanager'), userJwtPublicKeysArn: arn('UserJwtPublicKeysSecretArn', 'secretsmanager') };
  const allSecrets = [...Object.values(dashboardSecrets), ...['DbSecretArn', 'TokenHashSecretArn', 'AdminApiTokenSecretArn'].map(required)];
  if (new Set(allSecrets).size !== allSecrets.length) throw new Error('DB 계정·JWT·기존 인증 Secret 원본은 서로 달라야 한다');
  const oidc = oidcValues(runtime.oidc, outputs, allSecrets);
  const commonFiles = ['PULSEMETRY_DB_USERNAME', 'PULSEMETRY_DB_PASSWORD', 'PULSEMETRY_TOKEN_HASH_SECRET'];
  const binding = key => [{ stage: 'validation', targetGroupARN: arn(key, 'elasticloadbalancing'), confirmExclusiveOwnership: true }];
  const values = {
    'base.yaml': { nodeRoleName, subnetIds, appNodeSecurityGroupId: appSg, clickhouseNodeSecurityGroupId: chSg, clickhouseAvailabilityZone: zone },
    'lbc.yaml': { clusterName, region, vpcId },
    'runtime.yaml': {
      region, secrets: { dbArn: arn('DbSecretArn', 'secretsmanager'), tokenHashArn: arn('TokenHashSecretArn', 'secretsmanager'), adminApiTokenArn: arn('AdminApiTokenSecretArn', 'secretsmanager'), ...dashboardSecrets },
      userAuth: { privateVersionId: auth.privateVersionId, publicVersionId: auth.publicVersionId, activeKid: auth.activeKid, publicKeys: auth.publicKeys },
      oidc,
    },
    'enrollment-api.yaml': {
      image: image(enrollmentImage, 'enrollment image'), vpcId, jwt: jwt(true), userAuth: { ...authSettings, ...(auth.allowedRedirectUris ? { allowedRedirectUris: auth.allowedRedirectUris } : {}) }, oidc,
      runtime: { enabled: true, secretProviderClass: 'enrollment-api-runtime', requiredFiles: [...commonFiles, 'PULSEMETRY_ADMIN_API_TOKEN', ...(oidc.enabled ? oidc.clients.map(client => client.alias) : [])] },
      env: { PULSEMETRY_DB_URL: `jdbc:postgresql://${endpoint}:5432/controlplane`, PULSEMETRY_PUBLIC_BASE_URL: publicBaseUrl, PULSEMETRY_BINARIES_DIR: '/app/binaries', PULSEMETRY_MANAGEMENT_ENABLED: String(runtime.dashboard.managementEnabled), PULSEMETRY_MAIL_ENABLED: String(runtime.dashboard.mailEnabled) },
      targetGroupBindings: binding('ValidationEnrollmentApiTargetGroupArn'),
    },
    'telemetry-ingest.yaml': {
      image: image(ingestImage, 'ingest image'), vpcId,
      runtime: { enabled: true, secretProviderClass: 'telemetry-ingest-runtime', requiredFiles: commonFiles },
      env: { PULSEMETRY_DB_URL: `jdbc:postgresql://${endpoint}:5432/controlplane`, PULSEMETRY_ARCHIVE_TYPE: 's3', PULSEMETRY_ARCHIVE_BUCKET: bucket, PULSEMETRY_ARCHIVE_PREFIX: prefix, AWS_REGION: region, PULSEMETRY_CLICKHOUSE_URL: 'http://clickhouse.pulsemetry-dev.svc.cluster.local:8123', PULSEMETRY_CLICKHOUSE_DATABASE: 'default' },
      targetGroupBindings: binding('ValidationTelemetryIngestTargetGroupArn'),
    },
    'dashboard-api.yaml': {
      image: image(dashboardImage, 'dashboard image'), vpcId, nodePort: Number(dashboardNodePort),
      runtime: { enabled: true, secretProviderClass: 'dashboard-api-runtime', requiredFiles: dashboardFiles },
      jwt: jwt(false), userAuth: authSettings,
      env: { ...runtime.dashboard.settings, PULSEMETRY_DASHBOARD_PORT: '8081', PULSEMETRY_MANAGEMENT_ENABLED: String(runtime.dashboard.managementEnabled), PULSEMETRY_MAIL_ENABLED: String(runtime.dashboard.mailEnabled), PULSEMETRY_DASHBOARD_RDS_SOURCE_URL: `jdbc:postgresql://${endpoint}:5432/controlplane`, PULSEMETRY_DASHBOARD_RDS_CACHE_URL: `jdbc:postgresql://${endpoint}:5432/controlplane`, PULSEMETRY_DASHBOARD_CLICKHOUSE_SOURCE_URL: 'http://clickhouse.pulsemetry-dev.svc.cluster.local:8123', PULSEMETRY_DASHBOARD_CLICKHOUSE_SOURCE_DATABASE: 'default', PULSEMETRY_DASHBOARD_CLICKHOUSE_CACHE_URL: 'http://clickhouse.pulsemetry-dev.svc.cluster.local:8123', PULSEMETRY_DASHBOARD_CLICKHOUSE_CACHE_DATABASE: 'dashboard_cache' }, targetGroupBindings: binding('ValidationDashboardApiTargetGroupArn'),
    },
    'clickhouse.yaml': { vpcId, availabilityZone: zone, targetGroupBindings: binding('ValidationClickhouseTargetGroupArn') },
    'fluent-bit.yaml': { env: [{ name: 'AWS_REGION', value: region }, { name: 'APPLICATION_LOG_GROUP', value: required('ApplicationLogGroupName') }] },
    'ascp.yaml': { awsRegion: region },
  };
  const groups = ['ValidationEnrollmentApiTargetGroupArn', 'ValidationTelemetryIngestTargetGroupArn', 'ValidationClickhouseTargetGroupArn', 'ValidationDashboardApiTargetGroupArn'].map(required);
  if (new Set(groups).size !== groups.length) throw new Error('네 검증 TG ARN은 서로 달라야 한다');
  if (required('ApplicationLogGroupName') !== '/eks/dev/application') throw new Error('ApplicationLogGroupName이 런타임 계약과 다르다');
  return values;
}

export function main(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--outputs', '--output-dir', '--enrollment-image', '--ingest-image', '--dashboard-image', '--runtime-values'].includes(argv[i]) || !argv[i + 1]) throw new Error('사용법: node scripts/eks-values.mjs --outputs <cdk-output.json> --output-dir <dir> --enrollment-image <repository@sha256:digest> --ingest-image <repository@sha256:digest> --dashboard-image <repository@sha256:digest> --runtime-values <runtime.yaml>');
    if (options[argv[i]]) throw new Error(`${argv[i]} 옵션이 중복된다`);
    options[argv[i]] = argv[i + 1];
  }
  for (const name of ['--outputs', '--output-dir', '--enrollment-image', '--ingest-image', '--dashboard-image', '--runtime-values']) if (!options[name]) throw new Error(`${name} 옵션이 필요하다`);
  const values = generateValues(JSON.parse(readFileSync(options['--outputs'], 'utf8')), options['--enrollment-image'], options['--ingest-image'], options['--dashboard-image'], parseRuntimeValues(readFileSync(options['--runtime-values'], 'utf8')));
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
