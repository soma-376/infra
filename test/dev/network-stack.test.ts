import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { DEV_VPC_CIDR } from '../../lib/dev/config';
import { PORTS } from '../../lib/common/config';
import { buildDevApp } from '../helpers';

/** CIDR inline 규칙과 별도 SG peer 규칙을 모두 검사한다. */
function allIngressRules(template: Template): any[] {
  const inline = Object.values(template.findResources('AWS::EC2::SecurityGroup'))
    .flatMap((resource: any) => resource.Properties.SecurityGroupIngress ?? []);
  const standalone = Object.values(template.findResources('AWS::EC2::SecurityGroupIngress'))
    .map((resource: any) => resource.Properties);
  return [...inline, ...standalone];
}

function fixture(devAllowedCidr?: string) {
  const { network } = buildDevApp(devAllowedCidr === undefined ? {} : { devAllowedCidr });
  return { network, template: Template.fromStack(network) };
}
const CIDRS = ['203.0.113.10/32', '198.51.100.0/24'];
const baseline = fixture();
const narrowed = fixture(CIDRS[0]);
const multiple = fixture(CIDRS.join(', '));

describe('DevNetworkStack EKS 전용 네트워크', () => {
  const { network, template } = baseline;

  test('기존 VPC·public subnet 두 개·S3 endpoint를 유지하고 NAT를 만들지 않는다', () => {
    template.resourceCountIs('AWS::EC2::NatGateway', 0);
    template.hasResourceProperties('AWS::EC2::VPC', { CidrBlock: DEV_VPC_CIDR });
    expect(DEV_VPC_CIDR).toBe('10.1.0.0/16');
    template.resourceCountIs('AWS::EC2::Subnet', 5);
    expect(Object.values(template.findResources('AWS::EC2::Subnet'))
      .map((subnet: any) => subnet.Properties.MapPublicIpOnLaunch)).toEqual([true, true, false, false, false]);
    template.resourceCountIs('AWS::EC2::VPCEndpoint', 1);
    template.hasResourceProperties('AWS::EC2::VPCEndpoint', { VpcEndpointType: 'Gateway' });
  });

  test('EKS·RDS SG 여덟 개의 기존 ID와 교체 유발 description을 유지한다', () => {
    const groups = template.findResources('AWS::EC2::SecurityGroup');
    expect(Object.keys(groups).sort()).toEqual([
      'DevRdsSgD66FDC40', 'DevEksControlPlaneSgCB0F4EE9', 'DevEksAppNodeSg95755693',
      'DevEksClickhouseNodeSg4071CB1E', 'DevEksValidationAlbSg7D5E6C15', 'DevEksRelaySg930FF80D',
      'DevEksObservabilityNodeSgEDF3C199', 'DevMskSg6BEDDF12',
    ].sort());
    expect(Object.values(groups).map((resource: any) => resource.Properties.GroupDescription).sort()).toEqual([
      'dev RDS PostgreSQL (publicly accessible)', 'dev EKS control plane', 'dev EKS application nodes',
      'dev EKS ClickHouse nodes', 'dev EKS validation ALB', 'dev EKS API SSM relay',
      'dev EKS observability nodes', 'dev MSK brokers',
    ].sort());
  });

  test('ECS SG·동적 host port·구 ClickHouse canary 연결을 제거한다', () => {
    expect(JSON.stringify(template.toJSON())).not.toMatch(/DevAlbSg|DevAppHostSg|DevClickhouseSg|DevCollectorSg|EksToExistingClickhouse/);
    expect(allIngressRules(template).filter(rule => rule.FromPort === 32768 || rule.ToPort === 65535)).toEqual([]);
  });

  test('EKS 앱의 RDS·ClickHouse 통로와 ALB의 NodePort 통로를 유지한다', () => {
    for (const [port, target, source] of [
      [5432, 'DevRdsSg', 'DevEksAppNodeSg'],
      [8123, 'DevEksClickhouseNodeSg', 'DevEksAppNodeSg'],
      [9000, 'DevEksClickhouseNodeSg', 'DevEksAppNodeSg'],
      [30416, 'DevEksAppNodeSg', 'DevEksValidationAlbSg'],
      [30080, 'DevEksAppNodeSg', 'DevEksValidationAlbSg'],
      [30081, 'DevEksAppNodeSg', 'DevEksValidationAlbSg'],
      [30082, 'DevEksAppNodeSg', 'DevEksValidationAlbSg'],
    ] as const) template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      FromPort: port, ToPort: port, IpProtocol: 'tcp',
      GroupId: { 'Fn::GetAtt': [Match.stringLikeRegexp(target), 'GroupId'] },
      SourceSecurityGroupId: { 'Fn::GetAtt': [Match.stringLikeRegexp(source), 'GroupId'] },
    });
  });

  test('devAllowedCidr 미지정이면 기존 open-ingress 경고를 낸다', () => {
    Annotations.fromStack(network).hasWarning('*', Match.stringLikeRegexp('infra:dev-open-ingress'));
  });

  test.each([baseline, narrowed, multiple])('4318과 NodePort를 CIDR에 직접 열지 않는다', ({ template }) => {
    expect(allIngressRules(template).filter(rule => rule.CidrIp !== undefined &&
      [4318, 30416, 30080, 30081, 30082].includes(rule.FromPort))).toEqual([]);
  });

  test.each([[narrowed, [CIDRS[0]]], [multiple, CIDRS]] as const)('지정 CIDR에만 EKS ALB와 RDS 인바운드를 연다', ({ network, template }, cidrs) => {
    const ingress = allIngressRules(template);
    expect(ingress.filter(rule => rule.CidrIp === '0.0.0.0/0' || rule.CidrIpv6 === '::/0')).toEqual([]);
    for (const cidr of cidrs) {
      for (const port of [PORTS.http, PORTS.clickhouseHttp]) {
        template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
          GroupId: { 'Fn::GetAtt': ['DevEksValidationAlbSg7D5E6C15', 'GroupId'] },
          CidrIp: cidr, FromPort: port, ToPort: port, IpProtocol: 'tcp',
        });
      }
      template.hasResourceProperties('AWS::EC2::SecurityGroup', {
        GroupDescription: 'dev RDS PostgreSQL (publicly accessible)',
        SecurityGroupIngress: Match.arrayWith([Match.objectLike({
          CidrIp: cidr, FromPort: PORTS.aurora, ToPort: PORTS.aurora, IpProtocol: 'tcp',
        })]),
      });
    }
    Annotations.fromStack(network).hasNoWarning('*', Match.stringLikeRegexp('infra:dev-open-ingress'));
  });
});
