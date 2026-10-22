import { Template } from 'aws-cdk-lib/assertions';
import { App, Stack } from 'aws-cdk-lib/core';
import { SecurityGroup, SubnetType, Vpc } from 'aws-cdk-lib/aws-ec2';
import { buildDevApp, TEST_ENV } from '../helpers';
import { DevEksMsk } from '../../lib/dev/eks-msk';
import { DEV_EKS_MSK_IAM_PORT, DEV_EKS_MSK_SUBNETS, DEV_EKS_NODE_PORTS, devTelemetryStage } from '../../lib/dev/eks-config';

const EKS = { devEksEnabled: true };

/** PROJ-246: MSK·Gateway가 추가하는 dev EKS 리소스의 경계다. (ADR-0035·0036) */
describe('MSK 전용 네트워크', () => {
  const disabled = Template.fromStack(buildDevApp().network);
  const enabled = Template.fromStack(buildDevApp(EKS).network);
  const ingress = (template: Template): any[] => Object.values(template.findResources('AWS::EC2::SecurityGroupIngress'));

  test('EKS 생략과 true 구성은 같은 MSK 네트워크를 만든다', () => {
    expect(disabled.toJSON()).toEqual(enabled.toJSON());
    expect(() => buildDevApp({ devEksEnabled: false })).toThrow('false로 비활성화할 수 없다');
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

  test('DevMskSg는 앱 9098과 관측 11001·11002만 받는다', () => {
    const [id, sg] = Object.entries(enabled.findResources('AWS::EC2::SecurityGroup'))
      .find(([logicalId]) => logicalId.startsWith('DevMskSg'))! as [string, any];
    expect(sg.Properties.GroupDescription).toBe('dev MSK brokers');
    expect(sg.Properties.SecurityGroupIngress).toBeUndefined();
    expect(sg.Properties.SecurityGroupEgress).toBeUndefined();
    const own = ingress(enabled).filter(rule => JSON.stringify(rule.Properties.GroupId).includes(id));
    expect(own).toHaveLength(3);
    expect(own[0].Properties).toMatchObject({ IpProtocol: 'tcp', FromPort: DEV_EKS_MSK_IAM_PORT, ToPort: 9098,
      SourceSecurityGroupId: { 'Fn::GetAtt': [expect.stringMatching(/^DevEksAppNodeSg/), 'GroupId'] } });
    expect(own[0].Properties.CidrIp).toBeUndefined();
    const egress = Object.values(enabled.findResources('AWS::EC2::SecurityGroupEgress'))
      .filter((rule: any) => JSON.stringify(rule.Properties.GroupId).includes(id)) as any[];
    expect(egress.map(rule => rule.Properties.CidrIp)).toEqual(['255.255.255.255/32']);
  });

  test('EKS ALB SG만 앱 node의 Gateway NodePort 30082에 접근한다', () => {
    expect(DEV_EKS_NODE_PORTS.gateway).toBe(30082);
    const rules = ingress(enabled).filter(rule => rule.Properties.FromPort === 30082);
    expect(rules).toHaveLength(1);
    for (const rule of rules) {
      expect(rule.Properties).toMatchObject({ ToPort: 30082, IpProtocol: 'tcp' });
      expect(JSON.stringify(rule.Properties.GroupId)).toContain('DevEksAppNodeSg');
      expect(rule.Properties.CidrIp).toBeUndefined();
    }
    expect(rules.map(rule => JSON.stringify(rule.Properties.SourceSecurityGroupId)).sort())
      .toEqual([expect.stringContaining('DevEksValidationAlbSg')]);
  });
});

describe('MSK Provisioned cluster', () => {
  const built = buildDevApp(EKS);
  const eks = Template.fromStack(built.eks!);
  const cluster = () => Object.values(eks.findResources('AWS::MSK::Cluster'))[0] as any;

  test('EKS 생략 합성에도 MSK와 output을 유지한다', () => {
    const template = Template.fromStack(buildDevApp().eks);
    template.resourceCountIs('AWS::MSK::Cluster', 1);
    template.hasOutput('MskClusterArn', {});
  });

  test('3.9 KRaft broker 3대를 세 MSK subnet·DevMskSg에 IAM·TLS 전용으로 둔다', () => {
    eks.resourceCountIs('AWS::MSK::Cluster', 1);
    eks.resourceCountIs('AWS::MSK::Configuration', 1);
    const properties = cluster().Properties;
    expect(properties).toMatchObject({
      ClusterName: 'soma-376-dev-telemetry', KafkaVersion: '3.9.x.kraft', NumberOfBrokerNodes: 3,
      ClientAuthentication: { Sasl: { Iam: { Enabled: true }, Scram: { Enabled: false } }, Unauthenticated: { Enabled: false } },
      EncryptionInfo: { EncryptionInTransit: { ClientBroker: 'TLS', InCluster: true } },
      EnhancedMonitoring: 'DEFAULT',
      LoggingInfo: { BrokerLogs: { CloudWatchLogs: { Enabled: true, LogGroup: { Ref: expect.stringMatching(/^MskBrokerLogs/) } } } },
    });
    // 저장 암호화는 AWS 관리 키다. TLS 인증서 인증·public broker를 만들지 않는다.
    expect(properties.EncryptionInfo.EncryptionAtRest).toBeUndefined();
    expect(properties.ClientAuthentication.Tls).toBeUndefined();
    expect(properties.OpenMonitoring).toEqual({ Prometheus: { JmxExporter: { EnabledInBroker: true }, NodeExporter: { EnabledInBroker: true } } });
    const group = properties.BrokerNodeGroupInfo;
    expect(group).toMatchObject({ InstanceType: 'kafka.m7g.large', StorageInfo: { EBSStorageInfo: { VolumeSize: 100 } },
      ConnectivityInfo: { PublicAccess: { Type: 'DISABLED' } } });
    expect(group.ClientSubnets).toHaveLength(3);
    group.ClientSubnets.forEach((subnet: any, index: number) =>
      expect(JSON.stringify(subnet)).toContain(`DevMskSubnet${index + 1}Subnet`));
    expect(group.SecurityGroups).toHaveLength(1);
    expect(JSON.stringify(group.SecurityGroups)).toContain('DevMskSg');
    eks.hasResourceProperties('AWS::Logs::LogGroup', { LogGroupName: '/aws/vendedlogs/msk/soma-376-dev-telemetry', RetentionInDays: 14 });
  });

  test('broker 설정은 auto create off·RF3·minISR2·6 partition·unclean off·13 MiB·72시간이다', () => {
    const [id, configuration] = Object.entries(eks.findResources('AWS::MSK::Configuration'))[0] as [string, any];
    expect(configuration.Properties.KafkaVersionsList).toEqual(['3.9.x.kraft']);
    expect(configuration.Properties.ServerProperties.split('\n').sort()).toEqual([
      'auto.create.topics.enable=false', 'default.replication.factor=3', 'log.retention.hours=72',
      'message.max.bytes=13631488', 'min.insync.replicas=2', 'num.partitions=6',
      'replica.fetch.max.bytes=13631488', 'unclean.leader.election.enable=false',
    ]);
    expect(cluster().Properties.ConfigurationInfo).toEqual({
      Arn: { 'Fn::GetAtt': [id, 'Arn'] }, Revision: { 'Fn::GetAtt': [id, 'LatestRevision.Revision'] },
    });
  });

  test.each([
    ['eks_validation', 'validation'],
    ['eks', 'main'],
  ] as const)('%s prefix는 %s stage topic/group을 출력하고 bootstrap 조회 Lambda가 없다', (prefix, stage) => {
    expect(devTelemetryStage(prefix)).toBe(stage);
    const template = Template.fromStack(buildDevApp({ ...EKS, devEksArchivePrefix: prefix }).eks!);
    template.hasOutput('MskStage', { Value: stage });
    template.hasOutput('MskTopicName', { Value: `pulsemetry-dev-telemetry-ingress-${stage}` });
    template.hasOutput('MskConsumerGroupName', { Value: `pulsemetry-dev-telemetry-ingest-${stage}` });
    template.hasOutput('MskClusterName', { Value: 'soma-376-dev-telemetry' });
    const clusterId = Object.keys(template.findResources('AWS::MSK::Cluster'))[0];
    template.hasOutput('MskClusterArn', { Value: { 'Fn::GetAtt': [clusterId, 'Arn'] } });
    template.resourceCountIs('AWS::Lambda::Function', 0);
    expect(JSON.stringify(template.toJSON())).not.toMatch(/Custom::|AWS::CloudFormation::CustomResource|GetBootstrapBrokers/);
  });

  test('알 수 없는 prefix와 broker 수와 다른 subnet 수는 조립을 거부한다', () => {
    expect(() => devTelemetryStage('other' as 'eks')).toThrow('archivePrefix');
    const stack = new Stack(new App(), 'MskSubnetCount', { env: TEST_ENV });
    const vpc = new Vpc(stack, 'Vpc', { maxAzs: 2, natGateways: 0, subnetConfiguration: [{ name: 'p', subnetType: SubnetType.PUBLIC }] });
    const securityGroup = new SecurityGroup(stack, 'Sg', { vpc });
    expect(() => new DevEksMsk(stack, 'Msk', { subnets: vpc.publicSubnets, securityGroup, stage: 'validation' }))
      .toThrow('subnet 3개');
  });
});

describe('Pod Identity·MSK 역할 조립', () => {
  const template = Template.fromStack(buildDevApp(EKS).eks!);
  const json = template.toJSON();
  const clusterId = Object.keys(template.findResources('AWS::MSK::Cluster'))[0];
  const uuid = { 'Fn::Select': [2, { 'Fn::Split': ['/', { 'Fn::GetAtt': [clusterId, 'Arn'] }] }] };
  const dataArn = (type: 'topic' | 'group', name: string) => ({ 'Fn::Join': ['', [
    `arn:aws:kafka:ap-northeast-2:111111111111:${type}/soma-376-dev-telemetry/`, uuid, `/${name}`,
  ]] });

  test('topic·group ARN은 cluster ARN의 UUID와 stage 이름으로 만든다', () => {
    const text = JSON.stringify(json.Resources);
    expect(text).toContain(JSON.stringify(dataArn('topic', 'pulsemetry-dev-telemetry-ingress-validation')));
    expect(text).toContain(JSON.stringify(dataArn('group', 'pulsemetry-dev-telemetry-ingest-validation')));
    expect(text).not.toContain('pulsemetry-dev-telemetry-ingress-main');
  });

  test.each(['telemetry-gateway', 'telemetry-kafka-admin', 'telemetry-kafka-offsets'])('%s SA의 Pod Identity association을 만든다', sa => {
    template.hasResourceProperties('AWS::EKS::PodIdentityAssociation', {
      Namespace: 'pulsemetry-dev', ServiceAccount: sa, DisableSessionTags: false,
      ClusterName: { Ref: Object.keys(template.findResources('AWS::EKS::Cluster'))[0] },
    });
  });
});

describe('검증 ALB OTLP 대상 전환', () => {
  const ingest = buildDevApp(EKS), gateway = buildDevApp({ ...EKS, devEksOtlpTarget: 'gateway' });
  const edge = (built: typeof ingest) => Template.fromStack(built.edge).toJSON();
  const before = edge(ingest), after = edge(gateway);
  const tgId = (json: any, name: string) => Object.entries<any>(json.Resources)
    .find(([, resource]) => resource.Type === 'AWS::ElasticLoadBalancingV2::TargetGroup' && resource.Properties.Name === name)![0];

  test('gateway는 EKS priority 1 규칙의 대상만 Gateway TG로 바꾸고 기존 규칙 ID를 보존한다', () => {
    const changed = Object.keys(before.Resources).filter(id => JSON.stringify(before.Resources[id]) !== JSON.stringify(after.Resources[id]));
    expect(changed).toEqual(['EksValidationAlbHttpOtlpRule810EC07C']);
    expect(Object.keys(after.Resources).sort()).toEqual(Object.keys(before.Resources).sort());
    const rule = (json: any) => json.Resources.EksValidationAlbHttpOtlpRule810EC07C.Properties;
    expect(rule(before).Actions).toEqual([{ Type: 'forward', TargetGroupArn: { Ref: tgId(before, 'soma-376-dev-eks-ingest-v') } }]);
    expect(rule(after).Actions).toEqual([{ Type: 'forward', TargetGroupArn: { Ref: tgId(after, 'soma-376-dev-eks-gateway-v') } }]);
    expect({ ...rule(after), Actions: undefined }).toEqual({ ...rule(before), Actions: undefined });
    expect(after.Resources.DevAlbDevHttpListenerDevOtlpForwardRule79AA5238).toBeUndefined();
    expect(after.Outputs.ValidationOtlpTarget).toEqual({ Value: 'gateway' });
    expect({ ...after.Outputs, ValidationOtlpTarget: undefined }).toEqual({ ...before.Outputs, ValidationOtlpTarget: undefined });
  });

  test('전환은 Edge 외 스택 템플릿을 바꾸지 않는다', () => {
    for (const key of ['network', 'data', 'eks'] as const) {
      expect(Template.fromStack(gateway[key]!).toJSON()).toEqual(Template.fromStack(ingest[key]!).toJSON());
    }
  });

  test('Gateway TG는 CDK 소유 태그·instance·30082·healthz·60초이며 LBC 이름 접두사를 따른다', () => {
    const tg = before.Resources[tgId(before, 'soma-376-dev-eks-gateway-v')].Properties;
    expect('soma-376-dev-eks-gateway-v'.length).toBeLessThanOrEqual(32);
    expect(tg).toMatchObject({ Port: 30082, Protocol: 'HTTP', TargetType: 'instance', HealthCheckPath: '/api/v1/healthz',
      HealthCheckPort: 'traffic-port', Matcher: { HttpCode: '200' },
      Tags: expect.arrayContaining([{ Key: 'pulsemetry:eks-cluster', Value: 'soma-376-dev-eks' }]),
      TargetGroupAttributes: expect.arrayContaining([{ Key: 'deregistration_delay.timeout_seconds', Value: '60' }]) });
    expect(before.Outputs.ValidationTelemetryGatewayTargetGroupArn).toEqual({ Value: { Ref: tgId(before, 'soma-376-dev-eks-gateway-v') } });
  });

  test.each([
    [{ devEksOtlpTarget: 'Gateway' }, /devEksOtlpTarget은 ingest 또는 gateway/],
    [{ ...EKS, devEksOtlpTarget: 'direct' }, /devEksOtlpTarget은 ingest 또는 gateway/],
    [{ devEksEnabled: false, devEksOtlpTarget: 'gateway' }, /false로 비활성화할 수 없다/],
  ])('잘못된 OTLP 대상 입력 %j를 거부한다', (context, message) => {
    expect(() => buildDevApp(context)).toThrow(message);
  });

  test('EKS 기본 구성은 명시적 ingest와 같은 Edge를 만든다', () => {
    const explicit = Template.fromStack(buildDevApp({ devEksOtlpTarget: 'ingest' }).edge).toJSON();
    expect(explicit).toEqual(Template.fromStack(buildDevApp().edge).toJSON());
  });
});

describe('telemetry 관측 경보', () => {
  const template = Template.fromStack(buildDevApp(EKS).eks!);
  const alarms = Object.values(template.findResources('AWS::CloudWatch::Alarm')).map((alarm: any) => alarm.Properties) as any[];
  const alarm = (name: string) => alarms.find(item => item.AlarmName === `soma-376-dev-telemetry-${name}`)!;
  const logGroupId = Object.entries(template.findResources('AWS::Logs::LogGroup'))
    .find(([, group]: [string, any]) => group.Properties.LogGroupName === '/eks/dev/application')![0];

  test('MSK 공간·ISR·offline·consumer lag와 로그 이벤트 경보 10개는 알림 action 없이 상태만 남긴다', () => {
    expect(alarms.map(item => item.AlarmName).sort()).toEqual([
      'commit-failed', 'consumer-offset-lag', 'consumer-time-lag', 'gateway-rejected', 'msk-disk-used',
      'msk-offline-partitions', 'msk-under-min-isr', 'permanent-failure', 'publish-failed', 'retry-exhausted',
    ].map(name => `soma-376-dev-telemetry-${name}`));
    for (const item of alarms) {
      expect(item.AlarmActions).toBeUndefined();
      expect(item.OKActions).toBeUndefined();
      expect(item.ComparisonOperator).toBe('GreaterThanOrEqualToThreshold');
      expect(item.AlarmDescription).toMatch(/^[\x20-\x7e]+$/);
    }
    template.resourceCountIs('AWS::SNS::Topic', 0);
  });

  test('broker 지표는 세 broker를 모아 디스크 80%·minISR 미달 1개 이상에서 경보한다', () => {
    const brokerMetric = (item: any, name: string) => item.Metrics.filter((metric: any) => metric.MetricStat).map((metric: any) => {
      expect(metric.MetricStat.Metric).toMatchObject({ Namespace: 'AWS/Kafka', MetricName: name });
      return Object.fromEntries(metric.MetricStat.Metric.Dimensions.map((dimension: any) => [dimension.Name, dimension.Value]));
    });
    expect(alarm('msk-disk-used')).toMatchObject({ Threshold: 80, EvaluationPeriods: 2, DatapointsToAlarm: 2 });
    expect(alarm('msk-disk-used').Metrics[0].Expression).toBe('MAX([b1, b2, b3])');
    expect(brokerMetric(alarm('msk-disk-used'), 'KafkaDataLogsDiskUsed')).toEqual(['1', '2', '3']
      .map(id => ({ 'Broker ID': id, 'Cluster Name': 'soma-376-dev-telemetry' })));
    expect(alarm('msk-under-min-isr').Metrics[0].Expression).toBe('SUM([b1, b2, b3])');
    expect(brokerMetric(alarm('msk-under-min-isr'), 'UnderMinIsrPartitionCount')).toHaveLength(3);
    expect(alarm('msk-offline-partitions')).toMatchObject({ Namespace: 'AWS/Kafka', MetricName: 'OfflinePartitionsCount', Threshold: 1,
      Dimensions: [{ Name: 'Cluster Name', Value: 'soma-376-dev-telemetry' }] });
  });

  test.each([['consumer-time-lag', 'EstimatedMaxTimeLag', 600], ['consumer-offset-lag', 'SumOffsetLag', 10000]] as const)(
    '%s는 stage group·topic의 %s를 본다', (name, metric, threshold) => {
      expect(alarm(name)).toMatchObject({ Namespace: 'AWS/Kafka', MetricName: metric, Threshold: threshold, TreatMissingData: 'notBreaching' });
      expect(alarm(name).Dimensions).toEqual(expect.arrayContaining([
        { Name: 'Cluster Name', Value: 'soma-376-dev-telemetry' },
        { Name: 'Consumer Group', Value: 'pulsemetry-dev-telemetry-ingest-validation' },
        { Name: 'Topic', Value: 'pulsemetry-dev-telemetry-ingress-validation' },
      ]));
    });

  test.each([
    ['telemetry_gateway_rejected', 'TelemetryGatewayRejected', 'gateway-rejected', 50],
    ['telemetry_publish_failed', 'TelemetryPublishFailed', 'publish-failed', 1],
    ['telemetry_permanent_failure', 'TelemetryPermanentFailure', 'permanent-failure', 1],
    ['telemetry_retry_exhausted', 'TelemetryRetryExhausted', 'retry-exhausted', 1],
    ['telemetry_commit_failed', 'TelemetryCommitFailed', 'commit-failed', 1],
  ])('event=%s 평문 term을 /eks/dev/application에서 집계한다', (event, metric, name, threshold) => {
    template.hasResourceProperties('AWS::Logs::MetricFilter', {
      LogGroupName: { Ref: logGroupId }, FilterPattern: `"event=${event}"`,
      MetricTransformations: [{ MetricNamespace: 'Pulsemetry/Dev/Telemetry', MetricName: metric, MetricValue: '1' }],
    });
    expect(alarm(name)).toMatchObject({ Namespace: 'Pulsemetry/Dev/Telemetry', MetricName: metric, Statistic: 'Sum', Period: 300,
      Threshold: threshold, TreatMissingData: 'notBreaching' });
  });
});
