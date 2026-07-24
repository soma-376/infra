import { Template } from 'aws-cdk-lib/assertions';
import { CfnSubnet } from 'aws-cdk-lib/aws-ec2';
import { PRIMARY_AZ_INDEX, SUBNET_GROUP } from '../lib/config';
import { buildApp } from './helpers';

describe('전체 인프라', () => {
  test('애플리케이션 컴퓨트와 Aurora writer는 모두 primary AZ에 배치한다', () => {
    const { network, data, application } = buildApp();
    const primaryAz = network.vpc.availabilityZones[PRIMARY_AZ_INDEX];
    const primaryAppSubnets = network.vpc.selectSubnets({
      subnetGroupName: SUBNET_GROUP.app,
      availabilityZones: [primaryAz],
    }).subnets;

    expect(primaryAppSubnets).toHaveLength(1);

    const primaryAppSubnetLogicalId = network.getLogicalId(
      primaryAppSubnets[0].node.defaultChild as CfnSubnet,
    );
    const applicationTemplate = Template.fromStack(application);
    const networkTemplate = Template.fromStack(network).toJSON();
    const primaryAppSubnetOutput = Object.entries(
      networkTemplate.Outputs,
    ).find(
      ([, output]: [string, any]) =>
        output.Value?.Ref === primaryAppSubnetLogicalId,
    );

    expect(primaryAppSubnetOutput).toBeDefined();
    const primaryAppSubnetOutputName = primaryAppSubnetOutput![0];
    const services = Object.values(
      applicationTemplate.findResources('AWS::ECS::Service'),
    );

    expect(services).toHaveLength(3);
    for (const service of services) {
      const subnets =
        service.Properties.NetworkConfiguration.AwsvpcConfiguration.Subnets;
      expect(subnets).toHaveLength(1);
      expect(
        subnets[0]['Fn::GetStackOutput'].OutputName,
      ).toBe(primaryAppSubnetOutputName);
    }

    const autoScalingGroups = Object.values(
      applicationTemplate.findResources(
        'AWS::AutoScaling::AutoScalingGroup',
      ),
    );
    expect(autoScalingGroups).toHaveLength(1);
    const asgSubnets = autoScalingGroups[0].Properties.VPCZoneIdentifier;
    expect(asgSubnets).toHaveLength(1);
    expect(asgSubnets[0]['Fn::GetStackOutput'].OutputName).toBe(
      primaryAppSubnetOutputName,
    );

    const dataTemplate = Template.fromStack(data);
    const writers = Object.values(
      dataTemplate.findResources('AWS::RDS::DBInstance'),
    );

    expect(writers).toHaveLength(1);
    expect(writers[0].Properties.AvailabilityZone).toEqual(
      networkTemplate.Resources[primaryAppSubnetLogicalId].Properties
        .AvailabilityZone,
    );
  });
});
