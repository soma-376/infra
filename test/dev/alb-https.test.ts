import { Template } from 'aws-cdk-lib/assertions';
import { buildDevApp, BuiltDevApp, TEST_ENV } from '../helpers';

const LISTENER_ID = 'EksValidationAlbHttpB310BAC9';
const CERTIFICATE_ARN = `arn:aws:acm:${TEST_ENV.region}:${TEST_ENV.account}:certificate/22222222-2222-4222-8222-222222222222`;
const ADDITIONAL_CERTIFICATE_ARNS = [
  `arn:aws:acm:${TEST_ENV.region}:${TEST_ENV.account}:certificate/33333333-3333-4333-8333-333333333333`,
  `arn:aws:acm:${TEST_ENV.region}:${TEST_ENV.account}:certificate/44444444-4444-4444-8444-444444444444`,
];
const CIDRS = ['203.0.113.10/32', '198.51.100.0/24'];
const CONTEXT = { devAllowedCidr: CIDRS.join(',') };

function ingressRules(template: Template): any[] {
  const inline = Object.entries(template.findResources('AWS::EC2::SecurityGroup'))
    .flatMap(([id, resource]: [string, any]) => (resource.Properties.SecurityGroupIngress ?? [])
      .map((rule: any) => ({ ...rule, GroupId: { 'Fn::GetAtt': [id, 'GroupId'] } })));
  const standalone = Object.values(template.findResources('AWS::EC2::SecurityGroupIngress'))
    .map((resource: any) => resource.Properties);
  return [...inline, ...standalone];
}

function assertNoManagedCertificate(built: BuiltDevApp): void {
  for (const stack of [built.network, built.data, built.edge, built.eks]) {
    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::CertificateManager::Certificate', 0);
    template.resourceCountIs('AWS::Route53::RecordSet', 0);
    if (stack !== built.network) {
      template.resourceCountIs('AWS::EC2::SecurityGroup', 0);
      template.resourceCountIs('AWS::EC2::SecurityGroupIngress', 0);
    }
  }
}

describe('dev EKS ALB 외부 ACM 인증서', () => {
  const baseline = buildDevApp(CONTEXT);
  const baselineEdge = Template.fromStack(baseline.edge);
  const baselineNetwork = Template.fromStack(baseline.network);

  test('인증서가 없으면 기존 앱 80 listener와 53개 앱 규칙을 유지한다', () => {
    const listener = baselineEdge.toJSON().Resources[LISTENER_ID];
    expect(listener.Properties).toMatchObject({ Port: 80, Protocol: 'HTTP',
      DefaultActions: [{ Type: 'fixed-response', FixedResponseConfig: { StatusCode: '404' } }],
    });
    expect(listener.Properties.Certificates).toBeUndefined();
    expect(listener.Properties.SslPolicy).toBeUndefined();
    baselineEdge.resourceCountIs('AWS::ElasticLoadBalancingV2::ListenerRule', 53);
    baselineEdge.resourceCountIs('AWS::ElasticLoadBalancingV2::Listener', 1);
    expect(ingressRules(baselineNetwork).filter(rule => rule.FromPort === 443 && rule.CidrIp)).toEqual([]);
  });

  test('기존 listener를 HTTPS로 갱신하고 host·path·query를 보존하는 301을 추가한다', () => {
    const built = buildDevApp({ ...CONTEXT, devEksCertificateArn: CERTIFICATE_ARN });
    const edge = Template.fromStack(built.edge), network = Template.fromStack(built.network);
    const resources = edge.toJSON().Resources;
    expect(resources[LISTENER_ID].Properties).toEqual({
      ...baselineEdge.toJSON().Resources[LISTENER_ID].Properties,
      Port: 443, Protocol: 'HTTPS', Certificates: [{ CertificateArn: CERTIFICATE_ARN }],
      SslPolicy: 'ELBSecurityPolicy-TLS13-1-2-Res-2021-06',
    });
    const listeners = Object.values(edge.findResources('AWS::ElasticLoadBalancingV2::Listener')) as any[];
    expect(listeners).toHaveLength(2);
    const redirects = listeners.filter(listener => listener.Properties.Port === 80);
    expect(redirects).toHaveLength(1);
    expect(redirects[0]).toMatchObject({ DependsOn: expect.arrayContaining([LISTENER_ID]), Properties: {
      Port: 80, Protocol: 'HTTP', DefaultActions: [{ Type: 'redirect', RedirectConfig: {
        Protocol: 'HTTPS', Port: '443', Host: '#{host}', Path: '/#{path}', Query: '#{query}', StatusCode: 'HTTP_301',
      } }],
    } });
    // 기존 rule·TG·WAF·output은 인증서 유무와 무관하다.
    for (const [id, resource] of Object.entries(baselineEdge.toJSON().Resources)) {
      if (id !== LISTENER_ID) expect(resources[id]).toEqual(resource);
    }
    expect(edge.toJSON().Outputs).toEqual(baselineEdge.toJSON().Outputs);
    for (const key of ['data', 'eks'] as const) {
      expect(Template.fromStack(built[key]).toJSON()).toEqual(Template.fromStack(baseline[key]).toJSON());
    }
    const externalHttps = ingressRules(network).filter(rule => rule.FromPort === 443 && rule.CidrIp);
    expect(externalHttps).toHaveLength(CIDRS.length);
    for (const cidr of CIDRS) expect(externalHttps).toContainEqual(expect.objectContaining({
      GroupId: { 'Fn::GetAtt': ['DevEksValidationAlbSg7D5E6C15', 'GroupId'] },
      FromPort: 443, ToPort: 443, IpProtocol: 'tcp', CidrIp: cidr,
    }));
    expect(ingressRules(network).some(rule => rule.CidrIp === '0.0.0.0/0' || rule.CidrIpv6 === '::/0')).toBe(false);
    for (const [id, resource] of Object.entries(baselineNetwork.toJSON().Resources)) {
      expect(network.toJSON().Resources[id]).toEqual(resource);
    }
    assertNoManagedCertificate(built);
  });

  test.each([false, 'false'])('redirect=%j이면 HTTPS만 남긴다', value => {
    const built = buildDevApp({ ...CONTEXT, devEksCertificateArn: CERTIFICATE_ARN, devHttpRedirectEnabled: value });
    const template = Template.fromStack(built.edge);
    const listeners = Object.values(template.findResources('AWS::ElasticLoadBalancingV2::Listener')) as any[];
    expect(listeners.map(listener => listener.Properties.Port).sort((a, b) => a - b)).toEqual([443]);
    expect(template.findResources('AWS::ElasticLoadBalancingV2::ListenerRule')).toEqual(
      baselineEdge.findResources('AWS::ElasticLoadBalancingV2::ListenerRule'),
    );
    assertNoManagedCertificate(built);
  });

  test('redirect=false는 인증서가 없는 ALB의 HTTP를 제거하지 않는다', () => {
    const built = buildDevApp({ ...CONTEXT, devHttpRedirectEnabled: false });
    expect(Template.fromStack(built.edge).toJSON()).toEqual(baselineEdge.toJSON());
    expect(Template.fromStack(built.network).toJSON()).toEqual(baselineNetwork.toJSON());
  });

  test('공개 origin은 기존 output 값만 바꾸고 listener·라우팅·다른 스택을 유지한다', () => {
    const context = { ...CONTEXT, devEksCertificateArn: CERTIFICATE_ARN };
    const before = buildDevApp(context);
    const after = buildDevApp({ ...context, devEksPublicBaseUrl: 'https://api-dev.pulsemetry.co.kr' });
    const oldEdge = Template.fromStack(before.edge).toJSON();
    const newEdge = Template.fromStack(after.edge).toJSON();
    expect(newEdge.Resources).toEqual(oldEdge.Resources);
    expect(newEdge.Outputs).toEqual({
      ...oldEdge.Outputs,
      ValidationPublicBaseUrl: { Value: 'https://api-dev.pulsemetry.co.kr' },
    });
    expect(oldEdge.Outputs.ValidationPublicBaseUrl).toEqual(baselineEdge.toJSON().Outputs.ValidationPublicBaseUrl);
    for (const key of ['network', 'data', 'eks'] as const) {
      expect(Template.fromStack(after[key]).toJSON()).toEqual(Template.fromStack(before[key]).toJSON());
    }
  });

  test('추가 인증서는 기본 인증서·기존 리소스를 보존하고 배열 순서와 무관한 ID를 갖는다', () => {
    const context = {
      ...CONTEXT, devEksCertificateArn: CERTIFICATE_ARN,
      devEksPublicBaseUrl: 'https://api-dev.pulsemetry.co.kr',
    };
    const original = Template.fromStack(buildDevApp(context).edge);
    const first = Template.fromStack(buildDevApp({
      ...context, devEksAdditionalCertificateArns: [ADDITIONAL_CERTIFICATE_ARNS[0]],
    }).edge);
    const built = buildDevApp({ ...context, devEksAdditionalCertificateArns: ADDITIONAL_CERTIFICATE_ARNS });
    const added = Template.fromStack(built.edge);
    const reordered = Template.fromStack(buildDevApp({
      ...context, devEksAdditionalCertificateArns: [...ADDITIONAL_CERTIFICATE_ARNS].reverse(),
    }).edge);
    added.resourceCountIs('AWS::ElasticLoadBalancingV2::ListenerCertificate', 2);
    added.resourceCountIs('AWS::ElasticLoadBalancingV2::ListenerRule', 53);
    for (const arn of ADDITIONAL_CERTIFICATE_ARNS) {
      added.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerCertificate', {
        Certificates: [{ CertificateArn: arn }], ListenerArn: { Ref: LISTENER_ID },
      });
    }
    for (const [id, resource] of Object.entries(original.toJSON().Resources)) {
      expect(added.toJSON().Resources[id]).toEqual(resource);
    }
    for (const [id, resource] of Object.entries(first.findResources('AWS::ElasticLoadBalancingV2::ListenerCertificate'))) {
      expect(added.toJSON().Resources[id]).toEqual(resource);
    }
    expect(added.toJSON().Outputs).toEqual(original.toJSON().Outputs);
    expect(reordered.toJSON()).toEqual(added.toJSON());
    assertNoManagedCertificate(built);
  });

  test('기존 추가 인증서 logical ID를 유지하며 재정렬·새 인증서 추가로 바꾸지 않는다', () => {
    const legacyId = 'EksValidationAlbHttpAdditionalCertificate1AA7940BB';
    const context = {
      ...CONTEXT, devEksCertificateArn: CERTIFICATE_ARN,
      devEksAdditionalCertificateLogicalIds: { [ADDITIONAL_CERTIFICATE_ARNS[0]]: legacyId },
    };
    const first = Template.fromStack(buildDevApp({
      ...context, devEksAdditionalCertificateArns: [ADDITIONAL_CERTIFICATE_ARNS[0]],
    }).edge);
    first.resourceCountIs('AWS::ElasticLoadBalancingV2::ListenerCertificate', 1);
    expect(first.toJSON().Resources[legacyId]).toMatchObject({
      Type: 'AWS::ElasticLoadBalancingV2::ListenerCertificate',
      Properties: { Certificates: [{ CertificateArn: ADDITIONAL_CERTIFICATE_ARNS[0] }], ListenerArn: { Ref: LISTENER_ID } },
    });
    const added = Template.fromStack(buildDevApp({
      ...context, devEksAdditionalCertificateArns: ADDITIONAL_CERTIFICATE_ARNS,
    }).edge);
    const reordered = Template.fromStack(buildDevApp({
      ...context, devEksAdditionalCertificateArns: [...ADDITIONAL_CERTIFICATE_ARNS].reverse(),
    }).edge);
    added.resourceCountIs('AWS::ElasticLoadBalancingV2::ListenerCertificate', 2);
    for (const [id, resource] of Object.entries(first.toJSON().Resources)) {
      expect(added.toJSON().Resources[id]).toEqual(resource);
    }
    expect(reordered.toJSON()).toEqual(added.toJSON());
    const unmapped = Template.fromStack(buildDevApp({
      ...CONTEXT, devEksCertificateArn: CERTIFICATE_ARN,
      devEksAdditionalCertificateArns: [ADDITIONAL_CERTIFICATE_ARNS[1]],
    }).edge).findResources('AWS::ElasticLoadBalancingV2::ListenerCertificate');
    for (const [id, resource] of Object.entries(unmapped)) {
      expect(added.toJSON().Resources[id]).toEqual(resource);
    }
  });
});
