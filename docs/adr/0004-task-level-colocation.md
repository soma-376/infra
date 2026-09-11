# 0004. 서비스 묶음 - 태스크 단위 co-location

## Status

Accepted — 부분 대체: [ADR 0026](0026-dev-backend-deployment-units-and-staged-migration.md)이 dev의 두
co-location 묶음을 독립 `telemetry-ingest`·`enrollment-api` 서비스로 대체한다. prod의 두 태스크 묶음과
`batch-processor: essential: false` 결정은 그대로 유효하다.

## Context

배포와 수명주기를 함께 관리해야 하는 컨테이너 쌍이 두 개 존재한다. Collector와 Post Processor는 신호 파이프라인으로 직결되어 있고, API Server와 Batch Processor는 대시보드 백엔드로 묶여 있다. Batch Processor는 추후 API Server 소스 코드로 흡수되어 API Server가 그 수명주기를 관리하게 될 가능성이 있다.

## Decision

ECS Cluster는 **환경당** 1개로 유지하고(현재 계정에는 dev·prod 2개 — `soma-376-dev`·`soma-376-prod`), 서비스 묶음은 태스크 정의 단위로 표현한다.

- ① `otel-collector` + `post-processor` 컨테이너를 하나의 태스크 정의에 배치
- ② `api-server` + `batch-processor` 컨테이너를 하나의 태스크 정의에 배치

`batch-processor` 컨테이너는 `essential: false`로 설정하여, 배치 작업이 실패해도 그 태스크가 API 서버까지 함께 내려가지 않도록 한다.

## Alternatives Considered

- **ECS Cluster 자체를 분리**: 클러스터는 논리 그룹일 뿐이라 분리해도 실익이 없어 기각.
  (환경 분리에 따른 클러스터 분리는 이것과 다른 사유다 — 클러스터 이름이 계정+리전에서 유일해야
  하기 때문이며 [ADR 0021](0021-dev-prod-environment-separation.md)·[ADR 0024](0024-github-actions-oidc-deploy-roles.md)가 다룬다.)
- **서비스 4개로 전부 분리**: 태스크 간 통신 오버헤드와 비용이 증가해 기각.
- **처음부터 batch를 api-server에 내장**: 아직 결정되지 않아 채택하지 않음.

## Consequences/Tradeoffs

### Positive

- 같은 태스크 내 컨테이너는 localhost로 통신하므로, Collector와 Post Processor 간 신호 파이프라인이 단순해진다.
- `batch-processor`가 API Server 소스로 흡수되는 시점에는 `addContainer("batch-processor")` 블록만 제거하면 이행이 끝난다. 같은 태스크에 배치해 둔 덕분에 이 전환이 자연스럽다.

### Negative

- 이 결정에 대해 원문에 기록된 부정적 결과는 없다. 트레이드오프는 위 Alternatives Considered의 기각 사유로 갈음한다.

## Follow-up

- Batch Processor를 API Server 소스로 흡수할지 여부는 아직 미결이다.
  다만 `pulsemetry-backend`에는 `batch-processor` 모듈이 존재하지 않는다(`settings.gradle.kts`는
  `:apps:enrollment-api`와 `:libs:enrollment-persistence`만 포함) — **흡수 여부 이전에 구현 여부부터
  미정이다.** backend ADR-0008이 예고한 앱 모듈은 `:apps:enrollment-api` · `:apps:admin-api` ·
  `:apps:telemetry-ingest` · `:apps:dashboard-api` 넷이며 `batch-processor`는 그중에 없다.
  산출물 구성 확정은 ADR-0024 Follow-up(현상 기록)이 받는다.
