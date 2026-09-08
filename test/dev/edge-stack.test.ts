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

  test('우선순위 1~4가 정확한 경로와 앱별 타깃 그룹을 가리킨다', () => {
    expect(listenerRules()).toHaveLength(4);

    const telemetryIngestTg = targetGroupByPrefix('DevTelemetryIngestTg');
    const dashboardTg = targetGroupByPrefix('DevDashboardTg');
    const enrollmentApiTg = targetGroupByPrefix('DevEnrollmentApiTg');
    const expected = [
      {
        priority: 1,
        paths: ['/v1/traces', '/v1/metrics', '/v1/logs'],
        targetGroupLogicalId: telemetryIngestTg[0],
      },
      {
        priority: 2,
        paths: ['/api/*'],
        targetGroupLogicalId: dashboardTg[0],
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
  });

  // bridge 태스크는 동적 host port를 인스턴스 타깃으로 등록하고, 기존 awsvpc
  // collector와 ClickHouse만 태스크 ENI IP를 타깃으로 등록한다.
  test('여섯 타깃 그룹의 타입과 포트가 네트워크 모드에 맞는다', () => {
    expect(Object.keys(targetGroups())).toHaveLength(6);

    for (const [prefix, targetType, port] of [
      ['DevCollectorTg', 'ip', PORTS.otlp],
      ['DevAuthProxyTg', 'instance', PORTS.authProxy],
      ['DevTelemetryIngestTg', 'instance', PORTS.telemetryIngest],
      ['DevEnrollmentApiTg', 'instance', PORTS.enrollmentApi],
      ['DevDashboardTg', 'instance', PORTS.apiServer],
      ['DevClickhouseTg', 'ip', PORTS.clickhouseHttp],
    ] as const) {
      expect(targetGroupByPrefix(prefix)[1].Properties).toMatchObject({
        TargetType: targetType,
        Port: port,
      });
    }
  });

  // 일반 HTTP 타깃 그룹은 교체 배포 시간을 줄이는 60초를 쓰고 ClickHouse는
  // 장시간 쿼리를 고려해 AWS 기본 300초를 유지한다. (ADR-0025, ADR-0026)
  test('ClickHouse 외 타깃 그룹만 deregistration delay를 60초로 둔다', () => {
    for (const prefix of [
      'DevCollectorTg',
      'DevAuthProxyTg',
      'DevTelemetryIngestTg',
      'DevEnrollmentApiTg',
      'DevDashboardTg',
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

    expect(
      targetGroupByPrefix('DevClickhouseTg')[1].Properties
        .TargetGroupAttributes ?? [],
    ).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Key: 'deregistration_delay.timeout_seconds',
        }),
      ]),
    );
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

  // 라우팅을 되돌릴 수 있도록 기존 target group과 ECS service binding은 이번
  // 단계에 남긴다. 공개 리스너 액션에서는 collector와 auth-proxy만 분리한다.
  test('기존 collector와 auth-proxy 타깃 그룹은 보존하되 리스너가 참조하지 않는다', () => {
    const collectorTg = targetGroupByPrefix('DevCollectorTg');
    const authProxyTg = targetGroupByPrefix('DevAuthProxyTg');
    const listenerActions = [
      ...listeners().flatMap(
        (listener: any) => listener.Properties.DefaultActions,
      ),
      ...listenerRules().flatMap((rule: any) => rule.Properties.Actions),
    ];
    const renderedActions = JSON.stringify(listenerActions);

    expect(renderedActions).not.toContain(collectorTg[0]);
    expect(renderedActions).not.toContain(authProxyTg[0]);
  });

  test('기존 auth-proxy와 dashboard 헬스체크 계약을 유지한다', () => {
    expect(targetGroupByPrefix('DevAuthProxyTg')[1].Properties).toMatchObject({
      HealthCheckPath: '/health',
    });
    expect(
      targetGroupByPrefix('DevAuthProxyTg')[1].Properties.Matcher,
    ).toBeUndefined();
    expect(targetGroupByPrefix('DevDashboardTg')[1].Properties).toMatchObject({
      HealthCheckPath: '/',
      Matcher: { HttpCode: '200-404' },
    });
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

  test('디버그 주소를 제외한 운영용 출력 8개를 노출한다', () => {
    for (const outputName of [
      'AlbDnsName',
      'OtlpEndpoint',
      'ApiEndpoint',
      'ClickhouseDebugUrl',
      'RdsEndpoint',
      'RdsSecretArn',
      'TokenHashSecretArn',
      'AdminApiTokenSecretArn',
    ]) {
      template.hasOutput(outputName, {});
    }
    expect(template.findOutputs('OtlpDebugEndpoint')).toEqual({});
  });

  test('관리자 토큰은 값이 아니라 Secret ARN 만 출력한다', () => {
    const output = template.findOutputs('AdminApiTokenSecretArn');
    expect(Object.values(output)).toHaveLength(1);
    expect(JSON.stringify(output)).not.toContain('SecretString');
    expect(JSON.stringify(output)).not.toContain('dynamic-reference');
  });
});
