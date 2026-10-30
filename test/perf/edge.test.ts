import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { dump, load, loadAll } from 'js-yaml';
import { Template } from 'aws-cdk-lib/assertions';
import { buildDevApp, buildPerfApp } from '../helpers';
import { loadPerfProfile } from '../../lib/perf/profile';
import { collectPerfOutputs, parseInputYaml, parsePerfRuntimeInput, sha256 } from '../../lib/perf/deploy-inputs';
import { generatePerfValues } from '../../lib/perf/values';
import { buildProvisional, checkProvisional, contractEndpoints } from '../../lib/perf/results';
import { environmentSchemas } from '../../lib/perf/contract/schema-subset';
import { PERF_STRIMZI, STRIMZI_CLIENT_ROLES, parsePerfStrimziMetadata, strimziUser } from '../../lib/perf/strimzi';
import { PERF_GATEWAY_HTTPS } from '../../lib/perf/edge-config';
import { ACCOUNT, ENVIRONMENT_ID, ROOT, RUNTIME_VALUES, describeStacks, perfRequest } from './perf-fixtures';

const profilePath = 'profiles/perf/strimzi-fixed-v1.json';
const certificateArn = `arn:aws:acm:ap-northeast-2:${ACCOUNT}:certificate/01234567-0123-0123-0123-0123456789ab`;
const context = { perfProfile: profilePath, perfCertificateArn: certificateArn };
const built = buildPerfApp(context);
const edge = Template.fromStack(built.edge!);
const network = Template.fromStack(built.network);
const eks = Template.fromStack(built.eks);
const resources = (template: Template, type: string): any[] => Object.values(template.findResources(type));
const profile = loadPerfProfile(profilePath, ROOT);
const requestBytes = perfRequest(r => { r.infra.parameters.certificateArn = certificateArn; r.infra.parameters.gatewayHttps = PERF_GATEWAY_HTTPS; }, profilePath);
const request = JSON.parse(requestBytes.toString());
const outputs = collectPerfOutputs([describeStacks({}, context)]);
const metadata = parsePerfStrimziMetadata({ items: [PERF_STRIMZI.ca, ...STRIMZI_CLIENT_ROLES.map(strimziUser)].map((name, i) => ({ metadata: { name, namespace: 'pulsemetry-perf', uid: `uid-${i}`, resourceVersion: String(i + 1) } })) });
const values = () => generatePerfValues({ profile, request, outputs, runtime: parsePerfRuntimeInput(parseInputYaml(RUNTIME_VALUES, 'runtime')), strimziMetadata: metadata }) as any;

test('runtime 인증서 입력이 없으면 기존 4스택과 내부 endpoint를 보존한다', () => {
  expect(buildPerfApp().edge).toBeUndefined();
  expect(contractEndpoints()).not.toHaveProperty('gateway_https');
  expect(() => buildPerfApp({ ...context, perfCertificateArn: certificateArn.replace(ACCOUNT, '222222222222') })).toThrow(/계정/);
  expect(() => buildPerfApp({ ...context, perfCertificateArn: certificateArn.replace('ap-northeast-2', 'us-east-1') })).toThrow(/서울/);
  expect(() => buildPerfApp({ ...context, perfCertificateArn: '' })).toThrow(/ARN/);
});

test('HTTPS-only ALB는 공유 인증서 참조와 한 Gateway TG만 사용한다', () => {
  edge.resourceCountIs('AWS::CertificateManager::Certificate', 0);
  edge.resourceCountIs('AWS::ElasticLoadBalancingV2::Listener', 1);
  edge.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', { Port: 443, Protocol: 'HTTPS', Certificates: [{ CertificateArn: certificateArn }], DefaultActions: [{ Type: 'fixed-response', FixedResponseConfig: { ContentType: 'text/plain', MessageBody: 'Not found', StatusCode: '404' } }] });
  const rule = resources(edge, 'AWS::ElasticLoadBalancingV2::ListenerRule')[0].Properties;
  expect(rule.Conditions).toEqual(expect.arrayContaining([{ Field: 'host-header', HostHeaderConfig: { Values: ['perf-api.pulsemetry.co.kr'] } }, { Field: 'http-request-method', HttpRequestMethodConfig: { Values: ['POST'] } }, { Field: 'path-pattern', PathPatternConfig: { Values: ['/v1/traces', '/v1/metrics', '/v1/logs'] } }]));
  const tg = resources(edge, 'AWS::ElasticLoadBalancingV2::TargetGroup')[0].Properties;
  expect(tg).toMatchObject({ Port: 30082, TargetType: 'instance', HealthCheckPath: '/api/v1/healthz' });
  expect(tg.TargetGroupAttributes).toEqual(expect.arrayContaining([{ Key: 'stickiness.enabled', Value: 'false' }, { Key: 'load_balancing.algorithm.type', Value: 'round_robin' }]));
  expect(tg.Tags).toContainEqual({ Key: 'pulsemetry:perf-environment', Value: ENVIRONMENT_ID });
  edge.resourceCountIs('AWS::WAFv2::WebACLAssociation', 1);
  expect(resources(edge, 'AWS::S3::Bucket')[0].Properties.LifecycleConfiguration.Rules[0].ExpirationInDays).toBe(1);
});

test('SG는 자체 NAT의 HTTPS와 ALB→Gateway, control plane→LBC만 추가한다', () => {
  const groups = network.findResources('AWS::EC2::SecurityGroup');
  const named = (ref: any) => groups[ref?.['Fn::GetAtt']?.[0]]?.Properties.GroupDescription;
  const rules = resources(network, 'AWS::EC2::SecurityGroupIngress').map(r => r.Properties);
  const https = rules.filter(r => r.FromPort === 443 && named(r.GroupId) === 'perf HTTPS ALB from generator NAT only');
  expect(https).toHaveLength(1);
  expect(JSON.stringify(https[0].CidrIp)).not.toContain('0.0.0.0/0');
  expect(https[0].CidrIp['Fn::Join'][1][1]).toBe('/32');
  expect(rules.filter(r => r.FromPort === 30082).map(r => [named(r.GroupId), named(r.SourceSecurityGroupId)])).toEqual([['perf EKS gateway node pool', 'perf HTTPS ALB from generator NAT only']]);
  expect(rules.filter(r => r.FromPort === 9443).map(r => [named(r.GroupId), named(r.SourceSecurityGroupId)])).toEqual([['perf EKS system node pool', 'perf EKS control plane']]);
});

test('LBC는 perf TG 등록·해제만 쓰고 ALB/SG 생성·수정 권한이 없다', () => {
  const policy = resources(eks, 'AWS::IAM::Policy').find(r => r.Properties.PolicyName.startsWith('LbcRoleDefaultPolicy'));
  expect(policy).toBeDefined();
  const write = policy.Properties.PolicyDocument.Statement.find((s: any) => s.Action.includes('elasticloadbalancing:RegisterTargets'));
  expect(JSON.stringify(write.Resource)).toContain('targetgroup/soma-376-perf-eks-*/*');
  expect(write.Condition.StringEquals['aws:ResourceTag/pulsemetry:eks-cluster']).toEqual({ Ref: Object.keys(eks.findResources('AWS::EKS::Cluster'))[0] });
  expect(JSON.stringify(policy)).not.toMatch(/CreateLoadBalancer|CreateTargetGroup|AuthorizeSecurityGroup|ModifyListener/);
  expect(resources(eks, 'AWS::EKS::PodIdentityAssociation').some(r => r.Properties.ServiceAccount === 'aws-load-balancer-controller' && r.Properties.Namespace === 'kube-system')).toBe(true);
});

test('WAF의 OTLP managed/Count 정책은 dev와 같고 source Allow shortcut이 없다', () => {
  const actual = resources(edge, 'AWS::WAFv2::WebACL')[0].Properties;
  const dev = resources(Template.fromStack(buildDevApp().edge), 'AWS::WAFv2::WebACL')[0].Properties;
  for (const name of ['AmazonIpReputation', 'AnonymousIpList', 'CommonRules', 'KnownBadInputs', 'SqlInjection', 'OtlpRateCount']) {
    const a = actual.Rules.find((r: any) => r.Name === name); const d = dev.Rules.find((r: any) => r.Name === name);
    expect(a.Statement).toEqual(d.Statement); expect(a.Action).toEqual(d.Action); expect(a.OverrideAction).toEqual(d.OverrideAction);
  }
  const labels = (value: any): string[] => {
    if (Array.isArray(value)) return value.flatMap(labels);
    if (!value || typeof value !== 'object') return [];
    return [...(value.LabelMatchStatement ? [value.LabelMatchStatement.Key] : []), ...Object.values(value).flatMap(labels)];
  };
  expect([...new Set(labels(actual.Rules.find((r: any) => r.Name === 'OtlpQueryLabelBlock')))].sort())
    .toEqual([...new Set(labels(dev.Rules.find((r: any) => r.Name === 'AppQueryLabelBlock')))].sort());
  expect(actual.Rules.some((r: any) => r.Action?.Allow)).toBe(false);
  expect(actual.Rules.every((r: any) => r.VisibilityConfig.SampledRequestsEnabled === false)).toBe(true);
  expect(actual.Rules.find((r: any) => r.Name === 'OtlpRateCount').Statement.RateBasedStatement).toMatchObject({ AggregateKeyType: 'IP', EvaluationWindowSec: 300, Limit: 10000 });
  expect(actual.Rules.find((r: any) => r.Name === 'OutsidePerfNatBlock').Action).toEqual({ Block: {} });
  const logging = resources(edge, 'AWS::WAFv2::LoggingConfiguration')[0].Properties;
  expect(logging.RedactedFields).toContainEqual({ QueryString: {} });
  expect(logging.LoggingFilter.Filters[0].Conditions).toContainEqual({ ActionCondition: { Action: 'BLOCK' } });
});

test('v3 provisional과 values는 외부 origin/실제 output을 연결하고 Edge 누락을 거부한다', () => {
  const provisional = buildProvisional({ request, requestSha256: sha256(requestBytes), profile, outputs, deploymentId: `${ENVIRONMENT_ID}-d1`, createdAt: '2026-11-01T00:00:00Z' });
  expect(checkProvisional(environmentSchemas(3), request, sha256(requestBytes), provisional)).toEqual([]);
  expect((provisional.endpoints as any).gateway_https).toBe(PERF_GATEWAY_HTTPS);
  expect((provisional.endpoints as any).gateway).toContain('.svc.cluster.local:8082');
  expect(values()['lbc.yaml']).toMatchObject({ clusterName: 'soma-376-perf-eks', region: 'ap-northeast-2', vpcId: 'vpc-0123456789abcdef0' });
  expect(values()['jobs.yaml'].infra.endpoints.gatewayHttps).toBe(PERF_GATEWAY_HTTPS);
  const incomplete = { ...outputs, values: { ...outputs.values } }; delete incomplete.values.GatewayHttpsUrl;
  expect(() => generatePerfValues({ profile, request, outputs: incomplete, runtime: parsePerfRuntimeInput(parseInputYaml(RUNTIME_VALUES, 'runtime')), strimziMetadata: metadata })).toThrow(/Edge/);
});

(process.env.HELM_BIN ? test : test.skip)('NodePort와 TGB는 같은 Gateway Pod를 선택하고 dev 기본 chart는 건드리지 않는다', () => {
  const input = { ...(load(readFileSync(resolve(ROOT, 'helm/perf/workloads/telemetry-gateway.yaml'), 'utf8')) as object), ...values()['telemetry-gateway.yaml'] };
  const render = (value: unknown) => spawnSync(process.env.HELM_BIN!, ['template', 'gateway', 'helm/dev/workloads/spring-app', '-n', 'pulsemetry-perf', '--kube-version', '1.36.0', '-f', '-'], { cwd: ROOT, input: dump(value), encoding: 'utf8' });
  const result = render(input); expect([result.status, result.stderr]).toEqual([0, '']);
  const docs = loadAll(result.stdout).filter(Boolean) as any[];
  const service = docs.find(d => d.kind === 'Service' && d.metadata.name === 'telemetry-gateway');
  expect(service.spec).toMatchObject({ type: 'NodePort', externalTrafficPolicy: 'Local', ports: [{ port: 8082, nodePort: 30082 }] });
  expect(docs.find(d => d.kind === 'TargetGroupBinding').spec.nodeSelector.matchLabels['karpenter.sh/nodepool']).toBe('perf-gateway');
  const internal = { ...input, service: { type: 'ClusterIP' }, vpcId: '', targetGroupBindings: [] }; delete internal.nodePort;
  const internalResult = render(internal); expect([internalResult.status, internalResult.stderr]).toEqual([0, '']);
  const internalDocs = loadAll(internalResult.stdout).filter(Boolean) as any[];
  expect(docs.find(d => d.kind === 'Deployment')).toEqual(internalDocs.find(d => d.kind === 'Deployment'));
  expect(render({ ...input, nodePort: 30083 }).status).not.toBe(0);
  expect(render({ ...input, workload: 'enrollment-api' }).status).not.toBe(0);
});
