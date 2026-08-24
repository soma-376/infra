import { Annotations, App } from 'aws-cdk-lib/core';
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
 * basename 은 운영과 같게 유지한다 - 같은 컨테이너의 로그를 찾을 때 접두사만
 * 바꿔 끼우면 되게 하기 위함이다.
 */
export const DEV_LOG_GROUP_PREFIX = '/ecs/dev';

/**
 * 앱 호스트 ASG 인스턴스 타입 (collector 태스크 + dashboard 태스크).
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
 * `devAllowedCidr` 미지정 시의 기본 인바운드 소스 (ADR-0022 9번).
 *
 * **안전한 기본값이 아니다.** 팀원 IP 가 유동적인 개발 단계에서 CIDR 갱신
 * 마찰을 피하려고 선택한 값이며, 그 대가로 아래 `warnOnOpenIngress` 의 경고가
 * 유일한 방어선이 된다.
 */
export const DEV_OPEN_CIDR = '0.0.0.0/0';

/** `devAppAsgMaxCapacity` 기본값. 지금은 호스트 1대로 충분하다. */
const DEV_DEFAULT_APP_ASG_MAX_CAPACITY = 1;

/**
 * `devImageTag` 기본값. dev/prod 가 같은 ECR 레포를 공유하고 태그로만 갈린다
 * (ADR-0021 5번). 운영이 같은 태그를 쓰면 dev 빌드가 곧 운영 이미지가 되므로
 * 방어선은 인프라가 아니라 앱 레포의 태그 규율이다.
 */
const DEV_DEFAULT_IMAGE_TAG = 'latest';

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
    `devAllowedCidr 미지정(또는 ${DEV_OPEN_CIDR} 명시): ALB(80/4318/8123)와 RDS(5432)의 ` +
      '인바운드가 인터넷에 전면 공개된다. ClickHouse 의 default 유저는 비밀번호가 없고 ' +
      'access_management=1 을 가지므로(ADR-0019) 8123 에 닿을 수 있는 주체는 사실상 ' +
      '관리자이며, RDS 는 마스터 자격증명 무차별 대입에 노출된다. ' +
      '4318 은 auth-proxy 를 거치지 않고 Collector 로 직행하는 디버그 리스너라 ' +
      '인증 없는 OTLP 수신구가 그대로 열린다(ADR-0023 3번). ' +
      '`-c devAllowedCidr=<내 IP>/32` 로 좁혀서 배포한다 (ADR-0022 9번).',
  );
}
