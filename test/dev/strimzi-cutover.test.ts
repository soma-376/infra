import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Template } from 'aws-cdk-lib/assertions';
import { load } from 'js-yaml';
import { buildDevApp, TEST_ENV } from '../helpers';

const { readDeploymentProfile, createProfileContext } = require('../../lib/dev/deployment-profile.cjs');
const profile = readDeploymentProfile(resolve(__dirname, '../../config/dev/deployment.json'));
const context = createProfileContext(profile, TEST_ENV.account);

/** ADR-0049: 공개 ALB 전환과 ingest HTTP 종료를 서로 다른 배포로 검증한다. */
describe('Strimzi main ALB 전환 profile', () => {
  const before = buildDevApp({ ...context, devEksOtlpTarget: 'ingest' });
  const after = buildDevApp(context);
  const beforeEdge = Template.fromStack(before.edge).toJSON();
  const afterEdge = Template.fromStack(after.edge).toJSON();

  test('main/Strimzi/retain과 JWT 발급·dual HTTP 복구 경로를 유지한다', () => {
    expect(profile.context).toMatchObject({
      devEksArchivePrefix: 'eks', devKafkaProvider: 'strimzi',
      devMskRetirementStage: 'retain', devEksOtlpTarget: 'gateway',
    });
    const runtime = load(readFileSync(profile.runtimeValuesPath, 'utf8')) as any;
    expect(runtime.ingestMode).toBe('dual');
    expect(runtime.telemetryJwt.issueEnabled).toBe(true);
  });

  test('HTTPS OTLP 규칙의 forward 대상과 표시 output만 바꾸고 전체 나머지 template을 보존한다', () => {
    const ruleId = 'EksValidationAlbHttpOtlpRule810EC07C';
    const targetId = (name: string) => Object.entries<any>(afterEdge.Resources)
      .find(([, value]) => value.Type === 'AWS::ElasticLoadBalancingV2::TargetGroup' && value.Properties.Name === name)![0];
    const rule = (edge: any) => edge.Resources[ruleId].Properties;
    expect(rule(beforeEdge).Actions).toEqual([{ Type: 'forward', TargetGroupArn: { Ref: targetId('soma-376-dev-eks-ingest-v') } }]);
    expect(rule(afterEdge).Actions).toEqual([{ Type: 'forward', TargetGroupArn: { Ref: targetId('soma-376-dev-eks-gateway-v') } }]);
    expect(afterEdge.Outputs.ValidationOtlpTarget).toEqual({ Value: 'gateway' });
    Template.fromStack(after.edge).hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', { Port: 443, Protocol: 'HTTPS' });
    const expected = structuredClone(beforeEdge);
    expected.Resources[ruleId].Properties.Actions = rule(afterEdge).Actions;
    expected.Outputs.ValidationOtlpTarget = { Value: 'gateway' };
    expect(afterEdge).toEqual(expected);
    for (const key of ['network', 'data', 'eks'] as const) {
      expect(Template.fromStack(after[key]).toJSON()).toEqual(Template.fromStack(before[key]).toJSON());
    }
  });
});
