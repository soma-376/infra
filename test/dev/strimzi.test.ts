import { Template } from 'aws-cdk-lib/assertions';
import { buildDevApp } from '../helpers';

const asJson = (stack: any) => Template.fromStack(stack).toJSON();
const strimzi = (stage = 'retain') => buildDevApp({ devKafkaProvider: 'strimzi', devMskRetirementStage: stage });

describe('dev Strimzi 병렬 설치와 MSK 단계별 제거', () => {
  const baseline = buildDevApp();
  const parallel = strimzi();
  const removed = strimzi('cluster-removed');
  const retired = strimzi('network-removed');

  test('병렬 설치는 MSK 클러스터·설정·데이터와 기존 노드 SG를 보존한다', () => {
    const before = asJson(baseline.eks), after = asJson(parallel.eks);
    for (const [id, resource] of Object.entries<any>(before.Resources)) {
      if (resource.Type.startsWith('AWS::MSK::')) expect(after.Resources[id]).toEqual(resource);
    }
    const beforeNetwork = asJson(baseline.network), afterNetwork = asJson(parallel.network);
    for (const [id, resource] of Object.entries<any>(beforeNetwork.Resources)) {
      expect(afterNetwork.Resources[id]).toEqual(resource);
    }
    Template.fromStack(parallel.network).resourceCountIs('AWS::EC2::SecurityGroup', 10);
    Template.fromStack(parallel.eks).hasOutput('KafkaProvider', { Value: 'strimzi' });
    Template.fromStack(parallel.eks).hasOutput('KafkaTopicName', { Value: 'pulsemetry-dev-telemetry-ingress-validation' });
    Template.fromStack(parallel.eks).hasOutput('KafkaConsumerGroupName', { Value: 'pulsemetry-dev-telemetry-ingest-validation' });
  });

  test('Kafka SG는 내부 클라이언트·운영·관측만 받고 외부 listener를 열지 않는다', () => {
    const network = Template.fromStack(parallel.network);
    const [id] = Object.entries(network.findResources('AWS::EC2::SecurityGroup'))
      .find(([, resource]: [string, any]) => resource.Properties.GroupDescription === 'dev EKS Strimzi Kafka nodes')!;
    const ingress = Object.values<any>(network.findResources('AWS::EC2::SecurityGroupIngress'))
      .filter(resource => JSON.stringify(resource.Properties.GroupId).includes(id));
    expect(ingress.length).toBeGreaterThan(0);
    for (const resource of ingress) {
      expect(resource.Properties.CidrIp).toBeUndefined();
      expect(resource.Properties.CidrIpv6).toBeUndefined();
      expect(resource.Properties.SourceSecurityGroupId).toBeDefined();
    }
    expect(ingress.filter(rule => rule.Properties.FromPort === 9093)).toHaveLength(1);
    expect(ingress.some(rule => [9092, 9098].includes(rule.Properties.FromPort))).toBe(false);
  });

  test.each([
    ['retain', parallel], ['cluster-removed', removed], ['network-removed', retired],
  ] as const)('%s에서도 Operator의 controller quorum·KafkaAgent 경로를 apps SG에만 허용한다', (_, current) => {
    const network = Template.fromStack(current.network);
    const kafkaGroup = current.network.resolve(current.network.eksKafkaNodeSecurityGroup!.securityGroupId);
    const appGroup = current.network.resolve(current.network.eksAppNodeSecurityGroup.securityGroupId);
    const ingress = Object.values<any>(network.findResources('AWS::EC2::SecurityGroupIngress'))
      .map(resource => resource.Properties)
      .filter(rule => JSON.stringify(rule.GroupId) === JSON.stringify(kafkaGroup));
    const appsIngress = ingress.filter(rule => JSON.stringify(rule.SourceSecurityGroupId) === JSON.stringify(appGroup));
    // Strimzi 1.3.0 KafkaRoller의 controller Admin(9090)·KafkaAgent(8443)는 rolling safety 검사에 필수다.
    expect(appsIngress.map(rule => rule.FromPort).sort((a, b) => a - b)).toEqual([8443, 9090, 9091, 9093]);
    for (const port of [9090, 8443]) {
      const matches = ingress.filter(rule => rule.FromPort === port);
      expect(matches).toHaveLength(1);
      expect(matches[0]).toEqual(expect.objectContaining({
        GroupId: kafkaGroup, SourceSecurityGroupId: appGroup, IpProtocol: 'tcp', FromPort: port, ToPort: port,
      }));
      expect(matches[0].CidrIp).toBeUndefined();
      expect(matches[0].CidrIpv6).toBeUndefined();
    }
  });

  test('클러스터 제거 단계는 MSK와 전용 권한만 제거하고 JWT·RDS·S3 접근을 보존한다', () => {
    const eks = Template.fromStack(removed.eks), json = eks.toJSON();
    eks.resourceCountIs('AWS::MSK::Cluster', 0);
    eks.resourceCountIs('AWS::MSK::Configuration', 0);
    expect(JSON.stringify(json)).not.toMatch(/kafka-cluster:|MskGatewayRoleArn|MskBrokerLogs/);
    const associations = Object.values<any>(eks.findResources('AWS::EKS::PodIdentityAssociation'))
      .map(value => value.Properties.ServiceAccount);
    expect(associations).toEqual(expect.arrayContaining(['enrollment-api', 'telemetry-ingest', 'telemetry-gateway', 'dashboard-api']));
    expect(associations).not.toContain('telemetry-kafka-admin');
    expect(associations).not.toContain('telemetry-kafka-offsets');
    const before = asJson(baseline.eks);
    for (const [id, resource] of Object.entries<any>(before.Resources)) {
      if (resource.Type === 'AWS::IAM::Policy') {
        const preserved = resource.Properties.PolicyDocument.Statement.filter((statement: any) =>
          JSON.stringify(statement.Action).includes('secretsmanager:') || JSON.stringify(statement.Action).includes('s3:PutObject'));
        if (preserved.length) {
          expect(json.Resources[id].Properties.PolicyDocument.Statement).toEqual(expect.arrayContaining(preserved));
        }
      }
    }
    // 실제 MSK ENI 해제 확인 전에 NetworkStack 리소스를 제거하지 않는다.
    expect(asJson(removed.network).Resources).toEqual(asJson(parallel.network).Resources);
    expect(json.Outputs.MskClusterArn).toBeUndefined();
    expect(json.Outputs.KafkaProvider.Value).toBe('strimzi');
  });

  test('네트워크 제거 단계에서만 MSK 전용 subnet·SG를 제거한다', () => {
    const network = Template.fromStack(retired.network);
    network.resourceCountIs('AWS::EC2::Subnet', 2);
    network.resourceCountIs('AWS::EC2::SecurityGroup', 9);
    expect(JSON.stringify(network.toJSON())).not.toContain('DevMsk');
    expect(asJson(retired.eks)).toEqual(asJson(removed.eks));
    for (const key of ['data', 'edge'] as const) {
      expect(asJson(parallel[key])).toEqual(asJson(baseline[key]));
      expect(asJson(retired[key])).toEqual(asJson(baseline[key]));
    }
  });

  test('Strimzi에서는 AWS/Kafka 경보만 제거하며 애플리케이션 로그 경보를 유지한다', () => {
    const json = asJson(parallel.eks);
    const alarms = Object.values<any>(json.Resources).filter(resource => resource.Type === 'AWS::CloudWatch::Alarm');
    expect(alarms).toHaveLength(5);
    expect(JSON.stringify(alarms)).not.toContain('AWS/Kafka');
    expect(alarms.map(alarm => alarm.Properties.MetricName)).toEqual(expect.arrayContaining([
      'TelemetryGatewayRejected', 'TelemetryPublishFailed', 'TelemetryPermanentFailure', 'TelemetryRetryExhausted', 'TelemetryCommitFailed',
    ]));
  });

  test.each([
    ['strimzi', 'eks_validation', 'retain', ['eks_validation/*']],
    ['strimzi', 'eks', 'retain', ['eks/*', 'eks_validation/*']],
    ['strimzi', 'eks', 'cluster-removed', ['eks/*']],
    ['strimzi', 'eks', 'network-removed', ['eks/*']],
    ['msk', 'eks', 'retain', ['eks/*']],
  ] as const)('%s/%s/%s의 archive 권한과 기존 앱 자격을 보존한다', (provider, prefix, retirement, suffixes) => {
    const current = buildDevApp({ devKafkaProvider: provider, devEksArchivePrefix: prefix, devMskRetirementStage: retirement });
    const before = asJson(baseline.eks), after = asJson(current.eks);
    const policies = Object.entries<any>(after.Resources)
      .filter(([id, resource]) => id.startsWith('Runtime') && resource.Type === 'AWS::IAM::Policy');
    const s3Statements = policies.flatMap(([id, resource]) => resource.Properties.PolicyDocument.Statement
      .filter((statement: any) => JSON.stringify(statement.Action).includes('s3:'))
      .map((statement: any) => ({ id, statement })));
    expect(s3Statements).toHaveLength(1);
    expect(s3Statements[0].id).toContain('RuntimeTelemetryIngest');
    const statement = s3Statements[0].statement;
    const original = Object.values<any>(before.Resources)
      .filter(resource => resource.Type === 'AWS::IAM::Policy')
      .flatMap(resource => resource.Properties.PolicyDocument.Statement)
      .find((entry: any) => entry.Action === 's3:PutObject');
    const expectedResources = suffixes.map(suffix => JSON.parse(JSON.stringify(original.Resource).replace('eks_validation/*', suffix)));
    expect(statement).toEqual({
      Effect: 'Allow', Action: 's3:PutObject',
      Resource: expectedResources.length === 1 ? expectedResources[0] : expectedResources,
      Condition: { Bool: { 'aws:SecureTransport': 'true' } },
    });
    for (const [id, resource] of Object.entries<any>(before.Resources)) {
      if ((resource.Type === 'AWS::IAM::Role' || resource.Type === 'AWS::EKS::PodIdentityAssociation')
        && /^Runtime(Enrollment|TelemetryIngest|TelemetryGateway|Dashboard)/.test(id)) {
        expect(after.Resources[id]).toEqual(resource);
      }
      if (resource.Type === 'AWS::IAM::Policy') {
        const secretStatements = resource.Properties.PolicyDocument.Statement
          .filter((entry: any) => JSON.stringify(entry.Action).includes('secretsmanager:'));
        if (secretStatements.length) expect(after.Resources[id].Properties.PolicyDocument.Statement).toEqual(expect.arrayContaining(secretStatements));
      }
    }
    expect(asJson(current.data)).toEqual(asJson(baseline.data));
    const expectedEdge = structuredClone(asJson(baseline.edge));
    if (provider === 'strimzi' && prefix === 'eks') {
      // main 준비의 OTLP action만 달라진다. 철거 stage는 다른 Edge 리소스를 바꾸지 않는다.
      expectedEdge.Resources.EksValidationAlbHttpOtlpRule810EC07C.Properties.Actions = [{
        Type: 'forward', ForwardConfig: { TargetGroups: [
          { TargetGroupArn: { Ref: 'EksValidationIngestTg57D75D2A' }, Weight: 100 },
          { TargetGroupArn: { Ref: 'EksValidationGatewayTg502E534F' }, Weight: 0 },
        ] },
      }];
    }
    expect(asJson(current.edge)).toEqual(expectedEdge);
  });

  test.each([
    { devKafkaProvider: 'other' },
    { devKafkaProvider: 'strimzi', devMskRetirementStage: 'delete-all' },
    { devMskRetirementStage: 'cluster-removed' },
  ])('잘못된 공급자·삭제 순서 입력을 거부한다: %j', context => {
    expect(() => buildDevApp(context)).toThrow(/devKafkaProvider|devMskRetirementStage/);
  });
});
