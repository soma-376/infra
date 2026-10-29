import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { App } from 'aws-cdk-lib/core';
import { loadDevConfig } from '../../lib/dev/config';
import { TEST_ENV } from '../helpers';

const { readDeploymentProfile, createProfileContext, applyProfileContext } = require('../../lib/dev/deployment-profile.cjs');
const repository = resolve(__dirname, '../..');
const profilePath = join(repository, 'config/dev/deployment.json');
const profileSource = readFileSync(profilePath, 'utf8');
const fixture = () => JSON.parse(profileSource);
let directory: string;

beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'dev-deployment-profile-')); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

function readFixture(value: unknown) {
  const path = join(directory, 'deployment.json');
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
  return readDeploymentProfile(path);
}

describe('추적된 dev 배포 profile', () => {
  test('계정·ARN·비밀 원문 없이 origin과 기존 인증서 연결을 보존한다', () => {
    const profile = readDeploymentProfile(profilePath);
    expect(profile.publicBaseUrl).toBe('https://api-dev.pulsemetry.co.kr');
    expect(profile.frontendOrigin).toBe('https://dev.pulsemetry.co.kr');
    expect(profile.runtimeValuesPath).toBe(join(repository, 'config/dev/runtime.yaml'));
    expect(profile.certificates.additional).toEqual([{
      id: '77f93d1d-b750-46a6-b7c4-997da969cf41', logicalId: 'EksValidationAlbHttpAdditionalCertificate1AA7940BB',
    }]);
    expect(profileSource).not.toMatch(/arn:aws:|\b\d{12}\b|BEGIN .*PRIVATE KEY|clientSecret|password|account/i);
    expect(profileSource).not.toMatch(/reports|\/Users\//);
  });

  test('runtime 파일 경로를 profile 위치 기준으로 해석한다', () => {
    const profile = readFixture(fixture());
    expect(profile.runtimeValuesPath).toBe(join(directory, 'runtime.yaml'));
  });

  test.each([undefined, null, '', ' ', false, [], {}])('잘못된 profile 경로 %j를 거부한다', path => {
    expect(() => readDeploymentProfile(path)).toThrow(/devDeploymentProfile/);
  });

  test.each(['null', '[]', '{}', '{', '{"publicBaseUrl":"a","publicBaseUrl":"b"}'])('잘못되거나 불완전한 JSON %s를 거부한다', raw => {
    expect(() => readFixture(raw)).toThrow(/devDeploymentProfile/);
  });

  test.each(['publicBaseUrl', 'frontendOrigin'])('%s의 HTTPS origin 계약을 검사한다', key => {
    for (const value of ['http://example.com', 'https://example.com/', 'https://example.com:443', 'https://example.com:8443',
      'https://example.com?', 'https://example.com#', 'https://user:password@example.com', 'https://[::1]', 'https://with_space.example.com', null]) {
      expect(() => readFixture({ ...fixture(), [key]: value })).toThrow(key);
    }
  });

  test.each(['/tmp/runtime.yaml', '../runtime.yaml', './runtime.yaml', 'folder/runtime.yaml', 'runtime\\file.yaml', '', 'runtime.yaml '])(
    '개인·상위·잘못된 runtime 경로 %s를 거부한다', runtimeValuesFile => {
      expect(() => readFixture({ ...fixture(), runtimeValuesFile })).toThrow(/runtimeValuesFile/);
    },
  );

  test.each(['account', 'region', 'clientSecret', 'certificateArn'])('root에 허용하지 않은 %s를 거부하며 원문을 오류에 싣지 않는다', key => {
    const raw = { ...fixture(), [key]: 'sensitive-sentinel-do-not-print' };
    expect(() => readFixture(raw)).toThrow(/root/);
    try { readFixture(raw); } catch (error) { expect(String(error)).not.toContain('sensitive-sentinel'); }
  });

  test('인증서 ARN·중복·잘못된 ID와 추가 필드를 거부한다', () => {
    const base = fixture();
    const additional = base.certificates.additional[0];
    for (const certificates of [
      { ...base.certificates, defaultId: `arn:aws:acm:ap-northeast-2:${TEST_ENV.account}:certificate/${base.certificates.defaultId}` },
      { ...base.certificates, additional: [{ id: base.certificates.defaultId }] },
      { ...base.certificates, additional: [additional, additional] },
      { ...base.certificates, additional: [{ ...additional, logicalId: '0bad-id' }] },
      { ...base.certificates, additional: [{ ...additional, logicalId: 'A'.repeat(256) }] },
      { ...base.certificates, additional: [additional, { ...additional, id: '33333333-3333-4333-8333-333333333333' }] },
      { ...base.certificates, additional: [{ ...additional, secret: 'forbidden' }] },
      { ...base.certificates, account: TEST_ENV.account },
      { defaultId: base.certificates.defaultId },
    ]) expect(() => readFixture({ ...base, certificates })).toThrow(/certificates/);
  });

  test('기존 필수 context를 요구하고 임의 context·비밀 필드를 거부한다', () => {
    for (const key of Object.keys(fixture().context).filter(key => !['devKafkaProvider', 'devMskRetirementStage'].includes(key))) {
      const value = fixture();
      delete value.context[key];
      expect(() => readFixture(value)).toThrow(key);
    }
    for (const key of ['env', 'devEksPublicBaseUrl', 'devEksCertificateArn', 'devImageTag', 'password']) {
      const value = fixture();
      value.context[key] = 'not-allowed';
      expect(() => readFixture(value)).toThrow(/context/);
    }
  });

  test('기존 profile은 MSK 유지로 해석하고 삭제는 Strimzi에서만 허용한다', () => {
    const value = fixture();
    delete value.context.devKafkaProvider;
    delete value.context.devMskRetirementStage;
    expect(readFixture(value).context).toMatchObject({ devKafkaProvider: 'msk', devMskRetirementStage: 'retain' });
    value.context.devMskRetirementStage = 'cluster-removed';
    expect(() => readFixture(value)).toThrow('devMskRetirementStage');
    value.context.devKafkaProvider = 'strimzi';
    expect(readFixture(value).context.devMskRetirementStage).toBe('cluster-removed');
  });

  test.each([
    ['devOidcClientKeys', '["same","same"]'], ['devOidcClientKeys', ['bad key']],
    ['devAllowedCidr', '0.0.0.0/33'], ['devAllowedCidr', '999.0.0.0/24'], ['devAllowedCidr', ''],
    ['devAllowedCidr', '0.0.0.0/0,0.0.0.0/0'], ['devHttpRedirectEnabled', 'yes'],
    ['devEksArchivePrefix', 'unknown'], ['devEksOtlpTarget', 'unknown'],
    ['devKafkaProvider', 'unknown'], ['devMskRetirementStage', 'unknown'],
  ])('context %s의 잘못된 값을 거부한다', (key, value) => {
    const raw = fixture();
    raw.context[key as string] = value;
    expect(() => readFixture(raw)).toThrow(key as string);
  });

  test('계정은 실행 시에만 ARN에 합성하고 다른 계정으로도 재현한다', () => {
    const profile = readDeploymentProfile(profilePath);
    for (const account of [TEST_ENV.account, '222222222222']) {
      const context = createProfileContext(profile, account);
      expect(context.devEksCertificateArn).toBe(`arn:aws:acm:ap-northeast-2:${account}:certificate/${profile.certificates.defaultId}`);
      expect(context.devEksAdditionalCertificateLogicalIds).toEqual({
        [`arn:aws:acm:ap-northeast-2:${account}:certificate/${profile.certificates.additional[0].id}`]: profile.certificates.additional[0].logicalId,
      });
      expect(context).not.toHaveProperty('env');
      expect(profile).not.toHaveProperty('account');
    }
  });

  test.each([undefined, null, '', '123', 111111111111, '${AWS::AccountId}', ' 111111111111'])('확정되지 않은 계정 %j를 거부한다', account => {
    expect(() => createProfileContext(readDeploymentProfile(profilePath), account)).toThrow(/CDK_DEFAULT_ACCOUNT/);
  });

  test('CLI boolean·JSON 배열·맵과 목록 순서가 같은 의미면 적용한다', () => {
    const profile = readDeploymentProfile(profilePath);
    const expected = createProfileContext(profile, TEST_ENV.account);
    const app = new App({ context: {
      ...expected,
      devHttpRedirectEnabled: 'true',
      devOidcClientKeys: JSON.stringify([...expected.devOidcClientKeys].reverse()),
      devAllowedCidr: ' 0.0.0.0/0 ',
      devEksAdditionalCertificateArns: JSON.stringify(expected.devEksAdditionalCertificateArns),
      devEksAdditionalCertificateLogicalIds: JSON.stringify(expected.devEksAdditionalCertificateLogicalIds),
    } });
    applyProfileContext(app, profile, TEST_ENV.account);
    expect(loadDevConfig(app)).toEqual(loadDevConfig(new App({ context: expected })));
  });

  test.each([
    ['devEksPublicBaseUrl', 'https://old.example.com'], ['devHttpRedirectEnabled', false],
    ['devOidcClientKeys', []], ['devAllowedCidr', '10.0.0.0/8'],
    ['devEksAdditionalCertificateArns', []], ['devEksAdditionalCertificateLogicalIds', {}],
    ['devEksArchivePrefix', 'eks'], ['devEksOtlpTarget', 'gateway'],
  ])('명시한 %s가 충돌하면 context를 일부 적용하거나 리소스를 만들지 않는다', (key, value) => {
    const app = new App({ context: { [key as string]: value } });
    expect(() => applyProfileContext(app, readDeploymentProfile(profilePath), TEST_ENV.account)).toThrow(/충돌/);
    expect(app.node.tryGetContext('devEksCertificateArn')).toBeUndefined();
    expect(app.node.children).toHaveLength(0);
  });

  test('새 인증서는 logical ID를 생략해 기존 ARN 해시 식별자를 쓸 수 있다', () => {
    const raw = fixture();
    raw.certificates.additional = [{ id: '33333333-3333-4333-8333-333333333333' }];
    const profile = readFixture(raw);
    expect(createProfileContext(profile, TEST_ENV.account)).not.toHaveProperty('devEksAdditionalCertificateLogicalIds');
    const app = new App({ context: { devEksAdditionalCertificateLogicalIds: {} } });
    expect(() => applyProfileContext(app, profile, TEST_ENV.account)).toThrow(/충돌/);
  });

  test('공식 dev 명령만 profile을 기본 선택한다', () => {
    const scripts = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8')).scripts;
    for (const name of ['synth:dev', 'diff:dev', 'deploy:dev']) {
      expect(scripts[name]).toContain('-c env=dev -c devDeploymentProfile=config/dev/deployment.json');
    }
    expect(scripts['values:dev']).toBe('node scripts/eks-values.mjs --deployment-profile config/dev/deployment.json');
    for (const name of ['synth', 'diff', 'deploy', 'synth:cicd', 'diff:cicd', 'deploy:cicd']) {
      expect(scripts[name]).not.toContain('devDeploymentProfile');
    }
  });
});

describe('실제 CDK 진입점', () => {
  function run(context: Record<string, unknown>) {
    return spawnSync(process.execPath, ['--import', 'tsx', 'bin/infra.ts'], {
      cwd: repository,
      env: { ...process.env, CDK_DEFAULT_ACCOUNT: TEST_ENV.account, CDK_DEFAULT_REGION: TEST_ENV.region,
        CDK_OUTDIR: directory, CDK_CONTEXT_JSON: JSON.stringify({
          ...JSON.parse(readFileSync(join(repository, 'cdk.json'), 'utf8')).context,
          [`availability-zones:account=${TEST_ENV.account}:region=${TEST_ENV.region}`]: ['ap-northeast-2a', 'ap-northeast-2b', 'ap-northeast-2c'],
          ...context,
        }) },
      encoding: 'utf8', timeout: 60_000,
    });
  }

  test('추적 profile만 선택해 dev 네 스택과 기존 인증서 연결을 합성한다', () => {
    const result = run({ env: 'dev', devDeploymentProfile: profilePath });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const template = JSON.parse(readFileSync(join(directory, 'DevEdgeStack.template.json'), 'utf8'));
    expect(template.Outputs.ValidationPublicBaseUrl.Value).toBe('https://api-dev.pulsemetry.co.kr');
    expect(template.Resources.EksValidationAlbHttpAdditionalCertificate1AA7940BB.Type).toBe('AWS::ElasticLoadBalancingV2::ListenerCertificate');
    const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
    expect(Object.keys(manifest.artifacts).filter(key => /^Dev.*Stack$/.test(key)).sort())
      .toEqual(['DevDataStack', 'DevEdgeStack', 'DevEksStack', 'DevNetworkStack']);
  });

  test('profile 없이 기존 low-level dev 진입을 합성하면 HTTP fallback을 유지한다', () => {
    const result = run({ env: 'dev', devOidcClientKeys: [] });
    expect(result.status).toBe(0);
    const template = JSON.parse(readFileSync(join(directory, 'DevEdgeStack.template.json'), 'utf8'));
    expect(JSON.stringify(template.Outputs.ValidationPublicBaseUrl.Value)).toContain('http://');
    expect(template.Resources.EksValidationAlbHttpAdditionalCertificate1AA7940BB).toBeUndefined();
  });

  test.each(['prod', 'cicd'])('%s에서 dev profile을 선택하면 스택 조립 전에 거부한다', env => {
    const result = run({ env, devDeploymentProfile: profilePath });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('devDeploymentProfile은 env=dev에서만');
  });
});
