import { App, Tags } from 'aws-cdk-lib/core';

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
  apiServer: 8080,
  clickhouseHttp: 8123,
  clickhouseNative: 9000,
  aurora: 5432,
  https: 443,
  http: 80,
} as const;

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
