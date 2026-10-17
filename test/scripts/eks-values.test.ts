import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
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
const secret = (name: string) => `arn:aws:secretsmanager:ap-northeast-2:111111111111:secret:${name}-abc123`;
const tg = (name: string) => `arn:aws:elasticloadbalancing:ap-northeast-2:111111111111:targetgroup/soma-376-dev-eks-${name}/0123456789abcdef`;
const helmTest = process.env.HELM_BIN ? test : test.skip;

function outputs(prefix = 'eks_validation') {
  return {
    DevEksStack: {
      EksDashboardApiNodePort: '30081',
      DashboardRdsSourceSecretArn: secret('dashboard-rds-source'), DashboardRdsCacheSecretArn: secret('dashboard-rds-cache'), DashboardClickHouseSourceSecretArn: secret('dashboard-ch-source'), DashboardClickHouseCacheSecretArn: secret('dashboard-ch-cache'), UserJwtPrivateKeySecretArn: secret('jwt-private'), UserJwtPublicKeysSecretArn: secret('jwt-public'),
      EksClusterName: 'soma-376-dev-eks', EksRegion: 'ap-northeast-2', EksVpcId: 'vpc-0123456789abcdef0',
      EksSubnetIds: 'subnet-0123456789abcdef0,subnet-0123456789abcdef1',
      EksAppNodeSecurityGroupId: 'sg-0123456789abcdef0', EksClickhouseNodeSecurityGroupId: 'sg-0123456789abcdef1',
      EksClickhouseAvailabilityZone: 'ap-northeast-2a', EksNodeRoleName: 'soma-376-dev-eks-node',
      DbEndpoint: 'database.example.test', DbSecretArn: secret('db'), TokenHashSecretArn: secret('hmac'),
      AdminApiTokenSecretArn: secret('admin'), RawSignalBucketName: 'fixture-raw-signals',
      ApplicationLogGroupName: '/eks/dev/application', ArchivePrefix: prefix,
    },
    DevEdgeStack: {
      ValidationPublicBaseUrl: 'http://validation-alb.example.test',
      ValidationEnrollmentApiTargetGroupArn: tg('enroll-v'),
      ValidationTelemetryIngestTargetGroupArn: tg('ingest-v'),
      ValidationClickhouseTargetGroupArn: tg('ch-v'),
      ValidationDashboardApiTargetGroupArn: tg('dashboard-v'),
    },
  };
}

function invoke(document: any, image = enrollmentImage, dashboard = dashboardImage, runtimeText = readFileSync(runtimeFile, 'utf8')) {
  const temp = mkdtempSync(join(tmpdir(), 'eks-values-test-'));
  const source = join(temp, 'outputs.json');
  const dir = join(temp, 'values');
  writeFileSync(source, JSON.stringify(document));
  const runtime = join(temp, 'runtime.yaml');
  writeFileSync(runtime, runtimeText);
  const result = spawnSync(process.execPath, [
    join(root, 'scripts/eks-values.mjs'), '--outputs', source, '--output-dir', dir,
    '--enrollment-image', image, '--ingest-image', ingestImage, '--dashboard-image', dashboard, '--runtime-values', runtime,
  ], { cwd: root, encoding: 'utf8' });
  return { temp, dir, result, read: (file: string) => load(readFileSync(join(dir, file), 'utf8')) };
}

describe('배포 output→values 변환', () => {
  const temps: string[] = [];
  afterEach(() => { for (const temp of temps.splice(0)) rmSync(temp, { recursive: true, force: true }); });
  const run = (document: any, image?: string, dashboard?: string, runtimeText?: string) => { const output = invoke(document, image, dashboard, runtimeText); temps.push(output.temp); return output; };

  test.each(['eks_validation', 'eks'])('%s prefix가 IAM output과 일치하며 immutable image를 전달한다', prefix => {
    const output = run(outputs(prefix));
    expect(output.result.status).toBe(0);
    expect(readdirSync(output.dir).sort()).toEqual(['ascp.yaml', 'base.yaml', 'clickhouse.yaml', 'dashboard-api.yaml', 'enrollment-api.yaml', 'fluent-bit.yaml', 'lbc.yaml', 'runtime.yaml', 'telemetry-ingest.yaml']);
    expect(output.read('base.yaml')).toEqual({
      nodeRoleName: 'soma-376-dev-eks-node', subnetIds: ['subnet-0123456789abcdef0', 'subnet-0123456789abcdef1'],
      appNodeSecurityGroupId: 'sg-0123456789abcdef0', clickhouseNodeSecurityGroupId: 'sg-0123456789abcdef1', clickhouseAvailabilityZone: 'ap-northeast-2a',
    });
    expect(output.read('lbc.yaml')).toEqual({ clusterName: 'soma-376-dev-eks', region: 'ap-northeast-2', vpcId: 'vpc-0123456789abcdef0' });
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
    expect(output.read('runtime.yaml').secrets).toEqual({ dbArn: secret('db'), tokenHashArn: secret('hmac'), adminApiTokenArn: secret('admin'), dashboardRdsSourceArn: secret('dashboard-rds-source'), dashboardRdsCacheArn: secret('dashboard-rds-cache'), dashboardClickHouseSourceArn: secret('dashboard-ch-source'), dashboardClickHouseCacheArn: secret('dashboard-ch-cache'), userJwtPrivateKeyArn: secret('jwt-private'), userJwtPublicKeysArn: secret('jwt-public') });
    expect(output.read('runtime.yaml').userAuth.publicVersionId).toBe(enrollment.jwt.publicVersionId);
    expect(output.read('runtime.yaml').userAuth.publicKeys).toEqual(dashboard.jwt.publicKeys);
    expect(enrollment.targetGroupBindings).toEqual([{ stage: 'validation', targetGroupARN: tg('enroll-v'), confirmExclusiveOwnership: true }]);
  });

  test('CloudFormation describe-stacks output도 지원한다', () => {
    const source = outputs();
    const document = { Stacks: Object.entries(source).map(([StackName, values]) => ({ StackName, Outputs: Object.entries(values).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })) })) };
    expect(run(document).result.status).toBe(0);
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
      (source: any) => { source.DevEdgeStack.ValidationClickhouseTargetGroupArn = source.DevEdgeStack.ValidationEnrollmentApiTargetGroupArn; },
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
    expect(documents).toHaveLength(5);
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
    expect(pod.volumes).toHaveLength(2);
    expect(pod.containers[0].volumeMounts.every((mount: any) => mount.readOnly)).toBe(true);
    expect(pod.initContainers[0].volumeMounts).toEqual(pod.containers[0].volumeMounts);
    expect(pod.initContainers[0].args[0]).toContain('head -c 1');
    const authEnv = pod.containers[0].env.find((env: any) => env.name === 'SPRING_APPLICATION_JSON');
    expect(JSON.parse(authEnv.value).pulsemetry['user-auth']['public-key-files']).toEqual({ '[release-2026.10]': '/mnt/user-jwt/keys/release-2026-10.pem' });
    render('clickhouse', 'helm/dev/workloads/clickhouse', [join(output.dir, 'clickhouse.yaml')]);
    render('pulsemetry-base', 'helm/dev/platform/base', [join(output.dir, 'base.yaml')]);
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
