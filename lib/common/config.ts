import { App, Tags, Token } from 'aws-cdk-lib/core';

/**
 * App 스코프에 공통 태그를 적용한다. CDK 가 하위 모든 스택의 태그 지원 리소스로
 * 전파하므로 스택별 중복 호출은 필요 없다.
 *
 * bin/infra.ts 와 test/helpers.ts 가 각각 App 을 조립하므로 양쪽에서 호출한다.
 *
 * 태그 맵은 환경별로 다르므로(prod 는 `lib/prod/config.ts` 의 `COMMON_TAGS`)
 * 여기서 참조하지 않고 인자로 받는다.
 */
export function applyCommonTags(
  app: App,
  tags: Readonly<Record<string, string>>,
): void {
  for (const [key, value] of Object.entries(tags)) {
    Tags.of(app).add(key, value);
  }
}

/**
 * ECR 레포지토리 네임스페이스 (ADR-0007). `COMMON_TAGS.Org` 와 같은 값을 쓰는 것은 의도이며,
 * 태그 기반 비용 배분 축과 레지스트리 경로를 같은 식별자로 정렬하기 위함이다.
 * 두 값은 함께 바뀌어야 한다.
 */
export const ECR_NAMESPACE = 'soma-376';

/**
 * ECR 레포지토리 이름 (ADR-0007: CDK 밖에서 선생성, fromRepositoryName 참조만).
 * 자체 빌드 이미지의 레포는 반드시 `${ECR_NAMESPACE}/` 아래에 둔다.
 */
export const ECR_REPOS = {
  postProcessor: `${ECR_NAMESPACE}/post-processor`,
  apiServer: `${ECR_NAMESPACE}/api-server`,
  batchProcessor: `${ECR_NAMESPACE}/batch-processor`,
  /**
   * 인증 프록시 (ADR-0023). 현재는 dev 만 이 이미지를 쓴다.
   * 레포는 dev/prod 가 공유하므로 여기 두고, 이관 시 prod 가 같은 값을 참조한다.
   */
  authProxy: `${ECR_NAMESPACE}/auth-proxy`,
} as const;

/**
 * Cloud Map 프라이빗 DNS 네임스페이스와 ClickHouse 서비스 주소 (ADR-0005).
 */
export const CLOUD_MAP_NAMESPACE = 'obs.local';
export const CLICKHOUSE_SERVICE_NAME = 'clickhouse';
export const CLICKHOUSE_HOST = `${CLICKHOUSE_SERVICE_NAME}.${CLOUD_MAP_NAMESPACE}`;

/**
 * Collector 의 Cloud Map 서비스 이름과 호스트 (ADR-0023).
 *
 * auth-proxy 가 `COLLECTOR_BASE_URL` 로 이 주소를 부른다. ClickHouse 와 같은 이유로
 * **A 레코드**여야 하며(bridge/host 는 SRV 만 등록한다), Collector 태스크가 이미
 * awsvpc 이므로 요건은 충족되어 있다 (ADR-0005, ADR-0022 4번).
 *
 * **등록은 현재 dev 만 한다.** `DevCollectorService` 에만 `cloudMapOptions` 가 있고
 * 운영 `CollectorService` 에는 없다. prod 에 auth-proxy 를 도입할 때 그쪽에도
 * `cloudMapOptions` 를 추가해야 이 이름이 prod 에서 유효해진다 - 그 전에 prod 코드가
 * 이 상수를 쓰면 **죽은 계약**이 된다(`AGENTS.md` 3장).
 */
export const COLLECTOR_SERVICE_NAME = 'collector';
export const COLLECTOR_HOST = `${COLLECTOR_SERVICE_NAME}.${CLOUD_MAP_NAMESPACE}`;

/**
 * 컨테이너 포트.
 */
export const PORTS = {
  otlp: 4318,
  // Collector 가 같은 태스크의 post-processor 로 OTLP/HTTP 를 밀어넣는 포트.
  // apiServer 와 값은 같지만 다른 태스크의 다른 계약이므로 따로 둔다. (ADR-0017)
  postProcessor: 8080,
  apiServer: 8080,
  // auth-proxy 가 리슨하는 포트. 앱의 `PORT` 기본값과 같은 값이며
  // (`apps/auth-proxy/src/config/env.ts`), 이미지의 EXPOSE 도 4316 이다. (ADR-0023)
  authProxy: 4316,
  clickhouseHttp: 8123,
  clickhouseNative: 9000,
  aurora: 5432,
  https: 443,
  http: 80,
} as const;

/**
 * post-processor 앱이 읽는 ClickHouse HTTP 엔드포인트 (ADR-0018).
 *
 * 개념상 위 Cloud Map 블록에 속하지만 `PORTS` 를 참조하므로 여기 둔다.
 * 51행 옆으로 올리면 TDZ 로 `Cannot access 'PORTS' before initialization` 이다.
 *
 * **끝에 슬래시를 붙이지 않는다.** 앱이 이 값 뒤에 `/?query=...&database=...` 를
 * 그대로 이어붙이므로(`src/enrichment/sink_clickhouse.py`), 슬래시가 있으면
 * `//?query=` 가 되어 ClickHouse 가 404 를 돌려준다.
 */
export const CLICKHOUSE_HTTP_URL = `http://${CLICKHOUSE_HOST}:${PORTS.clickhouseHttp}`;

/**
 * auth-proxy 가 읽는 Collector OTLP/HTTP 엔드포인트 (ADR-0023).
 *
 * `CLICKHOUSE_HTTP_URL` 과 같은 이유로 `PORTS` 아래에 둔다(TDZ).
 *
 * **끝에 슬래시를 붙이지 않는다.** 앱이 이 값 뒤에 `/v1/traces` 를 그대로 이어붙인다
 * (`apps/auth-proxy/src/proxy/collector.client.ts`). 앱의 `env.ts` 가 끝 슬래시를
 * 잘라내긴 하지만, 그 방어에 기대지 않고 여기서부터 정확한 값을 준다.
 */
export const COLLECTOR_OTLP_URL = `http://${COLLECTOR_HOST}:${PORTS.otlp}`;

/**
 * post-processor 가 쓰는 ClickHouse 데이터베이스 이름.
 *
 * 아래 `CLICKHOUSE_CONTAINER_ENV.CLICKHOUSE_DB` 와 같은 값이어야 한다 - 서버가 만드는
 * DB 와 앱이 조회하는 DB 가 갈라지면 적재 대상 테이블이 서로 다른 DB 에 생긴다.
 * 두 값의 일치는 `test/config.test.ts` 가 고정한다. (ADR-0018, ADR-0019)
 */
export const CLICKHOUSE_DEFAULT_DB = 'default';

/**
 * ClickHouse 컨테이너 이미지 (ADR-0019).
 *
 * **태그를 반드시 붙인다.** 태그가 없으면 `latest` 로 해석되어 태스크가 재기동될 때마다
 * 메이저 버전이 바뀔 수 있고, 아래 `CLICKHOUSE_CONTAINER_ENV` 가 의존하는 entrypoint 의
 * 분기 로직 자체가 버전에 따라 변한다.
 *
 * 값은 앱 레포 compose(`ai-telemetry-pipeline/docker-compose.dev.yml`)와 같은 태그다.
 * 로컬에서 검증한 동작을 ECS 에서 그대로 재현하는 것이 목적이므로 함께 바꾼다.
 *
 * 이 태그의 매니페스트는 `linux/arm64` 를 포함한다 - ClickHouse 는 t4g(Graviton)
 * 인스턴스에서 돌기 때문에 arm64 가 없는 태그로 바꾸면 이미지 pull 이 실패한다. (ADR-0015)
 *
 * **버전을 올릴 때는 데이터 디렉터리 호환성을 먼저 확인한다.** ClickHouse 는 다운그레이드를
 * 지원하지 않아, 더 높은 버전이 초기화한 `/data/clickhouse` 위에서는 기동에 실패한다.
 */
export const CLICKHOUSE_IMAGE = 'clickhouse/clickhouse-server:24.8-alpine';

/**
 * ClickHouse 컨테이너 환경변수 (ADR-0019). compose 와 같은 조합이다.
 *
 * **실제로 동작을 바꾸는 값은 `CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT: '1'` 하나뿐이다.**
 * 이미지 entrypoint 의 분기 조건이
 *
 *   [ -n "$USER" ] && [ "$USER" != "default" ] || [ -n "$PASSWORD" ] || [ "$ACCESS_MGMT" != "0" ]
 *
 * 이라, `CLICKHOUSE_USER='default'` 는 두 번째 검사에서, `CLICKHOUSE_PASSWORD=''` 는
 * `-n` 검사에서 각각 탈락한다. 세 번째 항만 참이 되어 "유저를 `<ip>::/0</ip>` 로 재생성"
 * 분기를 탄다.
 *
 * 셋 다 비면 entrypoint 는 마지막 else 로 떨어져 `default` 유저를 **루프백 전용**으로
 * 잠근다(`disabling network access for user 'default'`). 그러면 post-processor 의 모든
 * 적재가 HTTP 403 - `Code: 516 ... Authentication failed` 로 죽고, 앱이 그걸
 * `BackendUnavailable` 로 감싸 리시버가 503 을 뱉는다. **synth 도 테스트도 배포도 전부
 * 통과한다** - 실제로 배포에서 이렇게 깨졌다.
 *
 * 나머지 세 개는 compose 와의 문서적 정합성을 위해 남긴다. 지워도 동작은 같지만
 * `CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT` 를 지우면 즉시 위 장애로 회귀한다.
 *
 * `default` 유저에 비밀번호가 없는 것은 의도다 - 앱이 자격증명을 아예 보내지 않기
 * 때문이다(`src/enrichment/sink_clickhouse.py` 의 `execute()` 는 쿼리 파라미터만 붙인다).
 * 접근 통제의 실체는 `NetworkStack` 의 `clickhouseSecurityGroup` 이다.
 */
export const CLICKHOUSE_CONTAINER_ENV: Readonly<Record<string, string>> = {
  CLICKHOUSE_DB: CLICKHOUSE_DEFAULT_DB,
  CLICKHOUSE_USER: 'default',
  CLICKHOUSE_PASSWORD: '',
  CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT: '1',
};

/**
 * Aurora control plane 데이터베이스 이름.
 *
 * `control`은 RDS가 엔진 예약어로 거부한다(400 InvalidParameterValue).
 * RDS의 예약어 목록은 PostgreSQL의 reserved 키워드보다 넓어서
 * non-reserved 키워드까지 막는다. 바꿀 때는 PostgreSQL 키워드 표에
 * 아예 없는 단어를 고른다. (ADR-0012)
 */
export const CONTROL_DB_NAME = 'controlplane';

/**
 * post-processor 가 Aurora 에 붙을 때 쓰는 libpq `sslmode`.
 *
 * Aurora PostgreSQL 16 은 TLS 를 강제하지 않는다 - `rds.force_ssl` 기본값은
 * PG 17 이상에서 1, 16 이하에서 0 이다. 따라서 이건 서버 요구사항이 아니라
 * 클라이언트 측 하드닝 선택이다. `require` 는 CA 검증을 하지 않으므로 컨테이너에
 * RDS CA 번들이 필요 없다(`verify-full` 은 이미지 변경이 필요해 앱 레포 몫이다).
 *
 * psycopg 의 TLS 가 문제되면 이 한 곳만 `'prefer'` 로 낮춘다. (ADR-0018)
 */
export const CONTROL_DB_SSLMODE = 'require';

/**
 * post-processor 컨테이너가 실제로 읽는 환경변수/시크릿 이름 (ADR-0018).
 *
 * **권위 소스는 앱 레포(`ai-telemetry-pipeline`)다.** 아래 이름 중 하나라도 틀리면
 * 앱은 예외를 던지지 않고 compose 전용 기본값으로 조용히 폴백하며, ECS 에서는
 * 그 호스트명이 안 풀려 모든 insert 가 `BackendUnavailable` -> HTTP 503 이 된다.
 * synth 도 테스트도 배포도 전부 통과하므로 여기가 유일한 방어선이다.
 *
 *   - ENRICHMENT_CH_URL : src/enrichment/sink_clickhouse.py:43
 *   - ENRICHMENT_CH_DB  : src/enrichment/sink_clickhouse.py:47
 *   - ENRICHMENT_PG_DSN : src/enrichment/rds.py:21
 *
 * 앱이 읽는 이름이 바뀌면 여기와 앱을 같은 PR 로 함께 바꾼다.
 */
export const ENRICHMENT_ENV = {
  clickhouseUrl: 'ENRICHMENT_CH_URL',
  clickhouseDb: 'ENRICHMENT_CH_DB',
  pgDsn: 'ENRICHMENT_PG_DSN',
} as const;

/**
 * auth-proxy 컨테이너가 실제로 읽는 환경변수/시크릿 이름 (ADR-0023).
 *
 * **권위 소스는 앱 레포(`ai-telemetry-pipeline`)의
 * `apps/auth-proxy/src/config/env.ts` 다.** `ENRICHMENT_ENV` 와 달리 이 앱은 필수 값이
 * 비면 `Missing required environment variable: <name>` 으로 **즉시 throw 하며 기동에
 * 실패한다** - 조용한 폴백은 없다. 그래서 이름이 틀리면 태스크가 재시작 루프에 빠지고
 * `/ecs/dev/auth-proxy` 로그에 그대로 드러난다.
 *
 *   - COLLECTOR_BASE_URL : 필수. 뒤에 `/v1/traces` 등을 이어붙인다
 *   - DATABASE_URL       : 필수. **URI 형식**이어야 한다 (아래 buildPostgresUri 주석)
 *   - TOKEN_HASH_SECRET  : 필수. Bearer 토큰 HMAC-SHA256 키
 *   - LOG_LEVEL          : 선택. silent|error|warn|info|debug, 기본 info
 *
 * `PORT`(기본 4316)와 `MAX_OTLP_BODY_SIZE`(기본 10MiB)는 기본값을 그대로 쓰므로
 * 주입하지 않는다. 포트는 `PORTS.authProxy` 가 같은 값을 들고 있다.
 */
export const AUTH_PROXY_ENV = {
  collectorBaseUrl: 'COLLECTOR_BASE_URL',
  databaseUrl: 'DATABASE_URL',
  tokenHashSecret: 'TOKEN_HASH_SECRET',
  logLevel: 'LOG_LEVEL',
} as const;

/**
 * libpq keyword/value DSN 의 구성 요소. `psycopg.connect()` 가 그대로 받는다.
 */
export interface LibpqDsnParts {
  readonly host: string;
  readonly port: number;
  readonly dbname: string;
  readonly user: string;
  readonly password: string;
  /** 생략하면 sslmode 키를 아예 넣지 않는다. */
  readonly sslmode?: string;
}

/**
 * 따옴표 없는 값이 libpq keyword/value DSN 을 깨뜨리는 문자.
 * 공백은 키 구분자, `'` 와 `"` 는 인용 부호, `\` 는 이스케이프 문자다.
 */
const LIBPQ_UNQUOTED_UNSAFE = /[\s'"\\]/;

/**
 * libpq keyword/value DSN 한 줄을 만든다 (ADR-0018).
 *
 * 형식: `host=H port=P dbname=D user=U password=W sslmode=S`
 * 앱의 compose 기본값(`src/enrichment/rds.py:21`)과 같은 형식이라 로컬과 ECS 사이에
 * 형식 차이가 생기지 않는다.
 *
 * **값을 따옴표로 감싸지 않는다.** user/password 는 합성 시점에 아직 CloudFormation
 * 토큰이라 여기서 이스케이프할 방법이 없다. 대신 Aurora 자동 생성 비밀번호가 위험
 * 문자 4개(공백, `'`, `"`, `\`)를 전부 제외한다는 사실에 의존한다
 * (aws-rds 의 `DEFAULT_PASSWORD_EXCLUDE_CHARS`). **이 커플링은 우연히 성립하는
 * 것이므로** `test/data-stack.test.ts` 가 합성 템플릿의 `ExcludeCharacters` 로 고정한다.
 *
 * 토큰이 아닌(= 합성 시점에 값이 확정된) 조각은 여기서 즉시 검증해, 조용히 깨진
 * DSN 이 배포되는 것을 막는다.
 */
export function buildLibpqDsn(parts: LibpqDsnParts): string {
  const pairs: ReadonlyArray<readonly [string, string]> = [
    ['host', parts.host],
    ['port', String(parts.port)],
    ['dbname', parts.dbname],
    ['user', parts.user],
    ['password', parts.password],
    ...(parts.sslmode ? ([['sslmode', parts.sslmode]] as const) : []),
  ];

  for (const [key, value] of pairs) {
    // 토큰은 합성 이후에야 값이 정해지므로 검사할 수 없다. 리터럴만 본다.
    if (!Token.isUnresolved(value) && LIBPQ_UNQUOTED_UNSAFE.test(value)) {
      throw new Error(
        `libpq DSN 값에 따옴표 없이 쓸 수 없는 문자가 있다: ${key}=${value}`,
      );
    }
  }

  return pairs.map(([key, value]) => `${key}=${value}`).join(' ');
}

/**
 * URI 형식 DSN 을 깨뜨리는 문자. 위 `LIBPQ_UNQUOTED_UNSAFE` 와 목적은 같고 집합이 다르다.
 *
 * `@` 는 userinfo 구분자, `/` 는 경로, `?` 는 쿼리, `#` 는 프래그먼트, `%` 는 퍼센트
 * 인코딩 도입부다. `:` 는 userinfo 안에서 user/password 를 가르지만 URL 파서가 **첫
 * 번째** `:` 만 구분자로 쓰므로 password 안의 `:` 는 안전하다 - 그래도 host:port 경계와
 * 헷갈릴 여지를 없애기 위해 함께 막는다. `[` `]` 는 IPv6 리터럴 표기다.
 */
const POSTGRES_URI_UNSAFE = /[\s@/?#%:[\]\\]/;

/**
 * `pg` 의 `Pool({ connectionString })` 이 받는 **URI 형식** DSN 한 줄을 만든다 (ADR-0023).
 *
 * 형식: `postgresql://U:W@H:P/D?uselibpqcompat=true&sslmode=S`
 *
 * **`buildLibpqDsn()` 을 재사용할 수 없다.** post-processor(psycopg)는 libpq
 * keyword/value 형식을 읽지만, `pg` 의 파서(`pg-connection-string`)는
 * `new URL(str, 'postgres://base')` 기반의 **URI 전용**이다. keyword/value 문자열을
 * 넣으면 공백이 `%20` 으로 인코딩되어 통째로 망가진다. 두 함수가 나란히 있는 것은
 * 중복이 아니라 두 앱이 서로 다른 형식을 요구한다는 사실의 반영이다.
 *
 * **`uselibpqcompat=true` 를 빼면 안 된다.** `pg-connection-string` 은 이 플래그가
 * 없을 때 `sslmode=prefer|require|verify-ca` 를 전부 **`verify-full` 의 별칭**으로
 * 취급한다(라이브러리가 직접 경고를 낸다). 그러면 `rejectUnauthorized` 가 켜지고,
 * RDS 기본 CA(`rds-ca-rsa2048-g1`)는 Node 기본 CA 번들에 없으므로 **접속 자체가
 * 실패한다.** 플래그를 주면 libpq 의 `require` 의미(암호화하되 CA 검증 안 함)가 되어
 * `CONTROL_DB_SSLMODE` 의 전제와 post-processor 의 동작에 맞는다.
 *
 * **값을 퍼센트 인코딩하지 않는다.** `buildLibpqDsn` 이 따옴표를 못 씌우는 것과 같은
 * 이유로 - 합성 시점에 user/password 는 CloudFormation 토큰이다. 대신 aws-rds 의
 * `DEFAULT_PASSWORD_EXCLUDE_CHARS` 가 위 `POSTGRES_URI_UNSAFE` 의 문자를 전부
 * 제외한다는 사실에 의존한다. **우연히 성립하는 커플링이므로**
 * `test/dev/data-stack.test.ts` 가 합성 템플릿의 `ExcludeCharacters` 로 고정한다.
 */
export function buildPostgresUri(parts: LibpqDsnParts): string {
  // 토큰은 합성 이후에야 값이 정해지므로 검사할 수 없다. 리터럴만 본다.
  for (const [key, value] of [
    ['host', parts.host],
    ['dbname', parts.dbname],
    ['user', parts.user],
    ['password', parts.password],
  ] as ReadonlyArray<readonly [string, string]>) {
    if (!Token.isUnresolved(value) && POSTGRES_URI_UNSAFE.test(value)) {
      throw new Error(
        `Postgres URI 값에 인코딩 없이 쓸 수 없는 문자가 있다: ${key}=${value}`,
      );
    }
  }

  const query = [
    // 이 플래그가 sslmode 의 의미를 libpq 와 일치시킨다. 위 주석 참조.
    'uselibpqcompat=true',
    ...(parts.sslmode ? [`sslmode=${parts.sslmode}`] : []),
  ].join('&');

  return (
    `postgresql://${parts.user}:${parts.password}` +
    `@${parts.host}:${parts.port}/${parts.dbname}?${query}`
  );
}
