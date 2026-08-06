# ADR-0002: 분석 저장소를 Redshift에서 ClickHouse(도커)로 변경

- **Status**: Accepted (MVP 한정)
- **Date**: 2026-07-24

## Context

초기 아키텍처 다이어그램은 Redshift Cluster와 Interface Endpoint 조합으로 분석 저장소를 구성하고 있었다. 그러나 MVP 단계의 비용 구조와 예상 데이터 볼륨을 함께 고려하면, 관리형 데이터 웨어하우스를 도입하는 것은 이 단계에서 과잉 투자에 해당한다.

## Decision

MVP 단계에서는 ClickHouse 공식 도커 이미지를 ECS 위에서 직접 운영한다. Redshift Cluster와 Interface Endpoint는 이번 구성에서 완전히 제외한다.

## Alternatives Considered

- **Redshift Provisioned**: 고정 비용이 크게 발생해 MVP 단계에는 부적합.
- **Redshift Serverless**: 최소 과금 단위가 존재해 MVP 트래픽 규모에서도 여전히 비용 부담이 됨.
- **ClickHouse Cloud**: 관리형이라는 장점은 있으나 별도 과금 체계가 추가되어 기각.

## Consequences

- 비용을 대폭 절감할 수 있다.
- 대신 백업, 내구성, 스케일링을 인프라 팀이 직접 책임져야 한다. 특히 ClickHouse가 인스턴스 로컬 EBS를 사용하는 데서 오는 데이터 유실 리스크는 [ADR-0006](0006-accept-local-ebs-durability-for-mvp.md) 참고.
- 텔레메트리 플레인(ClickHouse)과 컨트롤 플레인(Aurora PostgreSQL)을 분리하는 원칙은 이번 변경 이후에도 그대로 유지한다.
