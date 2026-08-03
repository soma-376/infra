import { Token } from 'aws-cdk-lib/core';
import {
  buildLibpqDsn,
  CLICKHOUSE_DEFAULT_DB,
  CLICKHOUSE_HOST,
  CLICKHOUSE_HTTP_URL,
  PORTS,
} from '../lib/config';

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

