import { Template } from 'aws-cdk-lib/assertions';
import { CfnSecurityGroup, SecurityGroup } from 'aws-cdk-lib/aws-ec2';
import { buildApp } from './helpers';

describe('NetworkStack', () => {
  const { network } = buildApp();
  const template = Template.fromStack(network);
  const securityGroupLogicalId = (securityGroup: SecurityGroup): string =>
    network.getLogicalId(
      securityGroup.node.defaultChild as CfnSecurityGroup,
    );
  const inboundRulesFor = (securityGroup: SecurityGroup) =>
    Object.values(
      template.findResources('AWS::EC2::SecurityGroupIngress', {
        Properties: {
          GroupId: {
            'Fn::GetAtt': [securityGroupLogicalId(securityGroup), 'GroupId'],
          },
        },
      }),
    );
  const inboundRuleSignatures = (
    ingress: ReturnType<typeof inboundRulesFor>,
  ): string[] =>
    ingress
      .map(({ Properties: properties }) => {
        const sourceLogicalId =
          properties.SourceSecurityGroupId['Fn::GetAtt'][0];
        return `${sourceLogicalId}:${properties.IpProtocol}:${properties.FromPort}-${properties.ToPort}`;
      })
      .sort();

  test('provisions 6 subnets across 2 AZs (3 tiers x 2)', () => {
    // Aurora / ALB 가 2 AZ 를 요구하므로 3계층 x 2 AZ = 6 서브넷.
    template.resourceCountIs('AWS::EC2::Subnet', 6);
  });

  test('provisions exactly 1 NAT gateway (cost minimized)', () => {
    template.resourceCountIs('AWS::EC2::NatGateway', 1);
  });

  test('has exactly 1 internet gateway', () => {
    template.resourceCountIs('AWS::EC2::InternetGateway', 1);
  });

  test('has an S3 gateway VPC endpoint', () => {
    template.resourceCountIs('AWS::EC2::VPCEndpoint', 1);
    template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
      VpcEndpointType: 'Gateway',
    });
  });

  test('defines all 5 security groups', () => {
    const securityGroups = template.findResources(
      'AWS::EC2::SecurityGroup',
    );
    const expectedLogicalIds = [
      network.albSecurityGroup,
      network.collectorSecurityGroup,
      network.dashboardSecurityGroup,
      network.clickhouseSecurityGroup,
      network.auroraSecurityGroup,
    ].map(securityGroupLogicalId);

    expect(Object.keys(securityGroups)).toHaveLength(5);
    expect(Object.keys(securityGroups)).toEqual(
      expect.arrayContaining(expectedLogicalIds),
    );
  });

  test('collector and dashboard SGs allow inbound traffic only from the ALB SG', () => {
    const albLogicalId = securityGroupLogicalId(network.albSecurityGroup);
    const appSecurityGroups = [
      { securityGroup: network.collectorSecurityGroup, port: 4318 },
      { securityGroup: network.dashboardSecurityGroup, port: 8080 },
    ];

    for (const { securityGroup, port } of appSecurityGroups) {
      const ingress = inboundRulesFor(securityGroup);

      expect(ingress).toHaveLength(1);
      expect(ingress[0]).toMatchObject({
        Properties: {
          FromPort: port,
          ToPort: port,
          IpProtocol: 'tcp',
          SourceSecurityGroupId: {
            'Fn::GetAtt': [albLogicalId, 'GroupId'],
          },
        },
      });
    }
  });

  test('clickhouse SG allows exactly 4 inbound rules from the app SGs', () => {
    const collectorLogicalId = securityGroupLogicalId(
      network.collectorSecurityGroup,
    );
    const dashboardLogicalId = securityGroupLogicalId(
      network.dashboardSecurityGroup,
    );
    const ingress = inboundRulesFor(network.clickhouseSecurityGroup);

    expect(ingress).toHaveLength(4);
    expect(inboundRuleSignatures(ingress)).toEqual(
      [
        `${collectorLogicalId}:tcp:8123-8123`,
        `${collectorLogicalId}:tcp:9000-9000`,
        `${dashboardLogicalId}:tcp:8123-8123`,
        `${dashboardLogicalId}:tcp:9000-9000`,
      ].sort(),
    );
  });

  test('aurora SG allows exactly 2 inbound rules from the app SGs', () => {
    const collectorLogicalId = securityGroupLogicalId(
      network.collectorSecurityGroup,
    );
    const dashboardLogicalId = securityGroupLogicalId(
      network.dashboardSecurityGroup,
    );
    const ingress = inboundRulesFor(network.auroraSecurityGroup);

    expect(ingress).toHaveLength(2);
    expect(inboundRuleSignatures(ingress)).toEqual(
      [
        `${collectorLogicalId}:tcp:5432-5432`,
        `${dashboardLogicalId}:tcp:5432-5432`,
      ].sort(),
    );
  });

  test('ALB SG allows 443 from anywhere', () => {
    const securityGroups = template.findResources(
      'AWS::EC2::SecurityGroup',
    );
    const albLogicalId = securityGroupLogicalId(network.albSecurityGroup);

    expect(securityGroups[albLogicalId]).toMatchObject({
      Properties: {
        SecurityGroupIngress: expect.arrayContaining([
          expect.objectContaining({
            FromPort: 443,
            ToPort: 443,
            IpProtocol: 'tcp',
            CidrIp: '0.0.0.0/0',
          }),
        ]),
      },
    });
  });
});
