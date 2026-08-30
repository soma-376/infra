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
  const targetGroups = (): any[] =>
    Object.values(
      template.findResources('AWS::ElasticLoadBalancingV2::TargetGroup'),
    );

  test('internet-facing ALB 하나를 만든다', () => {
    template.hasResourceProperties(
      'AWS::ElasticLoadBalancingV2::LoadBalancer',
      { Scheme: 'internet-facing' },
    );
  });

  // 80 은 앱(auth-proxy + API), 4318 은 Collector 직행 디버그, 8123 은 ClickHouse
  // 직접 쿼리. TLS 는 없고 전부 평문 HTTP 다 - 80 의 `/v1/*` 만 auth-proxy 가 인증하고
  // 나머지 경로의 방어선은 DevAlbSg 의 허용 CIDR 하나뿐이다.
  // (ADR-0022 8번/9번, ADR-0023 3번)
  test('80, 4318, 8123 세 개의 HTTP 리스너만 만든다', () => {
    const ascending = (a: number, b: number) => a - b;
    expect(listeners()).toHaveLength(3);
    expect(
      listeners()
        .map((listener: any) => listener.Properties.Port)
        .sort(ascending),
    ).toEqual([PORTS.http, PORTS.otlp, PORTS.clickhouseHttp].sort(ascending));
    for (const listener of listeners()) {
      expect(listener.Properties.Protocol).toBe('HTTP');
    }
  });

  // 두 경로 규칙(/v1/*, /api/*)에 걸리지 않은 요청이 어느 백엔드로도 새지 않게 한다.
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

  test('/v1/* 는 우선순위 1, /api/* 는 우선순위 2 로 라우팅한다', () => {
    const rules = Object.values(
      template.findResources('AWS::ElasticLoadBalancingV2::ListenerRule'),
    );
    expect(rules).toHaveLength(2);

    for (const [priority, path] of [
      [1, '/v1/*'],
      [2, '/api/*'],
    ] as const) {
      template.hasResourceProperties(
        'AWS::ElasticLoadBalancingV2::ListenerRule',
        {
          Priority: priority,
          Conditions: Match.arrayWith([
            Match.objectLike({
              Field: 'path-pattern',
              PathPatternConfig: { Values: [path] },
            }),
          ]),
          Actions: Match.arrayWith([Match.objectLike({ Type: 'forward' })]),
        },
      );
    }
  });

  // **타깃 타입은 선택이 아니라 네트워크 모드의 결과다.** collector/clickhouse 는
  // awsvpc 라 태스크 ENI IP 로 등록되고(ip), dashboard 와 auth-proxy 는 bridge +
  // 동적 포트라 호스트로 등록된다(instance). DevApplicationStack 의 NetworkMode 를
  // 바꾸면 여기가 함께 깨져야 정상이다. (ADR-0022 4번/8번, ADR-0023 2번)
  test('타깃 타입이 각 태스크의 네트워크 모드와 일치한다', () => {
    expect(targetGroups()).toHaveLength(4);

    const signatures = targetGroups()
      .map(
        (group: any) =>
          `${group.Properties.TargetType}:${group.Properties.Port}`,
      )
      .sort();

    expect(signatures).toEqual(
      [
        `ip:${PORTS.otlp}`,
        `instance:${PORTS.authProxy}`,
        'instance:8080',
        `ip:${PORTS.clickhouseHttp}`,
      ].sort(),
    );
  });

  // 60초는 실관측 최적값이 아니라 MVP 초기 기준이다. 일반 HTTP 서비스 세 개만
  // 기본 300초에서 줄이고, 장시간 연결과 쿼리 특성을 별도로 확인해야 하는
  // ClickHouse는 기본값을 유지한다. (ADR-0025)
  test('ClickHouse를 제외한 타깃 그룹만 deregistration delay를 60초로 줄인다', () => {
    const groups = template.findResources(
      'AWS::ElasticLoadBalancingV2::TargetGroup',
    );

    for (const logicalIdPrefix of [
      'DevAuthProxyTg',
      'DevDashboardTg',
      'DevCollectorTg',
    ]) {
      const group = Object.entries(groups).find(([logicalId]) =>
        logicalId.startsWith(logicalIdPrefix),
      );
      expect(group).toBeDefined();
      expect(group![1].Properties.TargetGroupAttributes).toEqual(
        expect.arrayContaining([
          {
            Key: 'deregistration_delay.timeout_seconds',
            Value: '60',
          },
        ]),
      );
    }

    const clickhouseGroup = Object.entries(groups).find(([logicalId]) =>
      logicalId.startsWith('DevClickhouseTg'),
    );
    expect(clickhouseGroup).toBeDefined();
    expect(
      clickhouseGroup![1].Properties.TargetGroupAttributes ?? [],
    ).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Key: 'deregistration_delay.timeout_seconds',
        }),
      ]),
    );
  });

  // **이 두 어서션이 "인증이 실제로 경로에 끼어 있는가"를 고정한다.** 타깃을
  // 되돌리면 synth 도 배포도 통과하고 OTLP 가 다시 무인증으로 흐른다 - 증상이
  // "정상 동작"이라 아무도 눈치채지 못한다. (ADR-0023 3번)
  test('/v1/* 는 auth-proxy 타깃 그룹으로 간다', () => {
    const authProxyTg = Object.entries(
      template.findResources('AWS::ElasticLoadBalancingV2::TargetGroup'),
    ).find(([logicalId]) => logicalId.startsWith('DevAuthProxyTg'));
    expect(authProxyTg).toBeDefined();

    template.hasResourceProperties(
      'AWS::ElasticLoadBalancingV2::ListenerRule',
      {
        Priority: 1,
        Actions: Match.arrayWith([
          Match.objectLike({
            Type: 'forward',
            TargetGroupArn: { Ref: authProxyTg![0] },
          }),
        ]),
      },
    );
  });

  test('4318 디버그 리스너는 collector 타깃 그룹으로 직행한다', () => {
    const collectorTg = Object.entries(
      template.findResources('AWS::ElasticLoadBalancingV2::TargetGroup'),
    ).find(([logicalId]) => logicalId.startsWith('DevCollectorTg'));
    expect(collectorTg).toBeDefined();

    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: PORTS.otlp,
      DefaultActions: Match.arrayWith([
        Match.objectLike({
          Type: 'forward',
          TargetGroupArn: { Ref: collectorTg![0] },
        }),
      ]),
    });
  });

  // 앱이 GET /health 에 200 JSON 을 준다. collector/dashboard 처럼 matcher 를
  // 200-404 로 넓히면 프로세스가 죽어도 타깃이 healthy 로 남을 수 있다. (ADR-0023)
  test('auth-proxy 타깃 그룹의 헬스체크 경로는 /health 다', () => {
    template.hasResourceProperties(
      'AWS::ElasticLoadBalancingV2::TargetGroup',
      {
        Port: PORTS.authProxy,
        TargetType: 'instance',
        HealthCheckPath: '/health',
        Matcher: Match.absent(),
      },
    );
  });

  // ClickHouse 는 /ping 에 200 을 주므로 헬스체크 경로를 좁힐 수 있다. 이게 빠져
  // 기본 경로(/)로 돌아가면 ClickHouse 가 400 을 돌려줘 타깃이 영영 unhealthy 다.
  test('ClickHouse 타깃 그룹의 헬스체크 경로는 /ping 이다', () => {
    template.hasResourceProperties(
      'AWS::ElasticLoadBalancingV2::TargetGroup',
      {
        Port: PORTS.clickhouseHttp,
        TargetType: 'ip',
        HealthCheckPath: '/ping',
      },
    );
  });

  // **의도적 생략이다.** dev 프론트엔드는 로컬에서 띄워 이 ALB 를 향하게 한다.
  // Cognito 를 만들지 않는 덕에 ADR-0021 Constraints 의 "Cognito 도메인 prefix
  // 충돌"이 애초에 발생하지 않는다. 여기에 하나라도 생기면 그 제약이 되살아나고
  // 개발 루프에 캐시 무효화가 끼어든다. (ADR-0022 8번)
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

  // 출력은 DevEdgeStack 한 곳에 모은다. 이 9개가 배포 직후 사람이 쓰는 전부이며
  // (OTLP 주입 주소, 인증 우회 디버그 주소, API, ClickHouse 직접 쿼리, psql 접속
  // 정보, enrollment-api 가 쓰는 두 Secret ARN) 하나라도 빠지면 콘솔을 뒤져야 한다.
  test('배포 직후 필요한 9개 출력을 모두 노출한다', () => {
    for (const outputName of [
      'AlbDnsName',
      'OtlpEndpoint',
      'OtlpDebugEndpoint',
      'ApiEndpoint',
      'ClickhouseDebugUrl',
      'RdsEndpoint',
      'RdsSecretArn',
      'TokenHashSecretArn',
      'AdminApiTokenSecretArn',
    ]) {
      template.hasOutput(outputName, {});
    }
  });

  test('관리자 토큰은 값이 아니라 Secret ARN 만 출력한다', () => {
    const output = template.findOutputs('AdminApiTokenSecretArn');
    expect(Object.values(output)).toHaveLength(1);
    expect(JSON.stringify(output)).not.toContain('SecretString');
    expect(JSON.stringify(output)).not.toContain('dynamic-reference');
  });
});
