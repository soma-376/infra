# ADR-0003: 하이브리드 launch type - ClickHouse만 EC2, 앱 서비스는 Fargate

- **Status**: Accepted
- **Date**: 2026-07-24

## Context

ClickHouse는 스테이트풀 워크로드로 영속 스토리지가 필요하다. Fargate와 EFS 조합은 MergeTree 엔진의 I/O 패턴에서 성능 저하가 크게 나타난다. 반대로 모든 컴포넌트를 EC2 단일 인스턴스에 올리는 방안은 비용은 최소화할 수 있지만, Spring Boot 기반 앱 서비스와 ClickHouse가 같은 인스턴스에서 동거하며 발생하는 메모리 경합과 인스턴스 관리 부담이 뒤따른다.

## Decision

ClickHouse만 EC2 launch type(EC2 Capacity Provider + EBS gp3)으로 운영하고, 나머지 앱 서비스(OTel Collector, Post Processor, API Server, Batch Processor)는 모두 Fargate로 운영한다. 단일 ECS Cluster 안에서 두 launch type을 혼합 운영한다.

## Alternatives Considered

- **전부 Fargate + EFS**: MergeTree I/O 패턴에서 성능 저하가 커서 기각.
- **전부 EC2 단일 인스턴스**: 월 비용은 더 저렴하지만 메모리 경합과 OOM 리스크가 있어 기각.
- **ClickHouse Cloud**: 별도 비용 부담으로 기각.

## Consequences

- 앱 서비스는 인스턴스 관리 부담이 완전히 사라진다.
- ClickHouse는 EBS 기반 영속 스토리지로 제 성능을 낸다.
- 비용 측면에서는 Fargate 태스크 2개(0.5vCPU/1GB 상시 + 0.5vCPU/2GB 상시)와 t4g.small, NAT Gateway를 조합한 이 구성이 전부-EC2 단일 인스턴스안보다 월 몇만 원 더 나간다. 대신 앱 서비스의 인스턴스 관리와 메모리 경합 걱정이 사라지는 트레이드오프를 수용한다.
- 위 Fargate 비용 근거는 이후 [ADR-0015](0015-arm64-fargate-for-cost-savings.md)에서 ARM64 요금으로 갱신되었다. Fargate 태스크는 x86_64가 아니라 ARM64로 구동한다.
- ClickHouse의 로컬 EBS 사용에 따른 데이터 내구성 트레이드오프는 [ADR-0006](0006-accept-local-ebs-durability-for-mvp.md) 참고.
