import * as path from 'path';
import { App, Aws } from 'aws-cdk-lib/core';
import { loadDevConfig } from '../../lib/dev/config';
import { synthDev } from '../../lib/dev/app';
import { buildDevApp, TEST_ENV } from '../helpers';

const CERTIFICATE_ARN = `arn:aws:acm:${TEST_ENV.region}:${TEST_ENV.account}:certificate/11111111-1111-4111-8111-111111111111`;
const EKS_CONTEXT = { devEksEnabled: true };

// 리소스를 만들지 않는 context 파싱과 생성 전 실패만 직접 App으로 검증한다.
function configApp(context: Record<string, unknown> = {}): App {
  return new App({ context: {
    devDashboardRuntimeFile: path.join(__dirname, '../fixtures/dashboard-runtime.json'),
    ...context,
  } });
}

describe('dev HTTPS context 입력', () => {
  test('인증서 생략 시 비활성이며 redirect 기본값은 true다', () => {
    const edge = loadDevConfig(configApp()).edge;
    expect(edge.certificateArn).toBeUndefined();
    expect(edge.eksCertificateArn).toBeUndefined();
    expect(edge.httpRedirectEnabled).toBe(true);
  });

  test.each([true, false, 'true', 'false'])('redirect=%j는 명시적 boolean으로 파싱한다', raw => {
    expect(loadDevConfig(configApp({ devHttpRedirectEnabled: raw })).edge.httpRedirectEnabled)
      .toBe(raw === true || raw === 'true');
  });

  test.each([null, '', ' ', 0, 1, 'TRUE', 'False', 'yes', [], {}])('redirect 잘못된 값 %j를 거부한다', raw => {
    expect(() => loadDevConfig(configApp({ devHttpRedirectEnabled: raw }))).toThrow(/devHttpRedirectEnabled/);
  });

  describe.each(['devCertificateArn', 'devEksCertificateArn'])('%s', key => {
    test('서울 ACM certificate ARN을 그대로 보존한다', () => {
      const edge = loadDevConfig(configApp({ ...EKS_CONTEXT, [key]: CERTIFICATE_ARN })).edge;
      expect(key === 'devCertificateArn' ? edge.certificateArn : edge.eksCertificateArn).toBe(CERTIFICATE_ARN);
    });

    test.each([
      null, '', ' ', false, 443, [], {},
      ` ${CERTIFICATE_ARN}`, `${CERTIFICATE_ARN} `, `${CERTIFICATE_ARN}\n`,
      'arn:aws:acm:ap-northeast-2:111111111111:certificate/not-a-uuid',
      CERTIFICATE_ARN.replace(':acm:', ':iam:'),
      CERTIFICATE_ARN.replace('arn:aws:', 'arn:aws-cn:'),
      CERTIFICATE_ARN.replace('ap-northeast-2', 'us-east-1'),
      CERTIFICATE_ARN.replace('111111111111:', '11111111111:'),
      CERTIFICATE_ARN.replace('certificate/', 'certificate:'),
      `${CERTIFICATE_ARN}/suffix`,
    ])('타입·형식·리전 오류 %j를 거부한다', raw => {
      expect(() => loadDevConfig(configApp({ ...EKS_CONTEXT, [key]: raw }))).toThrow(new RegExp(key));
    });

    test('배포 계정과 다른 인증서를 거부한다', () => {
      expect(() => buildDevApp({
        ...EKS_CONTEXT,
        [key]: CERTIFICATE_ARN.replace(TEST_ENV.account, '222222222222'),
      })).toThrow(new RegExp(key));
    });
  });

  test('EKS 비활성에서 EKS 인증서 입력을 거부한다', () => {
    expect(() => loadDevConfig(configApp({ devEksCertificateArn: CERTIFICATE_ARN })))
      .toThrow(/devEksCertificateArn/);
  });

  test.each([
    { account: undefined, region: TEST_ENV.region },
    { account: Aws.ACCOUNT_ID, region: TEST_ENV.region },
    { account: TEST_ENV.account, region: undefined },
    { account: TEST_ENV.account, region: Aws.REGION },
    { account: TEST_ENV.account, region: 'us-east-1' },
  ])('인증서가 있으면 미확정·불일치 배포 env를 리소스 생성 전에 거부한다: %j', env => {
    const app = configApp({ devCertificateArn: CERTIFICATE_ARN });
    const config = loadDevConfig(app);
    expect(() => synthDev(app, { env, config })).toThrow(/devCertificateArn/);
    expect(app.node.children).toHaveLength(0);
  });
});
