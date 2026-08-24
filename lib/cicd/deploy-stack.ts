import {
  Arn,
  ArnFormat,
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  StackProps,
} from 'aws-cdk-lib/core';
import {
  IOidcProvider,
  OidcProviderNative,
  OpenIdConnectPrincipal,
  PolicyStatement,
  Role,
} from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import {
  DeployEnv,
  DEPLOY_ENVS,
  ECS_CLUSTER_NAMES,
} from '../common/deploy-targets';
import {
  buildGithubOidcSubject,
  CicdConfig,
  DeployTarget,
  DEPLOY_BRANCHES,
  DEPLOY_TARGETS,
  ECR_PUSH_ACTIONS,
  ECS_DEPLOY_ACTIONS,
  GITHUB_OIDC_AUDIENCE,
  GITHUB_OIDC_DOMAIN,
  GITHUB_OIDC_URL,
  GITHUB_ORG,
} from './config';

export interface DeployStackProps extends StackProps {
  readonly config: CicdConfig;
}

/**
 * 앱 레포의 GitHub Actions 가 맡을 배포 역할 스택 (ADR-0024).
 *
 * GitHub OIDC 공급자 1개 + 배포 역할 4개(레포 × 환경)를 만든다. 역할이 할 수 있는 일은
 * **이미지 push 와 서비스 강제 재배포 둘뿐**이며, 태스크 정의는 여전히 dev/prod 스택이
 * 소유한다 (ADR-0009).
 *
 * **이 스택은 `lib/prod/` 도 `lib/dev/` 도 import 하지 않는다.** 여기서 양쪽을 끌어오면
 * ADR-0021 2번의 `prod <-> dev` 금지 규칙이 이 폴더를 경유해 우회된다. 두 환경의 물리
 * 이름은 `lib/common/deploy-targets.ts` 에서만 온다.
 *
 * **CloudFormation 은 IAM 정책에 적힌 리소스 ARN 의 실존을 검증하지 않는다.** 여기 조립한
 * 클러스터/서비스 이름이 실제 스택과 어긋나도 배포는 전부 성공하고 GitHub Actions 만
 * AccessDenied 로 죽는다. `test/cicd/deploy-stack.test.ts` 의 크로스 스택 어서션이 유일한
 * 방어선이다.
 */
export class DeployStack extends Stack {
  /** 역할 이름 -> 역할. 테스트와 하위 참조를 위해 공개한다. */
  public readonly deployRoles: Readonly<Record<string, Role>>;

  constructor(scope: Construct, id: string, props: DeployStackProps) {
    super(scope, id, props);

    const oidcProvider = this.resolveOidcProvider(props.config);

    const roles: Record<string, Role> = {};
    for (const env of DEPLOY_ENVS) {
      for (const target of DEPLOY_TARGETS[env]) {
        const role = this.buildDeployRole(env, target, oidcProvider);
        roles[role.roleName] = role;
      }
    }

    this.deployRoles = roles;
  }

  /**
   * OIDC 공급자를 만들거나(기본) 기존 것을 참조한다.
   *
   * **계정에는 이 URL 의 공급자가 하나만 존재할 수 있다.** 이미 있는 계정에서 만들려 하면
   * `EntityAlreadyExists` 로 스택이 통째로 롤백되므로, `-c githubOidcProviderArn=` 로
   * 참조 모드로 전환한다. 배포 전에 `aws iam list-open-id-connect-providers` 로 확인한다.
   */
  private resolveOidcProvider(config: CicdConfig): IOidcProvider {
    if (config.githubOidcProviderArn) {
      return OidcProviderNative.fromOidcProviderArn(
        this,
        'GithubOidc',
        config.githubOidcProviderArn,
      );
    }

    return new OidcProviderNative(this, 'GithubOidc', {
      url: GITHUB_OIDC_URL,
      // 토큰의 `aud` 클레임과 대조되는 값. 비면 AssumeRoleWithWebIdentity 가
      // `IncorrectClientId` 로 거부되는데, synth 는 그대로 통과한다.
      clientIds: [GITHUB_OIDC_AUDIENCE],
      // **thumbprints 를 주지 않는 것은 의도다.** `ThumbprintList` 는 선택이고, 생략하면
      // IAM 이 상위 중간 CA 지문을 직접 조회해 쓴다. GitHub 은 Actions 인증서에 중간
      // 인증서 둘 중 하나를 돌려주므로 지문을 박아 두면 회전 시점에 인프라는 멀쩡한 채
      // Actions 만 죽는다. (ADR-0024 3번)
      //
      // RETAIN 인 이유: 이 공급자는 계정 전역 신뢰 앵커다. 이 스택을 지웠다고 함께
      // 지우면, 나중에 다른 역할이 이 공급자를 신뢰하게 되었을 때 그쪽이 조용히 끊긴다.
      // 대가로 스택 재배포 시 `-c githubOidcProviderArn` 이 필요해진다 (AGENTS.md 6장).
      removalPolicy: RemovalPolicy.RETAIN,
    });
  }

  /**
   * 레포 하나가 한 환경에 배포할 때 맡는 역할.
   *
   * 권한은 statement 3개뿐이다 - ECR 로그인 / 이미지 push / 서비스 강제 재배포.
   */
  private buildDeployRole(
    env: DeployEnv,
    target: DeployTarget,
    oidcProvider: IOidcProvider,
  ): Role {
    const branch = DEPLOY_BRANCHES[env];
    const clusterName = ECS_CLUSTER_NAMES[env];
    const constructId = `${toPascalCase(target.repo.name)}${toPascalCase(env)}DeployRole`;

    const role = new Role(this, constructId, {
      // **물리 이름을 명시한다.** 앱 레포 워크플로우의 `role-to-assume` 이 이 이름으로
      // 만든 ARN 을 쓴다. CFN 생성 이름으로 두면 스택을 재생성할 때마다 ARN 이 바뀌어
      // 앱 레포 설정을 손으로 갱신해야 한다.
      roleName: `github-deploy-${target.repo.name}-${env}`,
      // **영문으로 쓴다.** 이 레포는 주석과 문서를 한국어로 쓰지만, IAM 의 `Description` 은
      // Latin-1(` -ÿ`) 밖의 문자를 거부한다. 한국어를 넣으면 `cdk synth` 는
      // 경고만 내고 통과한 뒤 `cdk deploy` 가 실패한다.
      description: `Deploy role for ${GITHUB_ORG.name}/${target.repo.name} on branch ${branch} targeting ${env} (ADR-0024)`,
      // 워크플로우 한 번이 넘을 이유가 없는 상한. 토큰이 새더라도 노출 창을 좁힌다.
      maxSessionDuration: Duration.hours(1),
      assumedBy: new OpenIdConnectPrincipal(oidcProvider, {
        // **`StringLike` 가 아니라 `StringEquals` 다.** GitHub 문서의 예시처럼
        // `repo:org@org-id/repo@repo-id:*` 로 넓히면 PR 헤드 브랜치와 태그를 포함한 모든 ref 가
        // 이 역할을 맡을 수 있어, develop -> dev / main -> prod 분리가 통째로 사라진다.
        // 즉 "PR 을 열 수 있는 사람 = 운영에 배포할 수 있는 사람"이 된다. (ADR-0024 2번)
        StringEquals: {
          [`${GITHUB_OIDC_DOMAIN}:aud`]: GITHUB_OIDC_AUDIENCE,
          [`${GITHUB_OIDC_DOMAIN}:sub`]: buildGithubOidcSubject(
            target.repo,
            branch,
          ),
        },
      }),
    });

    role.addToPolicy(
      new PolicyStatement({
        sid: 'EcrAuth',
        actions: ['ecr:GetAuthorizationToken'],
        // 이 액션은 **리소스 수준 권한을 지원하지 않는다.** 좁히려는 시도는 조용히 전부
        // 거부된다. `*` 가 강제되므로 이 statement 에 다른 액션을 얹지 않는다.
        resources: ['*'],
      }),
    );

    role.addToPolicy(
      new PolicyStatement({
        sid: 'EcrPush',
        actions: [...ECR_PUSH_ACTIONS],
        resources: target.ecrRepos.map((name) =>
          Arn.format(
            {
              service: 'ecr',
              resource: 'repository',
              resourceName: name,
              arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
            },
            this,
          ),
        ),
      }),
    );

    role.addToPolicy(
      new PolicyStatement({
        sid: 'EcsForceDeploy',
        actions: [...ECS_DEPLOY_ACTIONS],
        resources: target.services.map((service) =>
          Arn.format(
            {
              service: 'ecs',
              resource: 'service',
              // 장문 ARN 형식 `service/<cluster>/<service>`. CDK 피처 플래그
              // `@aws-cdk/aws-ecs:arnFormatIncludesClusterName` 이 같은 가정을 공유한다.
              // 계정이 단문 형식이면 매칭되지 않으므로 배포 후 실제 serviceArn 을 눈으로
              // 확인한다 (AGENTS.md 6장 런북).
              resourceName: `${clusterName}/${service}`,
              arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
            },
            this,
          ),
        ),
      }),
    );

    // 앱 레포 워크플로우의 `role-to-assume` 에 그대로 들어가는 값 (PROJ-65 핸드오프).
    new CfnOutput(this, `${constructId}Arn`, {
      value: role.roleArn,
      description: `${GITHUB_ORG.name}/${target.repo.name} @ ${branch} -> cluster ${clusterName}`,
    });

    return role;
  }
}

/** `ai-telemetry-pipeline` -> `AiTelemetryPipeline`. construct ID 조립용. */
function toPascalCase(value: string): string {
  return value
    .split('-')
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}
