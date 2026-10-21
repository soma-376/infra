# 0007. ECR 레포지토리는 CDK 관리 밖에서 선(先)생성

## Status

Accepted — 부분 대체: [ADR 0021](0021-dev-prod-environment-separation.md)이 "이 레포에는 환경 분리 메커니즘이 없다"는
전제를 대체한다. [ADR 0026](0026-dev-backend-deployment-units-and-staged-migration.md)은 dev 자체 빌드 산출물을
`soma-376/enrollment-api`와 `soma-376/telemetry-ingest`로 대체하며 ADR-0023의 dev auth-proxy 추가 결정을
끝낸다. prod의 기존 이미지 목록과 선생성·`fromRepositoryName` 참조·`soma-376/` 네임스페이스 결정은
그대로 유효하다.

[ADR-0029](0029-dev-dashboard-api-ecs-and-eks-deployment.md)이 dashboard-api를 dev ECS/EKS의 공통 이미지 소비 대상으로 추가한다. 아래 PROJ-226 공급 준비 기록과 ECR 선생성·참조 원칙은 보존하며 실제 이미지 게시·pull은 별도 증거다.

## Context

CDK 스택이 ECR 레포지토리를 함께 생성하도록 구성하면, 스택의 첫 배포 시점에는 아직 이미지가 push되지 않은 상태다. 이 상태에서 ECS 서비스가 이미지를 가져오지 못해 기동에 실패하고, 결과적으로 스택 전체가 롤백되는 닭-달걀 문제가 발생한다.

## Decision

### 소유권

ECR 레포지토리는 CLI 또는 콘솔로 먼저 생성하고 이미지를 push한 뒤, CDK에서는 `ecr.Repository.fromRepositoryName`으로 참조만 한다. OTel Collector와 ClickHouse는 공식 이미지를 그대로 사용하므로 이 대상에서 제외된다.

### 네임스페이스 컨벤션

자체 빌드 이미지의 ECR 레포는 전부 `soma-376/` 네임스페이스 아래에 둔다. 네임스페이스 값은 `COMMON_TAGS.Org`와 일치시킨다. 태그 기반 비용 배분의 축과 레지스트리 경로가 같은 식별자로 정렬되어, 계정에 다른 워크로드가 들어와도 레지스트리 목록에서 소유 주체가 드러난다.

아래는 ADR-0026의 dev 전환 전 이미지 목록이다. prod의 기존 목록은 그대로 유효하며,
기존 dev 배포 서비스의 이미지 대상은 `soma-376/enrollment-api`와 `soma-376/telemetry-ingest`다.

| 서비스 | 레포지토리 이름 |
|---|---|
| Collector & Processor | `soma-376/post-processor` |
| Auth Proxy (**dev 전용**, [ADR 0023](0023-dev-auth-proxy-between-alb-and-collector.md)이 추가) | `soma-376/auth-proxy` — auth-proxy 는 backend Spring Security 로 이관 예정이라 이 레포도 이관 시 정리 대상이다 |
| Dashboard Backend (API) | `soma-376/api-server` |
| Dashboard Backend (배치) | `soma-376/batch-processor` |

환경(`dev`/`stg`/`prod`)은 네임스페이스에 포함하지 않는다. **환경 구분은 네임스페이스가 아니라 이미지 태그가 담당한다** — dev/prod 가 같은 ECR 레포를 공유하고 dev 는 `dev`, prod 는 `prod` 태그를 읽는다([ADR 0021](0021-dev-prod-environment-separation.md) 5번, [ADR 0024](0024-github-actions-oidc-deploy-roles.md) 7번). 결정 당시의 "이 레포에는 환경 분리 메커니즘이 없다" 는 전제는 ADR-0021 로 해소됐다.

이름의 단일 출처는 `lib/common/config.ts`의 `ECR_NAMESPACE` / `ECR_REPOS`다. 스택 코드에 레포 이름 리터럴을 직접 박지 않는다.

### dashboard-api 이미지 공급 준비 (PROJ-226)

`soma-376/dashboard-api`를 `ECR_REPOS.dashboardApi`로 추가하고 backend-dev 역할의 이미지 공급
대상에 포함한다. 기존과 같이 레포지토리는 CDK 밖에서 선생성하고 참조만 한다. 이 추가는 이미지
이름과 push 권한 준비이며, ECS 서비스나 EKS 워크로드를 생성하지 않는다.

공급할 이미지는 `linux/arm64`이며 commit SHA 태그와 `dev` 태그가 같은 manifest digest를 가리켜야
한다. ECS와 EKS에서 사용할 dashboard-api는 같은 레포지토리의 동일한 산출물을 소비하는 것이
목표다. 전체 배포 계약과 ADR 채택은 PROJ-220, 서비스 정의는 PROJ-221에서 처리한다.

상수·권한의 로컬 구현과 합성 검증은 실제 레포지토리 생성·이미지 게시·ARM64 manifest 확인·태그별
digest 일치·런타임 pull 성공을 증명하지 않는다. 실제 이미지 공급 단계에서 각각 확인해야 한다.

## Alternatives Considered

- **ECR 전용 스택을 분리해 먼저 배포**: 스택 수가 늘어나는 부담이 있어 기각.
- **cdk-ecr-deployment 등으로 이미지까지 CDK가 동시에 배포**: 구성 복잡도가 늘어나 기각.
- **네임스페이스 없는 flat 이름(`post-processor`)**: 최초 구성 방식. 계정 내 소유 주체가 드러나지 않고 다른 워크로드와 이름이 충돌할 여지가 있어 기각.
- **`soma-376/<env>/<service>`**: 환경별로 별도 push가 필요해져 이미지 승격(promote) 없이 레포 수가 3배가 된다. 단일 계정/단일 환경인 MVP에는 과한 구조라 기각.
- **`soma-376/<domain>/<service>`**: 서비스가 3개뿐인 현 시점에 도메인 계층을 추가할 실익이 없어 기각.

## Consequences/Tradeoffs

### Positive

- CDK 스택은 이미지 존재 여부와 무관하게 레포지토리 참조만 하므로, 스택 자체의 배포 안정성은 이미지 준비 상태에 영향을 받지 않는다.

### Negative

- 인프라를 최초 배포하기 전에 반드시 이미지 push가 선행되어야 한다. 이 순서는 런북에 명시해야 한다.
- ECR은 레포지토리 이름을 변경할 수 없다. 네임스페이스를 나중에 바꾸려면 새 레포를 만들고 이미지를 다시 push한 뒤 구 레포를 지워야 하므로, 이름은 최초 생성 시점에 확정한다.
- 앱 레포(Collector & Processor, Dashboard Backend) CI의 push 대상 경로가 이 규칙에 종속된다. 인프라를 배포하기 전에 앱 레포 쪽에 전달되어야 한다(ADR-0009).
