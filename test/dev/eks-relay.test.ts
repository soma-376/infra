import { Template } from 'aws-cdk-lib/assertions';
import { buildDevApp, TEST_ENV } from '../helpers';

describe('dev EKS private API SSM 릴레이', () => {
  const built = buildDevApp({ devEksEnabled: true, devAllowedCidr: '203.0.113.10/32' });
  const eks = built.eks!;
  const template = Template.fromStack(eks);
  const network = Template.fromStack(built.network);
  const json = template.toJSON();
  const [instanceId, instance] = Object.entries(template.findResources('AWS::EC2::Instance'))[0];
  const [documentId, document] = Object.entries(template.findResources('AWS::SSM::Document'))[0];
  const clusterId = Object.keys(template.findResources('AWS::EKS::Cluster'))[0];
  const operatorId = Object.keys(template.findResources('AWS::IAM::Role', {
    Properties: { RoleName: 'soma-376-dev-eks-operator' },
  }))[0];
  const operatorPolicies = Object.values(template.findResources('AWS::IAM::Policy'))
    .filter(policy => policy.Properties.Roles?.some((ref: any) => ref.Ref === operatorId));
  const statements = operatorPolicies.flatMap(policy => policy.Properties.PolicyDocument.Statement);
  const instanceProfile = json.Resources[instance.Properties.IamInstanceProfile.Ref];
  const relayRoleId = instanceProfile.Properties.Roles[0].Ref;
  const resourceArn = (service: string, type: string, ref: string) => ({
    'Fn::Join': ['', [`arn:aws:${service}:${TEST_ENV.region}:${TEST_ENV.account}:${type}/`, { Ref: ref }]],
  });

  test('한 대의 ARM64 릴레이는 첫 public subnet과 전용 SG만 사용한다', () => {
    template.resourceCountIs('AWS::EC2::Instance', 1);
    expect(instance.Properties.InstanceType).toBe('t4g.micro');
    expect(instance.Properties.NetworkInterfaces).toEqual([{
      AssociatePublicIpAddress: true,
      DeviceIndex: '0',
      GroupSet: [eks.resolve(built.network.eksRelaySecurityGroup!.securityGroupId)],
      SubnetId: eks.resolve(built.network.vpc.publicSubnets[0].subnetId),
    }]);
    expect(instance.Properties.ImageId).toBe('ami-0be86884078364464');
    expect(JSON.stringify(json.Parameters)).not.toContain('ami-amazon-linux-latest');
    expect(instance.Properties.BlockDeviceMappings).toEqual([{
      DeviceName: '/dev/xvda',
      Ebs: { DeleteOnTermination: true, Encrypted: true, VolumeSize: 8, VolumeType: 'gp3' },
    }]);
    expect(instance.Properties.KeyName).toBeUndefined();
    const launchTemplateId = instance.Properties.LaunchTemplate.Version['Fn::GetAtt'][0];
    expect(json.Resources[launchTemplateId].Properties.LaunchTemplateData.MetadataOptions)
      .toMatchObject({ HttpTokens: 'required' });
    expect(instance.Properties.UserData['Fn::Base64'])
      .toContain('systemctl enable --now amazon-ssm-agent');
  });

  test('EC2는 SSM 전용 role을 사용하고 EKS 관리자 접근을 받지 않는다', () => {
    const role = json.Resources[relayRoleId].Properties;
    expect(relayRoleId).not.toBe(operatorId);
    expect(role.AssumeRolePolicyDocument.Statement).toEqual([{
      Effect: 'Allow', Action: 'sts:AssumeRole', Principal: { Service: 'ec2.amazonaws.com' },
    }]);
    expect(role.ManagedPolicyArns).toEqual([{
      'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':iam::aws:policy/AmazonSSMManagedInstanceCore']],
    }]);
    expect(role.Policies).toBeUndefined();
    const attachedPolicies = Object.values(template.findResources('AWS::IAM::Policy'))
      .filter(policy => policy.Properties.Roles?.some((ref: any) => ref.Ref === relayRoleId));
    expect(attachedPolicies).toEqual([]);
    template.resourceCountIs('AWS::EKS::AccessEntry', 2);
    const principals = Object.values(template.findResources('AWS::EKS::AccessEntry'))
      .map(entry => entry.Properties.PrincipalArn);
    expect(principals).not.toContainEqual({ 'Fn::GetAtt': [relayRoleId, 'Arn'] });
  });

  test('릴레이의 인바운드는 없고 443 egress와 control-plane 443만 Network가 소유한다', () => {
    const relayGroupId = built.network.resolve(built.network.eksRelaySecurityGroup!.securityGroupId);
    const controlPlaneGroupId = built.network.resolve(built.network.eksControlPlaneSecurityGroup!.securityGroupId);
    const relayLogicalId = relayGroupId['Fn::GetAtt'][0];
    const relay = network.toJSON().Resources[relayLogicalId].Properties;
    expect(relay.SecurityGroupIngress ?? []).toEqual([]);
    expect(relay.SecurityGroupEgress ?? []).toEqual([]);
    const ingress = Object.values(network.findResources('AWS::EC2::SecurityGroupIngress'))
      .map(rule => rule.Properties);
    expect(ingress.filter(rule => JSON.stringify(rule.GroupId) === JSON.stringify(relayGroupId))).toEqual([]);
    const fromRelay = ingress.filter(rule => JSON.stringify(rule.SourceSecurityGroupId) === JSON.stringify(relayGroupId));
    expect(fromRelay).toHaveLength(1);
    expect(fromRelay[0]).toMatchObject({
      GroupId: controlPlaneGroupId, SourceSecurityGroupId: relayGroupId,
      IpProtocol: 'tcp', FromPort: 443, ToPort: 443,
    });
    const egress = Object.values(network.findResources('AWS::EC2::SecurityGroupEgress'))
      .map(rule => rule.Properties)
      .filter(rule => JSON.stringify(rule.GroupId) === JSON.stringify(relayGroupId));
    expect(egress).toHaveLength(1);
    expect(egress[0]).toMatchObject({ CidrIp: '0.0.0.0/0', IpProtocol: 'tcp', FromPort: 443, ToPort: 443 });
    expect(egress[0].CidrIpv6).toBeUndefined();
    for (const type of ['SecurityGroup', 'SecurityGroupIngress', 'SecurityGroupEgress']) {
      template.resourceCountIs(`AWS::EC2::${type}`, 0);
    }
  });

  test('Session 문서는 EKS hostname의 443에 고정하고 로컬 포트만 입력받는다', () => {
    template.resourceCountIs('AWS::SSM::Document', 1);
    expect(document.Properties).toMatchObject({
      Name: 'soma-376-dev-eks-api-tunnel', DocumentType: 'Session',
      DocumentFormat: 'JSON', UpdateMethod: 'NewVersion',
    });
    const content = document.Properties.Content;
    expect(content.schemaVersion).toBe('1.0');
    expect(content.sessionType).toBe('Port');
    expect(Object.keys(content.parameters)).toEqual(['localPortNumber']);
    expect(content.parameters.localPortNumber).toMatchObject({ type: 'String', default: '8443' });
    expect(content.properties).toEqual({
      type: 'LocalPortForwarding',
      host: { 'Fn::Select': [2, { 'Fn::Split': ['/', { 'Fn::GetAtt': [clusterId, 'Endpoint'] }] }] },
      portNumber: '443', localPortNumber: '{{ localPortNumber }}',
    });
    const allowed = new RegExp(content.parameters.localPortNumber.allowedPattern);
    for (const port of ['1', '443', '8443', '65535']) expect(allowed.test(port)).toBe(true);
    for (const port of ['0', '-1', '65536', '99999', '1.5', '', '443,8443']) expect(allowed.test(port)).toBe(false);
  });

  test('StartSession은 BoolIfExists 문서 검사와 정확한 릴레이·문서 ARN으로 제한한다', () => {
    const starts = statements.filter(statement => statement.Action === 'ssm:StartSession');
    expect(starts).toHaveLength(2);
    expect(starts).toEqual(expect.arrayContaining([
      {
        Effect: 'Allow', Action: 'ssm:StartSession',
        Resource: resourceArn('ec2', 'instance', instanceId),
        Condition: { BoolIfExists: { 'ssm:SessionDocumentAccessCheck': 'true' } },
      },
      {
        Effect: 'Allow', Action: 'ssm:StartSession',
        Resource: resourceArn('ssm', 'document', documentId),
      },
    ]));
    expect(statements.flatMap(statement => statement.Action).sort()).toEqual([
      'eks:DescribeCluster', 's3:GetObject', 's3:PutObject', 'ssm:ResumeSession', 'ssm:StartSession', 'ssm:StartSession',
      'ssm:TerminateSession', 'ssmmessages:OpenDataChannel',
    ].sort());
  });

  test('데이터 채널은 호출자 세션만, 종료·재개는 호출자와 릴레이 태그를 모두 검사한다', () => {
    const sessionArn = `arn:aws:ssm:${TEST_ENV.region}:${TEST_ENV.account}:session/`;
    const channel = statements.filter(statement => statement.Action === 'ssmmessages:OpenDataChannel');
    expect(channel).toEqual([{
      Effect: 'Allow', Action: 'ssmmessages:OpenDataChannel', Resource: `${sessionArn}\${aws:userid}-*`,
    }]);
    const controls = statements.filter(statement => Array.isArray(statement.Action)
      && statement.Action.includes('ssm:TerminateSession'));
    expect(controls).toEqual([{
      Effect: 'Allow', Action: ['ssm:ResumeSession', 'ssm:TerminateSession'], Resource: `${sessionArn}*`,
      Condition: { StringEquals: {
        'ssm:resourceTag/aws:ssmmessages:session-id': '${aws:userid}',
        'ssm:resourceTag/aws:ssmmessages:target-id': { Ref: instanceId },
      } },
    }]);
  });

  test('신규 output은 실제 릴레이와 문서를 가리킨다', () => {
    template.hasOutput('EksRelayInstanceId', { Value: { Ref: instanceId } });
    template.hasOutput('EksRelaySessionDocumentName', { Value: { Ref: documentId } });
  });
});
