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
});
