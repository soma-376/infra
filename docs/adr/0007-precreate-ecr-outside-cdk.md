# 0007. ECR 레포지토리는 CDK 관리 밖에서 선(先)생성

## Status

Accepted

## Context

CDK 스택이 ECR 레포지토리를 함께 생성하도록 구성하면, 스택의 첫 배포 시점에는 아직 이미지가 push되지 않은 상태다. 이 상태에서 ECS 서비스가 이미지를 가져오지 못해 기동에 실패하고, 결과적으로 스택 전체가 롤백되는 닭-달걀 문제가 발생한다.

## Decision

### 소유권

ECR 레포지토리는 CLI 또는 콘솔로 먼저 생성하고 이미지를 push한 뒤, CDK에서는 `ecr.Repository.fromRepositoryName`으로 참조만 한다. OTel Collector와 ClickHouse는 공식 이미지를 그대로 사용하므로 이 대상에서 제외된다.

### 네임스페이스 컨벤션

자체 빌드 이미지의 ECR 레포는 전부 `soma-376/` 네임스페이스 아래에 둔다. 네임스페이스 값은 `COMMON_TAGS.Org`와 일치시킨다. 태그 기반 비용 배분의 축과 레지스트리 경로가 같은 식별자로 정렬되어, 계정에 다른 워크로드가 들어와도 레지스트리 목록에서 소유 주체가 드러난다.

| 서비스 | 레포지토리 이름 |
|---|---|
| Collector & Processor | `soma-376/post-processor` |
| Dashboard Backend (API) | `soma-376/api-server` |
| Dashboard Backend (배치) | `soma-376/batch-processor` |

환경(`dev`/`stg`/`prod`)은 네임스페이스에 포함하지 않는다. 환경 구분은 계정 경계와 `COMMON_TAGS.Env` 태그가 담당하며, 이 레포에는 애초에 환경 분리 메커니즘이 없다(AGENTS.md 4장). 환경 분리가 필요해지면 그때 별도 ADR에서 다룬다.

이름의 단일 출처는 `lib/config.ts`의 `ECR_NAMESPACE` / `ECR_REPOS`다. 스택 코드에 레포 이름 리터럴을 직접 박지 않는다.

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
