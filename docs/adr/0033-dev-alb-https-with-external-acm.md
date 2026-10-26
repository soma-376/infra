# 0033. dev ALB는 외부 ACM 인증서를 context로 참조해 선택적으로 HTTPS를 제공한다

## Status

[ADR-0035](0035-dev-backend-eks-only.md)가 dev 백엔드의 ECS 실행·병행 유지·입력·배포 권한 가정을 부분 대체한다. prod·frontend Terraform과 이 문서의 나머지 계약은 유지한다. 아래 ECS 구성은 당시 결정 기록이다.

Accepted (로컬 구현·검증 대상, 실제 AWS 배포·TLS 접속·애플리케이션 E2E 검증 별도)

ADR-0022·0026·0028의 dev HTTP 전용 listener 결정을 인증서 입력이 있는 ALB에 한해 부분 대체한다.
기존 라우팅·WAF·보안 그룹 소유권과 인증서 입력이 없는 ALB의 HTTP 동작은 유지한다.

[ADR 0038](0038-dev-databases-private-access-via-ssm-relay.md)이 ClickHouse 8123 listener 보존 가정을 부분 대체한다.
DB 운영자 접속은 별도 SSM 릴레이를 사용하며 나머지 앱·데이터·환경 경계는 유지한다.

## Context

dev ECS ALB와 EKS 검증 ALB는 앱 트래픽을 HTTP 80에서 받는다. ACM 인증서는 이 레포 밖에서
관리하므로 인증서 생성·DNS 검증을 CDK에 편입하지 않고 기존 인증서를 연결할 입력이 필요하다.
ALB listener와 규칙을 새 construct로 옮기면 listener rule 교체와 priority 충돌 위험이 생긴다.
이 결정은 앱 공개 URL·manifest·DNS 계약을 바꾸지 않는 infra 단일 레포의 TLS 종단 구현이다.

## Decision

- `devCertificateArn`은 ECS ALB, `devEksCertificateArn`은 EKS 검증 ALB의 선택적 인증서 ARN이다.
  두 입력은 독립적이며 같은 인증서를 쓰려면 같은 ARN을 각각 명시한다. 생략한 ALB는 HTTP를 유지한다.
  `devEksEnabled=false`에서 EKS 인증서를 명시하면 오류로 처리한다.
- 명시한 ARN의 문자열 타입·ACM certificate 형식·`ap-northeast-2` 리전·배포 계정을 검증한다.
  `Certificate.fromCertificateArn()`으로 참조만 하고 인증서 생성·발급·조회를 하지 않는다.
- 기존 앱 listener의 construct ID를 보존하고 인증서가 있으면 `443/HTTPS`로 갱신하며 인증서와
  `SslPolicy.TLS13_RES`를 설정한다. 기존 path·method·OPTIONS·default 404 및 라우팅 규칙 ID를 유지한다.
  ECS/EKS 각각의 기존 listener rule 53개는 이동하거나 재생성하지 않는다.
- `devHttpRedirectEnabled`는 기본값 `true`인 공통 boolean context다. 인증서가 있는 ALB에서만
  별도 `80/HTTP` listener를 만들고 원래 host·path·query를 보존해 HTTPS 443으로 `HTTP_301`을 반환한다.
  redirect listener는 기존 앱 listener에 명시적으로 의존한다. `false`이면 해당 ALB에 80 listener가 없다.
- 모든 listener는 `open: false`를 유지한다. `DevNetworkStack`만 해당 ALB SG의 443 ingress를
  `devAllowedCidr`로 추가한다. ALB·SG·TG·규칙의 기존 식별자와 SG 설명, WAF, ClickHouse 8123은 유지한다.
- 기존 스택의 HTTPS 활성화는 `ARN + redirect=false` 적용 완료 후 `redirect=true`를 적용한다.
  HTTP 복구는 `ARN + redirect=false` 적용 완료 후 ARN을 제거한다. 각 중간 단계에는 80 listener가 없다.
  flag는 공통이므로 다른 ALB도 이미 HTTPS이면 그 ALB의 80 redirect도 잠시 사라진다.
  `DependsOn`만으로 동일 업데이트의 listener 삭제와 80 포트 복귀 순서가 보장된다고 가정하지 않는다.
- prod/cicd, 도메인 context, DNS, 앱 공개 URL, endpoint output, Helm values 생성기는 바꾸지 않는다.
  `PULSEMETRY_PUBLIC_BASE_URL`과 기존 output의 `http://<ALB DNS>`는 그대로이며 인증서 이름과
  맞지 않는 ALB DNS를 요청하면 301 후 TLS 인증서 이름 검증이 실패할 수 있다.

## Constraints

운영자는 같은 계정·서울 리전의 사용 가능한 인증서와 그 인증서가 포함하는 도메인·DNS를 준비한다.
ARN 형식 검증은 인증서 존재·발급 상태·유효기간·SAN·사용 가능성을 증명하지 않는다.
CloudFormation은 listener의 Port·Protocol을 교체 없이 갱신하지만 인증서·TLS 정책 변경이나 두 단계
적용의 무중단을 보장하지 않는다. ALB와 target 사이의 기존 HTTP 연결은 유지한다.
OTLP 클라이언트는 HTTPS endpoint로 직접 요청하며 POST body·인증 헤더 보존을 HTTP 301에 의존하지 않는다.
앱 공개 URL·manifest·OIDC callback 등 후속 HTTPS 정합과 실제 기능 검증 없이 원격 E2E 완료를 선언하지 않는다.

## Alternatives Considered

- CDK에서 인증서 발급·DNS 검증: 현재 외부 인증서 소유권을 바꾸고 DNS 관리 결정을 추가하므로 채택하지 않는다.
- 새 HTTPS listener로 기존 규칙 이동: listener rule의 교체와 기존 priority 충돌 위험을 늘리므로 채택하지 않는다.
- 두 ALB에 단일 ARN 자동 상속: 각 ALB를 독립적으로 전환하거나 다른 인증서를 적용할 수 없어 채택하지 않는다.
- 한 업데이트로 HTTP 복구: redirect 삭제와 기존 listener의 80 복귀 순서에 의존하므로 채택하지 않는다.

## Consequences/Tradeoffs

### Positive

기존 외부 ACM 인증서 수명주기를 유지하며 ECS/EKS를 독립적으로 HTTPS로 전환할 수 있다.
기존 listener·규칙 식별자를 보존하고 인증서 입력이 없는 dev 구성의 동작을 유지한다.

### Negative

활성화·복구에 두 번의 배포가 필요하고 중간 단계에서 HTTP 접근이 끊긴다. 공통 redirect flag가 두 ALB에
영향을 준다. 외부 인증서 갱신·도메인·DNS와 앱 공개 URL 변경은 운영자와 후속 작업의 책임이다.
HTTP URL output이 남아 있으므로 인증서 연결만으로 사용자가 접근할 수 있는 최종 URL이 완성되지 않는다.

## Follow-up

- 실제 인증서 상태·도메인·DNS를 확인하고 두 단계 적용과 복구를 실행한다.
- 앱 공개 URL·OIDC callback·manifest endpoint의 HTTPS 정합을 별도 작업으로 처리한다.
- TLS 접속·인증·수집·snapshot·CLI enrollment → manifest → OTLP forward를 실환경에서 검증한다.

## Acceptance Criteria

입력 오류, ECS/EKS 독립 활성화·같은 ARN 사용, redirect 전환을 테스트한다. HTTP 기본 구성,
HTTPS 인증서·정책·301과 의존성, 규칙·리소스 ID 보존, CIDR 제한, ACM 리소스 미생성을 template assertion으로
확인한다. 전체 Jest·TypeScript build와 prod A/B·dev/EKS HTTP/HTTPS·cicd synth를 실행한다.
로컬 성공은 실제 인증서·AWS 배포·TLS·로그인·수집 E2E 성공의 증거가 아니다.

## References

- [dev ALB HTTPS 적용·복구 런북](../runbooks/dev-alb-https.md)
- [ADR-0022 dev 인프라 토폴로지](0022-dev-infrastructure-topology.md)
- [ADR-0026 dev 백엔드 전환](0026-dev-backend-deployment-units-and-staged-migration.md)
- [ADR-0028 EKS 병행 전환](0028-dev-eks-auto-mode-transition.md)
- [CloudFormation listener 속성·HTTP redirect 예시](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-elasticloadbalancingv2-listener.html)
