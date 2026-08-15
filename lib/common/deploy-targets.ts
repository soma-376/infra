/**
 * 배포 대상 ECS 리소스의 **물리 이름** 단일 출처 (ADR-0024).
 *
 * 여기 있는 값에 세 곳이 동시에 의존한다.
 *   - `lib/prod/application-stack.ts` / `lib/dev/application-stack.ts` : 리소스를 이 이름으로 만든다
 *   - `lib/cicd/deploy-stack.ts` : 이 이름으로 IAM 리소스 ARN 을 조립한다
 *   - 앱 레포 워크플로우(PROJ-65) : `aws ecs update-service --cluster/--service` 인자
 *
 * **소비자가 셋이라는 것이 이 파일이 `common/` 에 있는 이유다.** 클러스터 이름은 환경별로
 * 다르므로 ADR-0021 의 배치 규칙("dev 에서 달라야 할 이유가 없으면 common")만 보면 각 환경
 * 폴더 행이다. 그러나 그렇게 두면 `lib/cicd/` 가 `lib/prod/` 와 `lib/dev/` 를 둘 다 import
 * 해야 하고, 그게 바로 `prod <-> dev` 금지 규칙이 막으려던 커플링이다. 값은 환경별이되
 * **"환경 -> 값" 매핑 자체는 환경 무관 계약**이라 여기 둔다.
 *
 * 이건 명시적 예외이며, 그래서 `lib/common/config.ts` 에 섞지 않고 별도 파일로 격리한다.
 * GitHub org/레포/브랜치와 역할별 권한 대상은 소비자가 `lib/cicd/` 하나뿐이므로 여기 두지
 * 않는다 (`lib/cicd/config.ts`).
 *
 * **이름을 바꾸면 ECS 클러스터/서비스가 교체된다** (ADR-0024 Constraints). 게다가 한쪽만
 * 고치면 synth·test·deploy 가 전부 통과하고 GitHub Actions 만 AccessDenied 로 죽는다 -
 * CloudFormation 은 IAM 정책에 적힌 리소스 ARN 의 실존을 검증하지 않기 때문이다.
 * `test/cicd/deploy-stack.test.ts` 의 크로스 스택 어서션이 유일한 방어선이다.
 */

/** 배포 대상 환경. `cicd` 는 배포 *주체*라 여기 없다. */
export type DeployEnv = 'dev' | 'prod';

/** `DEPLOY_ENVS` 를 순회해 역할을 만든다. 순서가 논리 ID 순서를 정하므로 바꾸지 않는다. */
export const DEPLOY_ENVS: readonly DeployEnv[] = ['dev', 'prod'] as const;

/**
 * ECS 클러스터 물리 이름. **환경마다 달라야 하는 유일한 이름이다** - 클러스터 이름은
 * 계정 + 리전에서 유일하고 dev/prod 가 같은 계정·리전에 산다 (ADR-0021 Constraints).
 *
 * prod 의 공통 태그는 `Env: 'mvp'` 인데 클러스터 이름은 `prod` 다. **의도된 불일치다** -
 * 태그 값을 바꾸면 App 스코프 전파로 전 리소스에 태그 diff 가 생기고 일부는 교체되므로
 * 그대로 두고(ADR-0021 4번), 운영자가 읽는 이름 쪽만 명확하게 쓴다. Cost Explorer 에서는
 * 여전히 `Env=mvp` 가 운영이다.
 */
export const ECS_CLUSTER_NAMES: Readonly<Record<DeployEnv, string>> = {
  dev: 'soma-376-dev',
  prod: 'soma-376-prod',
} as const;

/**
 * ECS 서비스 물리 이름. **환경 무관하게 같은 이름을 쓴다.**
 *
 * 서비스 이름의 유일성 스코프가 클러스터 안이라 충돌하지 않고, 위 `ECS_CLUSTER_NAMES` 가
 * 이미 두 환경을 갈라 두었다. 이렇게 두면 앱 레포 워크플로우가 `--cluster` 하나만 갈아끼워
 * 환경을 바꿀 수 있다 - 환경별로 다른 서비스 이름을 알 필요가 없다.
 *
 * Cloud Map 서비스 이름(`COLLECTOR_SERVICE_NAME`, `CLICKHOUSE_SERVICE_NAME`)과 값이 겹치지만
 * **다른 계약이다.** 하나는 ECS 서비스 식별자이고 하나는 DNS 레이블이다. 한쪽을 바꿔야 할 때
 * 다른 쪽이 끌려가지 않도록 상수를 따로 둔다.
 *
 * `authProxy` 는 현재 dev 에만 존재한다 (ADR-0023).
 */
export const ECS_SERVICE_NAMES = {
  collector: 'collector',
  dashboard: 'dashboard',
  clickhouse: 'clickhouse',
  authProxy: 'auth-proxy',
} as const;
