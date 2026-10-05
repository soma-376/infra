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
 * remaining에는 새 인증·manifest·조직 관리·문의·업데이트와 bootstrap·다운로드·SQL 디버깅이
 * 포함된다. 여러 설치 GET·반복 요청과 같은 NAT의
 * 동시 설치에 여유를 두되, 서로 다른 요청을 한 IP로 합산하는 한계는 실트래픽으로 재검토한다.
 * 요청 건수는 다운로드 바이트·비용·SQL 복잡도를 제한하지 않는다. (ADR-0027)
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
 * dev CloudWatch Logs 로그 그룹 접두사 (ADR-0022 10번).
 *
 * **이걸 빼면 첫 `cdk deploy` 가 실패한다.** 운영 `ApplicationStack` 은
 * `logGroupName` 에 `/ecs/collector` 같은 물리 이름을 명시하고, 로그 그룹 이름은
 * 계정 + 리전 스코프에서 유일해야 한다. 접두사 없이 같은 이름을 쓰면
 * `Resource of type 'AWS::Logs::LogGroup' with identifier '/ecs/collector'
 * already exists` 로 스택이 통째로 롤백된다. (ADR-0021 Constraints)
 *
 * 최종 두 Spring 앱은 dev 전용 basename을 쓰고, ClickHouse는 운영과 같은
 * basename을 쓴다. 세 로그 그룹 모두 이 접두사 아래에 둔다.
 */
export const DEV_LOG_GROUP_PREFIX = '/ecs/dev';

/**
 * dev ALB 타깃의 deregistration delay (ADR-0025).
 *
 * 교체 배포에서는 AWS 기본값 300초의 connection draining이 먼저 끝난 뒤 새 태스크를
 * 띄우므로 ClickHouse 외 ALB 타깃 그룹에는 MVP 초기 기준인 60초를 적용한다.
 * 이 값은 실트래픽으로 최적화한 결과나 AWS 공식 권장값이 아니다. ClickHouse는 장시간
 * 연결과 쿼리 특성을 별도로 검증하기 전까지 기본값 300초를 유지하고, prod 적용도
 * 관측 이후 결정한다.
 */
export const DEV_DEREGISTRATION_DELAY = Duration.seconds(60);

/**
 * telemetry-ingest 전용 ECS health check 기동 유예 (ADR-0026).
 *
 * ClickHouse 스키마 준비가 응답 헤더 timeout과 재시도를 모두 소진하면 약
 * 160초가 걸릴 수 있다. 로드 밸런서를 쓰면 CDK 기본 60초로는 기동 중인
 * 태스크를 ECS scheduler가 조기 교체할 수 있어 ingest 서비스에만 240초를 둔다.
 * healthy 전환을 지연하는 대기 시간이 아니며, 배포 후 실제 기동 시간을 관측한다.
 */
export const DEV_TELEMETRY_INGEST_HEALTH_CHECK_GRACE = Duration.seconds(240);

/**
 * 앱 호스트 ASG 인스턴스 타입 (ClickHouse 외 모든 dev 앱 태스크).
 *
 * ARM64 로 고정한다 - 비용이 아니라 **운영과 같은 이미지를 쓰기 위해서**다.
 * dev 가 x86 이면 앱 레포가 두 아키텍처를 빌드해야 하고, 그러면 "dev 에서
 * 검증했다"가 운영에 대해 아무것도 보장하지 못한다. (ADR-0015, ADR-0022 3번)
 */
export const DEV_APP_INSTANCE_TYPE = InstanceType.of(
  InstanceClass.T4G,
  InstanceSize.MEDIUM,
);

/**
 * ClickHouse 호스트 ASG 인스턴스 타입. 운영과 같은 t4g.small 이다.
 *
 * 앱 호스트와 ASG 를 나누는 이유는 두 가지다 (ADR-0022 3번). ClickHouse 쿼리
 * 하나가 가용 메모리를 크게 잡아먹어 앱 태스크를 OOM 으로 밀어내는 것을 막고,
 * 데이터 디렉터리를 비울 때 앱 호스트를 함께 내리지 않아도 되게 한다.
 */
export const DEV_CLICKHOUSE_INSTANCE_TYPE = InstanceType.of(
  InstanceClass.T4G,
  InstanceSize.SMALL,
);

/** ClickHouse 데이터 볼륨(`/dev/xvdb`) 크기. 운영과 같은 값이다. */
export const DEV_CLICKHOUSE_DATA_VOLUME_GIB = 50;

/** RDS 할당 스토리지. gp3 최소 과금 구간이자 dev 스키마 검증에 충분한 크기다. */
export const DEV_RDS_ALLOCATED_STORAGE_GIB = 20;

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
 * telemetry-ingest의 S3 archive key prefix. 앱 고유 object key 레이아웃을 그대로 쓰며
 * dev 전용 상위 prefix 계약은 아직 없으므로 빈 문자열을 명시한다. (ADR-0026)
 */
export const DEV_TELEMETRY_ARCHIVE_PREFIX = '';

/** enrollment-api 이미지 안에서 bootstrap 바이너리를 서빙할 디렉터리. (ADR-0026) */
export const DEV_ENROLLMENT_BINARIES_DIR = '/app/binaries';

/**
 * `devAllowedCidr` 미지정 시의 기본 인바운드 소스 (ADR-0022 9번).
 *
 * **안전한 기본값이 아니다.** 팀원 IP 가 유동적인 개발 단계에서 CIDR 갱신
 * 마찰을 피하려고 선택한 값이며, 그 대가로 아래 `warnOnOpenIngress` 의 경고가
 * 유일한 방어선이 된다.
 */
export const DEV_OPEN_CIDR = '0.0.0.0/0';

/**
 * `devAppAsgMaxCapacity` 기본값. 구 서비스 정리 후 앱 호스트 소프트 예약은
 * telemetry-ingest와 enrollment-api 합 2048 MiB다. 기본 호스트를 한 대로
 * 되돌리고, 부하 검증이 필요하면 context로 늘린다. (ADR-0026)
 */
const DEV_DEFAULT_APP_ASG_MAX_CAPACITY = 1;

/**
 * `devImageTag` 기본값. dev/prod 가 같은 ECR 레포를 공유하고 태그로만 갈린다
 * (ADR-0021 5번).
 *
 * **예전 값은 `latest` 였고 운영도 태그를 주지 않아 `latest` 를 읽었다** - 그래서 dev 빌드가
 * 곧 운영 이미지가 됐다. ADR-0021 이 Negative 로 남겨 둔 그 구멍을 ADR-0024 가 두 환경에
 * 서로 다른 고정 태그를 주어 닫았다. 운영 쪽 상수는 `lib/prod/config.ts` 의 `PROD_IMAGE_TAG` 다.
 *
 * 태그가 갈렸다고 규율이 강제되는 것은 아니다. ECR 은 이미지 태그 기반 IAM 조건 키를 주지
 * 않으므로, dev 배포 역할이 `prod` 태그를 push 하는 것을 인프라가 막을 수단이 없다.
 * 방어선은 여전히 앱 레포 워크플로우다 (ADR-0024 Negative).
 *
 * `-c devImageTag=pr-42` 로 갈아탈 수 있다. 이 손잡이는 dev 에만 있다.
 */
const DEV_DEFAULT_IMAGE_TAG = 'dev';

/**
 * dev 배포별 가변값. context 키 3개에서만 온다.
 */
export interface DevConfig {
  /** ALB(80/8123)와 RDS(5432)의 인바운드 허용 소스. 항상 1개 이상이다. */
  readonly allowedCidrs: readonly string[];
  /** 앱 호스트 ASG 의 최대 용량. 부하 테스트 확장 손잡이다 (ADR-0022 11번). */
  readonly appAsgMaxCapacity: number;
  /** ECR 이미지 태그. */
  readonly imageTag: string;
}

/**
 * CDK context 에서 dev 설정을 로드한다.
 * context 키: devAllowedCidr, devAppAsgMaxCapacity, devImageTag.
 *
 * `devAllowedCidr` 은 쉼표로 여러 개를 줄 수 있다.
 *   npx cdk deploy --all -c env=dev -c devAllowedCidr=203.0.113.10/32,198.51.100.0/24
 */
export function loadDevConfig(app: App): DevConfig {
  return {
    allowedCidrs: parseAllowedCidrs(
      app.node.tryGetContext('devAllowedCidr') as string | undefined,
    ),
    appAsgMaxCapacity: parseAppAsgMaxCapacity(
      app.node.tryGetContext('devAppAsgMaxCapacity'),
    ),
    imageTag:
      (
        (app.node.tryGetContext('devImageTag') as string | undefined) ?? ''
      ).trim() || DEV_DEFAULT_IMAGE_TAG,
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
 * ASG 최대 용량을 파싱한다. CLI `-c` 는 문자열, `cdk.json` context 는 숫자로
 * 들어오므로 양쪽을 받는다.
 *
 * **파싱 실패나 1 미만이면 즉시 던진다.** 조용히 기본값으로 폴백하면 오타
 * (`-c devAppAsgMaxCapacity=3대`)가 "왜 안 늘어나지"로만 드러난다.
 */
function parseAppAsgMaxCapacity(raw: unknown): number {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return DEV_DEFAULT_APP_ASG_MAX_CAPACITY;
  }

  const text = String(raw).trim();
  const value = Number(text);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(
      `devAppAsgMaxCapacity 는 1 이상의 정수여야 한다: ${text}`,
    );
  }
  return value;
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
    `devAllowedCidr 미지정(또는 ${DEV_OPEN_CIDR} 명시): ALB(80/8123)와 RDS(5432)의 ` +
      '인바운드가 인터넷에 전면 공개된다. ClickHouse 의 default 유저는 비밀번호가 없고 ' +
      'access_management=1 을 가지므로(ADR-0019) 8123 에 닿을 수 있는 주체는 사실상 ' +
      '관리자이며, RDS 는 마스터 자격증명 무차별 대입에 노출된다. ' +
      '80의 telemetry-ingest·enrollment-api 경로도 같은 CIDR에 공개된다. ' +
      '`-c devAllowedCidr=<내 IP>/32` 로 좁혀서 배포한다 (ADR-0022 9번).',
  );
}
