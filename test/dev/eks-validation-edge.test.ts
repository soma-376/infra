import { Match, Template } from 'aws-cdk-lib/assertions';
import { buildDevApp } from '../helpers';
import { DEV_BOOTSTRAP_PATHS, DEV_ENROLLMENT_API_PATHS, DEV_ENROLLMENT_MANAGEMENT_PATHS, DEV_OTLP_PATHS } from '../../lib/dev/config';

const context = { devEksEnabled: true, devEksApiAllowedCidrs: '203.0.113.10/32', devAllowedCidr: '203.0.113.10/32' };

test('검증 ALB는 신규 TG만 사용하고 기존 ECS forwarding과 WAF 정책을 보존한다', () => {
  const old = buildDevApp({devAllowedCidr: '203.0.113.10/32'});
  const built = buildDevApp(context);
  const before = Template.fromStack(old.edge).toJSON();
  const edge = Template.fromStack(built.edge);
  const after = edge.toJSON();
  for (const [id, resource] of Object.entries(before.Resources)) expect(after.Resources[id]).toEqual(resource);
  edge.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 2);
  edge.resourceCountIs('AWS::ElasticLoadBalancingV2::TargetGroup', 7);
  edge.resourceCountIs('AWS::WAFv2::WebACL', 1);
  edge.resourceCountIs('AWS::WAFv2::WebACLAssociation', 2);
  edge.resourceCountIs('AWS::EC2::SecurityGroupIngress', 0);
  const associations = Object.values(edge.findResources('AWS::WAFv2::WebACLAssociation')).map((r: any) => r.Properties.WebACLArn);
  expect(associations[0]).toEqual(associations[1]);
  for (const [id, output] of Object.entries(before.Outputs)) expect(after.Outputs[id]).toEqual(output);
  const added = Object.entries(after.Resources).filter(([id]) => !before.Resources[id]) as [string, any][];
  const newResources = added.map(([,resource]) => resource);
  const groups = newResources.filter(r => r.Type === 'AWS::ElasticLoadBalancingV2::TargetGroup');
  expect(groups).toHaveLength(3);
  for (const [name,port,type,path,delay] of [
    ['ingest',30416,'instance','/api/v1/healthz','60'],
    ['enroll',30080,'instance','/api/v1/healthz','60'],
    ['ch',8123,'ip','/ping','300'],
  ] as const) {
    expect(groups.map(g => g.Properties)).toEqual(expect.arrayContaining([expect.objectContaining({
      Name:`soma-376-dev-eks-${name}-v`, Port:port, TargetType:type, HealthCheckPath:path, HealthCheckPort:'traffic-port', Matcher:{HttpCode:'200'},
      Tags:expect.arrayContaining([{Key:'pulsemetry:eks-cluster',Value:'soma-376-dev-eks'}]),
      TargetGroupAttributes: expect.arrayContaining([{Key:'deregistration_delay.timeout_seconds',Value:delay}]),
    })]));
  }
  groups.forEach(g=>expect(g.Properties.Targets).toBeUndefined());
  const groupRef = (name: string) => ({ Ref: added.find(([,r]) => r.Type === 'AWS::ElasticLoadBalancingV2::TargetGroup' && r.Properties.Name === `soma-376-dev-eks-${name}-v`)![0] });
  const listeners = added.filter(([,r]) => r.Type === 'AWS::ElasticLoadBalancingV2::Listener');
  const [httpId, http] = listeners.find(([,r]) => r.Properties.Port === 80)!;
  const [,clickhouseListener] = listeners.find(([,r]) => r.Properties.Port === 8123)!;
  expect(clickhouseListener.Properties.LoadBalancerArn).toEqual(http.Properties.LoadBalancerArn);
  expect(clickhouseListener.Properties.DefaultActions).toEqual([{ Type:'forward', TargetGroupArn:groupRef('ch') }]);
  const rules = newResources.filter(r => r.Type === 'AWS::ElasticLoadBalancingV2::ListenerRule');
  expect(rules).toHaveLength(4);
  for (const [priority, paths, name] of [
    [1,DEV_OTLP_PATHS,'ingest'], [3,DEV_ENROLLMENT_API_PATHS,'enroll'],
    [4,DEV_BOOTSTRAP_PATHS,'enroll'], [5,DEV_ENROLLMENT_MANAGEMENT_PATHS,'enroll'],
  ] as const) {
    expect(rules.find(r=>r.Properties.Priority===priority)?.Properties).toEqual(expect.objectContaining({
      Priority:priority, ListenerArn:{ Ref:httpId },
      Conditions:[{ Field:'path-pattern', PathPatternConfig:{ Values:[...paths] } }],
      Actions:[{ Type:'forward', TargetGroupArn:groupRef(name) }],
    }));
  }
  expect(JSON.stringify(rules)).not.toContain('/api/v1/healthz');
  edge.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
    Port:80, DefaultActions:[{Type:'fixed-response',FixedResponseConfig:{StatusCode:'404',ContentType:'text/plain',MessageBody:'Not Found'}}],
  });
  for (const name of ['ValidationTelemetryIngestTargetGroupArn','ValidationEnrollmentApiTargetGroupArn','ValidationClickhouseTargetGroupArn','ValidationPublicBaseUrl']) {
    edge.hasOutput(name, { Value: Match.anyValue() });
  }
  const assembly = built.app.synth();
  expect(assembly.getStackArtifact(built.eks!.artifactId).dependencies.map(d=>d.id)).not.toContain(built.edge.artifactId);
  expect(assembly.getStackArtifact(built.edge.artifactId).dependencies.map(d=>d.id)).not.toContain(built.eks!.artifactId);
});
