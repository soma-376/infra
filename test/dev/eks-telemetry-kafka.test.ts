import { Template } from 'aws-cdk-lib/assertions';
import { buildDevApp } from '../helpers';
import { DEV_EKS_MSK_IAM_PORT, DEV_EKS_MSK_SUBNETS, DEV_EKS_NODE_PORTS } from '../../lib/dev/eks-config';

const EKS = { devEksEnabled: true };

/** PROJ-246: MSK·Gateway가 추가하는 dev EKS 리소스의 경계다. (ADR-0035·0036) */
describe('MSK 전용 네트워크', () => {
  const disabled = Template.fromStack(buildDevApp().network);
  const enabled = Template.fromStack(buildDevApp(EKS).network);
  const ingress = (template: Template): any[] => Object.values(template.findResources('AWS::EC2::SecurityGroupIngress'));

  test('EKS 비활성 구성에는 MSK subnet·SG·9098·30082 규칙이 없다', () => {
    disabled.resourceCountIs('AWS::EC2::Subnet', 2);
    disabled.resourceCountIs('AWS::EC2::SecurityGroup', 4);
    const text = JSON.stringify(disabled.toJSON());
    for (const value of ['DevMsk', '10.1.32.0/24', '"FromPort":9098', '"FromPort":30082']) expect(text).not.toContain(value);
  });

  test('VPC는 그대로 두고 3 AZ isolated subnet을 local route만으로 추가한다', () => {
    enabled.resourceCountIs('AWS::EC2::Subnet', 5);
    enabled.resourceCountIs('AWS::EC2::VPC', 1);
    enabled.resourceCountIs('AWS::EC2::NatGateway', 0);
    // public subnet 두 개의 IGW default route만 있다. MSK route table에는 route 리소스가 없다.
    enabled.resourceCountIs('AWS::EC2::Route', 2);
    for (const route of Object.values(enabled.findResources('AWS::EC2::Route')) as any[]) {
      expect(JSON.stringify(route.Properties.RouteTableId)).not.toContain('DevMsk');
    }
    const subnets = Object.entries(enabled.findResources('AWS::EC2::Subnet'))
      .filter(([id]) => id.startsWith('DevMskSubnet')).map(([, resource]: [string, any]) => resource.Properties);
    expect(subnets.map(subnet => [subnet.CidrBlock, subnet.AvailabilityZone])).toEqual(
      DEV_EKS_MSK_SUBNETS.map(subnet => [subnet.cidrBlock, subnet.availabilityZone]));
    expect(subnets.map(subnet => subnet.AvailabilityZone)).toEqual(['ap-northeast-2a', 'ap-northeast-2b', 'ap-northeast-2c']);
    for (const subnet of subnets) expect(subnet).toMatchObject({ MapPublicIpOnLaunch: false, VpcId: { Ref: expect.stringMatching(/^DevVpc/) } });
    // S3 gateway endpoint는 기존 public route table만 사용한다.
    const endpoint = Object.values(enabled.findResources('AWS::EC2::VPCEndpoint'))[0] as any;
    expect(JSON.stringify(endpoint.Properties.RouteTableIds)).not.toContain('DevMsk');
  });

  test('DevMskSg는 아웃바운드가 없고 앱 node SG의 9098만 받는다', () => {
    const [id, sg] = Object.entries(enabled.findResources('AWS::EC2::SecurityGroup'))
      .find(([logicalId]) => logicalId.startsWith('DevMskSg'))! as [string, any];
    expect(sg.Properties.GroupDescription).toBe('dev MSK brokers');
    expect(sg.Properties.SecurityGroupIngress).toBeUndefined();
    expect(sg.Properties.SecurityGroupEgress).toBeUndefined();
    const own = ingress(enabled).filter(rule => JSON.stringify(rule.Properties.GroupId).includes(id));
    expect(own).toHaveLength(1);
    expect(own[0].Properties).toMatchObject({ IpProtocol: 'tcp', FromPort: DEV_EKS_MSK_IAM_PORT, ToPort: 9098,
      SourceSecurityGroupId: { 'Fn::GetAtt': [expect.stringMatching(/^DevEksAppNodeSg/), 'GroupId'] } });
    expect(own[0].Properties.CidrIp).toBeUndefined();
    const egress = Object.values(enabled.findResources('AWS::EC2::SecurityGroupEgress'))
      .filter((rule: any) => JSON.stringify(rule.Properties.GroupId).includes(id)) as any[];
    expect(egress.map(rule => rule.Properties.CidrIp)).toEqual(['255.255.255.255/32']);
  });

  test('두 ALB SG만 앱 node의 Gateway NodePort 30082에 접근한다', () => {
    expect(DEV_EKS_NODE_PORTS.gateway).toBe(30082);
    const rules = ingress(enabled).filter(rule => rule.Properties.FromPort === 30082);
    expect(rules).toHaveLength(2);
    for (const rule of rules) {
      expect(rule.Properties).toMatchObject({ ToPort: 30082, IpProtocol: 'tcp' });
      expect(JSON.stringify(rule.Properties.GroupId)).toContain('DevEksAppNodeSg');
      expect(rule.Properties.CidrIp).toBeUndefined();
    }
    expect(rules.map(rule => JSON.stringify(rule.Properties.SourceSecurityGroupId)).sort())
      .toEqual([expect.stringContaining('DevAlbSg'), expect.stringContaining('DevEksValidationAlbSg')]);
  });
});
