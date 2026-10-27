import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const { load, dump } = require('js-yaml');
const runtimeFile = resolve(__dirname, '../fixtures/eks-runtime.yaml');
const root = resolve(__dirname, '../..');
const digest = 'sha256:' + 'a'.repeat(64);
const repository = '111111111111.dkr.ecr.ap-northeast-2.amazonaws.com/soma-376/';
const enrollmentImage = repository + 'enrollment-api@' + digest;
const ingestImage = repository + 'telemetry-ingest@' + digest;
const dashboardImage = repository + 'dashboard-api@' + digest;
const gatewayImage = repository + 'telemetry-gateway@' + digest;
const bootstrapFile = resolve(__dirname, 'fixtures/msk-bootstrap.json');
// 실제 MSK는 cluster 이름의 하이픈을 지운 DNS를 준다(`soma-376-dev-telemetry` → `soma376devtelemetry`).
const brokers = [1, 2, 3].map(n => `b-${n}.soma376devtelemetry.abc123.c2.kafka.ap-northeast-2.amazonaws.com:9098`).join(',');
const mskRole = (name: string) => `arn:aws:iam::111111111111:role/DevEksStack-Runtime${name}MskRole-fixture`;
const secret = (name: string) => `arn:aws:secretsmanager:ap-northeast-2:111111111111:secret:${name}-abc123`;
const tg = (name: string) => `arn:aws:elasticloadbalancing:ap-northeast-2:111111111111:targetgroup/soma-376-dev-eks-${name}/0123456789abcdef`;
const helmTest = process.env.HELM_BIN ? test : test.skip;

function outputs(prefix = 'eks_validation', otlpTarget = 'ingest') {
  return {
    DevEksStack: {
      ObservabilityNamespace: 'pulsemetry-observability', ObservabilityNodeSecurityGroupId: 'sg-0123456789abcdef2',
      GrafanaAdminSecretArn: secret('soma-376/dev/observability/grafana-admin'),
      ObservabilityLogGroupName: '/eks/dev/observability', KubernetesEventsLogGroupName: '/eks/dev/events',
      DiagnosticsBucketName: 'fixture-diagnostics', MskBrokerLogGroupName: '/aws/vendedlogs/msk/soma-376-dev-telemetry',
      EksControlPlaneLogGroupName: '/aws/eks/soma-376-dev-eks/cluster',
      EksDashboardApiNodePort: '30081',
      DashboardRdsSourceSecretArn: secret('dashboard-rds-source'), DashboardRdsCacheSecretArn: secret('dashboard-rds-cache'), DashboardClickHouseSourceSecretArn: secret('dashboard-ch-source'), DashboardClickHouseCacheSecretArn: secret('dashboard-ch-cache'), UserJwtPrivateKeySecretArn: secret('jwt-private'), UserJwtPublicKeysSecretArn: secret('jwt-public'),
      EksClusterName: 'soma-376-dev-eks', EksRegion: 'ap-northeast-2', EksVpcId: 'vpc-0123456789abcdef0',
      EksSubnetIds: 'subnet-0123456789abcdef0,subnet-0123456789abcdef1',
      EksAppNodeSecurityGroupId: 'sg-0123456789abcdef0', EksClickhouseNodeSecurityGroupId: 'sg-0123456789abcdef1',
      EksClickhouseAvailabilityZone: 'ap-northeast-2a', EksNodeRoleName: 'soma-376-dev-eks-node',
      DbEndpoint: 'database.example.test', DbSecretArn: secret('db'), TokenHashSecretArn: secret('hmac'),
      AdminApiTokenSecretArn: secret('admin'), RawSignalBucketName: 'fixture-raw-signals',
      ApplicationLogGroupName: '/eks/dev/application', ArchivePrefix: prefix,
      EksTelemetryGatewayNodePort: '30082',
      MskClusterArn: 'arn:aws:kafka:ap-northeast-2:111111111111:cluster/soma-376-dev-telemetry/0123abcd-4567-89ef-0123-456789abcdef-2',
      MskClusterName: 'soma-376-dev-telemetry', MskStage: stage(prefix),
      MskTopicName: `pulsemetry-dev-telemetry-ingress-${stage(prefix)}`, MskConsumerGroupName: `pulsemetry-dev-telemetry-ingest-${stage(prefix)}`,
      MskGatewayRoleArn: mskRole('Gateway'), MskIngestRoleArn: mskRole('Ingest'),
      MskTopicAdminRoleArn: mskRole('TopicAdmin'), MskOffsetAdminRoleArn: mskRole('OffsetAdmin'),
      MskGatewaySessionName: 'pulsemetry-dev-telemetry-gateway', MskIngestSessionName: 'pulsemetry-dev-telemetry-ingest',
      MskTopicAdminSessionName: 'pulsemetry-dev-telemetry-kafka-admin', MskOffsetAdminSessionName: 'pulsemetry-dev-telemetry-kafka-offsets',
    },
    DevEdgeStack: {
      ValidationPublicBaseUrl: 'http://validation-alb.example.test',
      ValidationEnrollmentApiTargetGroupArn: tg('enroll-v'),
      ValidationTelemetryIngestTargetGroupArn: tg('ingest-v'),
      ValidationDashboardApiTargetGroupArn: tg('dashboard-v'),
      ValidationTelemetryGatewayTargetGroupArn: tg('gateway-v'),
      ValidationOtlpTarget: otlpTarget,
    },
    DevDataStack: {
      TelemetryJwtPrivateKeySecretArn: secret('soma-376/dev/telemetry-jwt/private-key'),
      TelemetryJwtPublicKeysSecretArn: secret('soma-376/dev/telemetry-jwt/public-keys'),
    },
  };
}

function stage(prefix: string) {
  return prefix === 'eks' ? 'main' : 'validation';
}

const oidcArn = (key: string) => secret(`soma-376/dev/oidc/clients/${key}`);
function oidcOutputs() {
  const source = outputs();
  return { ...source, DevDataStack: { ...source.DevDataStack, OidcClientSecretArns: JSON.stringify(Object.fromEntries(
    ['cognito-a', 'cognito-b', 'unused'].map(key => [key, oidcArn(key)]),
  )) } };
}
function oidcRuntime(enabled = true, scheme: 'http' | 'https' = 'https') {
  const value = load(readFileSync(runtimeFile, 'utf8'));
  value.userAuth.allowedRedirectUris = [`${scheme}://dashboard.example.test/auth/callback`];
  value.oidc = enabled ? {
    enabled: true, callbackBaseUrl: `${scheme}://auth.example.test`,
    failureRedirectUri: value.userAuth.allowedRedirectUris[0],
    clients: [{ key: 'cognito-b', versionId: 'b'.repeat(32) }, { key: 'cognito-a', versionId: 'a'.repeat(32) }],
  } : { enabled: false, clients: [{ key: 'cognito-a' }] };
  return value;
}

function invoke(document: any, image = enrollmentImage, dashboard = dashboardImage, runtimeText = readFileSync(runtimeFile, 'utf8'),
  extra: { gateway?: string; bootstrap?: string; nodes?: string } = {}) {
  const temp = mkdtempSync(join(tmpdir(), 'eks-values-test-'));
  const source = join(temp, 'outputs.json');
  const dir = join(temp, 'values');
  writeFileSync(source, JSON.stringify(document));
  const runtime = join(temp, 'runtime.yaml');
  writeFileSync(runtime, runtimeText);
  const bootstrap = join(temp, 'bootstrap.json');
  writeFileSync(bootstrap, extra.bootstrap ?? readFileSync(bootstrapFile, 'utf8'));
  const nodes = join(temp, 'nodes.json');
  writeFileSync(nodes, extra.nodes ?? readFileSync(resolve(__dirname, 'fixtures/msk-nodes.json'), 'utf8'));
  const result = spawnSync(process.execPath, [
    join(root, 'scripts/eks-values.mjs'), '--outputs', source, '--output-dir', dir,
    '--enrollment-image', image, '--ingest-image', ingestImage, '--dashboard-image', dashboard,
    '--gateway-image', extra.gateway ?? gatewayImage, '--runtime-values', runtime, '--msk-bootstrap', bootstrap, '--msk-nodes', nodes,
  ], { cwd: root, encoding: 'utf8' });
  return { temp, dir, result, read: (file: string) => load(readFileSync(join(dir, file), 'utf8')) };
}

describe('배포 output→values 변환', () => {
  const temps: string[] = [];
  afterEach(() => { for (const temp of temps.splice(0)) rmSync(temp, { recursive: true, force: true }); });
  const run = (document: any, image?: string, dashboard?: string, runtimeText?: string, extra?: { gateway?: string; bootstrap?: string; nodes?: string }) => { const output = invoke(document, image, dashboard, runtimeText, extra); temps.push(output.temp); return output; };

  test('새 HTTPS origin과 OIDC 복귀를 전달하면서 기존 issuer·키·localhost를 보존한다', () => {
    const source = oidcOutputs();
    source.DevEdgeStack.ValidationPublicBaseUrl = 'https://api-dev.pulsemetry.co.kr';
    const runtime = oidcRuntime();
    runtime.userAuth.allowedOrigins = ['http://localhost:3000', 'https://dev.pulsemetry.co.kr'];
    runtime.userAuth.allowedRedirectUris = ['http://localhost:3000/auth/callback', 'https://dev.pulsemetry.co.kr/auth/callback'];
    runtime.oidc.callbackBaseUrl = source.DevEdgeStack.ValidationPublicBaseUrl;
    runtime.oidc.failureRedirectUri = 'https://dev.pulsemetry.co.kr/auth/callback';
    const output = run(source, undefined, undefined, dump(runtime));
    expect(output.result.status).toBe(0);
    const enrollment = output.read('enrollment-api.yaml');
    const dashboard = output.read('dashboard-api.yaml');
    expect(enrollment.env.PULSEMETRY_PUBLIC_BASE_URL).toBe(source.DevEdgeStack.ValidationPublicBaseUrl);
    expect(enrollment.oidc.callbackBaseUrl).toBe(source.DevEdgeStack.ValidationPublicBaseUrl);
    expect(enrollment.oidc.failureRedirectUri).toBe(runtime.oidc.failureRedirectUri);
    expect(enrollment.userAuth.allowedRedirectUris).toEqual(runtime.userAuth.allowedRedirectUris);
    for (const app of [enrollment, dashboard]) {
      expect(app.userAuth.allowedOrigins).toEqual(runtime.userAuth.allowedOrigins);
      expect(app.userAuth.issuer).toBe(runtime.userAuth.issuer);
      expect(app.jwt.publicVersionId).toBe(runtime.userAuth.publicVersionId);
    }
    expect(enrollment.jwt.privateVersionId).toBe(runtime.userAuth.privateVersionId);
    expect(dashboard.oidc).toBeUndefined();
    expect(dashboard.env.PULSEMETRY_PUBLIC_BASE_URL).toBeUndefined();
    // 동일 입력의 재생성으로 전체 values가 달라지지 않는지 확인한다.
    const repeated = run(source, undefined, undefined, dump(runtime));
    expect(repeated.result.status).toBe(0);
    for (const file of readdirSync(output.dir)) expect(repeated.read(file)).toEqual(output.read(file));
  });

  helmTest('새 도메인의 두 앱 CORS와 enrollment 전용 callback을 실제 manifest로 검증한다', () => {
    const source = oidcOutputs();
    source.DevEdgeStack.ValidationPublicBaseUrl = 'https://api-dev.pulsemetry.co.kr';
    const runtime = oidcRuntime();
    runtime.userAuth.allowedOrigins = ['https://dev.pulsemetry.co.kr', 'http://localhost:3000'];
    runtime.userAuth.allowedRedirectUris = ['https://dev.pulsemetry.co.kr/auth/callback'];
    runtime.oidc.callbackBaseUrl = source.DevEdgeStack.ValidationPublicBaseUrl;
    runtime.oidc.failureRedirectUri = runtime.userAuth.allowedRedirectUris[0];
    const output = run(source, undefined, undefined, dump(runtime));
    expect(output.result.status).toBe(0);
    for (const app of ['enrollment-api', 'dashboard-api']) {
      const result = spawnSync(process.env.HELM_BIN!, ['template', app,
        join(root, 'helm/dev/workloads/spring-app'), '--kube-version', '1.36.0', '-n', 'pulsemetry-dev', '-f', join(root, `helm/dev/workloads/${app}.yaml`),
        '-f', join(output.dir, `${app}.yaml`)], { encoding: 'utf8' });
      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
      const resources = require('js-yaml').loadAll(result.stdout);
      const entries = resources.find((item: any) => item?.kind === 'Deployment').spec.template.spec.containers[0].env;
      expect(new Set(entries.map((item: any) => item.name)).size).toBe(entries.length);
      const env = Object.fromEntries(entries.map((item: any) => [item.name, item.value]));
      expect(env.PULSEMETRY_USER_AUTH_ALLOWED_ORIGINS).toBe(runtime.userAuth.allowedOrigins.join(','));
      expect(env.PULSEMETRY_USER_AUTH_ISSUER).toBe(runtime.userAuth.issuer);
      if (app === 'enrollment-api') {
        expect(env.PULSEMETRY_PUBLIC_BASE_URL).toBe(source.DevEdgeStack.ValidationPublicBaseUrl);
        expect(env.PULSEMETRY_OIDC_CALLBACK_BASE_URL).toBe(source.DevEdgeStack.ValidationPublicBaseUrl);
        expect(env.PULSEMETRY_OIDC_FAILURE_REDIRECT_URI).toBe(runtime.oidc.failureRedirectUri);
        expect(env.PULSEMETRY_USER_AUTH_ALLOWED_REDIRECT_URIS).toBe(runtime.userAuth.allowedRedirectUris.join(','));
      } else {
        expect(env.PULSEMETRY_OIDC_CALLBACK_BASE_URL).toBeUndefined();
        expect(env.PULSEMETRY_USER_AUTH_ALLOWED_REDIRECT_URIS).toBeUndefined();
      }
    }
  });

  test.each([
    'https://api.example.test/', 'https://api.example.test/path', 'https://api.example.test?next=x',
    'https://api.example.test#fragment', 'https://user:password@api.example.test',
    'https://api.example.test:443', 'https://api.example.test:8443', 'ftp://api.example.test',
    'https://api.example.test\\@other.test', 'https://api.example.test\n',
  ])('공개 origin에 부적절한 URL을 거부한다: %s', value => {
    const source = outputs();
    source.DevEdgeStack.ValidationPublicBaseUrl = value;
    const output = run(source);
    expect(output.result.status).not.toBe(0);
    expect(output.result.stderr).toContain('ValidationPublicBaseUrl');
  });

  test.each(['eks_validation', 'eks'])('%s prefix가 IAM output과 일치하며 immutable image를 전달한다', prefix => {
    const output = run(outputs(prefix));
    expect(output.result.status).toBe(0);
    expect(readdirSync(output.dir).sort()).toEqual(['ascp.yaml', 'base.yaml', 'clickhouse.yaml', 'dashboard-api.yaml', 'enrollment-api.yaml', 'fluent-bit.yaml', 'lbc.yaml', 'observability.yaml', 'runtime.yaml', 'telemetry-gateway.yaml', 'telemetry-ingest.yaml', 'telemetry-kafka-admin.yaml']);
    expect(output.read('base.yaml')).toEqual({
      nodeRoleName: 'soma-376-dev-eks-node', subnetIds: ['subnet-0123456789abcdef0', 'subnet-0123456789abcdef1'],
      appNodeSecurityGroupId: 'sg-0123456789abcdef0', clickhouseNodeSecurityGroupId: 'sg-0123456789abcdef1', clickhouseAvailabilityZone: 'ap-northeast-2a', observabilityNodeSecurityGroupId: 'sg-0123456789abcdef2',
    });
    expect(output.read('lbc.yaml')).toEqual({ clusterName: 'soma-376-dev-eks', region: 'ap-northeast-2', vpcId: 'vpc-0123456789abcdef0' });
    expect(output.read('clickhouse.yaml')).toEqual({ availabilityZone: 'ap-northeast-2a', observability: { enabled: true } });
    const ingest = output.read('telemetry-ingest.yaml');
    const enrollment = output.read('enrollment-api.yaml');
    const dashboard = output.read('dashboard-api.yaml');
    expect(dashboard.image).toEqual({ repository: repository + 'dashboard-api', digest });
    expect(dashboard.nodePort).toBe(30081);
    expect(dashboard.env.PULSEMETRY_DASHBOARD_PORT).toBe('8081');
    expect(dashboard.env.PULSEMETRY_DASHBOARD_RDS_SOURCE_URL).toBe(dashboard.env.PULSEMETRY_DASHBOARD_RDS_CACHE_URL);
    expect(dashboard.env.PULSEMETRY_DASHBOARD_CLICKHOUSE_SOURCE_URL).toBe(dashboard.env.PULSEMETRY_DASHBOARD_CLICKHOUSE_CACHE_URL);
    expect(dashboard.jwt.publicKeys).toHaveLength(1);
    expect(dashboard.jwt.privateVersionId).toBeUndefined();
    expect(dashboard.jwt.activeKid).toBeUndefined();
    expect(dashboard.runtime.enabled).toBe(true);
    expect(dashboard.runtime.requiredFiles).toHaveLength(8);
    expect(dashboard.targetGroupBindings).toEqual([{ stage: 'validation', targetGroupARN: tg('dashboard-v'), confirmExclusiveOwnership: true }]);
    expect(ingest.env.PULSEMETRY_ARCHIVE_PREFIX).toBe(prefix);
    expect(ingest.env.PULSEMETRY_DB_URL).toBe('jdbc:postgresql://database.example.test:5432/controlplane');
    expect(ingest.image).toEqual({ repository: repository + 'telemetry-ingest', digest });
    expect(enrollment.runtime.requiredFiles).toContain('PULSEMETRY_ADMIN_API_TOKEN');
    expect(ingest.runtime.requiredFiles).not.toContain('PULSEMETRY_ADMIN_API_TOKEN');
    for (const app of [ingest, enrollment]) {
      expect(Object.keys(app.env)).not.toEqual(expect.arrayContaining(['PULSEMETRY_DB_USERNAME', 'PULSEMETRY_DB_PASSWORD']));
      expect(app.env.PULSEMETRY_TOKEN_HASH_SECRET).toBeUndefined();
      expect(app.env.SPRING_CONFIG_IMPORT).toBeUndefined();
      expect(app.env.PULSEMETRY_ADMIN_API_TOKEN).toBeUndefined();
    }
    expect(output.read('runtime.yaml').secrets).toEqual({ dbArn: secret('db'), tokenHashArn: secret('hmac'), adminApiTokenArn: secret('admin'), dashboardRdsSourceArn: secret('dashboard-rds-source'), dashboardRdsCacheArn: secret('dashboard-rds-cache'), dashboardClickHouseSourceArn: secret('dashboard-ch-source'), dashboardClickHouseCacheArn: secret('dashboard-ch-cache'), userJwtPrivateKeyArn: secret('jwt-private'), userJwtPublicKeysArn: secret('jwt-public'),
      telemetryJwtPrivateKeyArn: secret('soma-376/dev/telemetry-jwt/private-key'), telemetryJwtPublicKeysArn: secret('soma-376/dev/telemetry-jwt/public-keys') });
    const kafkaAdmin = output.read('telemetry-kafka-admin.yaml');
    expect(kafkaAdmin).toEqual({ region: 'ap-northeast-2', bootstrapServers: brokers, stage: stage(prefix),
      topic: `pulsemetry-dev-telemetry-ingress-${stage(prefix)}`, consumerGroup: `pulsemetry-dev-telemetry-ingest-${stage(prefix)}`,
      topicAdmin: { roleArn: mskRole('TopicAdmin'), sessionName: 'pulsemetry-dev-telemetry-kafka-admin' },
      offsetAdmin: { roleArn: mskRole('OffsetAdmin'), sessionName: 'pulsemetry-dev-telemetry-kafka-offsets' } });
    expect(output.read('telemetry-gateway.yaml').kafka.topic).toBe(kafkaAdmin.topic);
    expect(output.read('runtime.yaml').userAuth.publicVersionId).toBe(enrollment.jwt.publicVersionId);
    expect(output.read('runtime.yaml').userAuth.publicKeys).toEqual(dashboard.jwt.publicKeys);
    expect(enrollment.targetGroupBindings).toEqual([{ stage: 'validation', targetGroupARN: tg('enroll-v'), confirmExclusiveOwnership: true }]);
  });

  test('CloudFormation describe-stacks output도 지원한다', () => {
    const source = outputs();
    const document = { Stacks: Object.entries(source).map(([StackName, values]) => ({ StackName, Outputs: Object.entries(values).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })) })) };
    expect(run(document).result.status).toBe(0);
  });

  test('공개 TG 삭제 전의 CDK output을 받아도 ClickHouse TG와 URL을 소비하지 않는다', () => {
    const source = outputs();
    const previous = { ...source, DevEdgeStack: { ...source.DevEdgeStack,
      ValidationClickhouseTargetGroupArn: tg('ch-v'),
      ValidationClickhouseUrl: 'http://validation-alb.example.test:8123',
    } };
    const current = run(source), old = run(previous);
    expect(current.result.status).toBe(0);
    expect(old.result.status).toBe(0);
    for (const filename of readdirSync(current.dir)) {
      expect(old.read(filename)).toEqual(current.read(filename));
    }
  });

  test('OIDC는 CDK 원본의 부분집합을 정렬하고 enrollment에만 고정 버전·alias를 전달한다', () => {
    const output = run(oidcOutputs(), enrollmentImage, dashboardImage, dump(oidcRuntime()));
    expect(output.result.status).toBe(0);
    const enrollment = output.read('enrollment-api.yaml');
    const oidc = enrollment.oidc;
    expect(oidc.callbackRegistrationId).toBe('oidc');
    expect(oidc.clients).toEqual([
      { key: 'cognito-a', versionId: 'a'.repeat(32), alias: 'PULSEMETRY_OIDC_CLIENT_SECRET_0', secretArn: oidcArn('cognito-a') },
      { key: 'cognito-b', versionId: 'b'.repeat(32), alias: 'PULSEMETRY_OIDC_CLIENT_SECRET_1', secretArn: oidcArn('cognito-b') },
    ]);
    expect(output.read('runtime.yaml').oidc).toEqual(oidc);
    expect(enrollment.userAuth.allowedRedirectUris).toEqual(oidcRuntime().userAuth.allowedRedirectUris);
    expect(enrollment.runtime.requiredFiles.slice(-2)).toEqual(oidc.clients.map((client: any) => client.alias));
    expect(JSON.stringify(enrollment)).not.toContain(oidcArn('unused'));
    expect(Object.keys(enrollment.env).some(name => name.startsWith('PULSEMETRY_OIDC'))).toBe(false);
    for (const app of ['dashboard-api', 'telemetry-ingest']) {
      expect(output.read(`${app}.yaml`).oidc).toBeUndefined();
      expect(JSON.stringify(output.read(`${app}.yaml`))).not.toContain('OIDC_CLIENT_SECRET');
    }
  });

  test('비활성 OIDC는 빈 원본의 ARN output·VersionId 없이 기존 필수 파일을 유지한다', () => {
    const input = oidcRuntime(false);
    input.oidc.allowInsecureLocalhost = true;
    const output = run(outputs(), enrollmentImage, dashboardImage, dump(input));
    expect(output.result.status).toBe(0);
    expect(output.read('runtime.yaml').oidc).toEqual({ enabled: false });
    expect(output.read('enrollment-api.yaml').oidc).toEqual({ enabled: false });
    expect(output.read('enrollment-api.yaml').runtime.requiredFiles).toHaveLength(4);
    expect(JSON.stringify(output.read('runtime.yaml'))).not.toContain('cognito-a');
  });

  test('HTTP OIDC 입력을 그대로 전달하며 backend의 local 예외를 자동 활성화하지 않는다', () => {
    const input = oidcRuntime(true, 'http');
    const output = run(oidcOutputs(), enrollmentImage, dashboardImage, dump(input));
    expect(output.result.status).toBe(0);
    const runtime = output.read('runtime.yaml');
    const enrollment = output.read('enrollment-api.yaml');
    expect(runtime.oidc.callbackBaseUrl).toBe(input.oidc.callbackBaseUrl);
    expect(runtime.oidc.failureRedirectUri).toBe(input.oidc.failureRedirectUri);
    expect(enrollment.oidc).toEqual(runtime.oidc);
    expect(enrollment.userAuth.allowedRedirectUris).toEqual(input.userAuth.allowedRedirectUris);
    expect(enrollment.oidc.allowInsecureLocalhost).toBe(false);
    expect(enrollment.env.PULSEMETRY_OIDC_ALLOW_INSECURE_LOCALHOST).toBeUndefined();
    expect(enrollment.env.SPRING_PROFILES_ACTIVE).toBeUndefined();
  });

  test.each([undefined, false, true])('localhost 예외 %j를 runtime과 enrollment에만 boolean으로 전달한다', value => {
    const input = oidcRuntime();
    if (value !== undefined) input.oidc.allowInsecureLocalhost = value;
    const output = run(oidcOutputs(), enrollmentImage, dashboardImage, dump(input));
    expect(output.result.status).toBe(0);
    for (const app of ['runtime', 'enrollment-api']) {
      expect(output.read(`${app}.yaml`).oidc.allowInsecureLocalhost).toBe(value ?? false);
    }
    for (const app of ['dashboard-api', 'telemetry-ingest']) {
      expect(output.read(`${app}.yaml`).oidc).toBeUndefined();
      expect(JSON.stringify(output.read(`${app}.yaml`))).not.toContain('allowInsecureLocalhost');
    }
  });

  test.each(['true', 'false', null, 0, 1, [], {}])('localhost 예외의 boolean이 아닌 입력 %j를 파일 생성 전에 거부한다', value => {
    const input = oidcRuntime();
    input.oidc.allowInsecureLocalhost = value;
    const output = run(oidcOutputs(), enrollmentImage, dashboardImage, dump(input));
    expect(output.result.status).toBe(1);
    expect(existsSync(output.dir)).toBe(false);
    expect(output.result.stderr).toContain('oidc.allowInsecureLocalhost');
  });

  helmTest('HTTP callback·실패 복귀·허용 복귀 주소로 runtime과 enrollment를 render한다', () => {
    const output = run(oidcOutputs(), enrollmentImage, dashboardImage, dump(oidcRuntime(true, 'http')));
    expect(output.result.status).toBe(0);
    for (const app of ['runtime', 'enrollment-api']) {
      const files = app === 'runtime' ? [join(output.dir, 'runtime.yaml')]
        : ['helm/dev/workloads/enrollment-api.yaml', join(output.dir, 'enrollment-api.yaml')];
      const result = spawnSync(process.env.HELM_BIN!, ['template', app,
        app === 'runtime' ? 'helm/dev/runtime/chart' : 'helm/dev/workloads/spring-app',
        '--namespace', 'pulsemetry-dev', '--kube-version', '1.36.0', ...files.flatMap(file => ['-f', file])], { cwd: root, encoding: 'utf8' });
      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain('PULSEMETRY_OIDC_ALLOW_INSECURE_LOCALHOST');
      expect(result.stdout).not.toContain('SPRING_PROFILES_ACTIVE');
      if (app === 'enrollment-api') {
        const deployment = result.stdout.split(/^---\s*$/m).filter(text => text.trim()).map(text => load(text)).find((doc: any) => doc.kind === 'Deployment');
        const env = Object.fromEntries(deployment.spec.template.spec.containers[0].env.map((item: any) => [item.name, item.value]));
        expect(env.PULSEMETRY_OIDC_CALLBACK_BASE_URL).toBe('http://auth.example.test');
        expect(env.PULSEMETRY_OIDC_FAILURE_REDIRECT_URI).toBe('http://dashboard.example.test/auth/callback');
        expect(env.PULSEMETRY_USER_AUTH_ALLOWED_REDIRECT_URIS).toBe('http://dashboard.example.test/auth/callback');
        expect(JSON.parse(env.SPRING_APPLICATION_JSON as string).pulsemetry.oidc['allow-insecure-localhost']).toBe(false);
      }
    }
  });

  test('OIDC output의 미선언 key·잘못된 계정/리전/소유 경로·중복·기존 Secret 충돌을 거부한다', () => {
    for (const change of [
      (source: any) => { delete source.DevDataStack.OidcClientSecretArns; },
      (source: any) => { source.DevDataStack.OidcClientSecretArns = '[]'; },
      (source: any) => { source.DevDataStack.OidcClientSecretArns = '{}'; },
      (source: any) => { source.DevDataStack.OidcClientSecretArns = '{"cognito-a":"a","cognito-a":"b"}'; },
      (source: any) => { source.DevDataStack.OidcClientSecretArns = source.DevDataStack.OidcClientSecretArns.replaceAll('111111111111', '222222222222'); },
      (source: any) => { source.DevDataStack.OidcClientSecretArns = source.DevDataStack.OidcClientSecretArns.replaceAll('ap-northeast-2', 'us-east-1'); },
      (source: any) => { source.DevDataStack.OidcClientSecretArns = source.DevDataStack.OidcClientSecretArns.replaceAll('/dev/', '/prod/'); },
      (source: any) => { source.DevDataStack.OidcClientSecretArns = JSON.stringify({ 'cognito-a': oidcArn('cognito-b'), 'cognito-b': oidcArn('cognito-b') }); },
      (source: any) => { source.DevEksStack.TokenHashSecretArn = oidcArn('cognito-a'); },
    ]) {
      const source = oidcOutputs(); change(source);
      const output = run(source, enrollmentImage, dashboardImage, dump(oidcRuntime()));
      expect(output.result.status).toBe(1);
      expect(existsSync(output.dir)).toBe(false);
    }
  });

  test.each(['registry.example/app:latest', 'registry.example/app@sha256:abcd'])('mutable 또는 잘못된 image %s는 파일 생성 전 거절한다', invalid => {
    const output = run(outputs(), invalid);
    expect(output.result.status).toBe(1);
    expect(output.result.stderr).toContain('이미지가 필요하다');
  });

  test('dashboard 이미지도 immutable digest만 허용한다', () => {
    const output = run(outputs(), enrollmentImage, 'registry.example/dashboard:latest');
    expect(output.result.status).toBe(1);
    expect(output.result.stderr).toContain('dashboard image');
  });

  test('필수 output 누락·미합성 token·중복값 충돌·prefix 확대를 거절한다', () => {
    for (const change of [
      (source: any) => { delete source.DevEksStack.DbSecretArn; },
      (source: any) => { delete source.DevEksStack.EksDashboardApiNodePort; },
      (source: any) => { delete source.DevEksStack.UserJwtPublicKeysSecretArn; },
      (source: any) => { delete source.DevEdgeStack.ValidationDashboardApiTargetGroupArn; },
      (source: any) => { source.DevEdgeStack.ValidationDashboardApiTargetGroupArn = source.DevEdgeStack.ValidationEnrollmentApiTargetGroupArn; },
      (source: any) => { source.DevEksStack.UserJwtPublicKeysSecretArn = source.DevEksStack.UserJwtPrivateKeySecretArn; },
      (source: any) => { source.DevEksStack.EksDashboardApiNodePort = '30080'; },
      (source: any) => { source.DevEksStack.DbEndpoint = '${Token[TOKEN.42]}'; },
      (source: any) => { source.DevEdgeStack.EksClusterName = 'another-cluster'; },
      (source: any) => { source.DevEksStack.ArchivePrefix = '*'; },
      (source: any) => { source.DevEksStack.EksNodeRoleName = 'arn:aws:iam::111111111111:role/node'; },
      (source: any) => { source.DevEdgeStack.ValidationTelemetryGatewayTargetGroupArn = source.DevEdgeStack.ValidationEnrollmentApiTargetGroupArn; },
    ]) {
      const source = outputs(); change(source);
      expect(run(source).result.status).toBe(1);
    }
  });

  helmTest('생성 values와 runtime SPC·workload 차트를 함께 render한다', () => {
    const helm = process.env.HELM_BIN!;
    const output = run(outputs());
    const render = (release: string, chart: string, files: string[]) => {
      const result = spawnSync(helm, ['template', release, chart, '--namespace', 'pulsemetry-dev', '--kube-version', '1.36.0', ...files.flatMap(path => ['-f', path])], { cwd: root, encoding: 'utf8' });
      expect(result.status).toBe(0);
      return result.stdout;
    };
    const runtime = render('pulsemetry-runtime', 'helm/dev/runtime/chart', [join(output.dir, 'runtime.yaml')]);
    const documents = runtime.split(/^---\s*$/m).filter(text => text.trim()).map(text => load(text));
    expect(documents).toHaveLength(8);
    const enrollment = documents.find(doc => doc.metadata.name === 'enrollment-api-runtime');
    const ingest = documents.find(doc => doc.metadata.name === 'telemetry-ingest-runtime');
    const objects = (doc: any) => load(doc.spec.parameters.objects);
    expect(objects(enrollment)).toHaveLength(3);
    expect(objects(ingest)).toHaveLength(2);
    expect(JSON.stringify(ingest)).not.toContain(secret('admin'));
    expect(ingest.spec.parameters.usePodIdentity).toBe('true');
    expect(enrollment.spec.secretObjects).toBeUndefined();
    for (const app of ['enrollment-api', 'telemetry-ingest']) {
      const text = render(app, 'helm/dev/workloads/spring-app', [`helm/dev/workloads/${app}.yaml`, join(output.dir, `${app}.yaml`)]);
      expect(text).toContain('configtree:/mnt/secrets-store/');
      expect(text).toContain(`${app}-runtime`);
      expect(text).not.toContain('secretKeyRef:');
      expect(text).not.toContain('name: PULSEMETRY_DB_PASSWORD');
    }
    const dashboard = render('dashboard-api', 'helm/dev/workloads/spring-app', ['helm/dev/workloads/dashboard-api.yaml', join(output.dir, 'dashboard-api.yaml')]);
    expect(dashboard).toContain('containerPort: 8081');
    expect(dashboard).toContain('nodePort: 30081');
    expect(dashboard).toContain('kind: TargetGroupBinding');
    expect(dashboard).toContain('dashboard-api-jwt');
    expect(dashboard).not.toContain('private.pem');
    expect(dashboard).not.toContain('PULSEMETRY_TOKEN_HASH_SECRET');
    expect(dashboard).not.toContain('PULSEMETRY_ADMIN_API_TOKEN');
    const pod = dashboard.split(/^---\s*$/m).filter(text => text.trim()).map(text => load(text)).find((doc: any) => doc?.kind === 'Deployment').spec.template.spec;
    expect(pod.securityContext.runAsUser).toBe(10001);
    expect(pod.volumes).toHaveLength(3);
    expect(pod.containers[0].volumeMounts.every((mount: any) => mount.readOnly)).toBe(true);
    expect(pod.initContainers[0].volumeMounts).toEqual(pod.containers[0].volumeMounts.filter((mount: any) => mount.name !== 'blocked-certs'));
    expect(pod.initContainers[0].args[0]).toContain('head -c 1');
    const authEnv = pod.containers[0].env.find((env: any) => env.name === 'SPRING_APPLICATION_JSON');
    expect(JSON.parse(authEnv.value).pulsemetry['user-auth']['public-key-files']).toEqual({ '[release-2026.10]': '/mnt/user-jwt/keys/release-2026-10.pem' });
    const clickhouse = render('clickhouse', 'helm/dev/workloads/clickhouse', [join(output.dir, 'clickhouse.yaml')]);
    expect(clickhouse).not.toContain('kind: TargetGroupBinding');
    expect(clickhouse).toContain('kind: StatefulSet');
    expect(clickhouse).toContain('type: ClusterIP');
    render('pulsemetry-base', 'helm/dev/platform/base', [join(output.dir, 'base.yaml')]);
  });

  helmTest('ClickHouse의 폐기한 Helm 입력은 빈 값이라도 거부한다', () => {
    const output = run(outputs());
    expect(output.result.status).toBe(0);
    for (const obsolete of [
      { targetGroupBindings: [] },
      { targetGroupBindings: [{ stage: 'validation', targetGroupARN: tg('ch-v'), confirmExclusiveOwnership: true }] },
      { vpcId: '' },
      { vpcId: 'vpc-0123456789abcdef0' },
    ]) {
      const values = join(output.temp, 'old-clickhouse.yaml');
      writeFileSync(values, dump({ ...output.read('clickhouse.yaml'), ...obsolete }));
      const result = spawnSync(process.env.HELM_BIN!, ['template', 'clickhouse', 'helm/dev/workloads/clickhouse',
        '--namespace', 'pulsemetry-dev', '--kube-version', '1.36.0', '-f', values], { cwd: root, encoding: 'utf8' });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/additional propert/i);
      expect(result.stderr).toContain(Object.keys(obsolete)[0]);
    }
  });

  test('YAML 중복·알 수 없는 필드·비밀·잘못된 버전/alias/kid는 파일 생성 전에 거부한다', () => {
    const good = readFileSync(runtimeFile, 'utf8');
    const invalid = [good + '\nuserAuth: {}\n', good + '\nwriterImage: unused\n', good + '\nsecrets: {dbArn: forbidden}\n'];
    for (const change of [
      (value: any) => { value.userAuth.publicVersionId = 'AWSCURRENT'; },
      (value: any) => { value.userAuth.publicKeys[0].alias = '../escape.pem'; },
      (value: any) => { value.userAuth.publicKeys[0].alias = 'private.pem'; },
      (value: any) => { value.userAuth.publicKeys.push({ ...value.userAuth.publicKeys[0] }); },
      (value: any) => { value.userAuth.activeKid = 'missing'; },
      (value: any) => { value.dashboard.settings.PULSEMETRY_DASHBOARD_RDS_SOURCE_PASSWORD = 'forbidden'; },
      (value: any) => { value.dashboard.settings.PULSEMETRY_DASHBOARD_RDS_SOURCE_URL = 'forbidden'; },
    ]) { const value = load(good); change(value); invalid.push(dump(value)); }
    for (const text of invalid) {
      const output = run(outputs(), enrollmentImage, dashboardImage, text);
      expect(output.result.status).toBe(1);
      expect(existsSync(output.dir)).toBe(false);
      expect(output.result.stderr).not.toContain('forbidden');
    }
  });

  test('OIDC 원문·ARN override·누락 버전·지원하지 않는 callback scheme은 입력 단계에서 거부한다', () => {
    for (const change of [
      (value: any) => { value.oidc.clients[0].secretArn = oidcArn('cognito-b'); },
      (value: any) => { value.oidc.clients[0].clientSecret = 'forbidden-oidc-value'; },
      (value: any) => { delete value.oidc.clients[0].versionId; },
      (value: any) => { value.oidc.clients[0].versionId = 'AWSCURRENT'; },
      (value: any) => { value.oidc.clients.push({ ...value.oidc.clients[0] }); },
      (value: any) => { value.oidc.callbackBaseUrl = 'ftp://validation-alb.example.test'; },
      (value: any) => { value.oidc.callbackBaseUrl = 'https://auth.example.test?'; },
      (value: any) => { value.oidc.callbackBaseUrl = 'https://auth.example.test#'; },
      (value: any) => { value.oidc.callbackBaseUrl = 'https://auth..example.test'; },
      (value: any) => { value.oidc.callbackBaseUrl = 'https://auth.-example.test'; },
      (value: any) => { value.oidc.callbackBaseUrl = 'https://auth.example-.test'; },
      (value: any) => { value.oidc.callbackBaseUrl = 'https://auth.example.test\\'; },
      (value: any) => { value.oidc.failureRedirectUri = 'https://unlisted.example.test/callback'; },
      (value: any) => { delete value.userAuth.allowedRedirectUris; },
    ]) {
      const value = oidcRuntime(); change(value);
      const output = run(oidcOutputs(), enrollmentImage, dashboardImage, dump(value));
      expect(output.result.status).toBe(1);
      expect(existsSync(output.dir)).toBe(false);
      expect(output.result.stderr).not.toContain('forbidden-oidc-value');
    }
  });

  helmTest('OIDC 고정 버전 SPC와 정확한 맵·필수 파일·rollout 변경을 검증한다', () => {
    const output = run(oidcOutputs(), enrollmentImage, dashboardImage, dump(oidcRuntime()));
    expect(output.result.status).toBe(0);
    const rendered = (chart: string, value: any, workload = 'enrollment-api') => {
      const filename = join(output.temp, 'render-values.yaml');
      writeFileSync(filename, dump(value));
      return spawnSync(process.env.HELM_BIN!, ['template', workload, chart, '--namespace', 'pulsemetry-dev', '--kube-version', '1.36.0',
        ...(chart.includes('spring-app') ? ['-f', `helm/dev/workloads/${workload}.yaml`] : []), '-f', filename], { cwd: root, encoding: 'utf8' });
    };
    const documents = (text: string) => text.split(/^---\s*$/m).filter(text => text.trim()).map(text => load(text));
    const runtime = output.read('runtime.yaml');
    const runtimeResult = rendered('helm/dev/runtime/chart', runtime);
    expect(runtimeResult.status).toBe(0);
    const spcs = documents(runtimeResult.stdout);
    expect(spcs).toHaveLength(8);
    const enrollmentSpc = spcs.find((doc: any) => doc.metadata.name === 'enrollment-api-runtime');
    const objects = load(enrollmentSpc.spec.parameters.objects);
    expect(objects.slice(-2)).toEqual(runtime.oidc.clients.map((client: any) => ({
      objectName: client.secretArn, objectType: 'secretsmanager', objectVersion: client.versionId,
      objectAlias: client.alias, filePermission: '0444',
    })));
    expect(enrollmentSpc.spec.secretObjects).toBeUndefined();
    for (const spc of spcs.filter((doc: any) => doc.metadata.name !== 'enrollment-api-runtime')) {
      expect(JSON.stringify(spc)).not.toContain('/oidc/clients/');
    }
    const app = output.read('enrollment-api.yaml');
    const appResult = rendered('helm/dev/workloads/spring-app', app);
    expect(appResult.status).toBe(0);
    const deployment = documents(appResult.stdout).find((doc: any) => doc.kind === 'Deployment');
    const pod = deployment.spec.template.spec;
    const env = Object.fromEntries(pod.containers[0].env.map((item: any) => [item.name, item.value]));
    expect(env.PULSEMETRY_OIDC_ENABLED).toBe('true');
    expect(env.PULSEMETRY_OIDC_CALLBACK_BASE_URL).toBe(app.oidc.callbackBaseUrl);
    expect(env.PULSEMETRY_OIDC_FAILURE_REDIRECT_URI).toBe(app.oidc.failureRedirectUri);
    expect(env.PULSEMETRY_USER_AUTH_ALLOWED_REDIRECT_URIS).toBe(app.userAuth.allowedRedirectUris.join(','));
    const properties = JSON.parse(env.SPRING_APPLICATION_JSON as string).pulsemetry;
    expect(properties.oidc).toEqual({ 'callback-registration-id': 'oidc', 'allow-insecure-localhost': false, 'client-secrets': {
      '[cognito-a]': '${PULSEMETRY_OIDC_CLIENT_SECRET_0}', '[cognito-b]': '${PULSEMETRY_OIDC_CLIENT_SECRET_1}',
    } });
    expect(properties['user-auth']['public-key-files']).toEqual({ '[release-2026.10]': '/mnt/user-jwt/keys/release-2026-10.pem' });
    expect(pod.containers[0].env.some((item: any) => item.name.startsWith('PULSEMETRY_OIDC_CLIENT_SECRET_'))).toBe(false);
    // 사용자 JWT·OIDC·telemetry JWT 맵이 하나의 SPRING_APPLICATION_JSON에 함께 남는다.
    expect(Object.keys(properties).sort()).toEqual(['oidc', 'telemetry-jwt', 'user-auth']);
    expect(properties['telemetry-jwt']).toEqual({
      'public-key-files': { '[telemetry-2026.10]': '/mnt/telemetry-jwt/keys/telemetry-2026-10.pem' },
      'active-kid': 'telemetry-2026.10',
      'private-key-file': '/mnt/telemetry-jwt/keys/private.pem', 'issue-enabled': false,
    });
    expect(pod.containers[0].env.filter((item: any) => item.name === 'SPRING_APPLICATION_JSON')).toHaveLength(1);
    expect(pod.volumes.map((volume: any) => volume.name)).toEqual(['secrets-store', 'user-jwt', 'telemetry-jwt', 'blocked-certs']);
    expect(pod.initContainers[0].volumeMounts).toEqual(pod.containers[0].volumeMounts.filter((mount: any) => mount.name !== 'blocked-certs'));
    const blockedContents = readFileSync(join(root, 'helm/dev/workloads/spring-app/files/blocked.certs'), 'utf8');
    const annotations = deployment.spec.template.metadata.annotations;
    expect(annotations['pulsemetry.io/blocked-certs-revision']).toBe(createHash('sha256').update(blockedContents).digest('hex'));
    const copiedChart = join(output.temp, 'spring-app');
    cpSync(join(root, 'helm/dev/workloads/spring-app'), copiedChart, { recursive: true });
    // 임시 복사본의 주석만 바꿔 사용자 JWT·OIDC·telemetry JWT revision 보존을 확인한다.
    const updatedContents = `${blockedContents}# PROJ-253 rollout fixture\n`;
    writeFileSync(join(copiedChart, 'files/blocked.certs'), updatedContents);
    const changedFileResult = rendered(copiedChart, app);
    expect(changedFileResult.status).toBe(0);
    const changedFileDocuments = documents(changedFileResult.stdout);
    const changedFile = changedFileDocuments.find((doc: any) => doc.kind === 'Deployment');
    expect(changedFile.spec.template.metadata.annotations).toEqual({
      ...annotations, 'pulsemetry.io/blocked-certs-revision': createHash('sha256').update(updatedContents).digest('hex'),
    });
    expect(changedFileDocuments.find((doc: any) => doc.kind === 'ConfigMap').data['blocked.certs']).toBe(updatedContents);
    for (const allowInsecureLocalhost of [undefined, false, true]) {
      const input = oidcRuntime();
      if (allowInsecureLocalhost !== undefined) input.oidc.allowInsecureLocalhost = allowInsecureLocalhost;
      const generated = run(oidcOutputs(), enrollmentImage, dashboardImage, dump(input));
      expect(generated.result.status).toBe(0);
      expect(rendered('helm/dev/runtime/chart', generated.read('runtime.yaml')).status).toBe(0);
      const result = rendered('helm/dev/workloads/spring-app', generated.read('enrollment-api.yaml'));
      expect(result.status).toBe(0);
      const next = documents(result.stdout).find((doc: any) => doc.kind === 'Deployment');
      const json = next.spec.template.spec.containers[0].env.find((item: any) => item.name === 'SPRING_APPLICATION_JSON');
      expect(JSON.parse(json.value).pulsemetry.oidc['allow-insecure-localhost']).toBe(allowInsecureLocalhost ?? false);
    }
    // 새 필드가 없는 과거 generated values도 기본 false로 계속 렌더링한다.
    const legacyRuntime = JSON.parse(JSON.stringify(runtime));
    const legacyApp = JSON.parse(JSON.stringify(app));
    delete legacyRuntime.oidc.allowInsecureLocalhost;
    delete legacyApp.oidc.allowInsecureLocalhost;
    expect(rendered('helm/dev/runtime/chart', legacyRuntime).status).toBe(0);
    const legacyResult = rendered('helm/dev/workloads/spring-app', legacyApp);
    expect(legacyResult.status).toBe(0);
    const legacyDeployment = documents(legacyResult.stdout).find((doc: any) => doc.kind === 'Deployment');
    const legacyJson = legacyDeployment.spec.template.spec.containers[0].env.find((item: any) => item.name === 'SPRING_APPLICATION_JSON');
    expect(JSON.parse(legacyJson.value).pulsemetry.oidc['allow-insecure-localhost']).toBe(false);
    for (const invalid of ['true', 'false', null, 0, 1, [], {}]) {
      for (const [chart, value] of [['helm/dev/runtime/chart', runtime], ['helm/dev/workloads/spring-app', app]] as const) {
        const changed = JSON.parse(JSON.stringify(value));
        changed.oidc.allowInsecureLocalhost = invalid;
        const result = rendered(chart, changed);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('allowInsecureLocalhost');
      }
    }
    const revision = deployment.spec.template.metadata.annotations['pulsemetry.io/oidc-revision'];
    expect(revision).toMatch(/^[a-f0-9]{64}$/);
    for (const change of [
      (value: any) => { value.oidc.allowInsecureLocalhost = true; },
      (value: any) => { value.oidc.clients[0].versionId = 'c'.repeat(32); },
      (value: any) => { value.oidc.clients[0].secretArn = value.oidc.clients[0].secretArn.replace('abc123', 'def456'); },
      (value: any) => { value.oidc.clients[0].key = 'cognito-A'; value.oidc.clients[0].secretArn = oidcArn('cognito-A'); },
    ]) {
      const changed = JSON.parse(JSON.stringify(app)); change(changed);
      const result = rendered('helm/dev/workloads/spring-app', changed);
      expect(result.status).toBe(0);
      const next = documents(result.stdout).find((doc: any) => doc.kind === 'Deployment');
      expect(next.spec.template.metadata.annotations['pulsemetry.io/oidc-revision']).not.toBe(revision);
    }
    const files = join(output.temp, 'oidc-configtree'), keys = join(output.temp, 'oidc-keys'), telemetryKeys = join(output.temp, 'oidc-telemetry-keys');
    mkdirSync(files); mkdirSync(keys); mkdirSync(telemetryKeys);
    for (const file of app.runtime.requiredFiles) writeFileSync(join(files, file), 'synthetic-oidc-fixture');
    for (const file of [...app.jwt.publicKeys.map((entry: any) => entry.alias), 'private.pem']) writeFileSync(join(keys, file), 'synthetic-key-fixture');
    for (const file of [...app.telemetryJwt.publicKeys.map((entry: any) => entry.alias), 'private.pem']) writeFileSync(join(telemetryKeys, file), 'synthetic-key-fixture');
    const command = pod.initContainers[0].args[0].replaceAll('/mnt/secrets-store', files).replaceAll('/mnt/user-jwt/keys', keys)
      .replaceAll('/mnt/telemetry-jwt/keys', telemetryKeys);
    const check = () => spawnSync('/bin/sh', ['-ec', command], { encoding: 'utf8' });
    expect(check().status).toBe(0);
    for (const client of app.oidc.clients) {
      const path = join(files, client.alias);
      writeFileSync(path, ''); expect(check().status).not.toBe(0);
      rmSync(path); expect(check().status).not.toBe(0);
      writeFileSync(path, 'synthetic-oidc-fixture');
    }
    for (const change of [
      (value: any) => { value.env.PULSEMETRY_OIDC_CLIENT_SECRET_0 = 'forbidden'; },
      (value: any) => { value.env.PULSEMETRY_OIDC_ENABLED = 'true'; },
      (value: any) => { value.env.PULSEMETRY_OIDC_CLIENTSECRETS_COGNITOA = 'forbidden'; },
      (value: any) => { value.env.PULSEMETRY_USER_AUTH_ALLOWED_REDIRECT_URIS = 'https://bypass.example.test'; },
      (value: any) => { value.oidc.callbackBaseUrl = 'ftp://validation-alb.example.test'; },
      (value: any) => { value.oidc.callbackBaseUrl = 'https://auth.example.test?'; },
      (value: any) => { value.oidc.callbackBaseUrl = 'https://auth.example.test#'; },
      (value: any) => { value.oidc.callbackBaseUrl = 'https://auth..example.test'; },
      (value: any) => { value.oidc.callbackBaseUrl = 'https://auth.-example.test'; },
      (value: any) => { value.oidc.callbackBaseUrl = 'https://auth.example-.test'; },
      (value: any) => { value.oidc.callbackBaseUrl = 'https://auth.example.test\\'; },
      (value: any) => { value.oidc.callbackBaseUrl = 'https://auth.example.test '; },
      (value: any) => { value.oidc.failureRedirectUri = 'https://unlisted.example.test/callback'; },
      (value: any) => { value.oidc.failureRedirectUri = 'https://dashboard.example.test/callback?'; value.userAuth.allowedRedirectUris = [value.oidc.failureRedirectUri]; },
      (value: any) => { value.oidc.failureRedirectUri = 'https://dashboard.example.test/' + 'a'.repeat(256); value.userAuth.allowedRedirectUris = [value.oidc.failureRedirectUri]; },
      (value: any) => { value.oidc.clients[0].secretArn = oidcArn('another-client'); },
      (value: any) => { value.oidc.clients[0].alias = '../escape'; },
      (value: any) => { value.oidc.clients[0].versionId = 'AWSCURRENT'; },
      (value: any) => { value.oidc.clients[1].key = value.oidc.clients[0].key; },
      (value: any) => { value.oidc.enabled = false; },
      (value: any) => { value.runtime.enabled = false; },
      (value: any) => { value.jwt.enabled = false; },
      (value: any) => { value.runtime.requiredFiles.pop(); },
    ]) {
      const invalid = JSON.parse(JSON.stringify(app)); change(invalid);
      expect(rendered('helm/dev/workloads/spring-app', invalid).status).not.toBe(0);
    }
    for (const workload of ['dashboard-api', 'telemetry-ingest']) {
      const invalid = output.read(`${workload}.yaml`); invalid.oidc = app.oidc;
      expect(rendered('helm/dev/workloads/spring-app', invalid, workload).status).not.toBe(0);
    }
    for (const change of [
      (value: any) => { value.oidc.clients[0].secretArn = value.oidc.clients[0].secretArn.replace('111111111111', '222222222222'); },
      (value: any) => { value.oidc.clients[0].secretArn = oidcArn('another-client'); },
      (value: any) => { value.oidc.clients[1].alias = value.oidc.clients[0].alias; },
      (value: any) => { value.oidc.clients[1].key = value.oidc.clients[0].key; },
      (value: any) => { value.oidc.clients[0].versionId = 'AWSCURRENT'; },
      (value: any) => { value.secrets.tokenHashArn = value.oidc.clients[0].secretArn; },
      (value: any) => { value.oidc.enabled = false; },
    ]) {
      const invalid = JSON.parse(JSON.stringify(runtime)); change(invalid);
      expect(rendered('helm/dev/runtime/chart', invalid).status).not.toBe(0);
    }
    const disabled = run(outputs(), enrollmentImage, dashboardImage, dump(oidcRuntime(false)));
    const disabledResult = rendered('helm/dev/runtime/chart', disabled.read('runtime.yaml'));
    expect(disabledResult.status).toBe(0);
    expect(disabledResult.stdout).not.toContain('PULSEMETRY_OIDC_CLIENT_SECRET_');
    const disabledApp = rendered('helm/dev/workloads/spring-app', disabled.read('enrollment-api.yaml'));
    expect(disabledApp.status).toBe(0);
    expect(disabledApp.stdout).not.toContain('pulsemetry.io/oidc-revision');
    expect(disabledApp.stdout).not.toContain('client-secrets');
  });

  helmTest('인용이 필요한 kid의 추출 identifier와 파일 맵을 보존한다', () => {
    const value = load(readFileSync(runtimeFile, 'utf8'));
    const kid = 'release-2026.10/"quoted"';
    value.userAuth.activeKid = kid; value.userAuth.publicKeys[0].kid = kid;
    const output = run(outputs(), enrollmentImage, dashboardImage, dump(value));
    expect(output.result.status).toBe(0);
    const render = (app: string, chart: string, files: string[]) => spawnSync(process.env.HELM_BIN!, ['template', app, chart, '--namespace', 'pulsemetry-dev', '--kube-version', '1.36.0', ...files.flatMap(file => ['-f', file])], { cwd: root, encoding: 'utf8' });
    const runtime = render('runtime-config', 'helm/dev/runtime/chart', [join(output.dir, 'runtime.yaml')]);
    expect(runtime.status).toBe(0);
    const spcs = runtime.stdout.split(/^---\s*$/m).filter(text => text.trim()).map(text => load(text)).filter(Boolean);
    const publicObjects = load(spcs.find((doc: any) => doc.metadata.name === 'dashboard-api-jwt').spec.parameters.objects);
    expect(publicObjects).toHaveLength(1);
    expect(publicObjects[0].objectVersion).toBe(value.userAuth.publicVersionId);
    expect(publicObjects[0].objectVersionLabel).toBeUndefined();
    expect(publicObjects[0].jmesPath[0].path).toBe(JSON.stringify(kid));
    expect(publicObjects[0].jmesPath[0].objectAlias).toBe('release-2026-10.pem');
    const text = render('dashboard-api', 'helm/dev/workloads/spring-app', ['helm/dev/workloads/dashboard-api.yaml', join(output.dir, 'dashboard-api.yaml')]);
    expect(text.status).toBe(0);
    const pod = text.stdout.split(/^---\s*$/m).filter(text => text.trim()).map(text => load(text)).find((doc: any) => doc?.kind === 'Deployment').spec.template.spec;
    const env = pod.containers[0].env.find((env: any) => env.name === 'SPRING_APPLICATION_JSON');
    expect(JSON.parse(env.value).pulsemetry['user-auth']['public-key-files'][`[${kid}]`]).toBe('/mnt/user-jwt/keys/release-2026-10.pem');
    const files = join(output.temp, 'configtree'), keys = join(output.temp, 'keys');
    mkdirSync(files); mkdirSync(keys);
    const generated = output.read('dashboard-api.yaml');
    for (const file of generated.runtime.requiredFiles) writeFileSync(join(files, file), 'fixture-only');
    writeFileSync(join(keys, 'release-2026-10.pem'), 'fixture-only');
    const command = pod.initContainers[0].args[0].replaceAll('/mnt/secrets-store', files).replaceAll('/mnt/user-jwt/keys', keys);
    const check = () => spawnSync('/bin/sh', ['-ec', command], { encoding: 'utf8' });
    const good = check(); expect(good.status).toBe(0); expect(good.stdout).toBe(''); expect(good.stderr).toBe('');
    writeFileSync(join(keys, 'release-2026-10.pem'), ''); expect(check().status).not.toBe(0);
    writeFileSync(join(keys, 'release-2026-10.pem'), 'fixture-only');
    chmodSync(join(keys, 'release-2026-10.pem'), 0); expect(check().status).not.toBe(0);
    chmodSync(join(keys, 'release-2026-10.pem'), 0o600);
    rmSync(join(keys, 'release-2026-10.pem')); expect(check().status).not.toBe(0);
  });

});

describe('PROJ-246 Gateway·MSK·telemetry JWT values 생성', () => {
  const temps: string[] = [];
  afterEach(() => { for (const temp of temps.splice(0)) rmSync(temp, { recursive: true, force: true }); });
  const run = (document: any, runtimeText = readFileSync(runtimeFile, 'utf8'), extra: { gateway?: string; bootstrap?: string; nodes?: string } = {}) => {
    const output = invoke(document, enrollmentImage, dashboardImage, runtimeText, extra); temps.push(output.temp); return output;
  };
  const runtime = (change: (value: any) => void = () => {}) => { const value = load(readFileSync(runtimeFile, 'utf8')); change(value); return dump(value); };
  const telemetryKeys = [{ kid: 'telemetry-2026.10', alias: 'telemetry-2026-10.pem' }];
  const publicTelemetry = (workload: string) => ({ enabled: true, secretProviderClass: `${workload}-telemetry-jwt`,
    publicVersionId: '44444444-4444-4444-8444-444444444444', publicKeys: telemetryKeys });

  test('계약 상수는 CDK 상수와 같다', () => {
    const { DEV_EKS_NODE_PORTS, DEV_EKS_TELEMETRY_SESSION_NAMES } = require('../../lib/dev/eks-config');
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      "import { TELEMETRY_CONTRACT } from './scripts/eks-values.mjs'; console.log(JSON.stringify(TELEMETRY_CONTRACT));"], { cwd: root, encoding: 'utf8' });
    expect(result.status).toBe(0);
    const contract = JSON.parse(result.stdout);
    expect(contract.gatewayNodePort).toBe(String(DEV_EKS_NODE_PORTS.gateway));
    expect(contract.sessions).toEqual({
      MskGatewaySessionName: DEV_EKS_TELEMETRY_SESSION_NAMES.gateway, MskIngestSessionName: DEV_EKS_TELEMETRY_SESSION_NAMES.ingest,
      MskTopicAdminSessionName: DEV_EKS_TELEMETRY_SESSION_NAMES.topicAdmin, MskOffsetAdminSessionName: DEV_EKS_TELEMETRY_SESSION_NAMES.offsetAdmin,
    });
  });

  test('생성기가 읽는 output은 모두 실제 CDK 합성 결과에 있다', () => {
    // fixture에만 있는 output으로 통과하지 않도록, 합성된 output 이름만 남겨 생성한다.
    const { buildDevApp } = require('../helpers');
    const synthesized = new Set(buildDevApp({ devEksEnabled: true }).app.synth().stacks
      .flatMap((stack: any) => Object.keys(stack.template.Outputs ?? {})));
    const source: any = outputs();
    for (const stack of Object.values(source) as any[]) {
      for (const key of Object.keys(stack)) if (!synthesized.has(key)) delete stack[key];
    }
    const output = run(source);
    expect(output.result.stderr).not.toContain('배포 output이 없다');
    expect(output.result.status).toBe(0);
  });

  test('Gateway는 공개키·Kafka 발행·전용 TG만 받고 DB·HMAC·사용자 JWT·개인키 설정이 없다', () => {
    const output = run(outputs());
    expect(output.result.status).toBe(0);
    expect(output.read('telemetry-gateway.yaml')).toEqual({
      image: { repository: repository + 'telemetry-gateway', digest }, metrics: { enabled: true }, vpcId: 'vpc-0123456789abcdef0', nodePort: 30082,
      telemetryJwt: publicTelemetry('telemetry-gateway'),
      kafka: { enabled: true, bootstrapServers: brokers, topic: 'pulsemetry-dev-telemetry-ingress-validation',
        iamRoleArn: mskRole('Gateway'), iamSessionName: 'pulsemetry-dev-telemetry-gateway' },
      env: { AWS_REGION: 'ap-northeast-2', PULSEMETRY_OBSERVABILITY_ENVIRONMENT: 'dev' },
      targetGroupBindings: [{ stage: 'validation', targetGroupARN: tg('gateway-v'), confirmExclusiveOwnership: true }],
    });
    const text = readFileSync(join(output.dir, 'telemetry-gateway.yaml'), 'utf8');
    for (const forbidden of ['private', 'jdbc:', 'secretsmanager', 'TOKEN_HASH', 'ARCHIVE', 'userAuth', 'runtime:', 'consumerGroup']) expect(text).not.toContain(forbidden);
    const enrollment = output.read('enrollment-api.yaml');
    expect(enrollment.telemetryJwt).toEqual({ ...publicTelemetry('enrollment-api'), privateVersionId: '33333333-3333-4333-8333-333333333333',
      activeKid: 'telemetry-2026.10', issueEnabled: false });
    expect(enrollment.kafka).toBeUndefined();
    expect(output.read('dashboard-api.yaml').telemetryJwt).toBeUndefined();
    expect(output.read('runtime.yaml').telemetryJwt).toEqual({ privateVersionId: '33333333-3333-4333-8333-333333333333',
      publicVersionId: '44444444-4444-4444-8444-444444444444', activeKid: 'telemetry-2026.10', publicKeys: telemetryKeys });
  });

  test.each([
    ['ingest', 'http', false, 'NodePort'],
    ['ingest', 'dual', true, 'NodePort'],
    ['gateway', 'dual', true, 'NodePort'],
    ['gateway', 'kafka', true, 'ClusterIP'],
  ] as const)('OTLP 대상 %s에서 ingest %s 모드를 생성한다', (target, mode, consumer, service) => {
    const output = run(outputs('eks_validation', target), runtime(value => { value.ingestMode = mode; }));
    expect(output.result.status).toBe(0);
    const ingest = output.read('telemetry-ingest.yaml');
    expect(ingest.ingestMode).toBe(mode);
    expect(ingest.telemetryJwt).toEqual(publicTelemetry('telemetry-ingest'));
    expect(ingest.kafka).toEqual(consumer ? { enabled: true, bootstrapServers: brokers, topic: 'pulsemetry-dev-telemetry-ingress-validation',
      consumerGroup: 'pulsemetry-dev-telemetry-ingest-validation', iamRoleArn: mskRole('Ingest'), iamSessionName: 'pulsemetry-dev-telemetry-ingest' } : undefined);
    expect(ingest.service?.type ?? 'NodePort').toBe(service);
    expect(ingest.targetGroupBindings).toEqual(service === 'ClusterIP' ? [] : [{ stage: 'validation', targetGroupARN: tg('ingest-v'), confirmExclusiveOwnership: true }]);
    expect(ingest.runtime.requiredFiles).toEqual(['PULSEMETRY_DB_USERNAME', 'PULSEMETRY_DB_PASSWORD', 'PULSEMETRY_TOKEN_HASH_SECRET']);
  });

  test.each([['ingest', 'kafka'], ['gateway', 'http']] as const)('OTLP 대상 %s와 ingest %s 모드 조합은 수집이 끊기므로 거부한다', (target, mode) => {
    const output = run(outputs('eks_validation', target), runtime(value => { value.ingestMode = mode; }));
    expect(output.result.status).toBe(1);
    expect(output.result.stderr).toContain('ValidationOtlpTarget');
    expect(existsSync(output.dir)).toBe(false);
  });

  test('main stage는 eks prefix와 main topic/group으로만 생성한다', () => {
    const output = run(outputs('eks'));
    expect(output.result.status).toBe(0);
    expect(output.read('telemetry-kafka-admin.yaml').stage).toBe('main');
    expect(output.read('telemetry-gateway.yaml').kafka.topic).toBe('pulsemetry-dev-telemetry-ingress-main');
    const mismatched = outputs('eks');
    mismatched.DevEksStack.MskStage = 'validation';
    expect(run(mismatched).result.status).toBe(1);
  });

  test.each([
    ['public 주소 포함', JSON.stringify({ BootstrapBrokerStringSaslIam: brokers, BootstrapBrokerStringPublicSaslIam: brokers })],
    ['평문 주소 포함', JSON.stringify({ BootstrapBrokerStringSaslIam: brokers, BootstrapBrokerString: brokers.replace(/9098/g, '9092') })],
    ['TLS 주소만 있음', JSON.stringify({ BootstrapBrokerStringTls: brokers.replace(/9098/g, '9094') })],
    ['broker 4대', JSON.stringify({ BootstrapBrokerStringSaslIam: `${brokers},${brokers.split(',')[0].replace('b-1', 'b-4')}` })],
    ['broker 중복', JSON.stringify({ BootstrapBrokerStringSaslIam: brokers.replace('b-3', 'b-1') })],
    ['서로 다른 cluster 이름', JSON.stringify({ BootstrapBrokerStringSaslIam: brokers.replace('b-3.soma376devtelemetry', 'b-3.othercluster') })],
    ['다른 리전', JSON.stringify({ BootstrapBrokerStringSaslIam: brokers.replace(/ap-northeast-2/g, 'us-east-1') })],
    ['다른 포트', JSON.stringify({ BootstrapBrokerStringSaslIam: brokers.replace(/9098/g, '9096') })],
    ['서로 다른 cluster id', JSON.stringify({ BootstrapBrokerStringSaslIam: brokers.replace('b-3.soma376devtelemetry.abc123', 'b-3.soma376devtelemetry.zzz999') })],
    ['중복 key', `{"BootstrapBrokerStringSaslIam":"${brokers}","BootstrapBrokerStringSaslIam":"${brokers}"}`],
    ['빈 문서', '{}'],
    ['빈 목록', JSON.stringify({ BootstrapBrokerStringSaslIam: '' })],
    ['JSON 아님', 'b-1:9098'],
  ])('bootstrap JSON의 %s는 파일 생성 전에 거부한다', (_name, bootstrap) => {
    const output = run(outputs(), undefined, { bootstrap });
    expect(output.result.status).toBe(1);
    expect(output.result.stderr).toContain('msk-bootstrap');
    expect(existsSync(output.dir)).toBe(false);
  });

  // bootstrap 목록은 cluster의 모든 broker를 담는다고 보장되지 않는다. API가 준 일부 주소도 그대로 쓴다.
  test.each([
    ['broker 2대', [3, 1]],
    ['broker 1대', [2]],
  ])('bootstrap JSON이 %s만 담아도 받은 주소 그대로 생성한다', (_name, ids) => {
    const list = ids.map(n => brokers.split(',')[n - 1]);
    const output = run(outputs(), undefined, { bootstrap: JSON.stringify({ BootstrapBrokerStringSaslIam: list.join(',') }) });
    expect(output.result.status).toBe(0);
    expect(output.read('telemetry-gateway.yaml').kafka.bootstrapServers).toBe([...list].sort().join(','));
    expect(output.read('telemetry-kafka-admin.yaml').bootstrapServers).toBe([...list].sort().join(','));
  });

  test('MSK·Gateway output 누락·불일치와 이미지 누락을 거부한다', () => {
    for (const change of [
      (source: any) => { delete source.DevEksStack.MskClusterArn; },
      (source: any) => { delete source.DevDataStack.TelemetryJwtPublicKeysSecretArn; },
      (source: any) => { delete source.DevEdgeStack.ValidationTelemetryGatewayTargetGroupArn; },
      (source: any) => { delete source.DevEdgeStack.ValidationOtlpTarget; },
      (source: any) => { source.DevEdgeStack.ValidationOtlpTarget = 'direct'; },
      (source: any) => { source.DevEksStack.EksTelemetryGatewayNodePort = '30081'; },
      (source: any) => { source.DevEksStack.MskTopicName = 'pulsemetry-dev-telemetry-ingress-main'; },
      (source: any) => { source.DevEksStack.MskConsumerGroupName = 'pulsemetry-dev-telemetry-ingest-main'; },
      (source: any) => { source.DevEksStack.MskGatewaySessionName = 'pulsemetry-dev-telemetry-ingest'; },
      (source: any) => { source.DevEksStack.MskClusterArn = source.DevEksStack.MskClusterArn.replace('soma-376-dev-telemetry', 'other'); },
      (source: any) => { source.DevEksStack.MskGatewayRoleArn = source.DevEksStack.MskGatewayRoleArn.replace('111111111111', '222222222222'); },
      (source: any) => { source.DevEksStack.MskOffsetAdminRoleArn = source.DevEksStack.MskTopicAdminRoleArn; },
      (source: any) => { source.DevEksStack.MskIngestRoleArn = '*'; },
      (source: any) => { source.DevEdgeStack.ValidationTelemetryGatewayTargetGroupArn = source.DevEdgeStack.ValidationTelemetryIngestTargetGroupArn; },
      (source: any) => { source.DevDataStack.TelemetryJwtPublicKeysSecretArn = source.DevEksStack.UserJwtPublicKeysSecretArn; },
      (source: any) => { source.DevDataStack.TelemetryJwtPrivateKeySecretArn = source.DevDataStack.TelemetryJwtPublicKeysSecretArn; },
    ]) {
      const source = outputs(); change(source);
      const output = run(source);
      expect(output.result.status).toBe(1);
      expect(existsSync(output.dir)).toBe(false);
    }
    expect(run(outputs(), undefined, { gateway: 'registry.example/telemetry-gateway:latest' }).result.stderr).toContain('gateway image');
  });

  test('telemetry JWT·모드 runtime 입력의 비밀·override·잘못된 버전/alias/kid를 거부한다', () => {
    for (const change of [
      (value: any) => { delete value.telemetryJwt; },
      (value: any) => { delete value.ingestMode; },
      (value: any) => { value.ingestMode = 'consumer'; },
      (value: any) => { value.telemetryJwt.publicVersionId = 'AWSCURRENT'; },
      (value: any) => { value.telemetryJwt.privateVersionId = undefined; },
      (value: any) => { value.telemetryJwt.publicKeys[0].alias = 'private.pem'; },
      (value: any) => { value.telemetryJwt.publicKeys[0].alias = '../escape.pem'; },
      (value: any) => { value.telemetryJwt.publicKeys.push({ ...value.telemetryJwt.publicKeys[0] }); },
      (value: any) => { value.telemetryJwt.activeKid = 'missing'; },
      (value: any) => { value.telemetryJwt.issueEnabled = 'true'; },
      (value: any) => { value.telemetryJwt.privateKeyPem = 'forbidden-telemetry-value'; },
      (value: any) => { value.telemetryJwt.secretArn = 'forbidden-telemetry-value'; },
      (value: any) => { value.kafka = { topic: 'forbidden-telemetry-value' }; },
    ]) {
      const output = run(outputs(), runtime(change));
      expect(output.result.status).toBe(1);
      expect(existsSync(output.dir)).toBe(false);
      expect(output.result.stderr).not.toContain('forbidden-telemetry-value');
    }
  });

  test('EKS runtime은 telemetry 설정을 받고 폐기된 ECS writer 입력은 거부한다', () => {
    const { parseRuntimeInputs } = require('../../lib/dev/runtime-input.cjs');
    const eks = load(readFileSync(runtimeFile, 'utf8'));
    expect(() => parseRuntimeInputs(eks)).not.toThrow();
    expect(() => parseRuntimeInputs({ ...eks, writerImage: 'removed-ecs-writer' })).toThrow('root');
  });

  helmTest('생성한 Gateway·kafka 모드 ingest·관리 Job·runtime values를 chart와 함께 render한다', () => {
    const output = run(outputs('eks_validation', 'gateway'), runtime(value => { value.ingestMode = 'kafka'; }));
    expect(output.result.status).toBe(0);
    const render = (release: string, chart: string, files: string[]) => {
      const result = spawnSync(process.env.HELM_BIN!, ['template', release, chart, '--namespace', 'pulsemetry-dev', '--kube-version', '1.36.0',
        ...files.flatMap(file => ['-f', file])], { cwd: root, encoding: 'utf8' });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      return result.stdout.split(/^---\s*$/m).filter(text => text.trim()).map(text => load(text)).filter(Boolean);
    };
    const gateway = render('telemetry-gateway', 'helm/dev/workloads/spring-app', ['helm/dev/workloads/telemetry-gateway.yaml', join(output.dir, 'telemetry-gateway.yaml')]);
    expect(gateway.map((doc: any) => doc.kind).sort()).toEqual(['ConfigMap', 'Deployment', 'Service', 'Service', 'ServiceAccount', 'TargetGroupBinding']);
    const gatewayDeployment = gateway.find((doc: any) => doc.kind === 'Deployment');
    const gatewayPod = gatewayDeployment.spec.template.spec;
    const blockedContents = readFileSync(join(root, 'helm/dev/workloads/spring-app/files/blocked.certs'), 'utf8');
    expect(gateway.find((doc: any) => doc.kind === 'ConfigMap').data['blocked.certs']).toBe(blockedContents);
    expect(gatewayDeployment.spec.template.metadata.annotations['pulsemetry.io/blocked-certs-revision'])
      .toBe(createHash('sha256').update(blockedContents).digest('hex'));
    expect(gatewayDeployment.spec.template.metadata.annotations['pulsemetry.io/telemetry-jwt-revision']).toMatch(/^[a-f0-9]{64}$/);
    expect(gatewayPod.containers[0].volumeMounts.map((mount: any) => mount.name)).toEqual(['telemetry-jwt', 'blocked-certs']);
    expect(gatewayPod.initContainers[0].volumeMounts.map((mount: any) => mount.name)).toEqual(['telemetry-jwt']);
    expect(gatewayPod.containers[0].ports).toContainEqual({ name: 'metrics', containerPort: 9404, protocol: 'TCP' });
    const ingest = render('telemetry-ingest', 'helm/dev/workloads/spring-app', ['helm/dev/workloads/telemetry-ingest.yaml', join(output.dir, 'telemetry-ingest.yaml')]);
    expect(ingest.find((doc: any) => doc.kind === 'Service').spec.type).toBe('ClusterIP');
    expect(ingest.some((doc: any) => doc.kind === 'TargetGroupBinding')).toBe(false);
    const env = Object.fromEntries(ingest.find((doc: any) => doc.kind === 'Deployment').spec.template.spec.containers[0].env.map((item: any) => [item.name, item.value]));
    expect(env.PULSEMETRY_INGEST_MODE).toBe('kafka');
    expect(env.PULSEMETRY_KAFKA_CONSUMER_GROUP).toBe('pulsemetry-dev-telemetry-ingest-validation');
    const admin = render('telemetry-kafka-admin', 'helm/dev/workloads/telemetry-kafka-admin', [join(output.dir, 'telemetry-kafka-admin.yaml')]);
    expect(admin.filter((doc: any) => doc.kind === 'Job').map((doc: any) => doc.metadata.name)).toEqual(['telemetry-topic-init-r1']);
    const spcs = render('runtime-config', 'helm/dev/runtime/chart', [join(output.dir, 'runtime.yaml')]);
    expect(spcs.map((doc: any) => doc.metadata.name).sort()).toEqual(['dashboard-api-jwt', 'dashboard-api-runtime', 'enrollment-api-jwt',
      'enrollment-api-runtime', 'enrollment-api-telemetry-jwt', 'telemetry-gateway-telemetry-jwt', 'telemetry-ingest-runtime', 'telemetry-ingest-telemetry-jwt']);
  });
});

// PROJ-191: bootstrap 일부 주소를 전체 scrape 대상으로 오인하지 않는다.
describe('관측 values와 전체 MSK broker 검증', () => {
  const temps: string[] = [];
  afterEach(() => temps.splice(0).forEach(temp => rmSync(temp, { recursive: true, force: true })));
  const run = (nodes?: string) => {
    const result = invoke(outputs(), undefined, undefined, undefined, { nodes,
      bootstrap: JSON.stringify({ BootstrapBrokerStringSaslIam: brokers.split(',')[0] }) });
    temps.push(result.temp); return result;
  };
  test('부분 bootstrap으로도 list-nodes의 3대와 observability 설정을 생성한다', () => {
    const output = run();
    expect(output.result.status).toBe(0);
    const config = output.read('observability.yaml').global.pulsemetry;
    expect(config.mskBrokers).toEqual(brokers.split(',').map(value => value.replace(':9098', '')));
    expect(config.environment).toBe('dev');
    expect(config.targetNamespace).toBe('pulsemetry-dev');
    expect(config.controlPlaneLogGroup).toBe('/aws/eks/soma-376-dev-eks/cluster');
    const monitoring = output.read('observability.yaml').monitoring;
    for (const path of [
      ['kubelet', 'serviceMonitor'], ['prometheus', 'serviceMonitor'], ['prometheusOperator', 'serviceMonitor'],
      ['grafana', 'serviceMonitor'], ['kube-state-metrics', 'prometheus', 'monitor'], ['prometheus-node-exporter', 'prometheus', 'monitor'],
    ]) expect(path.reduce((node, key) => node[key], monitoring).relabelings).toEqual([
      { targetLabel: 'cluster', replacement: config.clusterName }, { targetLabel: 'environment', replacement: 'dev' },
    ]);
    expect(output.read('clickhouse.yaml').observability.enabled).toBe(true);
    expect(output.read('telemetry-ingest.yaml').metrics.enabled).toBe(true);
  });
  test.each(['missing', 'duplicate', 'foreign', 'pagination'])('%s broker 목록은 파일 생성 전에 거부한다', mode => {
    const value = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/msk-nodes.json'), 'utf8'));
    if (mode === 'missing') value.NodeInfoList.pop();
    if (mode === 'duplicate') value.NodeInfoList[2] = value.NodeInfoList[0];
    if (mode === 'foreign') value.NodeInfoList[0].BrokerNodeInfo.Endpoints = ['b-1.foreign.cluster.c2.kafka.ap-northeast-2.amazonaws.com'];
    if (mode === 'pagination') value.NextToken = 'more';
    const output = run(JSON.stringify(value));
    expect(output.result.status).toBe(1);
    expect(output.result.stderr).toContain('msk-nodes');
    expect(existsSync(output.dir)).toBe(false);
  });
});

// PROJ-256: 플랫폼 trace는 runtime-values로 켜고 Gateway·ingest에만 고정 Collector 주소를 넣는다(ADR-0039).
describe('플랫폼 trace 입력', () => {
  const temps: string[] = [];
  afterEach(() => temps.splice(0).forEach(temp => rmSync(temp, { recursive: true, force: true })));
  const run = (value: unknown) => {
    const runtime = load(readFileSync(runtimeFile, 'utf8'));
    if (value !== undefined) runtime.platformTracing = value;
    const result = invoke(outputs(), undefined, undefined, dump(runtime));
    temps.push(result.temp); return result;
  };
  test('생략하거나 끄면 values에 넣지 않는다', () => {
    for (const value of [undefined, { enabled: false }]) {
      const output = run(value);
      expect(output.result.status).toBe(0);
      for (const file of ['telemetry-gateway.yaml', 'telemetry-ingest.yaml']) expect(output.read(file).tracing).toBeUndefined();
    }
  });
  test('켜면 Gateway·ingest에만 고정 endpoint·cluster·sampling을 넣는다', () => {
    const on = run({ enabled: true });
    expect(on.result.status).toBe(0);
    for (const file of ['telemetry-gateway.yaml', 'telemetry-ingest.yaml']) expect(on.read(file).tracing).toEqual({
      enabled: true, endpoint: 'http://pulsemetry-otel-platform.pulsemetry-observability.svc:4318/v1/traces',
      sampleProbability: '0.1', cluster: on.read('lbc.yaml').clusterName,
    });
    for (const file of ['enrollment-api.yaml', 'dashboard-api.yaml']) expect(on.read(file).tracing).toBeUndefined();
    expect(run({ enabled: true, sampleProbability: 1 }).read('telemetry-ingest.yaml').tracing.sampleProbability).toBe('1');
  });
  test('잘못된 입력은 파일 생성 전에 거부한다', () => {
    for (const value of [true, { enabled: 'yes' }, { enabled: true, sampleProbability: 1.5 }, { enabled: true, sampleProbability: '0.1' }, { enabled: true, endpoint: 'http://x' }]) {
      const output = run(value);
      expect(output.result.status).toBe(1);
      expect(output.result.stderr).toContain('platformTracing');
      expect(existsSync(output.dir)).toBe(false);
    }
  });
});

// PROJ-191: GC/safepoint stderr는 성능 비교 구간에서만 켜고 측정 대상 두 앱에만 전달한다.
describe('JVM GC·safepoint 로그 입력', () => {
  const temps: string[] = [];
  afterEach(() => temps.splice(0).forEach(temp => rmSync(temp, { recursive: true, force: true })));
  const run = (value: unknown) => {
    const runtime = load(readFileSync(runtimeFile, 'utf8'));
    if (value !== undefined) runtime.jvmGcSafepointLog = value;
    const result = invoke(outputs(), undefined, undefined, dump(runtime));
    temps.push(result.temp); return result;
  };
  test('생략하면 끄고 true면 Gateway·ingest values에만 넣는다', () => {
    const off = run(undefined);
    expect(off.result.status).toBe(0);
    for (const file of ['telemetry-gateway.yaml', 'telemetry-ingest.yaml']) expect(off.read(file).jvm).toBeUndefined();
    const on = run(true);
    expect(on.result.status).toBe(0);
    for (const file of ['telemetry-gateway.yaml', 'telemetry-ingest.yaml']) expect(on.read(file).jvm).toEqual({ gcSafepointLog: true });
    for (const file of ['enrollment-api.yaml', 'dashboard-api.yaml']) expect(on.read(file).jvm).toBeUndefined();
  });
  test('boolean이 아니면 파일 생성 전에 거부한다', () => {
    const output = run('-Xlog:gc');
    expect(output.result.status).toBe(1);
    expect(output.result.stderr).toContain('jvmGcSafepointLog');
    expect(existsSync(output.dir)).toBe(false);
  });
});
