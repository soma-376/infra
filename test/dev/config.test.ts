import {
  DevConfig,
  DEV_OPEN_CIDR,
  loadDevConfig,
} from '../../lib/dev/config';
import { buildDevApp } from '../helpers';

// loadDevConfig 는 CDK 리소스를 만들지 않고 context 만 읽는 순수 로직이라 template
// assertion 대신 일반 단위 테스트로 검증한다 (AGENTS.md 7장의 명시적 예외).
//
// App 은 bare `new App()` 대신 buildDevApp 이 만든 것을 재사용한다 - cdk.json 의
// context 가 실린 App 이어야 CLI 와 같은 조건에서 읽는 것이 된다.
//
// lib/common/config.ts 의 상수 계약(CLICKHOUSE_HTTP_URL 조립, ClickHouse 컨테이너
// env, buildLibpqDsn)은 dev/prod 가 같은 모듈을 쓰므로 test/prod/config.test.ts 가
// 이미 고정한다. 여기서 중복하지 않는다.
const devConfig = (context: Record<string, unknown> = {}): DevConfig =>
  loadDevConfig(buildDevApp(context).app);

describe('loadDevConfig - devAllowedCidr', () => {
  // 기본값이 열려 있다는 사실 자체가 계약이다. 여기가 바뀌면 warnOnOpenIngress 의
  // 판정 기준(0.0.0.0/0 포함 여부)도 함께 무의미해진다. (ADR-0022 9번)
  test('미지정이면 전면 공개 CIDR 하나로 폴백한다', () => {
    expect(devConfig().allowedCidrs).toEqual([DEV_OPEN_CIDR]);
    expect(DEV_OPEN_CIDR).toBe('0.0.0.0/0');
  });

  test('단일 CIDR 을 그대로 담는다', () => {
    expect(devConfig({ devAllowedCidr: '203.0.113.10/32' }).allowedCidrs).toEqual(
      ['203.0.113.10/32'],
    );
  });

  // `-c devAllowedCidr="a/32, b/24"` 처럼 공백을 넣는 것이 사람의 기본 습관이다.
  // 공백을 안 자르면 Peer.ipv4(' 198.51.100.0/24') 가 그대로 템플릿에 박힌다.
  test('쉼표로 여러 개를 주면 공백을 잘라내고 전부 담는다', () => {
    expect(
      devConfig({ devAllowedCidr: '203.0.113.10/32, 198.51.100.0/24' })
        .allowedCidrs,
    ).toEqual(['203.0.113.10/32', '198.51.100.0/24']);
  });

  // 반환값은 항상 1개 이상이어야 한다 - 빈 배열이면 SG 에 인바운드 룰이 하나도
  // 생기지 않아 "아무도 못 붙는 dev"가 조용히 배포된다.
  test('빈 문자열이면 기본값으로 폴백한다', () => {
    expect(devConfig({ devAllowedCidr: '' }).allowedCidrs).toEqual([
      DEV_OPEN_CIDR,
    ]);
    expect(devConfig({ devAllowedCidr: ' , ' }).allowedCidrs).toEqual([
      DEV_OPEN_CIDR,
    ]);
  });
});

describe('EKS 전용 context', () => {
  test.each(['devAppAsgMaxCapacity', 'devImageTag', 'devCertificateArn', 'devDashboardRuntimeFile'])(
    '폐기된 %s 입력은 값과 무관하게 거부한다', key => {
      for (const value of ['', null, false, 'legacy']) {
        expect(() => devConfig({ [key]: value })).toThrow(new RegExp(key + '.*폐기'));
      }
    },
  );
  test.each([undefined, true, 'true'])('EKS 활성 입력 %j는 항상 EKS를 유지한다', value => {
    expect(devConfig({devEksEnabled: value}).eks.enabled).toBe(true);
  });
  test.each([false, 'false', null, '', 0, 1, 'TRUE', {}, []].map(value => [value]))('EKS 비활성·잘못된 입력 %j를 거부한다', value => {
    expect(() => devConfig({devEksEnabled: value})).toThrow(/devEksEnabled/);
  });
});

describe('OIDC 원본 선언', () => {
  test.each([[], '[]'].map(value => [value]))('빈 원본을 명시할 수 있다: %j', value => {
    expect(devConfig({devOidcClientKeys: value}).oidcClientKeys).toEqual([]);
  });
  test.each([['cognito-b', 'Cognito_A'], '["cognito-b","Cognito_A"]'].map(value => [value]))(
    '배열과 CLI JSON 목록의 대소문자를 보존하고 정렬한다: %j', value => {
      expect(devConfig({devOidcClientKeys: value}).oidcClientKeys).toEqual(['Cognito_A', 'cognito-b']);
    },
  );
  test('최대 key 수와 길이를 허용한다', () => {
    const keys = Array.from({length:32}, (_, i) => String(i).padEnd(64, 'a'));
    expect(devConfig({devOidcClientKeys:keys}).oidcClientKeys).toHaveLength(32);
  });
  test.each([undefined, null, '', 'invalid-json', '"key"', '{}', 'null', false,
    [1], [''], ['../escape'], [' a'], ['a'.repeat(65)], ['a', 'a'], ['cognito.a'],
    Array.from({length:33}, (_,i) => `key-${i}`), [{key:'a',secret:'sensitive-marker'}]].map(value => [value]))(
    '누락·형식·중복 오류를 입력 원문 없이 거부한다: %j', value => {
      expect(() => devConfig({devOidcClientKeys:value})).toThrow(/devOidcClientKeys/);
      try { devConfig({devOidcClientKeys:value}); } catch (error) {
        expect(String(error)).not.toContain('sensitive-marker');
      }
    },
  );
});
