import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { App, Stack } from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { InstanceType } from 'aws-cdk-lib/aws-ec2';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { Cluster, ContainerImage, Ec2Service, Ec2TaskDefinition, NetworkMode } from 'aws-cdk-lib/aws-ecs';
import { DevNetworkStack } from '../../lib/dev/network-stack';
import { DevEdgeStack } from '../../lib/dev/edge-stack';
import { DEV_EKS_NODE_PORTS } from '../../lib/dev/eks-config';
import { DevEksStack } from '../../lib/dev/eks-stack';

/** 실제 Network/Edge와 공유 라우팅을 조립한다. ECS 서비스만 로컬 fixture다. */
function build(eksEnabled: boolean) {
  const context = JSON.parse(readFileSync(join(__dirname, '../../cdk.json'), 'utf8')).context;
  const app = new App({ context });
  const env = { account: '111111111111', region: 'ap-northeast-2' };
  const network = new DevNetworkStack(app, 'DevNetworkStack', { env, allowedCidrs: ['203.0.113.10/32'], eksEnabled });
  const services = new Stack(app, 'FixtureServices', { env });
  const cluster = new Cluster(services, 'Cluster', { vpc: network.vpc });
  cluster.addCapacity('FixtureCapacity', { instanceType: new InstanceType('t4g.medium'),
    minCapacity: 1, maxCapacity: 1,
  });
  const service = (name: string, port: number) => {
    const task = new Ec2TaskDefinition(services, `${name}Task`, {
      networkMode: name === 'clickhouse' ? NetworkMode.AWS_VPC : NetworkMode.BRIDGE,
    });
    task.addContainer(name, { image: ContainerImage.fromRegistry('fixture'), memoryReservationMiB: 1024, portMappings: [{ containerPort: port }] });
    return new Ec2Service(services, `${name}Service`, { cluster, taskDefinition: task, desiredCount: 1,
      ...(name === 'clickhouse' ? { securityGroups: [network.clickhouseSecurityGroup] } : {}),
    });
  };
  const edge = new DevEdgeStack(app, 'DevEdgeStack', {
    env, vpc: network.vpc, albSecurityGroup: network.albSecurityGroup,
    eksValidationAlbSecurityGroup: network.eksValidationAlbSecurityGroup,
    telemetryIngestService: service('telemetry-ingest', 4316), enrollmentApiService: service('enrollment-api', 8080),
    dashboardApiService: service('dashboard-api', 8081), clickhouseService: service('clickhouse', 8123),
    dbEndpoint: 'db.example.invalid', dbSecretArn: 'fixture-db-reference',
    tokenHashSecretArn: 'fixture-hmac-reference', adminApiTokenSecretArn: 'fixture-admin-reference',
  });
  const reference = (name: string) => Secret.fromSecretCompleteArn(services, name,
    `arn:aws:secretsmanager:ap-northeast-2:111111111111:secret:fixture-${name}-abcdef`);
  const eks = eksEnabled ? new DevEksStack(app, 'DevEksStack', {
    env, vpc: network.vpc, config: { enabled: true, archivePrefix: 'eks_validation' },
    dbEndpoint: 'db.example.invalid', dbSecret: reference('db'), tokenHashSecret: reference('hmac'),
    dashboardRdsSourceSecret: reference('rdsSource'), dashboardRdsCacheSecret: reference('rdsCache'),
    dashboardClickHouseSourceSecret: reference('chSource'), dashboardClickHouseCacheSecret: reference('chCache'),
    userJwtPrivateKeySecret: reference('jwtPrivate'), userJwtPublicKeysSecret: reference('jwtPublic'),
    adminApiTokenSecret: reference('admin'), rawSignalBucket: Bucket.fromBucketName(services, 'RawBucket', 'fixture-raw-bucket'),
    controlPlaneSecurityGroup: network.eksControlPlaneSecurityGroup!, appNodeSecurityGroup: network.eksAppNodeSecurityGroup!,
    clickhouseNodeSecurityGroup: network.eksClickhouseNodeSecurityGroup!,
    relaySecurityGroup: network.eksRelaySecurityGroup!,
    mskSubnets: network.mskSubnets!, mskSecurityGroup: network.mskSecurityGroup!,
  }) : undefined;
  return { network: Template.fromStack(network), edge: Template.fromStack(edge), eks: eks ? Template.fromStack(eks) : undefined };
}

describe('EKS dashboard 검증 edge', () => {
  const disabled = build(false), enabled = build(true);
  const before = disabled.edge.toJSON(), after = enabled.edge.toJSON();
  const added = Object.entries(after.Resources).filter(([id]) => !before.Resources[id]) as [string, any][];
  const groups = added.filter(([, resource]) => resource.Type === 'AWS::ElasticLoadBalancingV2::TargetGroup');
  const group = (name: string) => groups.find(([, resource]) => resource.Properties.Name === `soma-376-dev-eks-${name}-v`)!;
  const http = (entries: [string, any][]) => entries.find(([, resource]) => resource.Type === 'AWS::ElasticLoadBalancingV2::Listener' && resource.Properties.Port === 80)!;
  const ecsHttp = http(Object.entries(before.Resources)), eksHttp = http(added);
  const rules = (listener: string): any[] => Object.values(after.Resources).filter((resource: any) =>
    resource.Type === 'AWS::ElasticLoadBalancingV2::ListenerRule' && resource.Properties.ListenerArn.Ref === listener)
    .map((resource: any) => resource.Properties).sort((a, b) => a.Priority - b.Priority);

  test('기존 ECS 리소스·output을 보존하고 WAF 하나를 두 ALB에 연결한다', () => {
    for (const [id, resource] of Object.entries(before.Resources)) expect(after.Resources[id]).toEqual(resource);
    for (const [id, output] of Object.entries(before.Outputs)) expect(after.Outputs[id]).toEqual(output);
    for (const [type, count] of [['LoadBalancer', 2], ['TargetGroup', 8]] as const) enabled.edge.resourceCountIs(`AWS::ElasticLoadBalancingV2::${type}`, count);
    enabled.edge.resourceCountIs('AWS::WAFv2::WebACL', 1);
    enabled.edge.resourceCountIs('AWS::WAFv2::WebACLAssociation', 2);
    const associations = Object.values(enabled.edge.findResources('AWS::WAFv2::WebACLAssociation')) as any[];
    expect(associations[0].Properties.WebACLArn).toEqual(associations[1].Properties.WebACLArn);
    enabled.edge.resourceCountIs('AWS::EC2::SecurityGroupIngress', 0);
  });

  test('검증 TG 네 개는 기존 두 Spring TG의 ID·포트를 유지하고 dashboard 30081을 추가한다', () => {
    expect(groups).toHaveLength(4);
    for (const [name, prefix, port, type, path, delay] of [
      ['ingest', 'EksValidationIngestTg', 30416, 'instance', '/api/v1/healthz', '60'],
      ['enroll', 'EksValidationEnrollmentTg', 30080, 'instance', '/api/v1/healthz', '60'],
      ['dashboard', 'EksValidationDashboardTg', 30081, 'instance', '/api/v1/healthz', '60'],
      ['ch', 'EksValidationClickhouseTg', 8123, 'ip', '/ping', '300'],
    ] as const) {
      const [id, resource] = group(name);
      expect(id.startsWith(prefix)).toBe(true);
      expect(resource.Properties).toMatchObject({ Port: port, TargetType: type, HealthCheckPath: path,
        HealthCheckPort: 'traffic-port', Matcher: { HttpCode: '200' },
        Tags: expect.arrayContaining([{ Key: 'pulsemetry:eks-cluster', Value: 'soma-376-dev-eks' }]),
        TargetGroupAttributes: expect.arrayContaining([{ Key: 'deregistration_delay.timeout_seconds', Value: delay }]),
      });
      expect(resource.Properties.Targets).toBeUndefined();
    }
    // 검증 construct의 scope와 id를 바꾸면 이 logical ID가 달라져 TG 교체가 발생한다.
    expect(group('ingest')[0]).toBe('EksValidationIngestTg57D75D2A');
    expect(group('enroll')[0]).toBe('EksValidationEnrollmentTgF7289365');
  });

  test('기존 output 이름을 유지하고 새 dashboard TG ARN을 별도 output으로 전달한다', () => {
    for (const [output, name] of [['ValidationTelemetryIngestTargetGroupArn', 'ingest'],
      ['ValidationEnrollmentApiTargetGroupArn', 'enroll'], ['ValidationDashboardApiTargetGroupArn', 'dashboard'],
      ['ValidationClickhouseTargetGroupArn', 'ch']]) expect(after.Outputs[output].Value).toEqual({ Ref: group(name)[0] });
    for (const output of ['ValidationAlbArn', 'ValidationPublicBaseUrl', 'ValidationClickhouseUrl']) expect(after.Outputs[output]).toBeDefined();
  });

  test('기존 ECS와 EKS의 priority 1 OTLP 규칙 ID를 보존해 업데이트 중 중복 생성을 막는다', () => {
    // PROJ-212 이전부터 사용한 ID다. ID만 바꾸면 같은 listener의 priority 1을 재생성한다.
    for (const [ruleId, listenerId, targetId] of [
      ['DevAlbDevHttpListenerDevOtlpForwardRule79AA5238', ecsHttp[0], 'DevTelemetryIngestTg055AAFB6'],
      ['EksValidationAlbHttpOtlpRule810EC07C', eksHttp[0], group('ingest')[0]],
    ]) {
      expect(after.Resources[ruleId]).toMatchObject({
        Type: 'AWS::ElasticLoadBalancingV2::ListenerRule',
        Properties: {
          ListenerArn: { Ref: listenerId }, Priority: 1,
          Actions: [{ Type: 'forward', TargetGroupArn: { Ref: targetId } }],
          Conditions: [{ Field: 'path-pattern', PathPatternConfig: { Values: ['/v1/traces', '/v1/metrics', '/v1/logs'] } }],
        },
      });
      expect(rules(listenerId).filter((rule) => rule.Priority === 1)).toHaveLength(1);
    }
  });

  test('ECS와 EKS는 같은 53개 조건을 서로 다른 소유 TG에 연결하고 default 404를 유지한다', () => {
    const ecs = rules(ecsHttp[0]), eks = rules(eksHttp[0]);
    expect(ecs).toHaveLength(53); expect(eks).toHaveLength(53);
    expect(ecs.map(({ Priority, Conditions }) => ({ Priority, Conditions })))
      .toEqual(eks.map(({ Priority, Conditions }) => ({ Priority, Conditions })));
    for (let index = 0; index < ecs.length; index++) {
      const ecsTarget: string = ecs[index].Actions[0].TargetGroupArn.Ref;
      const eksTarget = eks[index].Actions[0].TargetGroupArn.Ref;
      const name = ecsTarget.startsWith('DevDashboard') ? 'dashboard' : ecsTarget.startsWith('DevEnrollment') ? 'enroll' : 'ingest';
      expect(eksTarget).toBe(group(name)[0]); expect(eksTarget).not.toBe(ecsTarget);
    }
    for (const listener of [ecsHttp[1], eksHttp[1]]) expect(listener.Properties.DefaultActions).toEqual([
      { Type: 'fixed-response', FixedResponseConfig: { StatusCode: '404', ContentType: 'text/plain', MessageBody: 'Not Found' } },
    ]);
  });

  test('Network만 30081을 열고 Helm·TG·상수·기존 CDK output의 값과 일치한다', () => {
    const ingress = Object.values(enabled.network.findResources('AWS::EC2::SecurityGroupIngress')) as any[];
    for (const [name, port] of [['ingest', 30416], ['enroll', 30080], ['dashboard', 30081]] as const) {
      expect(group(name)[1].Properties.Port).toBe(port);
      expect(ingress.filter((resource) => resource.Properties.FromPort === port && resource.Properties.ToPort === port)).toHaveLength(2);
    }
    const dashboard = ingress.filter((resource) => resource.Properties.FromPort === 30081);
    expect(dashboard).toHaveLength(2);
    for (const resource of dashboard) {
      expect(resource.Properties).toMatchObject({ FromPort: 30081, ToPort: 30081, IpProtocol: 'tcp' });
      expect(JSON.stringify(resource.Properties.GroupId)).toContain('DevEksAppNodeSg');
      expect(resource.Properties.CidrIp).toBeUndefined();
    }
    expect(dashboard.map((resource) => JSON.stringify(resource.Properties.SourceSecurityGroupId)))
      .toEqual(expect.arrayContaining([expect.stringContaining('DevAlbSg'), expect.stringContaining('DevEksValidationAlbSg')]));
    expect(Object.values(disabled.network.findResources('AWS::EC2::SecurityGroupIngress'))
      .some((resource: any) => resource.Properties.FromPort === 30081)).toBe(false);
    expect(DEV_EKS_NODE_PORTS.dashboard).toBe(30081);
    expect(group('dashboard')[1].Properties.Port).toBe(DEV_EKS_NODE_PORTS.dashboard);
    expect(readFileSync(join(__dirname, '../../helm/dev/workloads/dashboard-api.yaml'), 'utf8')).toMatch(/^nodePort: 30081$/m);
    enabled.eks!.hasOutput('EksDashboardApiNodePort', { Value: '30081' });
  });
});
