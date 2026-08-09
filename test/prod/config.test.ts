import { Token } from 'aws-cdk-lib/core';
import {
  buildLibpqDsn,
  CLICKHOUSE_CONTAINER_ENV,
  CLICKHOUSE_DEFAULT_DB,
  CLICKHOUSE_HOST,
  CLICKHOUSE_HTTP_URL,
  CLICKHOUSE_IMAGE,
  PORTS,
} from '../../lib/common/config';

// lib/config.ts 의 순수 함수/상수는 CDK 리소스를 만들지 않으므로 template assertion
// 대신 일반 단위 테스트로 검증한다 (AGENTS.md 섹션 7 의 명시적 예외).

describe('buildLibpqDsn', () => {
  test('libpq keyword/value 형식으로 공백 구분해 이어붙인다', () => {
    expect(
      buildLibpqDsn({
        host: 'h',
        port: 5432,
        dbname: 'controlplane',
        user: 'u',
        password: 'p',
        sslmode: 'require',
      }),
    ).toBe(
      'host=h port=5432 dbname=controlplane user=u password=p sslmode=require',
    );
  });

  test('sslmode 를 생략하면 키 자체를 넣지 않는다', () => {
    expect(
      buildLibpqDsn({
        host: 'h',
        port: 5432,
        dbname: 'd',
        user: 'u',
        password: 'p',
      }),
    ).toBe('host=h port=5432 dbname=d user=u password=p');
  });

  // 따옴표를 쓰지 않으므로 이 문자들이 리터럴로 들어오면 DSN 이 조용히 깨진다.
  // 합성 시점에 즉시 터뜨려서 배포까지 흘러가지 않게 한다. (ADR-0018)
  test.each([' ', "'", '"', '\\'])(
    '리터럴 값에 %j 가 있으면 합성 시점에 던진다',
    (char) => {
      expect(() =>
        buildLibpqDsn({
          host: 'h',
          port: 5432,
          dbname: 'd',
          user: 'u',
          password: `a${char}b`,
        }),
      ).toThrow(/따옴표 없이 쓸 수 없는/);
    },
  );

  test('미해결 토큰은 검사하지 않는다 (합성 시점엔 값이 없다)', () => {
    const token = Token.asString({ Ref: 'Whatever' });
    expect(() =>
      buildLibpqDsn({
        host: token,
        port: 5432,
        dbname: 'd',
        user: token,
        password: token,
      }),
    ).not.toThrow();
  });
});

describe('ClickHouse 엔드포인트 상수', () => {
  test('CLICKHOUSE_HOST 와 PORTS.clickhouseHttp 에서 조립한다', () => {
    expect(CLICKHOUSE_HTTP_URL).toBe(
      `http://${CLICKHOUSE_HOST}:${PORTS.clickhouseHttp}`,
    );
  });

  // 앱이 이 값 뒤에 `/?query=...` 를 붙이므로 슬래시가 있으면 `//?query=` 가 되어
  // ClickHouse 가 404 를 돌려준다.
  test('끝에 슬래시를 붙이지 않는다', () => {
    expect(CLICKHOUSE_HTTP_URL.endsWith('/')).toBe(false);
  });

  test('ClickHouse 컨테이너의 기본 DB 이름과 일치한다', () => {
    expect(CLICKHOUSE_DEFAULT_DB).toBe('default');
  });
});

describe('ClickHouse 컨테이너 계약 상수 (ADR-0019)', () => {
  // 태그가 없으면 latest 로 해석되어 재기동마다 메이저 버전이 바뀔 수 있고,
  // 아래 env 가 의존하는 entrypoint 분기 로직 자체가 버전에 따라 변한다.
  test('이미지에 명시적 태그가 있고 latest 가 아니다', () => {
    const [repository, tag] = CLICKHOUSE_IMAGE.split(':');
    expect(repository).toBe('clickhouse/clickhouse-server');
    expect(tag).toBeDefined();
    expect(tag).not.toBe('latest');
  });

  // compose(docker-compose.dev.yml)와 같은 버전이어야 로컬에서 검증한 동작이
  // ECS 에서 그대로 재현된다.
  test('compose 와 같은 24.8 계열로 고정한다', () => {
    expect(CLICKHOUSE_IMAGE.split(':')[1]).toMatch(/^24\.8/);
  });

  // entrypoint 조건은
  //   [ -n "$USER" ] && [ "$USER" != "default" ] || [ -n "$PASSWORD" ] || [ "$ACCESS_MGMT" != "0" ]
  // 이라 USER='default' 와 PASSWORD='' 는 조건을 만족시키지 못한다. 이 값 하나만
  // 세 번째 항을 참으로 만들어 default 유저를 <ip>::/0</ip> 으로 재생성시킨다.
  // '0' 이 되면 유저가 루프백 전용으로 잠겨 모든 적재가 인증 실패로 죽는다.
  test('CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT 가 분기를 여는 유일한 값이다', () => {
    expect(
      CLICKHOUSE_CONTAINER_ENV.CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT,
    ).not.toBe('0');
    expect(CLICKHOUSE_CONTAINER_ENV.CLICKHOUSE_USER).toBe('default');
    expect(CLICKHOUSE_CONTAINER_ENV.CLICKHOUSE_PASSWORD).toBe('');
  });

  // 서버가 만드는 DB 와 앱(ENRICHMENT_CH_DB)이 조회하는 DB 가 갈라지면 안 된다.
  test('컨테이너의 CLICKHOUSE_DB 는 앱이 쓰는 DB 와 같다', () => {
    expect(CLICKHOUSE_CONTAINER_ENV.CLICKHOUSE_DB).toBe(CLICKHOUSE_DEFAULT_DB);
  });
});
