import { Template } from 'aws-cdk-lib/assertions';
import { App, Aws } from 'aws-cdk-lib/core';
import { loadDevConfig } from '../../lib/dev/config';
import { synthDev } from '../../lib/dev/app';
import { buildDevApp, TEST_ENV } from '../helpers';

const CERTIFICATE_ARN = `arn:aws:acm:${TEST_ENV.region}:${TEST_ENV.account}:certificate/11111111-1111-4111-8111-111111111111`;
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

  test('추가 SNI 인증서는 기본 인증서 없이 사용할 수 없다', () => {
    expect(() => loadDevConfig(configApp({ devEksAdditionalCertificateArn: CERTIFICATE_ARN })))
      .toThrow(/devEksAdditionalCertificateArn/);
  });

  test('추가 SNI 인증서는 같은 계정이어야 한다', () => {
    expect(() => buildDevApp({
      devEksCertificateArn: CERTIFICATE_ARN,
      devEksAdditionalCertificateArn: CERTIFICATE_ARN.replace(TEST_ENV.account, '222222222222'),
    })).toThrow(/devEksAdditionalCertificateArn/);
  });

  test('SNI 인증서 추가는 기본 HTTPS 인증서와 listener를 유지한다', () => {
    const additional = CERTIFICATE_ARN.replace('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');
    const { edge } = buildDevApp({ devEksCertificateArn: CERTIFICATE_ARN, devEksAdditionalCertificateArn: additional });
    const template = Template.fromStack(edge);
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 443, Protocol: 'HTTPS', Certificates: [{ CertificateArn: CERTIFICATE_ARN }],
    });
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::Listener', 2);
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::ListenerCertificate', 1);
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerCertificate', {
      Certificates: [{ CertificateArn: additional }],
    });
  });

  test('EKS 비활성 입력은 인증서 여부와 무관하게 거부한다', () => {
    expect(() => loadDevConfig(configApp({ devEksEnabled: false, devEksCertificateArn: CERTIFICATE_ARN })))
      .toThrow(/devEksEnabled/);
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
