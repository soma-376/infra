import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Template } from 'aws-cdk-lib/assertions';
import { DEV_EKS_NODE_PORTS } from '../../lib/dev/eks-config';
import { buildDevApp } from '../helpers';

describe('기존 EKS edge의 identity 보존', () => {
  const built = buildDevApp({ devAllowedCidr: '203.0.113.10/32' });
  const edge = Template.fromStack(built.edge), network = Template.fromStack(built.network);
  const resources = edge.toJSON().Resources;
  const groups = Object.entries(edge.findResources('AWS::ElasticLoadBalancingV2::TargetGroup')) as [string, any][];
  const group = (name: string) => groups.find(([, resource]) => resource.Properties.Name === `soma-376-dev-eks-${name}-v`)!;

  test('기존 EKS ALB와 association만 남기고 Web ACL 하나를 유지한다', () => {
    expect(Object.keys(edge.findResources('AWS::ElasticLoadBalancingV2::LoadBalancer'))).toEqual(['EksValidationAlb629E2981']);
    expect(Object.keys(edge.findResources('AWS::WAFv2::WebACLAssociation'))).toEqual(['EksValidationWafAssociationA5870DA0']);
    expect(Object.keys(edge.findResources('AWS::WAFv2::WebACL'))).toEqual(['DevWafWebAclCD3BB602']);
    edge.resourceCountIs('AWS::EC2::SecurityGroupIngress', 0);
    expect(JSON.stringify(resources)).not.toMatch(/DevAlb6E3BD7B3|DevTelemetryIngestTg|DevEnrollmentApiTg|DevDashboardApiTg|DevClickhouseTg/);
  });

  test('다섯 TG의 배포된 logical ID·이름·타입·NodePort·health·drain을 유지한다', () => {
    expect(groups).toHaveLength(5);
    for (const [name, logicalId, port, type, path, delay] of [
      ['ingest', 'EksValidationIngestTg57D75D2A', 30416, 'instance', '/api/v1/healthz', '60'],
      ['enroll', 'EksValidationEnrollmentTgF7289365', 30080, 'instance', '/api/v1/healthz', '60'],
      ['dashboard', 'EksValidationDashboardTg6075C143', 30081, 'instance', '/api/v1/healthz', '60'],
      ['gateway', 'EksValidationGatewayTg502E534F', 30082, 'instance', '/api/v1/healthz', '60'],
      ['ch', 'EksValidationClickhouseTg1069CCC7', 8123, 'ip', '/ping', '300'],
    ] as const) {
      const [id, resource] = group(name);
      expect(id).toBe(logicalId);
      expect(resource.Properties).toMatchObject({ Port: port, TargetType: type, HealthCheckPath: path,
        HealthCheckPort: 'traffic-port', Matcher: { HttpCode: '200' },
        Tags: expect.arrayContaining([{ Key: 'pulsemetry:eks-cluster', Value: 'soma-376-dev-eks' }]),
        TargetGroupAttributes: expect.arrayContaining([{ Key: 'deregistration_delay.timeout_seconds', Value: delay }]),
      });
      expect(resource.Properties.Targets).toBeUndefined();
    }
  });

  test('generated YAML이 소비하는 Validation output 이름과 참조를 보존한다', () => {
    for (const [output, name] of [['ValidationTelemetryIngestTargetGroupArn', 'ingest'],
      ['ValidationEnrollmentApiTargetGroupArn', 'enroll'], ['ValidationDashboardApiTargetGroupArn', 'dashboard'],
      ['ValidationClickhouseTargetGroupArn', 'ch'], ['ValidationTelemetryGatewayTargetGroupArn', 'gateway']]) {
      expect(edge.toJSON().Outputs[output].Value).toEqual({ Ref: group(name)[0] });
    }
    for (const output of ['ValidationAlbArn', 'ValidationPublicBaseUrl', 'ValidationClickhouseUrl']) edge.hasOutput(output, {});
  });

  test('priority 1 OTLP 규칙 ID와 53개 앱 규칙의 listener를 보존한다', () => {
    const rules = Object.values(edge.findResources('AWS::ElasticLoadBalancingV2::ListenerRule')) as any[];
    expect(rules).toHaveLength(53);
    expect(rules.every(rule => rule.Properties.ListenerArn.Ref === 'EksValidationAlbHttpB310BAC9')).toBe(true);
    expect(resources.EksValidationAlbHttpOtlpRule810EC07C.Properties).toMatchObject({
      ListenerArn: { Ref: 'EksValidationAlbHttpB310BAC9' }, Priority: 1,
      Actions: [{ Type: 'forward', TargetGroupArn: { Ref: group('ingest')[0] } }],
      Conditions: [{ Field: 'path-pattern', PathPatternConfig: { Values: ['/v1/traces', '/v1/metrics', '/v1/logs'] } }],
    });
    expect(rules.filter(rule => rule.Properties.Priority === 1)).toHaveLength(1);
    expect(resources.EksValidationAlbHttpB310BAC9.Properties.DefaultActions).toEqual([
      { Type: 'fixed-response', FixedResponseConfig: { StatusCode: '404', ContentType: 'text/plain', MessageBody: 'Not Found' } },
    ]);
  });

  test('NodePort는 EKS ALB에서만 열고 TG·Helm·CDK output과 일치한다', () => {
    const ingress = Object.values(network.findResources('AWS::EC2::SecurityGroupIngress')) as any[];
    for (const [name, port] of [['ingest', 30416], ['enroll', 30080], ['dashboard', 30081], ['gateway', 30082]] as const) {
      expect(group(name)[1].Properties.Port).toBe(port);
      const rules = ingress.filter(resource => resource.Properties.FromPort === port);
      expect(rules).toHaveLength(1);
      expect(rules[0].Properties).toMatchObject({ FromPort: port, ToPort: port, IpProtocol: 'tcp',
        GroupId: { 'Fn::GetAtt': ['DevEksAppNodeSg95755693', 'GroupId'] },
        SourceSecurityGroupId: { 'Fn::GetAtt': ['DevEksValidationAlbSg7D5E6C15', 'GroupId'] },
      });
      expect(rules[0].Properties.CidrIp).toBeUndefined();
    }
    expect(DEV_EKS_NODE_PORTS.dashboard).toBe(30081);
    expect(readFileSync(join(__dirname, '../../helm/dev/workloads/dashboard-api.yaml'), 'utf8')).toMatch(/^nodePort: 30081$/m);
    Template.fromStack(built.eks).hasOutput('EksDashboardApiNodePort', { Value: '30081' });
  });
});
