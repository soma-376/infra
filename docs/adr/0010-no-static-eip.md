# 0010. 고정 IP(EIP) 미채택

## Status

Accepted

## Context

이 아키텍처에서 외부에 노출되는 지점은 ALB(DNS 기반)와 CloudFront뿐이다. NAT Gateway에 필요한 EIP는 CDK가 자동으로 할당한다.

## Decision

명시적인 EIP 리소스는 별도로 두지 않는다.

## Alternatives Considered

고정 IP를 확보하는 수단으로 아래 셋을 두고 판단했다. 현재 고정 IP를 요구하는 쪽이 없다는 것이 공통 기각 사유다.

- **NLB + EIP**: 서브넷별로 고정 IP를 부여할 수 있다. 외부 노출 지점이 ALB와 CloudFront뿐이라 이를 위해 NLB를 추가할 근거가 없어 채택하지 않음. 요구가 생기면 재검토 대상이다.
- **Global Accelerator**: 고정 anycast IP를 제공한다. 같은 이유로 채택하지 않았고, 별도 과금이 추가된다.
- **NAT Gateway의 EIP를 고정 엔드포인트로 사용**: 이미 자동 할당되어 있어 추가 리소스가 필요 없지만, 아웃바운드 전용 주소라 외부 진입점으로 쓸 수 없어 기각.

## Consequences/Tradeoffs

### Positive

- 명시적으로 관리할 EIP 리소스가 늘지 않는다. NAT Gateway에 필요한 EIP는 CDK가 자동으로 할당한다.

### Negative

- 외부 접근 지점이 모두 DNS 기반이므로, 고정 IP를 전제로 하는 요구사항(예: IP 화이트리스트)은 현재 구성으로 충족할 수 없다.
- NAT Gateway의 EIP는 CDK가 자동 할당하지만 이는 아웃바운드 트래픽용일 뿐, 외부에서 접근하는 고정 엔드포인트로 사용하거나 애플리케이션이 이 IP에 의존하도록 설계하지 않는다.

## Follow-up

- 고객사 방화벽 화이트리스트 등 고정 IP 요구가 발생하면 NLB + EIP 또는 Global Accelerator 도입을 검토한다.
