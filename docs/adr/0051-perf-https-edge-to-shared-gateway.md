# 0051. perf 내부 Service와 공개 HTTPS는 같은 Gateway를 사용한다

## Status

Accepted — PROJ-293의 로컬 구현이다. 실제 ALB 생성·DNS 등록·HTTPS/TG/WAF 검증과 부하는 NOT_RUN이다. 허브 ADR 0029의 두 경로 비교를 infra에 구체화한다.

## Context

ADR 0050은 격리 perf의 내부 HTTP Service만 제공한다. 이 경로의 측정으로 TLS·ALB·WAF·NAT 영향을 판단할 수 없다. 사용자는 공개 호스트 `perf-api.pulsemetry.co.kr`와 기존 wildcard ACM 재사용을 정했고 ALB 생성 후 CNAME을 직접 등록한다. 별도 Gateway를 만들면 경로별 앱 상태가 달라져 비교 해석이 어려워진다.

## Decision

- `perfCertificateArn` runtime 입력이 있을 때만 PerfEdgeStack을 만든다. 인증서는 서울 리전/같은 계정의 기존 ACM 참조이며 생성·삭제하지 않는다. 공개 호스트는 고정한다. 실제 계정 ARN은 저장소에 기록하지 않는다.
- ALB는 HTTPS 443만 열고 TLS 정책을 고정한다. host와 POST `/v1/traces`, `/v1/metrics`, `/v1/logs`만 Gateway TG로 전달하고 기본 응답은 404다. HTTP listener, dashboard, enrollment 공개 경로는 만들지 않는다.
- 기존 Gateway Service를 NodePort 30082로 확장한다. 내부 DNS/8082 ClusterIP와 selector·Pod는 그대로다. TGB는 `perf-gateway` 노드만 등록하고 externalTrafficPolicy=Local, TG stickiness=false와 round_robin을 사용한다. TG 건강한 노드 수를 Gateway Pod 수와 혼동하지 않는다.
- Network가 ALB SG→Gateway NodePort와 EKS control plane→system LBC webhook 통신을 소유한다. LBC는 고정 공식 3.6.0 chart와 Pod Identity를 사용하며 perf TG 이름/소유 태그에 대한 등록·해제와 필요한 조회만 허용한다. ALB/TG/SG 생성·수정·삭제 권한을 주지 않는다.
- 발생기는 기존 전용 perf-generator에서 같은 VPC의 NAT를 거쳐 ALB로 나간다. ALB SG와 WAF source IP 범위는 이 환경 NAT EIP/32만 허용한다. WAF에는 외부 source/host/path/method를 차단하는 규칙을 추가하며 Allow 규칙으로 나머지 평가를 우회하지 않는다.
- dev의 해당 OTLP 경로에 적용되는 managed rule 버전·악성 IP Block·정찰/DDoS Count·Anonymous/Hosting Count·본문 Count·query exact-label Block·IP당 10,000/300초 Count를 보존한다. OTLP와 무관한 enrollment/OIDC/다운로드 예외는 만들지 않는다. 소스 범위와 host/method 제한은 dev보다 좁으며 운영 동등성을 주장하지 않는다.
- WAF sampling은 끄고 Authorization/Cookie/admin header/query를 data protection과 log redaction으로 가린다. Block/Count 탐지를 보존하여 403과 앱/ALB 429를 구분할 근거로 쓴다. OTLP rate Count 자체는 429를 생성하지 않는다.
- v3 resolved의 기존 gateway는 내부 HTTP이고 gateway_https는 공개 HTTPS다. 출력에는 ALB DNS·ARN/TG/WAF·NAT IP를 남기며 DNS 등록과 TLS/target health 확인 없이 공개 readiness를 주장하지 않는다. 요청 수·시간·저장·비용 제한과 실제 관측 gate는 후속 작업이 집행한다.

## Constraints

총 100,000원·생성 후 24시간 내 시험/삭제, 두 경로 합계 10,000요청·20RPS·실행당 600초·추가 저장 1GiB를 유지한다. PROJ-294의 독립 정리 보호와 실행 제한 전에는 배포하지 않는다. 공유 ACM/ECR/dev 자원은 정리 대상이 아니다.

## Alternatives Considered

별도 Gateway 배포는 SUT 상태 차이가 생겨 제외했다. ALB DNS에 검증 생략 TLS를 쓰는 방법은 실제 도메인 검증을 하지 못하므로 제외했다. source Allow shortcut은 WAF 의미를 바꾸므로 사용하지 않는다.

## Consequences/Tradeoffs

### Positive

같은 앱·Pod·데이터를 대상으로 경로 차이를 비교한다. 공개 경로의 소유권과 보안 정책을 선언하고 기존 내부/v2 동작을 보존한다.

### Negative

ALB/NAT/WAF 비용과 외부 DNS 등록 의존성이 추가된다. source NAT IP가 바뀌면 생성 값과 관측 증거를 갱신해야 한다. 로컬 정책 동등성 검사는 실제 관리형 룰 버전 가용성·AWS WAF capacity·HTTPS 성공을 입증하지 않는다.

## Follow-up

PROJ-294는 새 Edge/log 자원을 포함한 24시간 정리를, PROJ-298은 DNS/TLS/ALB/TG/WAF/NAT 실제 진단을 수행한다. load-tests는 명시적 경로 선택과 출발지/동일 SUT 기록을 담당한다.

## Acceptance Criteria

기존 내부/v2와 dev 렌더를 보존하고 optional edge 합성의 HTTPS-only/인증서 참조/소유 태그/SG/LBC IAM/WAF 의미를 검사한다. 잘못된 ARN·계정·provider/endpoint 입력과 혼합 TGB를 거부한다. 공개 DNS 출력은 배포 뒤 실제 값에서만 만든다.

## References

- [perf 기반](0050-perf-strimzi-provider-and-isolated-capacity.md)
- [dev WAF](0027-dev-alb-waf-policy.md)
- [허브 ADR 0029](https://github.com/soma-376/docs/blob/main/adr/0029-perf-strimzi-readiness-and-path-comparison.md)
