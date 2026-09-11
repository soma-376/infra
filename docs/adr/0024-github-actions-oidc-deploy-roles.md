# 0024. GitHub Actions 배포 - 레포×환경 4개 OIDC 역할과 ECS 물리 이름 고정

## Status

Accepted — 부분 대체: [ADR 0026](0026-dev-backend-deployment-units-and-staged-migration.md)이 dev backend의
배포 대상을 `enrollment-api`·`telemetry-ingest`로 바꾸고, 기존 pipeline dev 역할은 신뢰 정책과 output만
유지한 채 permission statement를 0개로 만든다. 역할 4개 구조, prod 대상, OIDC 신뢰 경계와
`iam:PassRole`·태스크 정의 등록 금지는 그대로 유효하다.

## Context

인프라는 구축되어 있지만 **앱 배포가 수동이다.** `develop` 병합 후 누군가 손으로 이미지를
빌드해 ECR에 올리고 ECS 태스크를 갱신해야 한다(PROJ-48). 이 ADR은 그 배포를 각 앱 레포의
GitHub Actions가 수행하도록 **AWS 쪽 권한**을 정한다. 워크플로우 파일 자체는 앱 레포의
몫이다([ADR-0009](0009-single-infra-repo-stack-boundary.md)의 레포 경계, PROJ-65).

워크플로우가 하는 일은 두 가지뿐이다.

1. 이미지를 빌드해 ECR에 push
2. `aws ecs update-service --force-new-deployment`으로 서비스를 강제 재배포

태스크 정의는 CDK가 소유하므로 워크플로우가 새로 등록하지 않는다. 태스크 정의의 이미지 URI가
**가변 태그**를 가리키고, 강제 재배포가 그 태그를 다시 당겨오는 구조다.

이 레포에는 현재 IAM 코드가 사실상 없다. `AmazonSSMManagedInstanceCore` 관리형 정책 부착과
`grantReadWrite` 두 종류가 전부이고, 역할·신뢰 정책·OIDC 공급자는 하나도 없다.

여기에 **막고 있는 것**이 하나 있다. ECS 클러스터와 서비스에 물리 이름이 없다 -
`lib/prod/application-stack.ts`의 `new Cluster(this, 'Cluster', { vpc })`처럼 `clusterName`을
주지 않아 CloudFormation이 `ApplicationStack-Cluster<해시>` 형태로 만든다. 그 결과

- 워크플로우가 `--cluster` / `--service`에 넣을 값이 **존재하지 않는다.**
- IAM 정책의 `Resource`를 서비스 ARN으로 좁힐 수 없다. ARN이
  `arn:aws:ecs:<region>:<account>:service/<클러스터>/<서비스>` 형식이라 **두 조각 모두**
  합성 시점에 확정되지 않으면 `service/*/*` 와일드카드밖에 못 쓴다.

`AGENTS.md` 6장은 이미 `aws ecs update-service --cluster <cluster> --service <service>`를
적어 두었지만, 그 `<...>`를 채울 값이 어디에도 없다.

권한 경계를 **스택 ID로 표현할 수도 없다.** dev와 prod는 같은 계정·같은 리전에 살고 스택 ID
접두사로만 갈리는데([ADR-0021](0021-dev-prod-environment-separation.md) 3번), IAM은 어떤
CloudFormation 스택이 리소스를 만들었는지로 권한을 나눌 수 없다.

마지막으로 ADR-0021 5번이 남긴 Negative가 있다.

> dev/prod가 같은 ECR 레포를 공유하므로 dev용 이미지 push가 운영 태그를 덮어쓸 여지가
> 남는다. 특히 dev 기본 태그가 `latest`인데 운영이 같은 태그를 쓰면 dev 빌드가 곧 운영
> 이미지가 된다. 방어선은 인프라가 아니라 **태그 규율**뿐이며 (...)

지금 그 태그 규율의 주체(CI)가 생긴다. 규율을 세울 자리가 여기다.

**2026-08-24 정정.** GitHub는 2026-07-15 이후 생성된 저장소의 기본 OIDC `sub`를
조직/저장소 이름만 쓰는 형식에서 **이름과 immutable ID를 함께 쓰는 형식**으로 바꿨다.
`ai-telemetry-pipeline`은 2026-07-23, `pulsemetry-backend`는 2026-08-06 생성이라 둘 다 새
형식 대상이다. name-only 조건으로 배포한 결과 synth·test·CloudFormation 배포는 모두
성공했지만 GitHub Actions가 `Not authorized to perform sts:AssumeRoleWithWebIdentity`로
실패했다. 이 정정은 역할/권한 경계를 바꾸는 새 결정이 아니라 외부 발급자의 실제 토큰 형식에
기존 결정을 맞추는 변경이다.

## Decision

### 1. 새 최상위 환경 `cicd`

`bin/infra.ts`에 세 번째 분기 `-c env=cicd`를 추가하고 `lib/cicd/app.ts`의 `synthCicd()`가
`DeployStack` 하나를 조립한다. **기본값은 여전히 `prod`다.**

배포 역할을 `lib/prod/`에도 `lib/dev/`에도 둘 수 없기 때문이다.

- OIDC 공급자는 **URL당 계정에 하나**다. `lib/prod/`에 두면 `lib/dev/`가 그걸 참조해야 하고,
  그 순간 `dev → prod` import가 생겨 ADR-0021 2번이 깨진다. 반대도 같다.
- 역할 4개 중 둘은 dev 클러스터 ARN을, 둘은 prod 클러스터 ARN을 참조한다. 어느 한쪽 폴더에
  두면 그 폴더가 반대편 환경의 물리 이름을 알아야 한다.

의존 방향은 **`cicd → common` 단방향**이다. `lib/cicd/`는 `lib/prod/`도 `lib/dev/`도 import
하지 않는다 - 여기서 양쪽을 끌어오면 `prod ↔ dev` 금지 규칙이 이 폴더를 경유해 우회된다.
두 환경의 물리 이름은 `lib/common/deploy-targets.ts`에서만 온다.

부수 효과로 **IAM 변경이 앱 인프라 배포에 섞이지 않는다.** `cdk deploy --all`(무인자 = prod)은
`DeployStack`을 앱 트리에 담지 않으므로 건드리지 않고, `-c env=cicd`로 `--all`을 돌려도 운영
4-스택은 조립되지 않는다. 이건 우연이 아니라 얻고 싶었던 성질이다.

### 2. 장기 액세스 키를 만들지 않는다 - GitHub OIDC

GitHub Actions가 `token.actions.githubusercontent.com`이 발급한 토큰으로
`sts:AssumeRoleWithWebIdentity`를 호출해 역할을 가져간다. IAM 사용자도, GitHub Secrets에 넣을
액세스 키도 만들지 않는다.

신뢰 정책의 조건은 두 개이며 **둘 다 `StringEquals`(완전 일치)** 다.

| 조건 키 | 값 |
|---|---|
| `token.actions.githubusercontent.com:aud` | `sts.amazonaws.com` |
| `token.actions.githubusercontent.com:sub` | `repo:soma-376@297555253/<레포>@<레포-ID>:ref:refs/heads/<브랜치>` |

GitHub 조직/저장소 ID는 `lib/cicd/config.ts`의 `GITHUB_ORG` / `GITHUB_REPOS`에 이름과 함께
고정하고 `buildGithubOidcSubject()`가 위 형식을 조립한다. ID는 숫자 연산 대상이 아닌 외부
식별자이므로 문자열로 보존한다.

**`sub`에 와일드카드를 쓰지 않는 것이 이 결정의 핵심이다.** immutable prefix 뒤에
`StringLike` + `*`를 붙이면 그 레포의 **모든 ref** - PR 헤드 브랜치와 태그를 포함해 - 가 이
역할을 가져갈 수 있게 된다. 그러면 "PR을 열 수 있는 사람 = 운영에 배포할 수 있는 사람"이 된다.
`develop`→dev / `main`→prod 분리를 실제로 강제하는 것은 `StringEquals` 하나뿐이다.

브랜치를 추가하려면 `DEPLOY_BRANCHES`를 고쳐야 한다. 그 마찰은 의도된 것이다.

### 3. OIDC 공급자는 `OidcProviderNative`, thumbprint는 주지 않는다

| | `OpenIdConnectProvider` | `OidcProviderNative` |
|---|---|---|
| CFN 리소스 | `AWS::CloudFormation::CustomResource` | `AWS::IAM::OIDCProvider` |
| 딸려오는 것 | Lambda 함수 + 실행 역할 + 에셋 스테이징 | 없음 |
| CDK 소스의 안내 | "DO NOT ADD NEW FEATURES TO THIS CONSTRUCT ... use `OidcProviderNative` instead" | 권장 |

**`OidcProviderNative`를 쓴다.** 이 레포에는 현재 Lambda가 하나도 없다. 커스텀 리소스를 들이면
에셋 스테이징 의존, Node 런타임 EOL 주기에 끌려다니는 유지보수, 배포 실패 시 CloudWatch를
뒤져야 하는 진단 경로가 통째로 새로 생긴다. `cdk.json`이 이미
`"@aws-cdk/aws-eks:useNativeOidcProvider": true`를 켜 둔 것과도 방향이 같다.

**`thumbprints`를 주지 않는다.** `AWS::IAM::OIDCProvider`의 `ThumbprintList`는 `Required: No`이며,
생략하면 IAM이 상위 중간 CA 지문을 직접 조회해 사용한다. GitHub은 Actions 인증서에 대해 중간
인증서 둘 중 하나를 돌려주므로, 지문 하나를 박아두면 **회전 시점에 인프라는 멀쩡한 채 Actions만
죽는다.** 이 레포가 가장 싫어하는 "synth·test·deploy 전부 통과, 런타임만 죽음" 클래스다.

**`RemovalPolicy.RETAIN`을 건다.** 이 공급자는 계정 전역 신뢰 앵커다. `DeployStack`을 지웠다고
함께 지우면, 나중에 다른 역할이 이 공급자를 신뢰하게 되었을 때 그쪽이 조용히 끊긴다.
대가로 스택을 파괴한 뒤 재배포할 때 `-c githubOidcProviderArn`이 필요해진다.

그래서 컨텍스트 키 **`githubOidcProviderArn`** 을 둔다. 주면 만들지 않고 ARN을 참조만 한다.
값의 형식이 틀리면 **즉시 던진다** - 조용히 흘려보내면 신뢰 정책의 `Federated` 주체가 존재하지
않는 ARN이 되고, CloudFormation은 IAM 주체 ARN의 실존을 검증하지 않으므로 **스택 배포는 성공한
뒤 GitHub Actions만 AssumeRole에서 죽는다.**

### 4. 역할은 레포 × 환경 4개

| 역할 이름 | 신뢰하는 `sub` | ECR push 대상 | ECS 강제 재배포 대상 |
|---|---|---|---|
| `github-deploy-ai-telemetry-pipeline-dev` | `repo:soma-376@297555253/ai-telemetry-pipeline@1309872274:ref:refs/heads/develop` | `soma-376/post-processor`, `soma-376/auth-proxy` | `soma-376-dev/collector`, `soma-376-dev/auth-proxy` |
| `github-deploy-ai-telemetry-pipeline-prod` | `repo:soma-376@297555253/ai-telemetry-pipeline@1309872274:ref:refs/heads/main` | `soma-376/post-processor` | `soma-376-prod/collector` |
| `github-deploy-pulsemetry-backend-dev` | `repo:soma-376@297555253/pulsemetry-backend@1325324450:ref:refs/heads/develop` | `soma-376/api-server`, `soma-376/batch-processor` | `soma-376-dev/dashboard` |
| `github-deploy-pulsemetry-backend-prod` | `repo:soma-376@297555253/pulsemetry-backend@1325324450:ref:refs/heads/main` | `soma-376/api-server`, `soma-376/batch-processor` | `soma-376-prod/dashboard` |

**레포당 하나가 아니라 레포 × 환경인 이유**는 dev 잡이 운영 서비스를 강제 업데이트할 경로
자체를 없애기 위해서다. 역할 하나가 두 환경을 다 들면 dev 워크플로우의 버그나 `develop`에
머지된 잘못된 스크립트가 운영을 재배포할 수 있다. 그건 리뷰로 막는 종류의 위험이 아니다.

**역할 이름을 물리 이름으로 고정한다.** 앱 레포 워크플로우의 `role-to-assume`이 이 이름을
그대로 쓴다. CFN 생성 이름으로 두면 스택을 재생성할 때마다 ARN이 바뀌어 앱 레포 설정을 손으로
갱신해야 한다.

**의도적으로 비어 있는 것**

- **prod 파이프라인 역할에 `auth-proxy`가 없다.** auth-proxy는
  [ADR-0023](0023-dev-auth-proxy-between-alb-and-collector.md)에 따라 **dev에만** 존재한다.
  없는 서비스의 ARN을 넣으면 `AGENTS.md` 3장이 금지하는 **죽은 계약**이 되고, 아무도 소비하지
  않는 `prod` 태그 이미지를 밀 권한이 생긴다.
- **`clickhouse` 서비스가 어디에도 없다.** 공개 이미지를 고정 태그로 쓰므로
  ([ADR-0019](0019-clickhouse-container-runtime-contract.md)) 앱 레포가 재배포할 대상이 아니다.

ECR 레포는 dev/prod가 공유하므로(ADR-0021 5번) 두 환경 역할의 ECR 리소스는 같다. 갈리는 것은
ECS 서비스 ARN과 push하는 **태그**이며, **태그는 IAM 조건으로 표현할 수 없다** - ECR은 이미지
태그 기반 조건 키를 제공하지 않는다. 즉 태그 분리는 여전히 규율이지 강제가 아니다.

### 5. 권한은 위 두 동작만 덮는다

역할마다 statement 세 개다.

| Sid | 액션 | 리소스 |
|---|---|---|
| `EcrAuth` | `ecr:GetAuthorizationToken` | `*` |
| `EcrPush` | `ecr:BatchCheckLayerAvailability`, `InitiateLayerUpload`, `UploadLayerPart`, `CompleteLayerUpload`, `PutImage`, `BatchGetImage` | 그 레포가 실제로 만드는 이미지의 ECR 레포 ARN만 |
| `EcsForceDeploy` | `ecs:UpdateService`, `ecs:DescribeServices` | 그 환경의 그 서비스 ARN만 |

`ecr:GetAuthorizationToken`은 **리소스 수준 권한을 지원하지 않아** `*`가 강제된다. 좁히려는
시도는 조용히 전부 거부된다. 그래서 이 statement에는 **다른 액션을 얹지 않는다.**

`ecs:DescribeServices`는 `aws ecs wait services-stable`이 쓴다.

`Repository.grantPullPush()`로 대체하지 않는다. 액션 목록이 CDK 버전에 따라 조용히 바뀌는
암묵 계약이 되어, ADR과 테스트에 "무엇을 허용했는지" 적을 수가 없다.

`BatchGetImage`는 읽기 액션이지만 순수 `docker buildx build --push`의 manifest push
과정에서도 호출되므로 `EcrPush`에 포함한다. `GetDownloadUrlForLayer`는 주지 않는다.
**워크플로우가 `--cache-from type=registry`를 쓰기 시작하면 그 액션이 추가로 필요해진다** -
그때 나올 `AccessDenied`가 미스터리가 되지 않도록 여기와 `AGENTS.md`의 배포 계약 절에
알려진 스위치로 적어 둔다.

**명시적으로 주지 않는 것과 그 이유**

| 액션 | 왜 안 주는가 |
|---|---|
| `iam:PassRole` | `--force-new-deployment`는 서비스의 **기존 태스크 정의 리비전을 그대로 재사용**한다. 역할을 넘기는 API 호출이 없다. 주면 CI가 임의의 passable role을 태스크에 붙일 수 있어 계정 안에서 사실상 권한 상승 경로가 된다 |
| `ecs:RegisterTaskDefinition` | 주면 CI가 이미지·환경변수·시크릿 ARN·태스크 역할을 바꿀 수 있어 ADR-0009(태스크 정의는 이 레포 경유)가 무너진다. 게다가 CI가 등록한 리비전은 다음 `cdk deploy`가 조용히 되돌린다 |
| `ecs:DescribeTaskDefinition` | `render-task-definition` 방식에서만 필요하다. 이 워크플로우는 태스크 정의를 읽지 않는다 |
| `ecs:ListServices`, `ecs:DescribeClusters` | 이름을 이미 알고 들어간다. 클러스터 스코프 권한이 추가로 필요해진다 |

### 6. ECS 클러스터와 서비스에 물리 이름을 준다

| 환경 | 클러스터 이름 | 서비스 이름 |
|---|---|---|
| prod | `soma-376-prod` | `collector`, `dashboard`, `clickhouse` |
| dev | `soma-376-dev` | `collector`, `dashboard`, `clickhouse`, `auth-proxy` |

**클러스터 이름만 환경별로 갈린다.** 클러스터 이름은 계정 + 리전에서 유일해야 하고 두 환경이
같은 계정에 산다(ADR-0021 Constraints). 반면 **서비스 이름의 유일성 범위는 클러스터 안**이라
dev와 prod가 같은 이름을 쓸 수 있다. 그래서 그렇게 한다 - 앱 레포 워크플로우가 `--cluster`
하나만 갈아끼우면 환경이 갈리고, 환경별로 다른 서비스 이름을 알 필요가 없다.

prod의 공통 태그는 `Env: 'mvp'`인데 클러스터 이름은 `prod`다. **의도된 불일치다.** 태그 값을
바꾸면 App 스코프 전파로 전 리소스에 태그 diff가 생기므로 그대로 두고(ADR-0021 4번), 운영자가
읽는 이름 쪽만 명확하게 쓴다. Cost Explorer에서는 여전히 `Env=mvp`가 운영이다.

이 이름들의 단일 출처는 **`lib/common/deploy-targets.ts`** 다. `lib/prod/`, `lib/dev/`,
`lib/cicd/` 세 곳이 같은 문자열을 봐야 하는데 `prod ↔ dev` import가 금지되어 있으므로
공유 가능한 위치는 `common/`뿐이다.

ADR-0021의 배치 규칙("dev에서 달라야 할 이유가 없으면 `common/`")만 보면 클러스터 이름은
환경별 값이니 각 환경 폴더 행이다. **그러나 이 경우는 규칙의 전제가 다르다 - 소비자가 셋이다.**
각 환경 폴더에 두면 `lib/cicd/`가 `lib/prod/`와 `lib/dev/`를 둘 다 import 해야 하고, 그게 바로
규칙이 막으려던 커플링이다. **값은 환경별이되 "환경 → 값" 매핑 자체는 환경 무관 계약**이라는
근거로 `common/`에 둔다. 이건 명시적 예외이며, 그래서 `lib/common/config.ts`에 섞지 않고
**별도 파일**로 격리한다.

반대로 GitHub org·레포·브랜치·`DEPLOY_TARGETS`는 **소비자가 `lib/cicd/` 하나뿐**이므로
`common/`에 두지 않는다(`AGENTS.md` 4장의 "`common/`이 커지면 예전 `lib/config.ts`가
재현된다" 경고).

### 7. 이미지 태그를 환경별로 고정한다

| 환경 | 태그 | 위치 |
|---|---|---|
| dev | `dev` | `lib/dev/config.ts`의 `DEV_DEFAULT_IMAGE_TAG` (`-c devImageTag=`로 오버라이드 가능) |
| prod | `prod` | `lib/prod/config.ts`의 `PROD_IMAGE_TAG` (**오버라이드 없음**) |

이것이 위 Context가 인용한 ADR-0021 5번의 Negative를 닫는다. 두 환경이 같은 ECR 레포를
공유해도 서로 다른 태그를 읽으므로, dev 빌드가 곧 운영 이미지가 되는 경로가 사라진다.

**prod에는 컨텍스트 오버라이드를 만들지 않는다.**

1. ADR-0021이 정한 prod의 손잡이는 edge 관련 셋뿐이다. `-c prodImageTag=...`는 리뷰 흔적 없이
   임의 태그를 운영에 밀어 넣는 경로를 만들어, "dev/prod는 태그로만 갈린다"는 방어선을 CLI
   플래그 하나로 무력화한다.
2. dev의 `devImageTag`는 PR 태그 실험(`-c devImageTag=pr-42`)이라는 구체적 용도가 있다.
   prod에는 대응되는 용도가 없다. 대칭성 자체는 이 레포에서 가치가 아니다.
3. 운영 롤백은 인프라 재합성이 아니라 ECR에서 `prod` 태그를 이전 매니페스트에 다시 붙이고
   force-new-deployment 하는 절차다.

## Constraints

### Cluster 교체는 in-place 불가이고, Service 교체는 이름 변화에 따라 다르다

`clusterName`과 `serviceName`은 `AWS::ECS::Cluster` / `AWS::ECS::Service`에서 **교체 유발
속성**이다. 이미 배포된 스택에 이름을 추가하면 교체가 일어난다.

**결정적 사실은 ASG 런치 템플릿의 user data다.** 합성 산출물을 보면 마지막 조각이
`{"Ref":"Cluster..."}` + `' >> /etc/ecs/ecs.config'`다. 즉 **컨테이너 인스턴스가 어느
클러스터에 등록될지는 부팅 시 user data로 결정된다.** 따라서 클러스터를 교체하면

- 새 클러스터가 생기지만 **컨테이너 인스턴스가 0대**다. 기존 인스턴스는 여전히 옛 클러스터에
  등록돼 있고, 런치 템플릿의 새 버전은 다음 인스턴스 기동 때나 적용된다(instance refresh 미설정).
- EC2 launch type 서비스(prod `clickhouse`, dev 4개 전부)가 새 클러스터에 생성되지만 배치 가능한
  인스턴스가 없어 **steady state에 영원히 도달하지 못한다** → CFN이 안정화 대기하다 실패 → 롤백.
- 설령 용량이 있었더라도 **옛 클러스터 삭제가 실패한다.** `DeleteCluster`는 활성 서비스나 등록된
  컨테이너 인스턴스가 있으면 거부된다.
- 부분 생성된 ECS 서비스 + 클러스터의 롤백은 `UPDATE_ROLLBACK_FAILED`로 이어지기 쉽다.

prod의 Fargate 서비스 둘만 놓고 보면 교체가 깔끔하지만, 같은 스택 안에 ClickHouse `Ec2Service`가
있어 전체가 함께 롤백된다.

**따라서 Cluster가 Replacement면 in-place 업데이트를 시도하지 않는다. `ApplicationStack`을
파괴하고 재배포한다.** 이 절차의 전면 중단과 ClickHouse 로컬 EBS 손실은 Cluster 교체 때문에
발생하는 대가다.

Cluster가 유지되고 `AWS::ECS::Service`만 Replacement인 경우에는 `ServiceName` 전후 값을
추가로 비교한다.

- **`ServiceName`이 유지된 채 다른 속성이 교체를 유발하면** CloudFormation은 기존 서비스를
  지우기 전에 같은 클러스터에 같은 이름의 새 서비스를 만들므로 생성이 실패한다. 이 경우도
  in-place 업데이트를 하지 않고, 기존 서비스를 먼저 없애는 change-specific
  delete-before-create 절차를 별도로 세운다.
- **`ServiceName` 자체가 다른 고유 이름으로 바뀌거나 새로 지정되면** 동일 이름 충돌은 없다.
  Cluster도 유지되므로 새 클러스터의 인스턴스가 0대가 되는 문제도 없다. 다만 서비스 교체에
  필요한 호스트 용량을 확인하고, 이름 계약의 소비자인 `lib/common/deploy-targets.ts`, IAM ARN,
  앱 레포 워크플로우를 같은 변경에서 함께 갱신해야 한다.
- Cluster와 Service 모두 Replacement가 아니면 일반 업데이트다.

판정은 속성 이름을 추측하는 대신 `cdk diff`에서 Cluster Replacement를 먼저 확인하고, Cluster가
유지될 때만 Service Replacement와 `ServiceName` 전후 값을 확인한다. 현재 물리 이름 최초 도입은
Cluster Replacement이므로 `AGENTS.md` 6장의 전체 스택 파괴·재배포 런북을 따른다.

### 파괴 범위는 `ApplicationStack` 하나로 끝난다

합성 매니페스트상 의존은 **`ApplicationStack → EdgeStack`** 이다(역방향이 아니다). ECS 서비스의
`LoadBalancers.TargetGroupArn`이 `Fn::GetStackOutput`으로 `EdgeStack`을 가리키고, 크로스 스택
참조 모드가 `"@aws-cdk/core:defaultCrossStackReferences": "weak"`라 **CFN Export 잠금이 없다.**

그래서 `ApplicationStack` 하나만 파괴·재생성할 수 있고 `EdgeStack`(ALB·리스너·타깃 그룹·
Cognito·CloudFront·프론트엔드 S3)은 그대로 남는다. **ALB DNS 이름이 보존된다.** 타깃 그룹만
잠시 빈다. `NetworkStack`(VPC·SG)과 `DataStack`(Aurora/RDS·시크릿·S3)도 건드리지 않는다.

함께 잃는 것: ClickHouse `/data/clickhouse`(호스트 EBS와 함께 소멸,
[ADR-0006](0006-accept-local-ebs-durability-for-mvp.md)이 이미 수용한 리스크), 로그 그룹
(`RemovalPolicy.DESTROY`), Cloud Map `obs.local` 네임스페이스(같은 이름으로 재생성).

절차는 `AGENTS.md` 6장에 런북으로 남긴다.

### 그 밖의 제약

- **태그 전환 순서.** ECR의 `:dev` / `:prod` 태그에 이미지가 없으면 `cdk synth`도 `npm test`도
  통과하고 **태스크 기동에서만** `CannotPullContainerError` 재시도 루프로 죽는다.
  [ADR-0007](0007-precreate-ecr-outside-cdk.md)의 기존 함정과 같은 모양이며, 방어선은 런북의
  순서(태그 push가 배포보다 먼저)뿐이다.
- **`sub` 클레임 형태.** 워크플로우가 GitHub Environment를 쓰면 `sub`가
  `repo:org@org-id/repo@repo-id:environment:<name>`이 되고, PR 트리거면 `:pull_request`, 태그
  트리거면 `:ref:refs/tags/x`가 된다. 어느 경우든 신뢰 조건과 불일치해
  `AssumeRoleWithWebIdentity`가 거부되며, **인프라 쪽에는 아무 신호도 남지 않는다.** 코드로
  막을 수 없으므로 배포 계약 문서에 적는다.
- **GitHub 조직/저장소 ID는 자동 조회하지 않는다.** synth 시 GitHub API에 의존하면 네트워크와
  인증 상태에 따라 같은 커밋의 템플릿이 달라진다. 새 배포 저장소를 추가할 때 아래 API로 현재
  ID와 subject prefix를 확인한 뒤 `lib/cicd/config.ts`에 명시적으로 기록한다.

  ```bash
  gh api repos/soma-376/<repo> --jq '{id, owner_id: .owner.id, created_at}'
  gh api repos/soma-376/<repo>/actions/oidc/customization/sub
  ```
- **IAM 리소스 ARN이 ECS 장문 형식을 전제한다.** `service/<cluster>/<service>`이며, CDK 피처
  플래그 `@aws-cdk/aws-ecs:arnFormatIncludesClusterName`이 같은 가정을 공유한다. 계정이 단문
  형식이면 매칭되지 않으므로 배포 후 `serviceArn`을 육안 확인한다.
- **`ecs:DescribeServices`를 여러 서비스로 한 번에 호출할 때**, 권한 없는 서비스가 하나라도
  섞이면 **호출 전체가** 거부된다. 워크플로우는 부여된 서비스만 한 호출에 넣어야 한다.

## Alternatives Considered

- **IAM 사용자 + 액세스 키를 GitHub Secrets에 저장.** 가장 단순하지만 만료 없는 자격증명이
  깃허브에 상주하고, 회전 주체가 없으면 영원히 돌지 않는다. 기각.
- **레포당 역할 1개(총 2개).** 워크플로우가 단순해지지만 dev 잡이 운영 서비스를 강제
  업데이트할 수 있다. 기각.
- **환경당 역할 1개(총 2개, 두 레포 공유).** "레포별로"라는 요구와 어긋나고, 파이프라인 레포의
  잡이 대시보드 이미지를 덮어쓸 수 있다. 기각.
- **`sub` 조건에 `StringLike` + `repo:soma-376@297555253/<레포>@<레포-ID>:*`.** 브랜치 추가가
  자유롭지만, PR 헤드를 포함한 모든 ref가 배포 권한을 갖는다. 기각.
- **GitHub Environment 기반 조건(`repo:...:environment:prod`).** 승인 게이트를 GitHub에 둘 수
  있어 더 강한 통제가 가능하다. 그러나 앱 레포에 Environment 설정이 선행되어야 하고 이 레포는
  그걸 강제할 수 없다(ADR-0009와 같은 종류의 레포 경계 문제). 브랜치 조건으로 시작한다.
- **클러스터 이름을 CFN 생성값으로 두고 IAM에 `service/*/collector` 와일드카드.** 리소스 교체를
  피할 수 있어 매력적이다. 그러나 (a) 계정 내 임의 클러스터의 동명 서비스에 도달하고
  (b) 워크플로우가 써야 할 클러스터 이름이 코드 밖 GitHub 변수로만 존재해 조용히 낡는다. 기각.
- **자동 생성 이름 + SSM 파라미터로 export.** 위와 같은 (a)를 남기면서 워크플로우에 조회 단계와
  그 권한이 늘고, 운영자가 콘솔에서 이름을 읽을 수 없다. 기각.
- **태그로 서비스를 조회.** 계정 전역 `ecs:ListServices` 권한이 필요해져 최소권한이 무너진다. 기각.
- **`OpenIdConnectProvider`(커스텀 리소스).** CDK 소스가 직접 "새 기능을 추가하지 말고
  `OidcProviderNative`를 쓰라"고 안내한다. Lambda와 그 실행 역할이 딸려온다. 기각.
- **thumbprint를 명시적으로 고정.** 재현성이 좋아 보이지만 GitHub의 인증서 회전 때 Actions만
  죽는다. 기각.
- **역할을 `lib/prod/` 또는 `lib/dev/`에 배치.** 새 폴더가 생기지 않아 가벼워 보이지만 반대편
  환경 이름을 참조해야 해서 ADR-0021 2번을 뚫는다. 기각.
- **새 이름으로 두 번째 ApplicationStack을 병렬 배포 후 전환(블루/그린).** 같은 VPC에 `obs.local`
  private DNS 네임스페이스가 둘일 수 없어 애초에 성립하지 않는다. 기각.
- **`cdk import`로 이름 바꾼 리소스 흡수.** ECS 클러스터/서비스는 이름 변경 자체가 불가능하다.
  어떤 경로든 생성 + 삭제다. 기각.
- **`ecs:RegisterTaskDefinition`을 허용하고 `render-task-definition` 방식 사용.** 워크플로우가
  이미지 URI를 직접 갈아끼우는 흔한 패턴이지만, 태스크 정의 소유권이 두 레포로 쪼개져 ADR-0009가
  무너지고 다음 `cdk deploy`가 조용히 되돌린다. 기각.

## Consequences/Tradeoffs

### Positive

- **깃허브에 상주하는 AWS 자격증명이 없다.** 유출면이 잡 수명(최대 1시간)으로 줄어든다.
- **권한 경계가 템플릿에 드러난다.** 각 역할의 `Resource` 배열이 "이 레포의 이 브랜치가 건드릴
  수 있는 것의 전부"이며, `test/cicd/`가 그 경계를 네거티브 어서션으로 고정한다.
- **물리 이름이 코드의 단일 출처가 된다.** 워크플로우가 코드 밖 GitHub 변수에 의존하지 않고,
  운영자가 콘솔·CLI·`AGENTS.md`에서 같은 이름을 본다.
- **dev 빌드가 운영 이미지가 되는 경로가 닫힌다**(위 7번). ADR-0021의 Negative 하나가 해소된다.
- **IAM 변경과 앱 인프라 변경이 서로 다른 `cdk deploy`에 속한다.**

### Negative

- **일회성 전면 교체가 필요하다.** `ApplicationStack`이 파괴·재생성되고 ClickHouse 데이터를
  잃는다. `EdgeStack`을 건드리지 않아 ALB DNS는 지켜지지만 공짜는 아니다.
- **`cdk deploy --all`이 세 환경을 한 번에 다루지 않는다.** 배포 순서가 코드가 아니라 문서에만
  강제된다.
- **태그 규율은 여전히 강제되지 않는다.** ECR에 이미지 태그 기반 IAM 조건 키가 없으므로, dev
  역할이 `:prod` 태그를 push하는 것을 인프라가 막을 수 없다. 방어선은 앱 레포 워크플로우이며,
  이 레포는 그걸 강제할 수 없다(ADR-0007·ADR-0009와 같은 종류의 레포 경계 문제).
- **브랜치 전략에 결합된다.** `develop` / `main` 이름이 IAM 신뢰 정책 안으로 들어간다. 앱 레포가
  브랜치 이름을 바꾸면 배포가 `AccessDenied`로 죽고, 원인이 앱 레포가 아니라 이 레포에 있다.
- **`lib/common/`에 환경을 키로 갖는 맵이 들어온다.** 별도 파일로 격리했지만 "common은 환경
  무관"이라는 문장이 더는 폴더 전체에 대해 무조건 참이 아니다.
- **환경이나 레포가 늘면 역할이 곱으로 늘어난다.** 3환경 × 3레포면 9개다. 지금은
  `DEPLOY_TARGETS` 한 곳만 고치면 되지만, 수가 커지면 재검토가 필요하다.
- **`DeployStack`을 파괴한 뒤 재배포하려면 컨텍스트 키가 필요하다.** OIDC 공급자가 RETAIN이라
  남아 있어 무인자 재배포는 `EntityAlreadyExists`로 죽는다.

## Follow-up

- **auth-proxy를 prod로 이관할 때** `DEPLOY_TARGETS`의 prod 파이프라인 항목에 auth-proxy ECS
  서비스를 추가한다. ADR-0023의 이관 결정과 같은 PR에서 처리한다.
- **워크플로우가 `--cache-from type=registry`를 쓰게 되면**
  `ecr:GetDownloadUrlForLayer`를 `EcrPush` statement에 추가한다. 알려진 스위치다.
- **대시보드 쪽 계약에는 현재 소비자가 없다.** `pulsemetry-backend`의 현재 배포 산출물은
  `enrollment-api` 하나이고 배포 워크플로도 없다 — `api-server`·`batch-processor`(PROJ-48)는
  Gradle 모듈로 **존재하지 않는다**(미확보가 아니라 미존재다). 대시보드 역할 2개와 ECR 레포
  2개(`soma-376/api-server`·`soma-376/batch-processor`)가 대응 소스 없이 정의되어 있다.
  backend ADR-0008이 예고한 앱 모듈은 넷이다 — 산출물이 확정될 때 이 매핑을 다시 조사하지
  않도록 그대로 적어 둔다.

  | 모듈 | 상태 | 도메인 |
  |---|---|---|
  | `:apps:enrollment-api` | 현행 | enrollment |
  | `:apps:admin-api` | 신규 예정 | directory · policy · contract 쓰기 소유 |
  | `:apps:telemetry-ingest` | 신규 예정 | telemetry — collector 이관(backend ADR-0007)의 도착지 |
  | `:apps:dashboard-api` | 신규 예정 | 읽기 모델 |

  명명 규칙은 `:apps:<context>-<inbound>`(inbound = `api`·`ingest`·`worker`·`mcp`)이며,
  **infra의 `api-server`·`batch-processor`는 이 넷 중 어느 것과도 이름이 일치하지 않는다.**
  ECR은 레포 이름을 바꿀 수 없으므로([ADR 0007](0007-precreate-ecr-outside-cdk.md) Negative)
  **실제 이미지 push 전에** 정리해야 한다. 인증 계층은 배포 단위가 아니라 `:libs:security`
  횡단 라이브러리로 간다 — 인증만 따로 배포된다고 읽으면 안 된다. collector 이관 시
  `:apps:telemetry-ingest`가 새 배포 단위로 추가되어 ECR 레포와 `DEPLOY_TARGETS` 항목이
  하나 더 필요해진다. 산출물 구성이 확정되면 `DEPLOY_TARGETS`의 dashboard 항목과 ECR 레포
  이름을 그에 맞춘다. (`batch-processor` ECR 권한 회수는 하지 않는다.)
- **GitHub Environment 기반 승인 게이트**로 옮길지는 앱 레포에 Environment가 설정된 뒤
  재판단한다. 트리거는 "운영 배포에 사람 승인이 필요해질 때"다.
- **환경이 셋(`stg`)이 되면** 역할이 6개가 된다. ADR-0021 Follow-up의 `lib/stg/` 판단과 묶어서
  다시 본다.
- **인프라 레포 자체의 CI는 여전히 없다.** 이 ADR이 만든 것은 **앱 레포**가 쓸 배포 역할이며,
  이 레포의 `npm test` / `cdk synth` 검증 CI와는 별개다(`AGENTS.md` 5장 (H)).
- **`Env` 태그 값.** `cicd` 스택은 `Env: 'cicd'`를 쓴다. prod가 `mvp`, dev가 `dev`인 기존
  불일치(ADR-0021 4번)에 값이 하나 더 늘었다. 프로덕션 전환 시 일괄 정합화 대상에 포함한다.

## References

- `AGENTS.md` 3장(불변 규칙), 4장(설정과 환경 분기, 배포 계약), 6장(명령어와 런북), 7장(테스트 규칙)
- [ADR-0006](0006-accept-local-ebs-durability-for-mvp.md) - ClickHouse 로컬 EBS 내구성 수용
- [ADR-0007](0007-precreate-ecr-outside-cdk.md) - ECR 레포 선생성과 네임스페이스 컨벤션
- [ADR-0009](0009-single-infra-repo-stack-boundary.md) - 앱 레포는 이미지 배포만
- [ADR-0019](0019-clickhouse-container-runtime-contract.md) - ClickHouse 고정 태그
- [ADR-0021](0021-dev-prod-environment-separation.md) - dev/prod 분리, ECR 레포 공유와 태그 규율
- [ADR-0023](0023-dev-auth-proxy-between-alb-and-collector.md) - auth-proxy가 dev 전용인 근거
- [AWS::IAM::OIDCProvider 템플릿 레퍼런스](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-iam-oidcprovider.html) - `ThumbprintList`가 `Required: No`인 근거
- [Configuring OpenID Connect in Amazon Web Services](https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/configuring-openid-connect-in-amazon-web-services) - `aud` / `sub` 클레임 형식
- [OpenID Connect reference - Immutable subject claims](https://docs.github.com/en/actions/reference/security/oidc#immutable-subject-claims) - 2026-07-15 이후 생성 저장소의 이름+ID `sub` 형식
- [Amazon ECR identity-based policy examples](https://docs.aws.amazon.com/AmazonECR/latest/userguide/security_iam_id-based-policy-examples.html) - push 최소 액션 집합
- [Amazon ECS identity-based policy examples](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/security_iam_id-based-policy-examples.html) - `iam:PassRole`이 필요한 API 목록
