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

  // 80 은 앱(OTLP + API), 8123 은 ClickHouse 직접 쿼리. 인증이 없으므로 TLS 도 없고
  // 둘 다 평문 HTTP 다 - 방어선은 DevAlbSg 의 허용 CIDR 하나뿐이다. (ADR-0022 8번/9번)
  test('80 과 8123 두 개의 HTTP 리스너만 만든다', () => {
    expect(listeners()).toHaveLength(2);
    expect(
      listeners()
        .map((listener: any) => listener.Properties.Port)
        .sort((a: number, b: number) => a - b),
    ).toEqual([PORTS.http, PORTS.clickhouseHttp]);
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
  // awsvpc 라 태스크 ENI IP 로 등록되고(ip), dashboard 는 bridge + 동적 포트라
  // 호스트로 등록된다(instance). DevApplicationStack 의 NetworkMode 를 바꾸면 여기가
  // 함께 깨져야 정상이다. (ADR-0022 4번/8번)
  test('타깃 타입이 각 태스크의 네트워크 모드와 일치한다', () => {
    expect(targetGroups()).toHaveLength(3);

    const signatures = targetGroups()
      .map(
        (group: any) =>
          `${group.Properties.TargetType}:${group.Properties.Port}`,
      )
      .sort();

    expect(signatures).toEqual(
      [
        `ip:${PORTS.otlp}`,
        'instance:8080',
        `ip:${PORTS.clickhouseHttp}`,
      ].sort(),
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

  // 출력은 DevEdgeStack 한 곳에 모은다. 이 6개가 배포 직후 사람이 쓰는 전부이며
  // (OTLP 주입 주소, API, ClickHouse 직접 쿼리, psql 접속 정보) 하나라도 빠지면
  // 콘솔을 뒤져야 한다.
  test('배포 직후 필요한 6개 출력을 모두 노출한다', () => {
    for (const outputName of [
      'AlbDnsName',
      'OtlpEndpoint',
      'ApiEndpoint',
      'ClickhouseDebugUrl',
      'RdsEndpoint',
      'RdsSecretArn',
    ]) {
      template.hasOutput(outputName, {});
    }
  });
});
