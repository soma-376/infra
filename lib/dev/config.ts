import { DevEksConfig, loadDevEksConfig } from './eks-config';
import { DevEdgeConfig, loadDevEdgeConfig } from './edge-config';
import { loadDevOidcClientKeys } from './oidc-config';
import { Annotations, App, Duration } from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import { InstanceClass, InstanceSize, InstanceType } from 'aws-cdk-lib/aws-ec2';

/**
 * dev 스택 공통 태그 (ADR-0021 4번).
 *
 * `Org` 와 `ManagedBy` 는 prod(`lib/prod/config.ts` 의 `COMMON_TAGS`)와 같은 값이고
 * `Env` 만 갈린다. prod 의 `Env: 'mvp'` 는 의도적으로 그대로 두므로 - 값을 바꾸면
 * 태그가 App 스코프에서 전 리소스로 전파되어 운영 전체에 태그 diff 가 생긴다 -
 * 이 레포에서 환경을 식별하는 것은 태그가 아니라 **스택 ID 접두사**다.
 *
 * `Org` 는 `lib/common/config.ts` 의 `ECR_NAMESPACE` 와 같은 값이어야 한다.
 * 두 값의 커플링 근거는 그쪽 주석에 있고(ADR-0007), 여기서도 함께 바뀌어야 한다.
 */
export const DEV_COMMON_TAGS: Readonly<Record<string, string>> = {
  Org: 'soma-376',
  Env: 'dev',
  ManagedBy: 'cdk',
};

/**
 * ALB 라우팅과 WAF가 공유하는 dev 앱 경로의 literal exact/말단 wildcard 정의.
 * PROJ-200의 앱 API는 `/api/v1`, OTLP는 `/v1`을 유지한다.
 * `/api/v1/invitations*`는 slash 없는 접미사도 포함하고 bare `/bin`은 포함하지 않는다.
 * (ADR-0026, ADR-0027, PR #18)
 */
export const DEV_OTLP_PATHS = ['/v1/traces', '/v1/metrics', '/v1/logs'] as const;
/** 기존 300건 rate를 공유하는 등록·토큰·초대 세 조건. 새 인증·조회 경로는 포함하지 않는다. */
export const DEV_ENROLLMENT_REGISTRATION_PATHS = [
  '/api/v1/enroll',
  '/api/v1/installations/*',
  '/api/v1/invitations*',
] as const;
/** ALB priority 3의 최대 다섯 경로 조건. WAF 내용 검사는 모두 Block한다. */
export const DEV_ENROLLMENT_API_PATHS = [
  ...DEV_ENROLLMENT_REGISTRATION_PATHS,
  '/api/v1/auth/*',
  '/api/v1/manifest',
] as const;
/** ALB priority 5의 조직 관리·문의·업데이트 경로. */
export const DEV_ENROLLMENT_MANAGEMENT_PATHS = [
  '/api/v1/organizations/*',
  '/api/v1/inquiries',
  '/api/v1/check-updates',
] as const;
export const DEV_BOOTSTRAP_PATHS = ['/windows', '/unix', '/bin/*'] as const;

/** dev ALB 전체에 연결하는 REGIONAL Web ACL 이름. (ADR-0027) */
export const DEV_WAF_WEB_ACL_NAME = 'soma-376-dev';

/** WAF의 CloudWatch Logs 목적지는 aws-waf-logs- 접두사를 요구한다. (ADR-0027) */
export const DEV_WAF_LOG_GROUP_NAME = 'aws-waf-logs-soma-376-dev';

/** 로그 redaction과 Web ACL data protection이 함께 보호할 header 이름. (ADR-0027) */
export const DEV_WAF_REDACTED_HEADERS = ['authorization', 'cookie', 'x-admin-token'] as const;

/**
 * 개별 Count override와 exact label 매핑을 함께 검토할 수 있도록 static version을 고정한다.
 * WAF 요청 로그는 관리형 룰셋 버전을 직접 기록하지 않으며 `formatVersion`은 로그 형식 버전이다.
 * 과거 요청의 버전은 당시 합성 템플릿·commit·배포 기록과 대조해야 한다. 서울 리전의 버전 가용성과
 * 실제 rule/label은 배포 전 API로 확인하고 갱신·만료 전 rule·label·예외를 함께 재검증한다.
 * IP 목록 두 그룹은 비버전 그룹이다. (ADR-0027)
 */
export const DEV_WAF_MANAGED_RULE_VERSIONS = {
  common: 'Version_1.23',
  knownBadInputs: 'Version_1.26',
  sqlInjection: 'Version_2.4',
} as const;

/** 악성 IP 판정과 별개인 dev 접근 국가 정책. 모든 경로에 적용한다. (ADR-0027) */
export const DEV_WAF_BLOCKED_COUNTRIES = ['CN', 'RU', 'KP', 'IR'] as const;

/** 세 rate 규칙의 출발지 IP별 요청 집계 구간. X-Forwarded-For는 사용하지 않는다. */
export const DEV_WAF_RATE_EVALUATION_WINDOW_SECONDS = 300;

/**
 * 실측값이나 AWS 권장값이 아닌 dev 초기 가설이다. OTLP는 배치·재시도·공유 NAT의 burst를
 * Count로 관찰하고 등록·토큰·초대 세 조건은 저빈도 등록·토큰 발급의 반복 호출을 제한한다.
 * remaining에는 새 인증·manifest·조직 관리·문의·업데이트와 bootstrap·다운로드가
 * 포함된다. 여러 설치 GET·반복 요청과 같은 NAT의
 * 동시 설치에 여유를 두되, 서로 다른 요청을 한 IP로 합산하는 한계는 실트래픽으로 재검토한다.
 * 요청 건수는 다운로드 바이트·비용을 제한하지 않는다. (ADR-0027·0038)
 */
export const DEV_WAF_RATE_LIMITS = {
  otlp: 10_000,
  enrollment: 300,
  remaining: 1_000,
} as const;

/**
 * rate Block은 인증 거부와 구별되는 429를 사용하고 이 값을 Retry-After로 안내한다.
 * telemetryctl의 classify()는 OTLP 전송의 403을 인증 실패, 429를 재시도로 분류한다.
 * Forwarder.send()가 인증 실패 때 토큰 캐시를 무효화해 재조회하고 재시도 예산을 제한한다.
 * parseRetryAfter()가 최대 대기 시간으로 자르므로 정확히 60초 대기하거나 이때 WAF 차단이
 * 풀린다고 보장하지 않는다. enrollment·bootstrap 전체의 자동 재시도 계약도 아니다. (ADR-0027)
 */
export const DEV_WAF_RETRY_AFTER_SECONDS = 60;

/**
 * dev VPC CIDR (ADR-0022 1번).
 *
 * 운영 VPC 는 `ipAddresses` 를 주지 않아 CDK 기본값 `10.0.0.0/16` 을 쓴다. dev 에
 * 같은 대역을 쓰면 두 VPC 를 peering 하거나 같은 VPN 에 물릴 여지가 영구히 사라진다.
 * 지금 필요하지 않더라도 겹치지 않게 두는 비용이 0 이다.
 */
export const DEV_VPC_CIDR = '10.1.0.0/16';

/**
 * dev VPC 서브넷 그룹 이름.
 *
 * `natGateways: 0` 이면 `PRIVATE_WITH_EGRESS` 서브넷을 애초에 만들 수 없으므로
 * (egress 경로가 없는 "egress 있는 프라이빗 서브넷"은 정의상 성립하지 않는다)
 * 그룹은 public 하나뿐이다. prod 의 3티어(`SUBNET_GROUP`)와 대비된다. (ADR-0022 1번)
 */
export const DEV_SUBNET_GROUP = {
  public: 'public',
} as const;

/**
 * dev ALB 타깃의 deregistration delay (ADR-0025).
 *
 * 교체 배포에서는 AWS 기본값 300초의 connection draining이 먼저 끝난 뒤 새 태스크를
 * 띄우므로 앱 ALB 타깃 그룹에는 MVP 초기 기준인 60초를 적용한다.
 * 이 값은 실트래픽으로 최적화한 결과나 AWS 공식 권장값이 아니며 prod 적용은
 * 관측 이후 결정한다. ClickHouse ALB 타깃은 ADR-0038로 제거했다.
 */
export const DEV_DEREGISTRATION_DELAY = Duration.seconds(60);

/** RDS 할당 스토리지. gp3 최소 과금 구간이자 dev 스키마 검증에 충분한 크기다. */
export const DEV_RDS_ALLOCATED_STORAGE_GIB = 20;

/** DB 전용 SSM 릴레이. 기존 EKS API 릴레이의 이름·역할과 분리한다. (ADR-0038) */
export const DEV_DB_RELAY_INSTANCE_TYPE = 't4g.micro';
export const DEV_DB_OPERATOR_ROLE_NAME = 'soma-376-dev-db-operator';
export const DEV_DB_RELAY_POSTGRES_SESSION_DOCUMENT_NAME = 'soma-376-dev-db-postgres-tunnel';
export const DEV_DB_RELAY_CLICKHOUSE_SESSION_DOCUMENT_NAME = 'soma-376-dev-db-clickhouse-tunnel';

/**
 * dashboard source/cache 접속용 자격 증명 원본. 실제 DB 사용자·권한은 런북으로
 * 별도 준비하고, 기존 enrollment·ingest의 master credential은 바꾸지 않는다. (ADR-0031)
 */
export const DEV_DASHBOARD_DB_CREDENTIALS = {
  rdsSource: {
    secretName: 'soma-376/dev/dashboard/rds-source',
    username: 'dashboard_rds_source',
  },
  rdsCache: {
    secretName: 'soma-376/dev/dashboard/rds-cache',
    username: 'dashboard_rds_cache',
  },
  clickHouseSource: {
    secretName: 'soma-376/dev/dashboard/clickhouse-source',
    username: 'dashboard_ch_source',
  },
  clickHouseCache: {
    secretName: 'soma-376/dev/dashboard/clickhouse-cache',
    username: 'dashboard_ch_cache',
  },
} as const;

/** DB 사용자와 동기화해 수동 등록할 영숫자 비밀번호 길이. (ADR-0031) */
export const DEV_DASHBOARD_DB_PASSWORD_LENGTH = 32;

/** JWT 키 값은 별도 초기화하며 두 원본은 같은 ARN으로 보존한다. (ADR-0030·0031) */
export const DEV_USER_JWT_PRIVATE_KEY_SECRET_NAME = 'soma-376/dev/user-jwt/private-key';
export const DEV_USER_JWT_PUBLIC_KEYS_SECRET_NAME = 'soma-376/dev/user-jwt/public-keys';

/**
 * telemetry 전용 RS256 키 원본. 사용자 로그인 JWT와 원본·SPC·mount를 공유하지 않는다.
 * 개인키는 enrollment만, 공개키는 enrollment·Gateway·ingest가 읽는다. (ADR-0036)
 */
export const DEV_TELEMETRY_JWT_PRIVATE_KEY_SECRET_NAME = 'soma-376/dev/telemetry-jwt/private-key';
export const DEV_TELEMETRY_JWT_PUBLIC_KEYS_SECRET_NAME = 'soma-376/dev/telemetry-jwt/public-keys';

/**
 * RDS 인스턴스 타입 (ADR-0022 6번). Aurora Serverless v2 는 최소 0.5 ACU 가
 * 상시 과금되어 개발용으로 과하므로 `DatabaseInstance` + db.t4g.micro 를 쓴다.
 */
export const DEV_RDS_INSTANCE_TYPE = InstanceType.of(
  InstanceClass.BURSTABLE4_GRAVITON,
  InstanceSize.MICRO,
);

/** Raw Signal 버킷 만료 기간. 운영(30일)보다 짧게 둔다 - dev 데이터는 재현용이다. */
export const DEV_RAW_SIGNAL_EXPIRATION_DAYS = 7;

/**
 * `devAllowedCidr` 미지정 시의 기본 인바운드 소스 (ADR-0022 9번).
 *
 * **안전한 기본값이 아니다.** 팀원 IP 가 유동적인 개발 단계에서 CIDR 갱신
 * 마찰을 피하려고 선택한 값이며, 그 대가로 아래 `warnOnOpenIngress` 의 경고가
 * 유일한 방어선이 된다.
 */
export const DEV_OPEN_CIDR = '0.0.0.0/0';

/**
 * dev 배포별 가변값. AWS 원본 선언과 EKS·ALB 입력만 읽는다.
 */
export interface DevConfig {
  readonly eks: DevEksConfig;
  readonly edge: DevEdgeConfig;
  /** 앱 ALB(80/선택적 443)의 인바운드 허용 소스. 항상 1개 이상이다. */
  readonly allowedCidrs: readonly string[];
  /** 원본이 없는 경우에도 빈 배열을 명시한다. */
  readonly oidcClientKeys: readonly string[];
}

/** EKS 전용 dev 설정. 폐기된 ECS 입력을 조용히 무시하지 않는다. (ADR-0035) */
export function loadDevConfig(app: App): DevConfig {
  for (const key of ['devAppAsgMaxCapacity', 'devImageTag', 'devCertificateArn', 'devDashboardRuntimeFile']) {
    if (app.node.tryGetContext(key) !== undefined) {
      throw new Error(`${key}는 ECS 제거로 폐기되었습니다. OIDC 원본 key는 devOidcClientKeys로, 앱 설정은 EKS runtime YAML로 이전하세요. EKS 인증서는 devEksCertificateArn을 사용하세요`);
    }
  }
  return {
    eks: loadDevEksConfig(app),
    edge: loadDevEdgeConfig(app),
    oidcClientKeys: loadDevOidcClientKeys(app),
    allowedCidrs: parseAllowedCidrs(app.node.tryGetContext('devAllowedCidr') as string | undefined),
  };
}

/**
 * 쉼표 구분 CIDR 목록을 정규화한다. 공백은 잘라내고 빈 조각은 버린다.
 * 남는 것이 없으면 `DEV_OPEN_CIDR` 로 폴백한다 - 반환값은 항상 1개 이상이다.
 */
function parseAllowedCidrs(raw: string | undefined): readonly string[] {
  const parsed = (raw ?? '')
    .split(',')
    .map((cidr) => cidr.trim())
    .filter((cidr) => cidr.length > 0);

  return parsed.length > 0 ? parsed : [DEV_OPEN_CIDR];
}

/**
 * 인바운드가 인터넷 전면 공개일 때 synth 경고를 낸다 (ADR-0022 9번).
 *
 * 경고 메커니즘은 `lib/prod/edge-stack.ts` 의 `infra:edge-no-auth` 폴백 경고와
 * 같다(ADR-0008). 첫 인자는 `cdk synth --quiet` 등에서 acknowledge 할 때 쓰는
 * ID 이므로 문자열을 바꾸면 기존 acknowledge 가 무효가 된다.
 *
 * **`Annotations.of(app)` 이 아니라 스택 스코프로 받는다.** CDK 는 스택 아티팩트
 * 메타데이터를 수집할 때 스택 노드부터 트리를 훑으므로(`collectStackMetadata`),
 * App 루트에 붙인 annotation 은 어떤 스택 메타데이터에도 실리지 않아 CLI 가
 * 출력하지 않는다. ADR-0022 의 예시도 `Annotations.of(scope)` 다.
 *
 * 판정 기준을 "context 미지정"이 아니라 "결과 CIDR 에 0.0.0.0/0 이 있는가"로
 * 두는 것은 의도다 - `-c devAllowedCidr=0.0.0.0/0` 을 명시해도 노출 범위는 같다.
 */
export function warnOnOpenIngress(
  scope: Construct,
  allowedCidrs: readonly string[],
): void {
  if (!allowedCidrs.includes(DEV_OPEN_CIDR)) {
    return;
  }

  Annotations.of(scope).addWarningV2(
    'infra:dev-open-ingress',
    `devAllowedCidr 미지정(또는 ${DEV_OPEN_CIDR} 명시): 앱 ALB(80/선택적 443)의 ` +
      '인바운드가 인터넷에 전면 공개된다. telemetry-ingest·telemetry-gateway·enrollment-api·dashboard-api ' +
      '경로가 같은 CIDR에 공개되므로 `-c devAllowedCidr=<내 IP>/32` 로 좁혀서 배포한다 (ADR-0022 9번·0038).',
  );
}
