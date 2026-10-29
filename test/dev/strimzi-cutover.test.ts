import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Template } from 'aws-cdk-lib/assertions';
import { load } from 'js-yaml';
import { buildDevApp, TEST_ENV } from '../helpers';

const { readDeploymentProfile, createProfileContext } = require('../../lib/dev/deployment-profile.cjs');
const profile = readDeploymentProfile(resolve(__dirname, '../../config/dev/deployment.json'));
const context = createProfileContext(profile, TEST_ENV.account);

const asJson = (stack: any) => Template.fromStack(stack).toJSON();
const ruleId = 'EksValidationAlbHttpOtlpRule810EC07C';
const rule = (edge: any) => edge.Resources[ruleId].Properties;
const targetId = (edge: any, name: string) => Object.entries<any>(edge.Resources)
  .find(([, value]) => value.Type === 'AWS::ElasticLoadBalancingV2::TargetGroup' && value.Properties.Name === `soma-376-dev-eks-${name}-v`)![0];
const single = (edge: any, name: string) => [{ Type: 'forward', TargetGroupArn: { Ref: targetId(edge, name) } }];
const weighted = (edge: any) => [{ Type: 'forward', ForwardConfig: { TargetGroups: [
  { TargetGroupArn: { Ref: targetId(edge, 'ingest') }, Weight: 100 },
  { TargetGroupArn: { Ref: targetId(edge, 'gateway') }, Weight: 0 },
] } }];

/** ADR-0049: listener 연결 준비 → 실제 healthy → 별도 공개 전환 → 별도 HTTP 종료 순서다. */
describe('Strimzi main Gateway health check 준비', () => {
  const prepared = buildDevApp(context);
  const preparedEdge = asJson(prepared.edge);
  const gateway = buildDevApp({ ...context, devEksOtlpTarget: 'gateway' });
  const gatewayEdge = asJson(gateway.edge);

  test('main/Strimzi/retain·ALB ingest·JWT 발급·dual을 유지한다', () => {
    expect(profile.context).toMatchObject({
      devEksArchivePrefix: 'eks', devKafkaProvider: 'strimzi',
      devMskRetirementStage: 'retain', devEksOtlpTarget: 'ingest',
    });
    const runtime = load(readFileSync(profile.runtimeValuesPath, 'utf8')) as any;
    expect(runtime.ingestMode).toBe('dual');
    expect(runtime.telemetryJwt.issueEnabled).toBe(true);
  });

  test('준비는 HTTPS OTLP Actions만 ingest100/Gateway0으로 바꾸고 전체 나머지 Edge와 output을 보존한다', () => {
    // Edge는 MSK 리소스를 소유하지 않는다. 같은 입력의 MSK Edge가 준비 전 단일 ingest 형태다.
    const before = asJson(buildDevApp({ ...context, devKafkaProvider: 'msk' }).edge);
    expect(rule(before).Actions).toEqual(single(before, 'ingest'));
    expect(rule(preparedEdge).Actions).toEqual(weighted(preparedEdge));
    expect(preparedEdge.Outputs.ValidationOtlpTarget).toEqual({ Value: 'ingest' });
    Template.fromStack(prepared.edge).hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', { Port: 443, Protocol: 'HTTPS' });
    const expected = structuredClone(before);
    expected.Resources[ruleId].Properties.Actions = weighted(before);
    expect(preparedEdge).toEqual(expected);
  });

  test('후속 gateway 선택은 기존 단일 Gateway action만 사용하며 Edge 외 스택을 바꾸지 않는다', () => {
    expect(rule(gatewayEdge).Actions).toEqual(single(gatewayEdge, 'gateway'));
    const expected = structuredClone(preparedEdge);
    expected.Resources[ruleId].Properties.Actions = single(preparedEdge, 'gateway');
    expected.Outputs.ValidationOtlpTarget = { Value: 'gateway' };
    expect(gatewayEdge).toEqual(expected);
    for (const key of ['network', 'data', 'eks'] as const) {
      expect(asJson(gateway[key])).toEqual(asJson(prepared[key]));
    }
  });

  test.each([
    ['msk', 'eks', 'ingest'], ['msk', 'eks_validation', 'ingest'],
    ['msk', 'eks', 'gateway'], ['msk', 'eks_validation', 'gateway'],
    ['strimzi', 'eks_validation', 'ingest'], ['strimzi', 'eks_validation', 'gateway'],
  ])('%s/%s/%s는 기존 단일 target action을 유지한다', (provider, prefix, target) => {
    const edge = asJson(buildDevApp({ ...context, devKafkaProvider: provider, devEksArchivePrefix: prefix, devEksOtlpTarget: target }).edge);
    expect(rule(edge).Actions).toEqual(single(edge, target));
    const expected = structuredClone(preparedEdge);
    expected.Resources[ruleId].Properties.Actions = single(preparedEdge, target);
    expected.Outputs.ValidationOtlpTarget = { Value: target };
    expect(edge).toEqual(expected);
  });
});
