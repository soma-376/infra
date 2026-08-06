import { App, Tags, Token } from 'aws-cdk-lib/core';

/**
 * 전 스택 공통 태그. 비용 배분(Cost Explorer 태그 분해)과 소유권 식별에 쓴다.
 */
export const COMMON_TAGS: Readonly<Record<string, string>> = {
  Org: 'soma-376',
  Env: 'mvp',
  ManagedBy: 'cdk',
};

/**
 * MVP 워크로드를 고정할 primary AZ의 VPC availabilityZones 인덱스 (ADR-0011).
 */
export const PRIMARY_AZ_INDEX = 0;

/**
 * App 스코프에 공통 태그를 적용한다. CDK 가 하위 모든 스택의 태그 지원 리소스로
 * 전파하므로 스택별 중복 호출은 필요 없다.
 *
 * bin/infra.ts 와 test/helpers.ts 가 각각 App 을 조립하므로 양쪽에서 호출한다.
 */
export function applyCommonTags(app: App): void {
  for (const [key, value] of Object.entries(COMMON_TAGS)) {
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
} as const;

/**
 * Cloud Map 프라이빗 DNS 네임스페이스와 ClickHouse 서비스 주소 (ADR-0005).
 */
export const CLOUD_MAP_NAMESPACE = 'obs.local';
export const CLICKHOUSE_SERVICE_NAME = 'clickhouse';
export const CLICKHOUSE_HOST = `${CLICKHOUSE_SERVICE_NAME}.${CLOUD_MAP_NAMESPACE}`;

/**
 * 컨테이너 포트.
 */
export const PORTS = {
  otlp: 4318,
  // Collector 가 같은 태스크의 post-processor 로 OTLP/HTTP 를 밀어넣는 포트.
  // apiServer 와 값은 같지만 다른 태스크의 다른 계약이므로 따로 둔다. (ADR-0017)
  postProcessor: 8080,
  apiServer: 8080,
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
 * VPC 서브넷 그룹 이름 (network-stack 과 소비 스택이 공유).
 */
export const SUBNET_GROUP = {
  public: 'public',
  app: 'app',
  db: 'db',
} as const;

/**
 * EdgeStack 모드 분기 입력. certificateArn 이 있으면 모드 A(HTTPS + ALB 인증),
 * 없으면 모드 B(HTTP 폴백 + synth 경고).
 */
export interface EdgeConfig {
  readonly certificateArn?: string;
  readonly domainName?: string;
  readonly cognitoDomainPrefix: string;
}

/**
 * 전체 인프라 설정.
 */
export interface InfraConfig {
  readonly edge: EdgeConfig;
}

/**
 * CDK context 에서 설정을 로드한다.
 * context 키: certificateArn, domainName, cognitoDomainPrefix.
 */
export function loadConfig(app: App): InfraConfig {
  const certificateArn = app.node.tryGetContext('certificateArn') as
    | string
    | undefined;
  const domainName = app.node.tryGetContext('domainName') as string | undefined;
  const cognitoDomainPrefix =
    (app.node.tryGetContext('cognitoDomainPrefix') as string | undefined) ??
    DEFAULT_COGNITO_DOMAIN_PREFIX;

  return {
    edge: {
      certificateArn,
      domainName,
      cognitoDomainPrefix,
    },
  };
}

/**
 * Cognito 호스팅 도메인 prefix 는 리전 내 전역 유일해야 하므로 suffix 를 붙인 기본값.
 */
export const DEFAULT_COGNITO_DOMAIN_PREFIX = 'soma-376-mvp-auth';

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
