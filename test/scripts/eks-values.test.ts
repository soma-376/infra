import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const { load } = require('js-yaml');
const root = resolve(__dirname, '../..');
const digest = 'sha256:' + 'a'.repeat(64);
const repository = '111111111111.dkr.ecr.ap-northeast-2.amazonaws.com/soma-376/';
const enrollmentImage = repository + 'enrollment-api@' + digest;
const ingestImage = repository + 'telemetry-ingest@' + digest;
const secret = (name: string) => `arn:aws:secretsmanager:ap-northeast-2:111111111111:secret:${name}-abc123`;
const tg = (name: string) => `arn:aws:elasticloadbalancing:ap-northeast-2:111111111111:targetgroup/soma-376-dev-eks-${name}/0123456789abcdef`;
const helmTest = process.env.HELM_BIN ? test : test.skip;

function outputs(prefix = 'eks_validation') {
  return {
    DevEksStack: {
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
    },
  };
}

function invoke(document: any, image = enrollmentImage) {
  const temp = mkdtempSync(join(tmpdir(), 'eks-values-test-'));
  const source = join(temp, 'outputs.json');
  const dir = join(temp, 'values');
  writeFileSync(source, JSON.stringify(document));
  const result = spawnSync(process.execPath, [
    join(root, 'scripts/eks-values.mjs'), '--outputs', source, '--output-dir', dir,
    '--enrollment-image', image, '--ingest-image', ingestImage,
  ], { cwd: root, encoding: 'utf8' });
  return { temp, dir, result, read: (file: string) => load(readFileSync(join(dir, file), 'utf8')) };
}

describe('배포 output→values 변환', () => {
  const temps: string[] = [];
  afterEach(() => { for (const temp of temps.splice(0)) rmSync(temp, { recursive: true, force: true }); });
  const run = (document: any, image?: string) => { const output = invoke(document, image); temps.push(output.temp); return output; };

  test.each(['eks_validation', 'eks'])('%s prefix가 IAM output과 일치하며 immutable image를 전달한다', prefix => {
    const output = run(outputs(prefix));
    expect(output.result.status).toBe(0);
    expect(readdirSync(output.dir).sort()).toEqual(['ascp.yaml', 'base.yaml', 'clickhouse.yaml', 'enrollment-api.yaml', 'fluent-bit.yaml', 'lbc.yaml', 'runtime.yaml', 'telemetry-ingest.yaml']);
    expect(output.read('base.yaml')).toEqual({
      nodeRoleName: 'soma-376-dev-eks-node', subnetIds: ['subnet-0123456789abcdef0', 'subnet-0123456789abcdef1'],
      appNodeSecurityGroupId: 'sg-0123456789abcdef0', clickhouseNodeSecurityGroupId: 'sg-0123456789abcdef1', clickhouseAvailabilityZone: 'ap-northeast-2a',
    });
    expect(output.read('lbc.yaml')).toEqual({ clusterName: 'soma-376-dev-eks', region: 'ap-northeast-2', vpcId: 'vpc-0123456789abcdef0' });
    const ingest = output.read('telemetry-ingest.yaml');
    const enrollment = output.read('enrollment-api.yaml');
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
    expect(output.read('runtime.yaml').secrets).toEqual({ dbArn: secret('db'), tokenHashArn: secret('hmac'), adminApiTokenArn: secret('admin') });
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

  test('필수 output 누락·미합성 token·중복값 충돌·prefix 확대를 거절한다', () => {
    for (const change of [
      (source: any) => { delete source.DevEksStack.DbSecretArn; },
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
    expect(documents).toHaveLength(2);
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
    render('clickhouse', 'helm/dev/workloads/clickhouse', [join(output.dir, 'clickhouse.yaml')]);
    render('pulsemetry-base', 'helm/dev/platform/base', [join(output.dir, 'base.yaml')]);
  });
});
