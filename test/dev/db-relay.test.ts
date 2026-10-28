import { Template } from 'aws-cdk-lib/assertions';
import { buildDevApp, TEST_ENV } from '../helpers';

describe('dev DB 전용 SSM 릴레이', () => {
  const built = buildDevApp({ devAllowedCidr: '203.0.113.10/32' });
  const data = built.data;
  const template = Template.fromStack(data);
  const network = Template.fromStack(built.network);
  const json = template.toJSON();
  const [instanceId, instance] = Object.entries(template.findResources('AWS::EC2::Instance'))[0];
  const documents = Object.entries(template.findResources('AWS::SSM::Document'));
  const document = (name: string) => documents.find(([, resource]) => resource.Properties.Name === name)!;
  const [postgresId, postgres] = document('soma-376-dev-db-postgres-tunnel');
  const [clickHouseId, clickHouse] = document('soma-376-dev-db-clickhouse-tunnel');
  const databaseId = Object.keys(template.findResources('AWS::RDS::DBInstance'))[0];
  const operatorId = Object.keys(template.findResources('AWS::IAM::Role', {
    Properties: { RoleName: 'soma-376-dev-db-operator' },
  }))[0];
  const statements = Object.values(template.findResources('AWS::IAM::Policy'))
    .filter(policy => policy.Properties.Roles?.some((ref: any) => ref.Ref === operatorId))
    .flatMap(policy => policy.Properties.PolicyDocument.Statement);
  const instanceProfile = json.Resources[instance.Properties.IamInstanceProfile.Ref];
  const relayRoleId = instanceProfile.Properties.Roles[0].Ref;
  const resourceArn = (service: string, type: string, ref: string) => ({
    'Fn::Join': ['', [`arn:aws:${service}:${TEST_ENV.region}:${TEST_ENV.account}:${type}/`, { Ref: ref }]],
  });

  test('Data에만 새 ARM64 EC2 한 대를 만들고 기존 EKS API 릴레이를 유지한다', () => {
    template.resourceCountIs('AWS::EC2::Instance', 1);
    Template.fromStack(built.eks).resourceCountIs('AWS::EC2::Instance', 1);
    expect(instance.Properties.InstanceType).toBe('t4g.micro');
    expect(instance.Properties.NetworkInterfaces).toEqual([{
      AssociatePublicIpAddress: true, DeviceIndex: '0',
      GroupSet: [data.resolve(built.network.dbRelaySecurityGroup.securityGroupId)],
      SubnetId: data.resolve(built.network.vpc.publicSubnets[0].subnetId),
    }]);
    expect(instance.Properties.ImageId).toBe('ami-012bcb5c12dcf8e43');
    expect(JSON.stringify(json.Parameters)).not.toContain('ami-amazon-linux-latest');
    expect(instance.Properties.BlockDeviceMappings).toEqual([{
      DeviceName: '/dev/xvda',
      Ebs: { DeleteOnTermination: true, Encrypted: true, VolumeSize: 8, VolumeType: 'gp3' },
    }]);
    expect(instance.Properties.KeyName).toBeUndefined();
    const launchTemplateId = instance.Properties.LaunchTemplate.Version['Fn::GetAtt'][0];
    expect(json.Resources[launchTemplateId].Properties.LaunchTemplateData.MetadataOptions)
      .toMatchObject({ HttpTokens: 'required' });
    expect(instance.Properties.UserData['Fn::Base64']).toContain('systemctl enable --now amazon-ssm-agent');
    expect(instance.Properties.UserData['Fn::Base64']).not.toMatch(/kubectl|psql|clickhouse-client|secret/i);
  });

  test('EC2 role은 SSM만, DB operator는 세션 권한만 갖고 EKS·Secret·DB 권한이 없다', () => {
    const relayRole = json.Resources[relayRoleId].Properties;
    expect(relayRoleId).not.toBe(operatorId);
    expect(relayRole.AssumeRolePolicyDocument.Statement).toEqual([{
      Effect: 'Allow', Action: 'sts:AssumeRole', Principal: { Service: 'ec2.amazonaws.com' },
    }]);
    expect(relayRole.ManagedPolicyArns).toEqual([{
      'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':iam::aws:policy/AmazonSSMManagedInstanceCore']],
    }]);
    expect(relayRole.Policies).toBeUndefined();
    expect(Object.values(template.findResources('AWS::IAM::Policy'))
      .filter(policy => policy.Properties.Roles?.some((ref: any) => ref.Ref === relayRoleId))).toEqual([]);
    const operatorRole = json.Resources[operatorId].Properties;
    expect(operatorRole.AssumeRolePolicyDocument.Statement).toEqual([{
      Effect: 'Allow', Action: 'sts:AssumeRole', Principal: { AWS: `arn:aws:iam::${TEST_ENV.account}:root` },
    }]);
    expect(operatorRole.ManagedPolicyArns).toBeUndefined();
    expect(operatorRole.Policies).toBeUndefined();
    expect(statements.flatMap(statement => statement.Action).sort()).toEqual([
      'ssm:StartSession', 'ssm:StartSession', 'ssm:ResumeSession', 'ssm:TerminateSession', 'ssmmessages:OpenDataChannel',
    ].sort());
    template.resourceCountIs('AWS::EKS::AccessEntry', 0);
    Template.fromStack(built.eks).resourceCountIs('AWS::EKS::AccessEntry', 2);
  });

  test('Network가 모든 relay SG 규칙을 소유하고 SSM과 두 DB 포트에만 egress를 허용한다', () => {
    const resolve = (group: { securityGroupId: string }) => built.network.resolve(group.securityGroupId);
    const relayGroupId = resolve(built.network.dbRelaySecurityGroup);
    const rdsGroupId = resolve(built.network.rdsSecurityGroup);
    const clickHouseGroupId = resolve(built.network.eksClickhouseNodeSecurityGroup);
    const relay = network.toJSON().Resources[relayGroupId['Fn::GetAtt'][0]].Properties;
    expect(relay.SecurityGroupIngress ?? []).toEqual([]);
    expect(relay.SecurityGroupEgress ?? []).toEqual([]);
    const ingress = Object.values(network.findResources('AWS::EC2::SecurityGroupIngress')).map(rule => rule.Properties);
    const matches = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    expect(ingress.filter(rule => matches(rule.GroupId, relayGroupId))).toEqual([]);
    const fromRelay = ingress.filter(rule => matches(rule.SourceSecurityGroupId, relayGroupId));
    expect(fromRelay).toHaveLength(2);
    const egress = Object.values(network.findResources('AWS::EC2::SecurityGroupEgress'))
      .map(rule => rule.Properties).filter(rule => matches(rule.GroupId, relayGroupId));
    expect(egress).toHaveLength(3);
    for (const [port, target] of [[5432, rdsGroupId], [8123, clickHouseGroupId]] as const) {
      expect(fromRelay).toContainEqual(expect.objectContaining({
        GroupId: target, SourceSecurityGroupId: relayGroupId, IpProtocol: 'tcp', FromPort: port, ToPort: port,
      }));
      expect(egress).toContainEqual(expect.objectContaining({
        GroupId: relayGroupId, DestinationSecurityGroupId: target, IpProtocol: 'tcp', FromPort: port, ToPort: port,
      }));
    }
    expect(egress.filter(rule => rule.CidrIp !== undefined || rule.CidrIpv6 !== undefined)).toEqual([
      expect.objectContaining({ CidrIp: '0.0.0.0/0', IpProtocol: 'tcp', FromPort: 443, ToPort: 443 }),
    ]);
    for (const type of ['SecurityGroup', 'SecurityGroupIngress', 'SecurityGroupEgress']) {
      template.resourceCountIs(`AWS::EC2::${type}`, 0);
    }
  });

  test('PostgreSQL endpoint와 두 원격 포트를 고정하고 로컬 포트만 선택한다', () => {
    template.resourceCountIs('AWS::SSM::Document', 2);
    expect(Object.keys(postgres.Properties.Content.parameters)).toEqual(['localPortNumber']);
    expect(postgres.Properties.Content.properties).toEqual({
      type: 'LocalPortForwarding', host: { 'Fn::GetAtt': [databaseId, 'Endpoint.Address'] },
      portNumber: '5432', localPortNumber: '{{ localPortNumber }}',
    });
    expect(clickHouse.Properties.Content.properties).toEqual({
      type: 'LocalPortForwarding', host: '{{ host }}', portNumber: '8123', localPortNumber: '{{ localPortNumber }}',
    });
    for (const [resource, defaultPort] of [[postgres, '15432'], [clickHouse, '18123']] as const) {
      expect(resource.Properties).toMatchObject({ DocumentType: 'Session', DocumentFormat: 'JSON', UpdateMethod: 'NewVersion' });
      expect(resource.Properties.Content).toMatchObject({ schemaVersion: '1.0', sessionType: 'Port' });
      const parameter = resource.Properties.Content.parameters.localPortNumber;
      expect(parameter.default).toBe(defaultPort);
      const allowed = new RegExp(parameter.allowedPattern);
      for (const port of ['1', '5432', '8123', '15432', '18123', '65535']) expect(allowed.test(port)).toBe(true);
      for (const port of ['0', '-1', '65536', '99999', '1.5', '', '5432,8123']) expect(allowed.test(port)).toBe(false);
    }
  });

  test('ClickHouse 목적지는 dev VPC의 정상 IPv4만 허용하고 DNS·loopback·IMDS·외부 주소를 거부한다', () => {
    const parameters = clickHouse.Properties.Content.parameters;
    expect(Object.keys(parameters).sort()).toEqual(['host', 'localPortNumber']);
    expect(parameters.host.default).toBeUndefined();
    const allowed = new RegExp(parameters.host.allowedPattern);
    for (const host of ['10.1.0.5', '10.1.1.255', '10.1.255.254']) expect(allowed.test(host)).toBe(true);
    for (const host of [
      'localhost', '127.0.0.1', '169.254.169.254', '::1', '[::1]', 'example.com', '10.1.0.5.nip.io',
      '203.0.113.10', '10.0.0.1', '10.2.0.1', '10.1.256.1', '10.1.1.256', '10.1.01.1',
      '10.1.1.1:9000', 'http://10.1.1.1', '10.1.1.1,10.1.1.2', '',
    ]) expect(allowed.test(host)).toBe(false);
  });

  test('StartSession은 정확한 DB relay와 문서 두 개에만 허용한다', () => {
    expect(statements.filter(statement => statement.Action === 'ssm:StartSession')).toEqual([
      {
        Effect: 'Allow', Action: 'ssm:StartSession', Resource: resourceArn('ec2', 'instance', instanceId),
        Condition: { BoolIfExists: { 'ssm:SessionDocumentAccessCheck': 'true' } },
      },
      {
        Effect: 'Allow', Action: 'ssm:StartSession',
        Resource: expect.arrayContaining([resourceArn('ssm', 'document', postgresId), resourceArn('ssm', 'document', clickHouseId)]),
      },
    ]);
    expect(statements.find(statement => statement.Action === 'ssm:StartSession'
      && Array.isArray(statement.Resource)).Resource).toHaveLength(2);
  });

  test('세션 재개·종료는 호출자와 DB relay 양쪽으로 제한하고 data channel에는 SSM tag 조건을 쓰지 않는다', () => {
    const sessionArn = `arn:aws:ssm:${TEST_ENV.region}:${TEST_ENV.account}:session/`;
    expect(statements.filter(statement => statement.Action === 'ssmmessages:OpenDataChannel')).toEqual([{
      Effect: 'Allow', Action: 'ssmmessages:OpenDataChannel', Resource: `${sessionArn}\${aws:userid}-*`,
    }]);
    expect(statements.filter(statement => Array.isArray(statement.Action) && statement.Action.includes('ssm:TerminateSession'))).toEqual([{
      Effect: 'Allow', Action: ['ssm:ResumeSession', 'ssm:TerminateSession'], Resource: `${sessionArn}*`,
      Condition: { StringEquals: {
        'ssm:resourceTag/aws:ssmmessages:session-id': '${aws:userid}',
        'ssm:resourceTag/aws:ssmmessages:target-id': { Ref: instanceId },
      } },
    }]);
  });

  test('Data output은 실제 DB relay·operator·두 문서를 가리킨다', () => {
    template.hasOutput('DbRelayInstanceId', { Value: { Ref: instanceId } });
    template.hasOutput('DbOperatorRoleArn', { Value: { 'Fn::GetAtt': [operatorId, 'Arn'] } });
    template.hasOutput('DbRelayPostgresSessionDocumentName', { Value: { Ref: postgresId } });
    template.hasOutput('DbRelayClickHouseSessionDocumentName', { Value: { Ref: clickHouseId } });
  });
});
