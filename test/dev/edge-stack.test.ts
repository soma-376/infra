import { Match, Template } from 'aws-cdk-lib/assertions';
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
    template.hasResourceProperties(
      'AWS::ElasticLoadBalancingV2::LoadBalancer',
      { Scheme: 'internet-facing' },
    );
  });

  // 인증을 우회하던 4318 리스너는 제거한다. 80은 앱별 경로, 8123은 기존
  // ClickHouse 직접 쿼리용이며 둘 다 NetworkStack이 인바운드를 통제한다.
  test('80과 8123 HTTP 리스너만 만들고 4318은 열지 않는다', () => {
    const ascending = (a: number, b: number) => a - b;
    expect(listeners()).toHaveLength(2);
    expect(
      listeners()
        .map((listener: any) => listener.Properties.Port)
        .sort(ascending),
    ).toEqual([PORTS.http, PORTS.clickhouseHttp].sort(ascending));
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

  test('우선순위 1·3·4가 정확한 경로와 앱별 타깃 그룹을 가리킨다', () => {
    expect(listenerRules()).toHaveLength(3);

    const telemetryIngestTg = targetGroupByPrefix('DevTelemetryIngestTg');
    const enrollmentApiTg = targetGroupByPrefix('DevEnrollmentApiTg');
    const expected = [
      {
        priority: 1,
        paths: ['/v1/traces', '/v1/metrics', '/v1/logs'],
        targetGroupLogicalId: telemetryIngestTg[0],
      },
      {
        priority: 3,
        paths: [
          '/v1/enroll',
          '/v1/installations/*',
          '/v1/invitations*',
        ],
        targetGroupLogicalId: enrollmentApiTg[0],
      },
      {
        priority: 4,
        paths: ['/windows', '/unix', '/bin/*'],
        targetGroupLogicalId: enrollmentApiTg[0],
      },
    ];

    for (const { priority, paths, targetGroupLogicalId } of expected) {
      const rule = ruleByPriority(priority);
      expect(rule.Properties.Conditions).toEqual([
        {
          Field: 'path-pattern',
          PathPatternConfig: { Values: paths },
        },
      ]);
      expect(rule.Properties.Actions).toEqual([
        {
          Type: 'forward',
          TargetGroupArn: { Ref: targetGroupLogicalId },
        },
      ]);
    }

    const publicPaths = listenerRules().flatMap(
      (rule: any) => rule.Properties.Conditions[0].PathPatternConfig.Values,
    );
    expect(publicPaths).not.toContain('/v1/*');
    expect(publicPaths).not.toContain('/v1/healthz');
    expect(publicPaths).not.toContain('/api/*');
  });

  // bridge 앱 태스크는 동적 host port를 인스턴스 타깃으로 등록하고,
  // ClickHouse만 태스크 ENI IP를 타깃으로 등록한다.
  test('최종 세 타깃 그룹의 타입과 포트가 네트워크 모드에 맞는다', () => {
    expect(Object.keys(targetGroups())).toHaveLength(3);

    for (const [prefix, targetType, port] of [
      ['DevTelemetryIngestTg', 'instance', PORTS.telemetryIngest],
      ['DevEnrollmentApiTg', 'instance', PORTS.enrollmentApi],
      ['DevClickhouseTg', 'ip', PORTS.clickhouseHttp],
    ] as const) {
      expect(targetGroupByPrefix(prefix)[1].Properties).toMatchObject({
        TargetType: targetType,
        Port: port,
      });
    }
  });

  test('신규 두 앱만 deregistration delay를 60초로 둔다', () => {
    for (const prefix of [
      'DevTelemetryIngestTg',
      'DevEnrollmentApiTg',
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

  test('신규 두 앱은 /v1/healthz의 200만 healthy로 판정한다', () => {
    for (const prefix of [
      'DevTelemetryIngestTg',
      'DevEnrollmentApiTg',
    ]) {
      expect(targetGroupByPrefix(prefix)[1].Properties).toMatchObject({
        TargetType: 'instance',
        HealthCheckPath: '/v1/healthz',
        Matcher: { HttpCode: '200' },
      });
    }
  });

  test('ClickHouse 타깃 그룹은 ip/8123, /ping, 기본 drain을 유지한다', () => {
    const clickhouse = targetGroupByPrefix('DevClickhouseTg')[1].Properties;
    expect(clickhouse).toMatchObject({
      Port: PORTS.clickhouseHttp,
      TargetType: 'ip',
      HealthCheckPath: '/ping',
    });
    expect(clickhouse.TargetGroupAttributes ?? []).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Key: 'deregistration_delay.timeout_seconds',
        }),
      ]),
    );
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

  test('구 디버그·API 주소를 제외한 출력 7개를 노출한다', () => {
    for (const outputName of [
      'AlbDnsName',
      'OtlpEndpoint',
      'ClickhouseDebugUrl',
      'RdsEndpoint',
      'RdsSecretArn',
      'TokenHashSecretArn',
      'AdminApiTokenSecretArn',
    ]) {
      template.hasOutput(outputName, {});
    }
    expect(template.findOutputs('OtlpDebugEndpoint')).toEqual({});
    expect(template.findOutputs('ApiEndpoint')).toEqual({});
  });

  test('관리자 토큰은 값이 아니라 Secret ARN 만 출력한다', () => {
    const output = template.findOutputs('AdminApiTokenSecretArn');
    expect(Object.values(output)).toHaveLength(1);
    expect(JSON.stringify(output)).not.toContain('SecretString');
    expect(JSON.stringify(output)).not.toContain('dynamic-reference');
  });
});
