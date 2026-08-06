# ADR-0014: MVP에서는 ClickHouse를 app subnet에 유지

- **Status**: Proposed
- **Date**: 2026-07-27

## Context

현재 ClickHouse ASG와 ECS 서비스는 [ADR-0011](0011-single-az-topology.md)에
따라 primary AZ의 app subnet을 Collector, Dashboard와 함께 사용한다.
네트워크 접근은 전용 ClickHouse 보안 그룹이 담당하며, Collector와 Dashboard
보안 그룹에서 오는 TCP 8123(HTTP)과 9000(Native)만 인바운드로 허용한다.

ClickHouse를 별도 private subnet으로 옮기면 CIDR과 route table을 앱 계층과
분리할 수 있다. 그러나 ClickHouse는 public container image pull과 CloudWatch
Logs 전송을 위한 outbound 경로가 필요하다. 별도 `PRIVATE_WITH_EGRESS`
subnet을 추가해도 기존 NAT Gateway와 기본 Network ACL을 공유한다면 즉시
추가되는 접근 통제는 제한적이고, 실제 인바운드 경계는 계속 보안 그룹이
담당한다.

또한 현재 ClickHouse 데이터는 [ADR-0006](0006-accept-local-ebs-durability-for-mvp.md)에
따라 EC2 인스턴스에 연결된 로컬 EBS에 저장된다. ASG의 subnet을 변경하는
배포는 인스턴스 교체를 유발할 수 있으며, 이 경우 ClickHouse 데이터가
유실될 수 있다.

## Decision

MVP에서는 ClickHouse를 primary AZ의 app subnet에 유지한다. ClickHouse 전용
subnet, 전용 Network ACL, 추가 VPC endpoint는 도입하지 않는다.

네트워크 접근 제어는 기존 ClickHouse 보안 그룹으로 유지한다. subnet 분리는
별도의 라우팅, egress, Network ACL 또는 IP 용량 요구가 확인된 뒤 도입한다.

## Alternatives Considered

- **별도 `PRIVATE_WITH_EGRESS` subnet**: 앱 계층과 CIDR 및 route table을
  분리할 수 있지만 같은 NAT Gateway와 기본 Network ACL을 사용하면 MVP에서
  얻는 추가 격리 효과가 작다. subnet과 route table, IP 주소 공간 및 배포
  절차만 늘어나므로 보류한다.
- **완전 isolated subnet**: 인터넷 경로를 제거할 수 있지만 public ClickHouse
  image 공급 방식을 바꾸고 CloudWatch Logs 등 AWS 서비스 접근을 위한 VPC
  endpoint를 추가해야 한다. 현재 MVP 범위보다 운영 복잡도가 크므로 보류한다.
- **별도 subnet과 전용 Network ACL**: subnet 경계에서 추가 통제를 제공하지만
  상태 비저장 규칙과 ephemeral port까지 운영해야 한다. 현재 보안 그룹 정책으로
  요구사항을 충족하므로 보류한다.

## Consequences

- VPC를 2 AZ × 3계층의 6개 subnet으로 유지하고 추가 CIDR과 route table을
  만들지 않는다.
- ClickHouse와 Fargate 앱 서비스는 동일한 primary app subnet의 라우팅 및
  NAT Gateway 장애 범위를 공유한다.
- ClickHouse 보안 그룹이 워크로드 간 접근 경계를 계속 담당한다.
- subnet 이동에 따른 ClickHouse EC2 교체와 로컬 EBS 데이터 유실 위험을
  현재 배포에 추가하지 않는다.
- subnet 단위의 독립 egress, Network ACL, IP 용량 관리는 제공하지 않는다.

## Revisit Trigger

다음 중 하나가 발생하면 ClickHouse 전용 subnet 도입을 다시 검토한다.

- ClickHouse 전용 egress, Network ACL 또는 VPC endpoint 정책이 필요해진다.
- app subnet의 IP 주소가 부족해진다.
- ClickHouse에 독립적인 장애 범위나 규제상 네트워크 경계가 필요해진다.
- 정식 운영 전환으로 네트워크 계층과 데이터 마이그레이션 절차를 재설계한다.

