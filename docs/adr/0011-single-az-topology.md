# 0011. 최소 AZ 구성 - 서브넷은 2 AZ, 이중화는 미적용

## Status

Accepted (MVP 한정)

## Context

MVP의 범위는 고객사 사내 개발자를 대상으로 한 시연과 검증이다. 이 단계에서는 가용성보다 비용과 단순성을 우선한다.

원래 이 ADR은 VPC를 완전한 단일 AZ로 구성(각 계층 서브넷 1개씩)하려 했다. 그러나 CDK 구현 과정에서 다음 하드 제약이 확인되었다.

- Aurora `DatabaseCluster`는 최소 2개 AZ의 서브넷을 요구한다. 단일 AZ로는 synth 단계에서 "Cluster requires at least 2 subnets, got 1" 오류로 실패한다.
- 인터넷 페이싱 ALB도 최소 2개 AZ의 퍼블릭 서브넷을 요구한다.

즉 완전한 단일 AZ 구성은 애초에 배포가 불가능한 조합이었다. 비용과 단순성을 우선한다는 원래 취지는 유지하되, 이 하드 제약에 맞춰 서브넷 계층만 2 AZ로 확장했다.

## Decision

VPC는 `maxAzs: 2`로 구성한다. public/app/db 3계층 각각 2 AZ에 서브넷을 두어 총 6개 서브넷이 생긴다. 단 NAT Gateway는 원래 의도대로 1대만 둔다(비용 최소화).

컴퓨트와 데이터 워크로드는 VPC가 반환하는 첫 번째 AZ를 primary AZ로 정하고
그 AZ에 명시적으로 고정한다.

- Fargate 서비스(Collector, Dashboard)는 primary AZ의 app 서브넷만 사용한다.
- ClickHouse ASG와 ECS 서비스는 primary AZ의 app 서브넷만 사용한다.
- Aurora DB subnet group은 필수 조건에 따라 2 AZ의 db 서브넷을 유지하되,
  writer 1대(reader 없음)는 primary AZ에 배치한다.

인터넷 페이싱 ALB는 필수 조건에 따라 2 AZ의 public 서브넷을 계속 사용한다.
Aurora 스토리지 역시 서비스 특성상 여러 AZ에 복제되므로, 여기서 단일 AZ란
애플리케이션 컴퓨트와 Aurora writer의 배치 범위를 뜻한다.

## Alternatives Considered

- **완전한 단일 AZ (각 계층 서브넷 1개씩)**: 이 ADR이 원래 의도했던 구성. Aurora `DatabaseCluster`가 최소 2개 AZ의 서브넷을 요구하고("Cluster requires at least 2 subnets, got 1") 인터넷 페이싱 ALB도 최소 2개 AZ의 퍼블릭 서브넷을 요구해, 배포 자체가 불가능한 조합이라 기각.
- **2 AZ 완전 이중화 (NAT Gateway 2대 + 서비스 이중화)**: 가용성은 확보되지만 NAT Gateway 추가분과 태스크 증설 비용이 든다. 가용성보다 비용과 단순성을 우선하는 MVP 범위에서는 채택하지 않고, 정식 운영 전환 시점으로 미뤘다.
- **서브넷만 2 AZ + 워크로드는 primary AZ 고정** (채택): 위 하드 제약을 충족하면서 NAT Gateway 1대와 단일 AZ 배치라는 원래 취지를 유지한다.

## Consequences/Tradeoffs

### Positive

- NAT Gateway와 워크로드를 같은 primary AZ에 두어 정상 상태의 cross-AZ NAT
  트래픽은 발생하지 않는다.
- 반대편 AZ의 app 서브넷은 MVP 워크로드 배치에는 사용하지 않지만, 정식 운영
  전환 시 서비스 이중화를 추가할 수 있도록 유지한다.
- 정식 운영으로 전환할 때는 NAT Gateway를 2대로 늘리고 Fargate desiredCount 증가, Aurora reader 추가 등 서비스 이중화만 도입하면 된다. 서브넷은 이미 2 AZ로 구성되어 있으므로, 원래 ADR이 예상했던 "서브넷 구성 변경"은 더 이상 필요하지 않다.

### Negative

- primary AZ에 장애가 발생하면 ALB의 다른 AZ 노드와 Aurora 스토리지가 남아
  있더라도 Collector, Dashboard, ClickHouse, Aurora writer가 모두 중단된다.
  이 단일 장애 도메인 리스크는 MVP 범위에서 수용한다.

## Follow-up

- 정식 운영 전환 시 NAT Gateway 이중화(1대 → 2대)와 서비스 이중화(Fargate desiredCount 증가, Aurora reader 추가)를 도입한다.
