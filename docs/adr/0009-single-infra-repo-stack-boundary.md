# 0009. CDK 스택 경계 - 인프라 레포 단일 관리 + 앱 레포는 이미지 배포만

## Status

Accepted

## Context

Collector & Processor와 Dashboard Backend는 서로 다른 깃 레포로 관리된다. 이 레포 경계를 그대로 CDK 스택 경계로 가져갈지 검토가 필요하다.

## Decision

CDK는 별도의 인프라 레포에서 단일 `ApplicationStack`으로 관리한다. 각 앱 레포의 CI는 이미지 빌드, ECR push, `ecs update-service --force-new-deployment` 실행까지만 수행한다. 앱 배포가 CDK 배포를 유발하지 않도록 두 흐름을 분리한다.

ClickHouse는 분석 데이터를 저장하지만, MVP에서는 독립 관리형 데이터베이스가 아니라 ECS Cluster, EC2 Capacity Provider, Cloud Map, 공통 task execution role에 결합된 런타임 워크로드다. 따라서 ClickHouse의 ASG, EBS, 태스크 정의와 `Ec2Service`를 `ApplicationStack`에 배치한다. 스택 경계는 데이터의 논리적 성격보다 배포 수명주기와 construct 의존 방향을 우선한다.

## Alternatives Considered

- **SharedStack + CollectorStack + DashboardStack으로 분리**: 각 레포가 자기 인프라를 소유하는 구조. 다만 cross-stack export의 락인 문제와 ALB 리스너 룰의 순환 의존 문제가 발생하며, 이를 SSM Parameter 참조나 리스너 import 패턴으로 풀어야 하는 추가 복잡도가 있어 채택하지 않음.
- **ClickHouse를 DataStack으로 이동**: ClickHouse만 옮기면 `DataStack`이 `ApplicationStack`의 ECS Cluster, Cloud Map namespace, task execution role을 참조해야 한다. 반대로 `ApplicationStack`은 이미 `DataStack`의 DB secret과 Raw Signal S3 버킷을 참조하므로 스택 간 순환 의존이 발생한다. ECS Cluster까지 함께 옮기면 `DataStack`이 앱 런타임을 소유해 책임 경계가 불명확해지므로 채택하지 않음.
- **ClickHouse를 AnalyticsStack으로 분리**: ECS Cluster와 Cloud Map namespace를 별도 공유 런타임 스택으로 분리하거나 cross-stack 참조를 추가해야 한다. ClickHouse의 독립 배포 필요성이 확인되지 않은 MVP 단계에서는 스택 수와 배포 순서의 복잡도만 늘어나므로 보류.

## Consequences/Tradeoffs

### Positive

- ClickHouse 인프라 변경도 다른 ECS 워크로드와 동일하게 `ApplicationStack` 배포를 통해 수행한다.

### Negative

- 태스크 정의 변경은 항상 인프라 레포를 경유해야 한다.

## Follow-up

- ClickHouse에 독립적인 배포, 복구 또는 보존 수명주기가 필요해지면 공유 런타임 스택과 `AnalyticsStack` 분리를 재검토한다.
- "앱 팀이 인프라 레포를 수정하는 것이 부담"이라는 문제가 실제 병목으로 드러나면, 그 시점에 스택 분리로 전환한다. 이는 논리적 재배치 수준의 변경으로 가능하다고 판단한다.
- **재검토 트리거** — `pulsemetry-backend` ADR-0007(collector 이관 + 인증 계층)이 `Accepted` 로
  전환되면 collector 설정의 소유권이 이 레포를 떠나므로 [ADR 0017](0017-inject-collector-config-via-env-provider.md)을 재검토한다.
  파이프라인 전체 이관(Python·Kotlin 성능 비교 목적)이 다시 논의되면
  [ADR 0007](0007-precreate-ecr-outside-cdk.md)·[ADR 0015](0015-arm64-fargate-for-cost-savings.md)·[ADR 0024](0024-github-actions-oidc-deploy-roles.md)도 함께 재검토한다.
  (backend ADR-0006 — 파이프라인 전체 병합 — 은 기각으로 닫혔으므로 이 결정의 전제
  "파이프라인과 대시보드가 서로 다른 깃 레포"는 유지된다.)
