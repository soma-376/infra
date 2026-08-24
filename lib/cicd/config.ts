import { App } from 'aws-cdk-lib/core';
import { ECR_REPOS } from '../common/config';
import { DeployEnv, ECS_SERVICE_NAMES } from '../common/deploy-targets';

/**
 * cicd 스택 공통 태그. `Org` 와 `ManagedBy` 는 다른 두 환경과 같은 값이고 `Env` 만 갈린다.
 *
 * IAM 리소스에는 비용이 없으므로 여기서 `Env` 는 비용 배분 축이 아니라 소유권 표시다.
 * prod 가 `mvp`, dev 가 `dev` 인 기존 불일치(ADR-0021 4번)에 값이 하나 더 늘어난 것이며,
 * 프로덕션 전환 시 일괄 정합화 대상이다 (ADR-0024 Follow-up).
 */
export const CICD_COMMON_TAGS: Readonly<Record<string, string>> = {
  Org: 'soma-376',
  Env: 'cicd',
  ManagedBy: 'cdk',
};

/**
 * GitHub Actions OIDC 발급자 URL. **계정당 이 URL 의 공급자는 하나만 존재할 수 있다.**
 */
export const GITHUB_OIDC_URL = 'https://token.actions.githubusercontent.com';

/**
 * 신뢰 정책 조건 키의 접두사. `GITHUB_OIDC_URL` 에서 스킴을 뺀 값과 **반드시 같아야 한다.**
 *
 * 어긋나면 조건 키가 토큰의 어떤 클레임과도 매칭되지 않고, 그 결과 조건이 느슨해지는 게
 * 아니라 `sts:AssumeRoleWithWebIdentity` 가 **전부 거부된다.** 두 상수는 함께 바뀐다.
 */
export const GITHUB_OIDC_DOMAIN = 'token.actions.githubusercontent.com';

/**
 * `aws-actions/configure-aws-credentials` 가 요청하는 audience 기본값.
 * 신뢰 정책의 `:aud` 조건과 워크플로우의 `audience` 설정이 같아야 한다.
 */
export const GITHUB_OIDC_AUDIENCE = 'sts.amazonaws.com';

/** GitHub immutable OIDC subject 를 구성하는 저장소 식별자. */
export interface GitHubRepository {
  readonly name: string;
  readonly id: string;
}

/**
 * 배포 대상 GitHub 조직. 이름은 `ECR_NAMESPACE` / `COMMON_TAGS.Org` 와 같은 값이다.
 *
 * 2026-07-15 이후 생성된 저장소의 OIDC `sub` 는 이름뿐 아니라 조직/저장소 ID까지 포함한다.
 * ID는 숫자 계산 대상이 아니라 외부 식별자이므로 문자열로 보존한다 (ADR-0024 2번).
 */
export const GITHUB_ORG = {
  name: 'soma-376',
  id: '297555253',
} as const;

/** 배포 대상 GitHub 레포 (PROJ-48). 파이프라인 레포 하나가 이미지 둘을 낸다. */
export const GITHUB_REPOS = {
  pipeline: {
    name: 'ai-telemetry-pipeline',
    id: '1309872274',
  },
  dashboard: {
    name: 'pulsemetry-backend',
    id: '1325324450',
  },
} as const satisfies Record<string, GitHubRepository>;

/**
 * 환경별 배포 브랜치. **신뢰 정책 `sub` 조건의 유일한 출처이며, 여기가 배포 권한의 실질적
 * 경계다** - `develop` 에서 운영 역할을 맡을 수 없게 하는 것이 이 맵의 목적이다.
 *
 * 앱 레포가 브랜치 이름을 바꾸면 배포가 `AccessDenied` 로 죽는데 원인은 앱 레포가 아니라
 * 여기에 있다 (ADR-0024 Negative).
 */
export const DEPLOY_BRANCHES: Readonly<Record<DeployEnv, string>> = {
  dev: 'develop',
  prod: 'main',
} as const;

/**
 * GitHub 의 immutable OIDC subject 를 조립한다.
 *
 * 이름만 넣는 이전 형식은 2026-07-15 이후 생성된 저장소의 실제 토큰과 일치하지 않아
 * `sts:AssumeRoleWithWebIdentity` 가 AccessDenied 로 거부된다 (ADR-0024 2번).
 */
export function buildGithubOidcSubject(
  repo: GitHubRepository,
  branch: string,
): string {
  return `repo:${GITHUB_ORG.name}@${GITHUB_ORG.id}/${repo.name}@${repo.id}:ref:refs/heads/${branch}`;
}

/**
 * ECR push 최소 액션 집합 (ADR-0024 5번).
 *
 * `docker buildx build --push` 가 실제로 호출하는 것만 담는다. **pull 액션
 * (`ecr:BatchGetImage`, `ecr:GetDownloadUrlForLayer`)은 일부러 빠져 있다** - 순수 빌드+push
 * 에는 필요 없다. 워크플로우가 `--cache-from type=registry` 를 쓰기 시작하면 그 둘을 여기
 * 추가해야 하며, 그때 나올 `AccessDenied` 가 미스터리가 되지 않도록 알려진 스위치로 적어 둔다.
 *
 * `Repository.grantPullPush()` 를 쓰지 않는 이유는 액션 목록이 CDK 버전에 따라 조용히
 * 바뀌는 암묵 계약이 되어, ADR 과 테스트에 "무엇을 허용했는지" 적을 수 없기 때문이다.
 */
export const ECR_PUSH_ACTIONS: readonly string[] = [
  'ecr:BatchCheckLayerAvailability',
  'ecr:InitiateLayerUpload',
  'ecr:UploadLayerPart',
  'ecr:CompleteLayerUpload',
  'ecr:PutImage',
] as const;

/**
 * ECS 강제 재배포 최소 액션 집합 (ADR-0024 5번).
 *
 * `DescribeServices` 는 `aws ecs wait services-stable` 이 쓴다. **여러 서비스를 한 호출에
 * 넣을 때 권한 없는 서비스가 하나라도 섞이면 호출 전체가 거부된다** - 워크플로우는 그 역할에
 * 부여된 서비스만 한 호출에 넣어야 한다.
 *
 * `iam:PassRole` 과 `ecs:RegisterTaskDefinition` 은 **의도적으로 없다.**
 * `--force-new-deployment` 는 기존 태스크 정의 리비전을 그대로 재사용하므로 필요 없고,
 * 주면 CI 가 태스크에 임의 역할을 붙일 수 있어 권한 상승 경로가 된다.
 */
export const ECS_DEPLOY_ACTIONS: readonly string[] = [
  'ecs:UpdateService',
  'ecs:DescribeServices',
] as const;

/** 레포 하나가 한 환경에서 가질 권한의 대상. */
export interface DeployTarget {
  /** GitHub 레포 이름/ID. 역할 이름에는 name, 신뢰 정책 `sub` 에는 둘 다 들어간다. */
  readonly repo: GitHubRepository;
  /** push 를 허용할 ECR 레포 이름. `lib/common/config.ts` 의 `ECR_REPOS` 값이다. */
  readonly ecrRepos: readonly string[];
  /** 강제 재배포를 허용할 ECS 서비스 이름. 클러스터는 환경이 정한다. */
  readonly services: readonly string[];
}

/**
 * 레포 × 환경 -> 권한 대상. **역할 4개의 유일한 출처다** (ADR-0024 4번).
 *
 * **여기 없는 것은 의도적으로 없다.**
 *   - prod 파이프라인에 `authProxy` 가 없다: 운영에는 auth-proxy 가 아예 없다 (ADR-0023).
 *     넣으면 아무도 소비하지 않는 `prod` 태그 이미지를 밀 권한이 생기고, 그게 AGENTS.md
 *     3장이 금지하는 **죽은 계약**이다. prod 이관 시 함께 추가한다.
 *   - `clickhouse` 서비스가 어디에도 없다: 공개 이미지를 고정 태그로 쓰므로(ADR-0019)
 *     앱 레포가 재배포할 대상이 아니다.
 *
 * ECR 레포는 dev/prod 가 공유하므로(ADR-0021 5번) 두 환경의 ECR 목록은 같다. 갈리는 것은
 * ECS 서비스와 push 하는 **태그**이며, 태그는 IAM 조건으로 표현할 수 없다 - ECR 은 이미지
 * 태그 기반 조건 키를 제공하지 않는다.
 */
export const DEPLOY_TARGETS: Readonly<
  Record<DeployEnv, readonly DeployTarget[]>
> = {
  dev: [
    {
      repo: GITHUB_REPOS.pipeline,
      ecrRepos: [ECR_REPOS.postProcessor, ECR_REPOS.authProxy],
      services: [ECS_SERVICE_NAMES.collector, ECS_SERVICE_NAMES.authProxy],
    },
    {
      repo: GITHUB_REPOS.dashboard,
      ecrRepos: [ECR_REPOS.apiServer, ECR_REPOS.batchProcessor],
      services: [ECS_SERVICE_NAMES.dashboard],
    },
  ],
  prod: [
    {
      repo: GITHUB_REPOS.pipeline,
      ecrRepos: [ECR_REPOS.postProcessor],
      services: [ECS_SERVICE_NAMES.collector],
    },
    {
      repo: GITHUB_REPOS.dashboard,
      ecrRepos: [ECR_REPOS.apiServer, ECR_REPOS.batchProcessor],
      services: [ECS_SERVICE_NAMES.dashboard],
    },
  ],
} as const;

/**
 * cicd 배포별 가변값. context 키 1개에서만 온다.
 */
export interface CicdConfig {
  /**
   * 이미 존재하는 GitHub OIDC 공급자 ARN. 주면 새로 만들지 않고 참조만 한다.
   *
   * 계정에는 이 URL 의 공급자가 **하나만** 존재할 수 있어, 이미 있는 계정에서 무인자로
   * 배포하면 `EntityAlreadyExists` 로 스택이 통째로 롤백된다. `DeployStack` 을 destroy 한
   * 뒤(공급자는 RETAIN 이라 계정에 남는다) 재배포할 때도 이 키가 필요하다.
   *
   * 배포 전에 `aws iam list-open-id-connect-providers` 로 확인한다 (AGENTS.md 6장).
   */
  readonly githubOidcProviderArn?: string;
}

/**
 * CDK context 에서 cicd 설정을 로드한다.
 * context 키: githubOidcProviderArn.
 *
 *   npx cdk deploy --all -c env=cicd \
 *     -c githubOidcProviderArn=arn:aws:iam::<account>:oidc-provider/token.actions.githubusercontent.com
 */
export function loadCicdConfig(app: App): CicdConfig {
  return {
    githubOidcProviderArn: parseOidcProviderArn(
      app.node.tryGetContext('githubOidcProviderArn'),
    ),
  };
}

/**
 * OIDC 공급자 ARN 을 검증한다.
 *
 * **파싱 실패면 즉시 던진다.** `lib/dev/config.ts` 의 `parseAppAsgMaxCapacity` 와 같은
 * 방침이다. 조용히 흘려보내면 신뢰 정책의 `Federated` 주체가 존재하지 않는 ARN 이 되고,
 * **CloudFormation 은 IAM 주체 ARN 의 실존을 검증하지 않으므로** 스택 배포는 성공한 뒤
 * GitHub Actions 만 AssumeRole 에서 죽는다.
 *
 * 다른 발급자(예: `.../accounts.google.com`)를 잘못 넣는 것도 여기서 걸러진다.
 */
function parseOidcProviderArn(raw: unknown): string | undefined {
  const value = String(raw ?? '').trim();
  if (value.length === 0) {
    return undefined;
  }

  const expectedSuffix = `:oidc-provider/${GITHUB_OIDC_DOMAIN}`;
  if (!value.startsWith('arn:') || !value.endsWith(expectedSuffix)) {
    throw new Error(
      `githubOidcProviderArn 은 'arn:' 으로 시작하고 '${expectedSuffix}' 로 끝나야 한다: ${value}`,
    );
  }

  return value;
}
