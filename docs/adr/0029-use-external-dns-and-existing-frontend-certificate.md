# 0029. 프론트 DNS는 외부에서 관리하고 발급된 ACM 인증서를 참조한다

## Status

Accepted — 사용자 요청으로 ADR 0028의 Route 53 레코드·ACM 인증서 생성 결정을 대체한다. 네트워크, ALB, EC2/Fargate 및 단일 BFF 태스크 결정은 유지한다.

## Context

사용하는 도메인 제공 업체에서 Route 53으로 NS 위임을 할 수 없다. 기존 모듈은 public hosted zone을
필수로 요구하고 인증서 검증 CNAME 및 서비스 A alias를 생성하므로 이 도메인을 연결할 수 없다.
사용자는 ACM에서 인증서를 발급하고 외부 DNS에 검증 및 ALB 연결 CNAME을 직접 등록하기로 했다.
변경은 infra 내부 리소스 소유권이며 앱 API 계약을 변경하지 않는다.

## Decision

- runtime의 `route53_zone_id`를 `certificate_arn`으로 대체한다. 같은 계정·서울 리전의 인증서 ARN만 입력한다.
- 인증서는 관리자가 프론트 도메인을 포함하도록 발급하고 ISSUED 상태를 확인한다. 인증서의 상태·SAN 일치 여부는 로컬 입력 검증으로 보증하지 않는다.
- HTTPS 리스너는 입력된 ARN을 사용한다. Terraform은 인증서 생성·검증 및 Route 53 레코드 조회·수정을 하지 않는다.
- `alb_dns_name` 출력을 외부 DNS의 서비스 CNAME 대상으로 사용한다. 인증서 검증 CNAME은 자동 갱신을 위해 유지한다.
- bootstrap CI 역할의 Route 53 및 ACM 관리 권한과 `frontend_dns` 입력을 제거한다. ALB 리스너 관리 권한은 유지한다.
- 이전에 생성한 인증서·DNS 레코드는 `removed` 블록의 `destroy = false`로 보존하며 Terraform state에서만 제외한다. 관리자가 해당 레코드와 인증서의 이후 수명을 책임진다.

## Alternatives Considered

- Route 53 전용 유지: 현재 도메인의 NS 위임 제약 때문에 사용할 수 없다.
- 외부 DNS와 Route 53 선택 모드 병행: 현재 요청에 필요하지 않은 입력·권한·검증 분기를 늘리므로 채택하지 않는다.

## Consequences/Tradeoffs

### Positive

- 외부 DNS에서 관리하는 도메인과 기존 ACM 인증서를 사용할 수 있다.
- CI가 DNS나 인증서를 변경하지 않고 ALB·컴퓨트 실행 환경만 관리한다.

### Negative

- 인증서 발급·DNS 연결·갱신용 레코드 유지는 관리자 작업이다.
- Terraform apply 성공만으로 도메인 HTTPS 접속 성공을 보장하지 않는다.
- 기존 관리 대상에서 제외된 DNS와 인증서는 자동 삭제되지 않는다. 기존 state가 있다면 이 전환은 이전 ARN을 그대로 입력하고 runtime을 활성 상태로 유지한 채 먼저 적용한다.

## Acceptance Criteria

- mock test로 입력 ARN이 HTTPS 리스너와 출력에 연결되는지, 다른 계정·리전 ARN이 거부되는지 확인한다.
- 기존 dev EC2/prod Fargate 및 단일 태스크 검증을 유지한다.
- bootstrap CI 정책에 Route 53 및 ACM 작업 권한이 남지 않는다.
- 기존 인증서·DNS 리소스 제거 블록은 삭제를 금지한다. 실제 plan에서 삭제 없이 관리 제외로 표시되는지 운영자가 검토한다.

## References

- [ADR 0028](0028-frontend-alb-and-container-runtime.md)
- [Terraform removed 블록](https://developer.hashicorp.com/terraform/language/block/removed)
