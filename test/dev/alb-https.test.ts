import { Template } from 'aws-cdk-lib/assertions';
import { buildDevApp, BuiltDevApp, TEST_ENV } from '../helpers';

const ECS_LISTENER_ID = 'DevAlbDevHttpListener5D5CFB98';
const EKS_LISTENER_ID = 'EksValidationAlbHttpB310BAC9';
const ECS_CERTIFICATE_ARN = `arn:aws:acm:${TEST_ENV.region}:${TEST_ENV.account}:certificate/11111111-1111-4111-8111-111111111111`;
const EKS_CERTIFICATE_ARN = `arn:aws:acm:${TEST_ENV.region}:${TEST_ENV.account}:certificate/22222222-2222-4222-8222-222222222222`;
const ALLOWED_CIDRS = ['203.0.113.10/32', '198.51.100.0/24'];
const EKS_CONTEXT = {
  devEksEnabled: true,
  devEksApiAllowedCidrs: '203.0.113.10/32',
  devAllowedCidr: ALLOWED_CIDRS.join(','),
};

function ingressRules(template: Template): any[] {
  const inline = Object.entries(template.findResources('AWS::EC2::SecurityGroup'))
    .flatMap(([id, resource]: [string, any]) => (resource.Properties.SecurityGroupIngress ?? [])
      .map((rule: any) => ({ ...rule, GroupId: { 'Fn::GetAtt': [id, 'GroupId'] } })));
  const standalone = Object.values(template.findResources('AWS::EC2::SecurityGroupIngress'))
    .map((resource: any) => resource.Properties);
  return [...inline, ...standalone];
}

function assertNoManagedCertificate(built: BuiltDevApp): void {
  for (const stack of [built.network, built.data, built.application, built.edge, built.eks]) {
    if (!stack) continue;
    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::CertificateManager::Certificate', 0);
    template.resourceCountIs('AWS::Route53::RecordSet', 0);
    if (stack !== built.network) {
      template.resourceCountIs('AWS::EC2::SecurityGroup', 0);
      template.resourceCountIs('AWS::EC2::SecurityGroupIngress', 0);
    }
  }
}

describe('dev ALB 외부 ACM 인증서', () => {
  const baseline = buildDevApp(EKS_CONTEXT);
  const baselineEdge = Template.fromStack(baseline.edge);
  const baselineNetwork = Template.fromStack(baseline.network);

  test('인증서가 없으면 기존 80/8123 listener와 앱별 53개 규칙을 유지한다', () => {
    for (const listenerId of [ECS_LISTENER_ID, EKS_LISTENER_ID]) {
      const listener = baselineEdge.toJSON().Resources[listenerId];
      expect(listener.Properties).toMatchObject({
        Port: 80,
        Protocol: 'HTTP',
        DefaultActions: [{ Type: 'fixed-response', FixedResponseConfig: { StatusCode: '404' } }],
      });
      expect(listener.Properties.Certificates).toBeUndefined();
      expect(listener.Properties.SslPolicy).toBeUndefined();
      const rules = Object.values(baselineEdge.findResources('AWS::ElasticLoadBalancingV2::ListenerRule'))
        .filter((rule: any) => rule.Properties.ListenerArn.Ref === listenerId);
      expect(rules).toHaveLength(53);
    }
    baselineEdge.resourceCountIs('AWS::ElasticLoadBalancingV2::Listener', 4);
    expect(ingressRules(baselineNetwork).filter(rule => rule.FromPort === 443 && rule.CidrIp)).toEqual([]);
  });

  test.each([
    ['ECS만', ECS_CERTIFICATE_ARN, undefined],
    ['EKS만', undefined, EKS_CERTIFICATE_ARN],
    ['서로 다른 인증서', ECS_CERTIFICATE_ARN, EKS_CERTIFICATE_ARN],
    ['같은 인증서', ECS_CERTIFICATE_ARN, ECS_CERTIFICATE_ARN],
  ] as const)('%s 적용은 해당 ALB만 HTTPS와 301로 전환한다', (_name, ecsArn, eksArn) => {
    const built = buildDevApp({
      ...EKS_CONTEXT,
      ...(ecsArn ? { devCertificateArn: ecsArn } : {}),
      ...(eksArn ? { devEksCertificateArn: eksArn } : {}),
    });
    const edge = Template.fromStack(built.edge);
    const network = Template.fromStack(built.network);
    const resources = edge.toJSON().Resources;
    const listeners = edge.findResources('AWS::ElasticLoadBalancingV2::Listener');

    for (const [listenerId, arn] of [[ECS_LISTENER_ID, ecsArn], [EKS_LISTENER_ID, eksArn]] as const) {
      const listener = resources[listenerId];
      const before = baselineEdge.toJSON().Resources[listenerId];
      if (!arn) {
        expect(listener).toEqual(before);
        continue;
      }
      expect(listener.Properties).toEqual({
        ...before.Properties,
        Port: 443,
        Protocol: 'HTTPS',
        Certificates: [{ CertificateArn: arn }],
        SslPolicy: 'ELBSecurityPolicy-TLS13-1-2-Res-2021-06',
      });
      const redirects = Object.values(listeners).filter((candidate: any) =>
        candidate.Properties.Port === 80 &&
        JSON.stringify(candidate.Properties.LoadBalancerArn) === JSON.stringify(listener.Properties.LoadBalancerArn));
      expect(redirects).toHaveLength(1);
      expect(redirects[0]).toMatchObject({
        DependsOn: expect.arrayContaining([listenerId]),
        Properties: {
          Port: 80,
          Protocol: 'HTTP',
          DefaultActions: [{
            Type: 'redirect',
            RedirectConfig: {
              Protocol: 'HTTPS', Port: '443', Host: '#{host}', Path: '/#{path}',
              Query: '#{query}', StatusCode: 'HTTP_301',
            },
          }],
        },
      });
    }
    expect(Object.keys(listeners)).toHaveLength(4 + Number(Boolean(ecsArn)) + Number(Boolean(eksArn)));

    // 기존 listener를 제자리 갱신해야 rule의 ListenerArn과 priority까지 전부 보존된다.
    expect(edge.findResources('AWS::ElasticLoadBalancingV2::ListenerRule')).toEqual(
      baselineEdge.findResources('AWS::ElasticLoadBalancingV2::ListenerRule'),
    );
    for (const [id, resource] of Object.entries(baselineEdge.toJSON().Resources)) {
      if (![ECS_LISTENER_ID, EKS_LISTENER_ID].includes(id)) expect(resources[id]).toEqual(resource);
    }
    expect(edge.toJSON().Outputs).toEqual(baselineEdge.toJSON().Outputs);
    for (const key of ['data', 'application', 'eks'] as const) {
      expect(Template.fromStack(built[key]!).toJSON()).toEqual(Template.fromStack(baseline[key]!).toJSON());
    }

    const externalHttps = ingressRules(network).filter(rule => rule.FromPort === 443 && rule.CidrIp);
    const expectedGroups = Object.entries(network.findResources('AWS::EC2::SecurityGroup'))
      .filter(([id]) => (Boolean(ecsArn) && id.startsWith('DevAlbSg')) || (Boolean(eksArn) && id.startsWith('DevEksValidationAlbSg')))
      .map(([id]) => id);
    expect(externalHttps).toHaveLength(expectedGroups.length * ALLOWED_CIDRS.length);
    for (const id of expectedGroups) {
      for (const cidr of ALLOWED_CIDRS) {
        expect(externalHttps).toContainEqual(expect.objectContaining({
          GroupId: { 'Fn::GetAtt': [id, 'GroupId'] },
          FromPort: 443, ToPort: 443, IpProtocol: 'tcp', CidrIp: cidr,
        }));
      }
    }
    expect(ingressRules(network).some(rule => rule.CidrIp === '0.0.0.0/0' || rule.CidrIpv6 === '::/0')).toBe(false);
    for (const [id, resource] of Object.entries(baselineNetwork.toJSON().Resources)) {
      const changed = structuredClone(network.toJSON().Resources[id]);
      if (changed.Properties.SecurityGroupIngress) {
        changed.Properties.SecurityGroupIngress = changed.Properties.SecurityGroupIngress
          .filter((rule: any) => !(rule.FromPort === 443 && rule.CidrIp));
      }
      expect(changed).toEqual(resource);
    }
    assertNoManagedCertificate(built);
  });

  test('EKS 비활성에서도 ECS에만 인증서를 연결한다', () => {
    const built = buildDevApp({ devCertificateArn: ECS_CERTIFICATE_ARN, devAllowedCidr: ALLOWED_CIDRS[0] });
    const template = Template.fromStack(built.edge);
    expect(built.eks).toBeUndefined();
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 1);
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::Listener', 3);
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::ListenerRule', 53);
    expect(template.toJSON().Resources[ECS_LISTENER_ID].Properties.Certificates).toEqual([{ CertificateArn: ECS_CERTIFICATE_ARN }]);
    assertNoManagedCertificate(built);
  });

  test.each([false, 'false'])('redirect=%j 중간 단계는 양쪽 HTTPS만 남기고 80 listener를 생성하지 않는다', value => {
    const built = buildDevApp({
      ...EKS_CONTEXT,
      devCertificateArn: ECS_CERTIFICATE_ARN,
      devEksCertificateArn: EKS_CERTIFICATE_ARN,
      devHttpRedirectEnabled: value,
    });
    const template = Template.fromStack(built.edge);
    const listeners = Object.values(template.findResources('AWS::ElasticLoadBalancingV2::Listener'));
    expect(listeners.map((listener: any) => listener.Properties.Port).sort((a, b) => a - b)).toEqual([443, 443, 8123, 8123]);
    expect(template.findResources('AWS::ElasticLoadBalancingV2::ListenerRule')).toEqual(
      baselineEdge.findResources('AWS::ElasticLoadBalancingV2::ListenerRule'),
    );
  });

  test('redirect=false는 인증서가 없는 ALB의 HTTP를 제거하지 않는다', () => {
    const built = buildDevApp({ ...EKS_CONTEXT, devHttpRedirectEnabled: false });
    expect(Template.fromStack(built.edge).toJSON()).toEqual(baselineEdge.toJSON());
    expect(Template.fromStack(built.network).toJSON()).toEqual(baselineNetwork.toJSON());
  });
});
