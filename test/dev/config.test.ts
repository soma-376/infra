import { DevConfig, DEV_OPEN_CIDR, loadDevConfig } from '../../lib/dev/config';
import { PROD_IMAGE_TAG } from '../../lib/prod/config';
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

describe('loadDevConfig - devAppAsgMaxCapacity', () => {
  test('미지정이면 1 이다', () => {
    expect(devConfig().appAsgMaxCapacity).toBe(1);
  });

  // CLI `-c` 는 문자열, cdk.json context 는 숫자로 들어오므로 양쪽을 받아야 한다.
  test('문자열과 숫자를 모두 받는다', () => {
    expect(devConfig({ devAppAsgMaxCapacity: '3' }).appAsgMaxCapacity).toBe(3);
    expect(devConfig({ devAppAsgMaxCapacity: 3 }).appAsgMaxCapacity).toBe(3);
  });

  // 조용히 기본값으로 폴백하면 오타(`-c devAppAsgMaxCapacity=3대`)가 "왜 안 늘어나지"
  // 로만 드러난다. 키 이름을 메시지에 넣어 어느 손잡이가 틀렸는지 바로 보이게 한다.
  test.each(['0', 'abc', '-1', '1.5'])(
    '%j 는 키 이름을 담은 에러로 즉시 던진다',
    (raw) => {
      expect(() => devConfig({ devAppAsgMaxCapacity: raw })).toThrow(
        /devAppAsgMaxCapacity/,
      );
    },
  );
});

describe('loadDevConfig - devImageTag', () => {
  // dev/prod 가 같은 ECR 레포를 공유하고 태그로만 갈린다 (ADR-0021 5번).
  // **기본값이 `latest` 이면 안 된다** - 운영도 태그 없이 `latest` 를 읽던 시절에는
  // dev 빌드가 곧 운영 이미지였다. ADR-0024 가 두 환경에 서로 다른 고정 태그를 줘서
  // 그 경로를 닫았고, 이 어서션이 되돌아가는 것을 막는다.
  test('미지정이면 dev 다', () => {
    expect(devConfig().imageTag).toBe('dev');
  });

  test('지정한 태그를 그대로 쓴다', () => {
    expect(devConfig({ devImageTag: 'pr-42' }).imageTag).toBe('pr-42');
  });

  test('빈 문자열이면 기본값으로 폴백한다', () => {
    expect(devConfig({ devImageTag: '  ' }).imageTag).toBe('dev');
  });

  // 운영 태그와 절대 겹치면 안 된다. 겹치는 순간 ADR-0024 7번이 무의미해진다.
  test('기본 태그가 운영 태그와 다르다', () => {
    expect(devConfig().imageTag).not.toBe(PROD_IMAGE_TAG);
  });
});
