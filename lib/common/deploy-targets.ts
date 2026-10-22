/**
 * prod ECS 리소스의 물리 이름과 CI 역할 환경의 단일 출처 (ADR-0024·0035).
 *
 * prod ApplicationStack, DeployStack의 서비스 ARN, 앱 workflow가 같은 ECS 이름을 쓴다.
 * dev는 EKS만 실행하며 CI 역할은 이미지 공급만 맡으므로 dev ECS 이름은 정의하지 않는다.
 * prod와 cicd가 서로 import하지 않도록 남은 ECS 계약도 common에 둔다.
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
 * prod ECS 클러스터 물리 이름. dev ECS 클러스터는 ADR-0035에서 제거했다.
 *
 * prod 의 공통 태그는 `Env: 'mvp'` 인데 클러스터 이름은 `prod` 다. **의도된 불일치다** -
 * 태그 값을 바꾸면 App 스코프 전파로 전 리소스에 태그 diff 가 생기고 일부는 교체되므로
 * 그대로 두고(ADR-0021 4번), 운영자가 읽는 이름 쪽만 명확하게 쓴다. Cost Explorer 에서는
 * 여전히 `Env=mvp` 가 운영이다.
 */
export const ECS_CLUSTER_NAMES = {
  prod: 'soma-376-prod',
} as const;

/**
 * prod ECS 서비스 물리 이름. dev 앱의 Kubernetes 이름과 별개다.
 *
 * ClickHouse Cloud Map 서비스 이름(`CLICKHOUSE_SERVICE_NAME`)과 값이 겹치지만 **다른
 * 계약이다.** 하나는 ECS 서비스 식별자이고 하나는 DNS 레이블이다. 한쪽을 바꿔야 할 때
 * 다른 쪽이 끌려가지 않도록 상수를 따로 둔다.
 */
export const ECS_SERVICE_NAMES = {
  collector: 'collector',
  dashboard: 'dashboard',
  clickhouse: 'clickhouse',
} as const;
