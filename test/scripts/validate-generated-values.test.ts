import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(__dirname, '../..');
const url = (file: string) => pathToFileURL(resolve(root, file)).href;
const secret = (name: string) => `arn:aws:secretsmanager:ap-northeast-2:111111111111:secret:${name}-abc123`;
const tg = (name: string) => `arn:aws:elasticloadbalancing:ap-northeast-2:111111111111:targetgroup/soma-376-dev-eks-${name}/0123456789abcdef`;
// 계정·endpoint는 기존 생성기 fixture와 같은 합성 입력이며 AWS를 조회하지 않는다.
const outputs = {
  DevEksStack: {
    ObservabilityNamespace: 'pulsemetry-observability', ObservabilityNodeSecurityGroupId: 'sg-0123456789abcdef2',
    GrafanaAdminSecretArn: secret('soma-376/dev/observability/grafana-admin'),
    ObservabilityLogGroupName: '/eks/dev/observability', KubernetesEventsLogGroupName: '/eks/dev/events',
    DiagnosticsBucketName: 'fixture-diagnostics', EksControlPlaneLogGroupName: '/aws/eks/soma-376-dev-eks/cluster',
    EksDashboardApiNodePort: '30081', EksTelemetryGatewayNodePort: '30082',
    DashboardRdsSourceSecretArn: secret('dashboard-rds-source'), DashboardRdsCacheSecretArn: secret('dashboard-rds-cache'),
    DashboardClickHouseSourceSecretArn: secret('dashboard-ch-source'), DashboardClickHouseCacheSecretArn: secret('dashboard-ch-cache'),
    UserJwtPrivateKeySecretArn: secret('jwt-private'), UserJwtPublicKeysSecretArn: secret('jwt-public'),
    EksClusterName: 'soma-376-dev-eks', EksRegion: 'ap-northeast-2', EksVpcId: 'vpc-0123456789abcdef0',
    EksSubnetIds: 'subnet-0123456789abcdef0,subnet-0123456789abcdef1',
    EksAppNodeSecurityGroupId: 'sg-0123456789abcdef0', EksClickhouseNodeSecurityGroupId: 'sg-0123456789abcdef1',
    EksClickhouseAvailabilityZone: 'ap-northeast-2a', EksNodeRoleName: 'soma-376-dev-eks-node',
    DbEndpoint: 'database.example.test', DbSecretArn: secret('db'), TokenHashSecretArn: secret('hmac'),
    AdminApiTokenSecretArn: secret('admin'), RawSignalBucketName: 'fixture-raw-signals',
    ApplicationLogGroupName: '/eks/dev/application', ArchivePrefix: 'eks', KafkaProvider: 'strimzi', KafkaStage: 'main',
    KafkaTopicName: 'pulsemetry-dev-telemetry-ingress-main', KafkaConsumerGroupName: 'pulsemetry-dev-telemetry-ingest-main',
    EksKafkaNodeSecurityGroupId: 'sg-0123456789abcdef3', EksKafkaAvailabilityZone: 'ap-northeast-2a',
  },
  DevEdgeStack: {
    ValidationPublicBaseUrl: 'http://validation-alb.example.test', ValidationOtlpTarget: 'gateway',
    ValidationEnrollmentApiTargetGroupArn: tg('enroll-v'), ValidationTelemetryIngestTargetGroupArn: tg('ingest-v'),
    ValidationDashboardApiTargetGroupArn: tg('dashboard-v'), ValidationTelemetryGatewayTargetGroupArn: tg('gateway-v'),
  },
  DevDataStack: {
    ManagementResponseKeySecretArn: secret('soma-376/dev/management/response-encryption-key'),
    MailEncryptionKeySecretArn: secret('soma-376/dev/mail/encryption-key'),
    TelemetryJwtPrivateKeySecretArn: secret('soma-376/dev/telemetry-jwt/private-key'),
    TelemetryJwtPublicKeysSecretArn: secret('soma-376/dev/telemetry-jwt/public-keys'),
  },
};

// ESM 생성기·validator를 실제 Node로 호출한다. private 값이 들어갈 출력 경로에는 성공 요약만 남긴다.
const driver = `
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, linkSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dump } from 'js-yaml';
import { generateValues, parseRuntimeValues } from ${JSON.stringify(url('scripts/eks-values.mjs'))};
import { GENERATED_FILES, inspectGeneratedValues, validateGeneratedValues } from ${JSON.stringify(url('scripts/validate-generated-values.mjs'))};
const data = JSON.parse(readFileSync(0, 'utf8'));
const temporary = mkdtempSync(join(tmpdir(), 'generated-validation-test-'));
const directory = join(temporary, 'values'); mkdirSync(directory);
try {
  const apps = ['enrollment-api', 'telemetry-ingest', 'telemetry-gateway', 'dashboard-api'];
  const images = Object.fromEntries(apps.map((app, i) => [app, {
    repository: '111111111111.dkr.ecr.ap-northeast-2.amazonaws.com/soma-376/' + app,
    digest: 'sha256:' + 'abcd'[i].repeat(64), platform: 'linux/arm64',
  }]));
  const runtime = parseRuntimeValues(readFileSync(join(data.root, 'test/fixtures/eks-runtime.yaml'), 'utf8'));
  runtime.ingestMode = 'kafka';
  const metadata = {items: ['soma-376-dev-telemetry-cluster-ca-cert', ...['gateway', 'ingest', 'topic-admin', 'offset-admin'].map(role => 'pulsemetry-' + role + '-main')]
    .map((name, i) => ({metadata: {name, namespace: 'pulsemetry-dev', uid: 'fixture-' + i, resourceVersion: '123'}}))};
  const refs = Object.fromEntries(['enrollment', 'ingest', 'gateway', 'dashboard'].map((key, i) => [key, images[apps[i]].repository + '@' + images[apps[i]].digest]));
  const expectedValues = generateValues(data.outputs, refs, runtime, undefined, undefined, undefined, JSON.stringify(metadata));
  for (const [file, value] of Object.entries(expectedValues)) writeFileSync(join(directory, file), dump(value));
  const file = join(directory, 'enrollment-api.yaml');
  const original = readFileSync(file, 'utf8');
  switch (data.mutation) {
    case 'extra': writeFileSync(join(directory, 'bundle.json'), '{}'); break;
    case 'missing': rmSync(file); break;
    case 'directory': rmSync(file); mkdirSync(file); break;
    case 'symlink': rmSync(file); symlinkSync(join(directory, 'runtime.yaml'), file); break;
    case 'hardlink': rmSync(file); linkSync(join(directory, 'runtime.yaml'), file); break;
    case 'empty': writeFileSync(file, ''); break;
    case 'oversized': writeFileSync(file, '#'.repeat(1024 * 1024 + 1)); break;
    case 'multidoc': writeFileSync(file, original + '\\n---\\npassword: PRIVATE-SENTINEL'); break;
    case 'duplicate': writeFileSync(file, original + '\\nimage: PRIVATE-SENTINEL'); break;
    case 'extra-field': writeFileSync(file, original + '\\npassword: PRIVATE-SENTINEL'); break;
    case 'image-drift': expectedValues['enrollment-api.yaml'].image.digest = 'sha256:' + 'f'.repeat(64);
      writeFileSync(file, dump(expectedValues['enrollment-api.yaml'])); break;
    case 'platform': images['enrollment-api'].platform = 'linux/amd64'; break;
    case 'tag': images['enrollment-api'].digest = 'latest'; break;
    case 'repository': images['enrollment-api'].repository = images['enrollment-api'].repository.replace('enrollment-api', 'telemetry-ingest'); break;
    case 'account': images['enrollment-api'].repository = images['enrollment-api'].repository.replace('111111111111', '222222222222'); break;
    case 'missing-image': delete images['telemetry-gateway']; break;
    case 'missing-expected': delete expectedValues['base.yaml']; break;
  }
  let result;
  if (data.operation === 'render') result = await validateGeneratedValues({root: data.root, directory, images, expectedValues,
    helm: process.env.HELM_BIN, chartsDirectory: process.env.GENERATED_VALUES_CHARTS_DIRECTORY});
  else if (['helm-error', 'helm-version', 'chart-tamper'].includes(data.operation)) {
    const helm = join(temporary, 'helm');
    writeFileSync(helm, data.operation === 'helm-error' ? '#!/bin/sh\\nprintf PRIVATE-SENTINEL >&2\\nexit 1\\n' :
      '#!/bin/sh\\nprintf ' + (data.operation === 'helm-version' ? 'v4.3.1' : 'v3.22.0') + '\\n'); chmodSync(helm, 0o700);
    const chartsDirectory = join(temporary, 'charts'); mkdirSync(chartsDirectory);
    if (data.operation === 'chart-tamper') {
      const versions = JSON.parse(readFileSync(join(data.root, 'helm/dev/runtime/versions.json'), 'utf8'));
      const filename = new URL(versions.ascp.url).pathname.split('/').at(-1);
      writeFileSync(join(chartsDirectory, filename), 'PRIVATE-SENTINEL');
    }
    result = await validateGeneratedValues({root: data.root, directory, images, expectedValues, helm, chartsDirectory});
  } else result = inspectGeneratedValues({directory, images, expectedValues});
  process.stdout.write(JSON.stringify({files: Object.keys(result.hashes), rendered: result.rendered,
    expectedFiles: GENERATED_FILES, hashes: Object.values(result.hashes)}));
} catch (error) { process.stdout.write(JSON.stringify({error: error.message})); }
finally { rmSync(temporary, {recursive: true, force: true}); }
`;

function invoke(mutation?: string, operation = 'inspect') {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', driver], {
    cwd: root, input: JSON.stringify({ root, outputs, mutation, operation }), encoding: 'utf8', timeout: 180_000,
  });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.stdout).not.toContain('PRIVATE-SENTINEL');
  return JSON.parse(result.stdout);
}

describe('사본 파일·승인 이미지·실제 Helm 검증', () => {
  test('Strimzi 생성기의 정확한 13개 파일과 네 승인 이미지를 허용한다', () => {
    const result = invoke();
    expect(result.error).toBeUndefined();
    expect(result.files).toEqual(result.expectedFiles);
    expect(result.files).toHaveLength(13);
    expect(result.hashes.every((value: string) => /^[a-f0-9]{64}$/.test(value))).toBe(true);
  });
  test.each([
    ['extra', /13개/], ['missing', /13개/], ['directory', /일반 파일/], ['symlink', /일반 파일/],
    ['hardlink', /일반 파일/], ['empty', /크기/], ['oversized', /크기/], ['multidoc', /YAML/],
    ['duplicate', /YAML/], ['extra-field', /원본/], ['image-drift', /승인 이미지/],
    ['platform', /ARM64/], ['tag', /digest/], ['repository', /ECR/], ['account', /계정/],
    ['missing-image', /4개/], ['missing-expected', /원본 13개/],
  ])('%s 입력을 게시 전에 거부하고 원문을 노출하지 않는다', (mutation, expected) => {
    expect(invoke(mutation as string).error).toMatch(expected as RegExp);
  });
  test('Helm 오류 stdout/stderr가 공개 job 로그로 누출되지 않는다', () => {
    expect(invoke(undefined, 'helm-error').error).toMatch(/Helm 실행 실패/);
  });
  test('다른 Helm 버전은 chart 다운로드 전에 거부한다', () => {
    expect(invoke(undefined, 'helm-version').error).toMatch(/Helm 3\.22\.0/);
  });
  test('기존 cache의 chart archive도 checksum이 다르면 렌더하지 않는다', () => {
    expect(invoke(undefined, 'chart-tamper').error).toMatch(/ascp chart SHA256/);
  });
  (process.env.HELM_BIN ? test : test.skip)('고정 checksum chart로 13개 consumers를 실제 렌더한다', () => {
    const result = invoke(undefined, 'render');
    expect(result.error).toBeUndefined();
    expect(result.rendered.map((value: any) => value.file).sort()).toEqual([...result.expectedFiles].sort());
    expect(result.rendered.every((value: any) => value.resources > 0)).toBe(true);
  }, 180_000);
});
