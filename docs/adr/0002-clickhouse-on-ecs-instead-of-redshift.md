# 0002. 분석 저장소를 Redshift에서 ClickHouse(도커)로 변경

## Status

[ADR-0035](0035-dev-backend-eks-only.md)가 dev 백엔드의 ECS 실행·병행 유지·입력·배포 권한 가정을 부분 대체한다. prod·frontend Terraform과 이 문서의 나머지 계약은 유지한다. 아래 ECS 구성은 당시 결정 기록이다.

Accepted (MVP 한정)

EKS 활성화 dev 경로의 실행·접속·스토리지·스택 경계는 [ADR 0028](0028-dev-eks-auto-mode-transition.md)이 부분 대체한다. 기존 ECS와 prod 경로는 계속 유효하다.

## Context

초기 아키텍처 다이어그램은 Redshift Cluster와 Interface Endpoint 조합으로 분석 저장소를 구성하고 있었다. 그러나 MVP 단계의 비용 구조와 예상 데이터 볼륨을 함께 고려하면, 관리형 데이터 웨어하우스를 도입하는 것은 이 단계에서 과잉 투자에 해당한다.

## Decision

MVP 단계에서는 ClickHouse 공식 도커 이미지를 ECS 위에서 직접 운영한다. Redshift Cluster와 Interface Endpoint는 이번 구성에서 완전히 제외한다.

## Alternatives Considered

- **Redshift Provisioned**: 고정 비용이 크게 발생해 MVP 단계에는 부적합.
- **Redshift Serverless**: 최소 과금 단위가 존재해 MVP 트래픽 규모에서도 여전히 비용 부담이 됨.
- **ClickHouse Cloud**: 관리형이라는 장점은 있으나 별도 과금 체계가 추가되어 기각.

## Consequences/Tradeoffs

### Positive

- 비용을 대폭 절감할 수 있다.
- 텔레메트리 플레인(ClickHouse)과 컨트롤 플레인(Aurora PostgreSQL)을 분리하는 원칙은 이번 변경 이후에도 그대로 유지한다.

### Negative

- 대신 백업, 내구성, 스케일링을 인프라 팀이 직접 책임져야 한다. 특히 ClickHouse가 인스턴스 로컬 EBS를 사용하는 데서 오는 데이터 유실 리스크는 [ADR-0006](0006-accept-local-ebs-durability-for-mvp.md) 참고.
