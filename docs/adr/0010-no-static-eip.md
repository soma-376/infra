# ADR-0010: 고정 IP(EIP) 미채택

- **Status**: Accepted
- **Date**: 2026-07-24

## Context

이 아키텍처에서 외부에 노출되는 지점은 ALB(DNS 기반)와 CloudFront뿐이다. NAT Gateway에 필요한 EIP는 CDK가 자동으로 할당한다.

## Decision

명시적인 EIP 리소스는 별도로 두지 않는다.

## Consequences

- 외부 접근 지점이 모두 DNS 기반이므로, 고정 IP를 전제로 하는 요구사항(예: IP 화이트리스트)은 현재 구성으로 충족할 수 없다.
- NAT Gateway의 EIP는 CDK가 자동 할당하지만 이는 아웃바운드 트래픽용일 뿐, 외부에서 접근하는 고정 엔드포인트로 사용하거나 애플리케이션이 이 IP에 의존하도록 설계하지 않는다.

## Revisit Trigger

고객사 방화벽 화이트리스트 등 고정 IP 요구가 발생하면 NLB + EIP 또는 Global Accelerator 도입을 검토한다.
