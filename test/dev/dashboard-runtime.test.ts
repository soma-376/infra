import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const { load } = require('js-yaml');
const { parseRuntimeInputs } = require('../../lib/dev/runtime-input.cjs');
const fixture = () => load(readFileSync(join(__dirname, '../fixtures/eks-runtime.yaml'), 'utf8'));

describe('EKS dashboard runtime 입력', () => {
  test.each([
    (v: any) => { v.writerImage = 'unused-ecs-writer'; },
    (v: any) => { v.userAuth.publicVersionId = 'AWSCURRENT'; },
    (v: any) => { v.userAuth.publicKeys[0].alias = '../escape.pem'; },
    (v: any) => { v.userAuth.publicKeys[0].alias = 'private.pem'; },
    (v: any) => { v.userAuth.publicKeys.push(v.userAuth.publicKeys[0]); },
    (v: any) => { v.userAuth.activeKid = 'missing'; },
    (v: any) => { v.userAuth.privatePem = 'sensitive-marker'; },
    (v: any) => { v.userAuth.allowedOrigins = ['*']; },
    (v: any) => { v.userAuth.allowedOrigins = ['https://example.invalid/path']; },
    (v: any) => { v.dashboard.settings.PULSEMETRY_DB_PASSWORD = 'sensitive-marker'; },
    (v: any) => { delete v.dashboard.settings.PULSEMETRY_DASHBOARD_SNAPSHOT_BUILD_TIMEOUT; },
    (v: any) => { v.dashboard.settings.PULSEMETRY_DASHBOARD_INGEST_DOWN_AFTER = '1s'; },
    (v: any) => { v.dashboard.settings.PULSEMETRY_DASHBOARD_RETRY_AFTER = '1.5s'; },
    (v: any) => { v.dashboard.settings.PULSEMETRY_DASHBOARD_SNAPSHOT_MAX_CONCURRENT_BUILDS = '2147483648'; },
    (v: any) => { v.dashboard.managementEnabled = true; },
    (v: any) => { v.dashboard.mailEnabled = true; },
    (v: any) => { v.userAuth.publicKeys[0].alias = 'a'.repeat(97) + '.pem'; },
    (v: any) => { v.userAuth.allowedOrigins = ['https://a,b.example.invalid']; },
    (v: any) => { v.dashboard.settings.PULSEMETRY_DASHBOARD_RETRY_AFTER = '999999999999999999999s'; },
  ])('잘못된 값과 원문 공급을 차단한다 #%#', change => {
    const value = fixture(); change(value);
    expect(() => parseRuntimeInputs(value)).toThrow('runtime 입력 오류');
    try { parseRuntimeInputs(value); } catch (error) { expect(String(error)).not.toContain('sensitive-marker'); }
  });
  test('정수 밀리초를 부동소수점 반올림 없이 허용한다', () => {
    const input = fixture(); input.dashboard.settings.PULSEMETRY_DASHBOARD_RETRY_AFTER = '1001ms';
    expect(() => parseRuntimeInputs(input)).not.toThrow();
  });

  test.each([{}, { enrollment: 'require' }, { ingest: 'require' }, { enrollment: 'require', ingest: 'require' }])(
    '선택적 PostgreSQL TLS 모드 %j를 보존한다', modes => {
      const input = fixture(); input.postgresSslMode = modes;
      expect(parseRuntimeInputs(input).postgresSslMode).toEqual(modes);
    },
  );

  test.each([
    null, [], 'require', true,
    { dashboard: 'require' }, { enrollment: 'disable' }, { ingest: 'prefer' },
    { enrollment: 'verify-full' }, { enrollment: null }, { ingest: 'sensitive-marker' },
  ])('허용하지 않은 PostgreSQL TLS 입력 %j를 거부한다', modes => {
    const input = fixture(); input.postgresSslMode = modes;
    expect(() => parseRuntimeInputs(input)).toThrow('postgresSslMode');
    try { parseRuntimeInputs(input); } catch (error) { expect(String(error)).not.toContain('sensitive-marker'); }
  });
});

function mailRuntime() {
  const input = fixture();
  input.dashboard.managementEnabled = true;
  input.dashboard.mailEnabled = true;
  input.management = {
    responseKeyVersionId: 'a'.repeat(32), onboardingOtlpEndpoint: 'https://api-dev.pulsemetry.co.kr',
    invitationAcceptUrl: 'https://dev.pulsemetry.co.kr/login', installationPageUrl: 'https://dev.pulsemetry.co.kr/install',
  };
  input.mail = { encryptionKeyVersionId: 'b'.repeat(32), provider: 'ses', from: 'no-reply@pulsemetry.co.kr',
    region: 'ap-northeast-2', dispatchInterval: 'PT5S', retryInterval: 'PT1M', maxAttempts: 3, sendTimeout: 'PT15S' };
  return input;
}

test('관리·SES를 독립된 고정 키 버전과 명시 설정으로 활성화한다', () => {
  const input = mailRuntime();
  expect(parseRuntimeInputs(input)).toEqual(input);
});

test.each([
  (v: any) => { v.management.responseKeyVersionId = 'AWSCURRENT'; },
  (v: any) => { v.management.secretArn = 'sensitive-marker'; },
  (v: any) => { v.management.installationPageUrl += '?code=sensitive-marker'; },
  (v: any) => { v.management.installationPageUrl = v.management.invitationAcceptUrl; },
  (v: any) => { v.management.onboardingOtlpEndpoint = 'http://example.test'; },
  (v: any) => { v.mail.encryptionKey = 'sensitive-marker'; },
  (v: any) => { v.mail.encryptionKeyVersionId = 'AWSCURRENT'; },
  (v: any) => { v.mail.from = 'other@example.test'; },
  (v: any) => { v.mail.provider = 'smtp'; },
  (v: any) => { v.mail.region = 'us-east-1'; },
  (v: any) => { v.mail.maxAttempts = 0; },
  (v: any) => { v.mail.sendTimeout = 'PT0S'; },
  (v: any) => { v.dashboard.managementEnabled = false; },
])('SES 활성 입력은 비밀 원문·불완전 설정·권한 불일치를 거부한다 #%#', change => {
  const value = mailRuntime(); change(value);
  expect(() => parseRuntimeInputs(value)).toThrow('runtime 입력 오류');
  try { parseRuntimeInputs(value); } catch (error) { expect(String(error)).not.toContain('sensitive-marker'); }
});
