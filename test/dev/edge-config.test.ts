import { App, Aws } from 'aws-cdk-lib/core';
import { loadDevConfig } from '../../lib/dev/config';
import { synthDev } from '../../lib/dev/app';
import { buildDevApp, TEST_ENV } from '../helpers';

const CERTIFICATE_ARN = `arn:aws:acm:${TEST_ENV.region}:${TEST_ENV.account}:certificate/11111111-1111-4111-8111-111111111111`;
const ADDITIONAL_CERTIFICATE_ARN = `arn:aws:acm:${TEST_ENV.region}:${TEST_ENV.account}:certificate/22222222-2222-4222-8222-222222222222`;
const PUBLIC_BASE_URL = 'https://api-dev.pulsemetry.co.kr';
const EKS_CONTEXT = { devEksEnabled: true };

// 리소스를 만들지 않는 context 파싱과 생성 전 실패만 직접 App으로 검증한다.
function configApp(context: Record<string, unknown> = {}): App {
  return new App({ context: {
    devOidcClientKeys: [],
    ...context,
  } });
}

describe('dev HTTPS context 입력', () => {
  test('인증서 생략 시 비활성이며 redirect 기본값은 true다', () => {
    const edge = loadDevConfig(configApp()).edge;
    expect(edge.eksCertificateArn).toBeUndefined();
    expect(edge.eksAdditionalCertificateArns).toEqual([]);
    expect(edge.eksAdditionalCertificateLogicalIds).toEqual({});
    expect(edge.eksPublicBaseUrl).toBeUndefined();
    expect(edge.httpRedirectEnabled).toBe(true);
  });

  test.each([true, false, 'true', 'false'])('redirect=%j는 명시적 boolean으로 파싱한다', raw => {
    expect(loadDevConfig(configApp({ devHttpRedirectEnabled: raw })).edge.httpRedirectEnabled)
      .toBe(raw === true || raw === 'true');
  });

  test.each([null, '', ' ', 0, 1, 'TRUE', 'False', 'yes', [], {}])('redirect 잘못된 값 %j를 거부한다', raw => {
    expect(() => loadDevConfig(configApp({ devHttpRedirectEnabled: raw }))).toThrow(/devHttpRedirectEnabled/);
  });

  describe.each(['devEksCertificateArn'])('%s', key => {
    test('서울 ACM certificate ARN을 그대로 보존한다', () => {
      const edge = loadDevConfig(configApp({ ...EKS_CONTEXT, [key]: CERTIFICATE_ARN })).edge;
      expect(edge.eksCertificateArn).toBe(CERTIFICATE_ARN);
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

  test('EKS 비활성 입력은 인증서 여부와 무관하게 거부한다', () => {
    expect(() => loadDevConfig(configApp({ devEksEnabled: false, devEksCertificateArn: CERTIFICATE_ARN })))
      .toThrow(/devEksEnabled/);
  });

  describe('공개 HTTPS origin', () => {
    test('기본 인증서와 지정한 origin을 그대로 보존한다', () => {
      const edge = loadDevConfig(configApp({
        devEksCertificateArn: CERTIFICATE_ARN, devEksPublicBaseUrl: PUBLIC_BASE_URL,
      })).edge;
      expect(edge.eksPublicBaseUrl).toBe(PUBLIC_BASE_URL);
    });

    test('인증서 없는 origin을 거부한다', () => {
      expect(() => loadDevConfig(configApp({ devEksPublicBaseUrl: PUBLIC_BASE_URL })))
        .toThrow(/devEksPublicBaseUrl.*devEksCertificateArn/);
    });

    test.each([
      null, '', false, 443, [], {},
      'http://api-dev.pulsemetry.co.kr', 'api-dev.pulsemetry.co.kr',
      'https://[::1]', 'https://api_dev.pulsemetry.co.kr',
      `${PUBLIC_BASE_URL}/`, `${PUBLIC_BASE_URL}/api`,
      `${PUBLIC_BASE_URL}?`, `${PUBLIC_BASE_URL}?key=value`,
      `${PUBLIC_BASE_URL}#`, `${PUBLIC_BASE_URL}#fragment`,
      `${PUBLIC_BASE_URL}:443`, `${PUBLIC_BASE_URL}:8443`,
      'https://user:password@api-dev.pulsemetry.co.kr', 'https://@api-dev.pulsemetry.co.kr',
      ` ${PUBLIC_BASE_URL}`, `${PUBLIC_BASE_URL}\n`,
      'https://api-dev.pulsemetry.co.kr\\path',
    ])('origin이 아닌 입력 %j를 거부한다', raw => {
      expect(() => loadDevConfig(configApp({
        devEksCertificateArn: CERTIFICATE_ARN, devEksPublicBaseUrl: raw,
      }))).toThrow(/devEksPublicBaseUrl/);
    });
  });

  describe('추가 SNI 인증서', () => {
    test.each([
      { raw: [ADDITIONAL_CERTIFICATE_ARN] }, { raw: JSON.stringify([ADDITIONAL_CERTIFICATE_ARN]) },
    ])(
      '배열과 CLI JSON 배열을 허용한다: $raw', ({ raw }) => {
        expect(loadDevConfig(configApp({
          devEksCertificateArn: CERTIFICATE_ARN, devEksAdditionalCertificateArns: raw,
        })).edge.eksAdditionalCertificateArns).toEqual([ADDITIONAL_CERTIFICATE_ARN]);
      },
    );

    test('빈 목록은 인증서 없는 기존 HTTP 구성에서도 허용한다', () => {
      expect(loadDevConfig(configApp({ devEksAdditionalCertificateArns: [] })).edge.eksAdditionalCertificateArns)
        .toEqual([]);
    });

    test('기본 인증서 없는 추가 목록을 거부한다', () => {
      expect(() => loadDevConfig(configApp({ devEksAdditionalCertificateArns: [ADDITIONAL_CERTIFICATE_ARN] })))
        .toThrow(/devEksAdditionalCertificateArns.*devEksCertificateArn/);
    });

    test.each([
      null, '', false, 443, {}, 'null', '{}', '[', ADDITIONAL_CERTIFICATE_ARN,
      [null], [false], [ADDITIONAL_CERTIFICATE_ARN + ' '],
      [ADDITIONAL_CERTIFICATE_ARN.replace('ap-northeast-2', 'us-east-1')],
      [ADDITIONAL_CERTIFICATE_ARN.replace(':acm:', ':iam:')],
      [CERTIFICATE_ARN], [ADDITIONAL_CERTIFICATE_ARN, ADDITIONAL_CERTIFICATE_ARN],
    ].map(raw => [raw]))('형식·리전·중복 오류 %j를 거부한다', raw => {
      expect(() => loadDevConfig(configApp({
        devEksCertificateArn: CERTIFICATE_ARN, devEksAdditionalCertificateArns: raw,
      }))).toThrow(/devEksAdditionalCertificateArns/);
    });

    test('추가 인증서의 다른 계정을 리소스 생성 전에 거부한다', () => {
      const app = configApp({
        devEksCertificateArn: CERTIFICATE_ARN,
        devEksAdditionalCertificateArns: [ADDITIONAL_CERTIFICATE_ARN.replace(TEST_ENV.account, '222222222222')],
      });
      expect(() => synthDev(app, { env: TEST_ENV, config: loadDevConfig(app) }))
        .toThrow(/devEksAdditionalCertificateArns/);
      expect(app.node.children).toHaveLength(0);
    });
  });

  describe('배포된 추가 인증서 logical ID 보존', () => {
    const existingId = 'EksValidationAlbHttpAdditionalCertificate1AA7940BB';
    const mapping = { [ADDITIONAL_CERTIFICATE_ARN]: existingId };
    const context = { devEksCertificateArn: CERTIFICATE_ARN, devEksAdditionalCertificateArns: [ADDITIONAL_CERTIFICATE_ARN] };

    test.each([{ raw: mapping }, { raw: JSON.stringify(mapping) }])('객체와 CLI JSON 객체를 허용한다: $raw', ({ raw }) => {
      expect(loadDevConfig(configApp({ ...context, devEksAdditionalCertificateLogicalIds: raw }))
        .edge.eksAdditionalCertificateLogicalIds).toEqual(mapping);
    });

    test.each([
      null, '', false, 1, [], {}, 'null', '{}', '[',
      { [CERTIFICATE_ARN]: existingId }, { '': existingId },
      { [ADDITIONAL_CERTIFICATE_ARN]: '' }, { [ADDITIONAL_CERTIFICATE_ARN]: '123Invalid' },
      { [ADDITIONAL_CERTIFICATE_ARN]: 'Invalid-ID' }, { [ADDITIONAL_CERTIFICATE_ARN]: 'a'.repeat(256) },
      { [ADDITIONAL_CERTIFICATE_ARN]: null },
    ].map(raw => [raw]))('잘못된 호환 맵 %j를 거부한다', raw => {
      expect(() => loadDevConfig(configApp({ ...context, devEksAdditionalCertificateLogicalIds: raw })))
        .toThrow(/devEksAdditionalCertificateLogicalIds/);
    });

    test('추가 인증서마다 같은 logical ID를 지정할 수 없다', () => {
      const other = ADDITIONAL_CERTIFICATE_ARN.replace('certificate/2', 'certificate/3');
      expect(() => loadDevConfig(configApp({
        ...context, devEksAdditionalCertificateArns: [ADDITIONAL_CERTIFICATE_ARN, other],
        devEksAdditionalCertificateLogicalIds: { ...mapping, [other]: existingId },
      }))).toThrow(/devEksAdditionalCertificateLogicalIds.*중복/);
    });
  });

  test.each([
    { account: undefined, region: TEST_ENV.region },
    { account: Aws.ACCOUNT_ID, region: TEST_ENV.region },
    { account: TEST_ENV.account, region: undefined },
    { account: TEST_ENV.account, region: Aws.REGION },
    { account: TEST_ENV.account, region: 'us-east-1' },
  ])('인증서가 있으면 미확정·불일치 배포 env를 리소스 생성 전에 거부한다: %j', env => {
    const app = configApp({ devEksCertificateArn: CERTIFICATE_ARN });
    const config = loadDevConfig(app);
    expect(() => synthDev(app, { env, config })).toThrow(/devEksCertificateArn/);
    expect(app.node.children).toHaveLength(0);
  });
});
