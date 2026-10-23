import { DEV_APP_ROUTES } from '../../lib/dev/app-routing';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { DEV_EKS_NODE_PORTS } from '../../lib/dev/eks-config';
import { PORTS } from '../../lib/common/config';
import { buildDevApp } from '../helpers';

describe('DevEdgeStack', () => {
  const { edge } = buildDevApp();
  const template = Template.fromStack(edge);

  const listeners = (): any[] =>
    Object.values(
      template.findResources('AWS::ElasticLoadBalancingV2::Listener'),
    );
  const listenerRules = (): any[] =>
    Object.values(
      template.findResources('AWS::ElasticLoadBalancingV2::ListenerRule'),
    );
  const targetGroups = (): Record<string, any> =>
    template.findResources('AWS::ElasticLoadBalancingV2::TargetGroup');
  const targetGroupByPrefix = (
    logicalIdPrefix: string,
  ): readonly [string, any] => {
    const found = Object.entries(targetGroups()).find(([logicalId]) =>
      logicalId.startsWith(logicalIdPrefix),
    );
    expect(found).toBeDefined();
    return found!;
  };
  const ruleByPriority = (priority: number): any => {
    const found = listenerRules().filter(
      (rule: any) => rule.Properties.Priority === priority,
    );
    expect(found).toHaveLength(1);
    return found[0];
  };

  test('internet-facing ALB 하나를 만든다', () => {
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 1);
    template.hasResourceProperties(
      'AWS::ElasticLoadBalancingV2::LoadBalancer',
      { Scheme: 'internet-facing' },
    );
  });

  // DB 운영자 접근은 별도 SSM 릴레이를 사용한다. (ADR-0038)
  test('앱 HTTP 리스너만 만들고 DB 포트는 열지 않는다', () => {
    const ascending = (a: number, b: number) => a - b;
    expect(listeners()).toHaveLength(1);
    expect(
      listeners()
        .map((listener: any) => listener.Properties.Port)
        .sort(ascending),
    ).toEqual([PORTS.http]);
    expect(
      listeners().some(
        (listener: any) => listener.Properties.Port === PORTS.otlp,
      ),
    ).toBe(false);
    for (const listener of listeners()) {
      expect(listener.Properties.Protocol).toBe('HTTP');
    }
  });

  test('80 리스너의 기본 액션은 fixed-response 404 다', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: PORTS.http,
      DefaultActions: Match.arrayWith([
        Match.objectLike({
          Type: 'fixed-response',
          FixedResponseConfig: Match.objectLike({ StatusCode: '404' }),
        }),
      ]),
    });
  });

  test('공통 path/method/preflight가 실제 앱 전용 TG에 연결된다', () => {
    const targets = {
      enrollment: targetGroupByPrefix('EksValidationEnrollmentTg')[0],
      dashboard: targetGroupByPrefix('EksValidationDashboardTg')[0],
    };
    const resolve = (path: string, method: string, requested?: string) => listenerRules()
      .sort((a: any, b: any) => a.Properties.Priority - b.Properties.Priority)
      .find((rule: any) => rule.Properties.Conditions.every((condition: any) => {
        if (condition.Field === 'path-pattern') return condition.PathPatternConfig.RegexValues
          ? condition.PathPatternConfig.RegexValues.some((r: string) => new RegExp(r).test(path))
          : condition.PathPatternConfig.Values.includes(path);
        if (condition.Field === 'http-request-method') return condition.HttpRequestMethodConfig.Values.includes(method);
        if (condition.Field === 'http-header') return condition.HttpHeaderConfig.Values.includes(requested);
        throw new Error('미지원 조건');
      }))?.Properties.Actions[0].TargetGroupArn;
    for (const route of DEV_APP_ROUTES) {
      const path = route.pathTemplate.replace(/\{[^}]+\}/g, 'fixture');
      for (const method of route.methods) expect(resolve(path, method)).toEqual({ Ref: targets[route.owner] });
      for (const method of route.corsMethods) expect(resolve(path, 'OPTIONS', method)).toEqual({ Ref: targets[route.owner] });
      expect(resolve(path, 'HEAD')).toBeUndefined();
      expect(resolve(path, 'OPTIONS')).toBeUndefined();
      expect(resolve(path + '/extra/unexpected/segment/path', 'GET')).toBeUndefined();
    }
    for (const path of ['/api/v1/healthz', '/v1/healthz', '/api/v1/unknown', '/api/v1/auth/login']) {
      expect(resolve(path, 'GET')).toBeUndefined();
    }
    expect(ruleByPriority(1).Properties.Conditions).toEqual([{ Field: 'path-pattern', PathPatternConfig: { Values: ['/v1/traces', '/v1/metrics', '/v1/logs'] } }]);
    expect(listenerRules().length).toBeLessThanOrEqual(100);
  });

  // 앱 네 개의 NodePort 타깃만 유지한다.
  test('네 앱 타깃 그룹의 타입과 포트가 네트워크 모드에 맞는다', () => {
    expect(Object.keys(targetGroups())).toHaveLength(4);

    for (const [prefix, targetType, port] of [
      ['EksValidationIngestTg', 'instance', DEV_EKS_NODE_PORTS.ingest],
      ['EksValidationEnrollmentTg', 'instance', DEV_EKS_NODE_PORTS.enrollment],
      ['EksValidationDashboardTg', 'instance', DEV_EKS_NODE_PORTS.dashboard],
      ['EksValidationGatewayTg', 'instance', DEV_EKS_NODE_PORTS.gateway],
    ] as const) {
      expect(targetGroupByPrefix(prefix)[1].Properties).toMatchObject({
        TargetType: targetType,
        Port: port,
      });
    }
  });

  test('세 앱만 deregistration delay를 60초로 둔다', () => {
    for (const prefix of [
      'EksValidationIngestTg',
      'EksValidationEnrollmentTg',
      'EksValidationDashboardTg',
    ]) {
      expect(
        targetGroupByPrefix(prefix)[1].Properties.TargetGroupAttributes,
      ).toEqual(
        expect.arrayContaining([
          {
            Key: 'deregistration_delay.timeout_seconds',
            Value: '60',
          },
        ]),
      );
    }
  });

  test('세 앱은 /api/v1/healthz의 200만 healthy로 판정한다', () => {
    for (const prefix of [
      'EksValidationIngestTg',
      'EksValidationEnrollmentTg',
      'EksValidationDashboardTg',
    ]) {
      expect(targetGroupByPrefix(prefix)[1].Properties).toMatchObject({
        TargetType: 'instance',
        HealthCheckPath: '/api/v1/healthz',
        Matcher: { HttpCode: '200' },
      });
    }
  });

  test('공개 ClickHouse listener와 타깃 그룹이 없다', () => {
    expect(listeners().some(listener => listener.Properties.Port === PORTS.clickhouseHttp)).toBe(false);
    expect(Object.keys(targetGroups()).some(id => id.includes('Clickhouse'))).toBe(false);
  });

  test('Cognito 와 CloudFront 를 하나도 만들지 않는다', () => {
    for (const type of [
      'AWS::Cognito::UserPool',
      'AWS::Cognito::UserPoolClient',
      'AWS::Cognito::UserPoolDomain',
      'AWS::CloudFront::Distribution',
    ]) {
      template.resourceCountIs(type, 0);
    }
  });

  test('기존 Validation·공유 데이터 output만 유지한다', () => {
    for (const outputName of [
      'ValidationAlbArn',
      'ValidationPublicBaseUrl',
      'ValidationTelemetryIngestTargetGroupArn',
      'ValidationEnrollmentApiTargetGroupArn',
      'ValidationDashboardApiTargetGroupArn',
      'RdsEndpoint',
      'RdsSecretArn',
      'TokenHashSecretArn',
      'AdminApiTokenSecretArn',
    ]) {
      template.hasOutput(outputName, {});
    }
    for (const name of ['ValidationClickhouseUrl', 'ValidationClickhouseTargetGroupArn', 'AlbDnsName', 'OtlpEndpoint', 'ClickhouseDebugUrl', 'OtlpDebugEndpoint']) {
      expect(template.findOutputs(name)).toEqual({});
    }
    expect(template.findOutputs('ApiEndpoint')).toEqual({});
  });

  test('관리자 토큰은 값이 아니라 Secret ARN 만 출력한다', () => {
    const output = template.findOutputs('AdminApiTokenSecretArn');
    expect(Object.values(output)).toHaveLength(1);
    expect(JSON.stringify(output)).not.toContain('SecretString');
    expect(JSON.stringify(output)).not.toContain('dynamic-reference');
  });
});
