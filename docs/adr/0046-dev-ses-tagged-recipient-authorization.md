# 0046. dev SES 수신 identity 권한은 승인 태그와 고정 발신 주소로 제한한다

## Status

Superseded by [ADR 0047](0047-dev-ses-fixed-sender-identity-authorization.md) — 배포 후 실제 단회 진단도 수신 identity의 SendEmail을 403으로 거부했다. 오류 원인에 대한 AWS 구현 추측은 하지 않는다.

## Context

정상 dev 초대의 outbox가 SES `AccessDeniedException`으로 실패했다. 같은 enrollment Pod의
`DefaultCredentialsProvider`로 STS caller가 예상 Pod Identity 역할임을 확인했고, 발신 도메인과
DKIM은 검증되었으며 해당 도메인 ARN의 `SendEmail` IAM 시뮬레이션은 허용이었다.
지정 수신함에 대한 한 번의 비민감 진단에서 실제 거부 action은 `ses:SendEmail`, 리소스 유형은
`identity`, 대상은 승인된 수신 identity임을 확인했다. 주소·수신 identity ARN·AWS 오류 원문은
메모리에서만 분류했고 공유 기록에 남기지 않았다. 현 dev 계정은 SES sandbox다.

개인 수신자 주소를 IAM·CloudFormation·저장소에 기록할 수 없다. AWS SES v2 서비스 권한 표는
`SendEmail`의 identity 리소스에 `aws:ResourceTag/${TagKey}`와 `ses:FromAddress` 조건을 지원한다.
도메인 권한 시뮬레이션만으로 실제 수신 identity 권한을 검증했다고 판단할 수 없다.

## Decision

- 기존 발신 도메인 exact ARN과 고정 `ses:FromAddress`의 `ses:SendEmail` statement를 보존한다.
- enrollment Pod 역할에만 별도 `ses:SendEmail` statement를 추가한다. 리소스는 실행 계정·리전의
  `identity/*`이고 `StringEquals`의 두 조건, `ses:FromAddress=no-reply@pulsemetry.co.kr`와
  `aws:ResourceTag/pulsemetry:dev-mail-recipient=true`를 모두 요구한다.
- 운영자가 명시 승인된 검증 완료 수신 identity에만 `pulsemetry:dev-mail-recipient=true`를 단다.
  주소와 ARN은 비공개 입력에서 SES API에만 전달하며 IAM·CloudFormation·Git·PR·Jira에 넣지 않는다.
  기존 태그를 보존하고 태그 변경 권한을 앱 역할에 주지 않는다. 테스트 종료 시 태그 제거를 기록한다.
  이 태그는 identity 리소스 권한 분류이며 `ses:Recipients` 주소 allowlist 자체가 아니다.
  임의 domain identity에 붙이지 않으며 기존 발신 도메인 statement 범위는 별도로 유지된다.
- 발송 action을 확대하지 않는다. `SendRawEmail`, 관리 API, 다른 계정·리전, configuration set과
  태그 없는 추가 identity는 이 statement로 허용하지 않는다. 기존 domain statement가 허용하는
  도메인 범위는 그대로다. prod·DNS·메일 본문·공급자 체인·outbox 재시도 정책은 바꾸지 않는다.
- CI·독립 검토·병합 후 실제 prepared change set에서 enrollment IAM 정책만 변경되고
  기존 EC2·RDS·LaunchTemplate 교체가 없음을 확인한 뒤 DevEksStack만 적용한다.

## Alternatives Considered

### A. 수신 identity ARN을 IAM에 직접 나열
- 장점: 정확한 개별 리소스를 제한한다.
- 단점: 개인 주소가 코드·CloudFormation·PR에 남는다.
- 탈락 이유: 개인 주소 비공개 제약을 위반한다.

### B. 발신 조건만 유지한 identity wildcard
- 장점: 개인 주소 없이 실제 수신 identity 평가를 허용한다.
- 단점: 승인 태그가 없는 identity도 포함한다.
- 탈락 이유: 지원되는 태그 조건으로 더 좁게 제한할 수 있다.

### C. SendRawEmail 또는 전체 SES 권한 추가
- 장점: 없다. 관측된 거부 action은 SendEmail이다.
- 단점: 사용하지 않는 API 권한을 넓힌다.
- 탈락 이유: 실제 오류와 관련이 없다.

## Consequences/Tradeoffs

### Positive
- 고정 발신 주소와 승인된 수신 identity 조건을 함께 유지하며 개인 주소를 배포 산출물에 넣지 않는다.
- 앱은 수신 승인 태그를 스스로 변경할 수 없다.

### Negative
- SES identity 검증과 별개로 운영자의 승인 태그 관리가 필요하다.
- IAM 시뮬레이션은 조건 입력을 검증할 뿐 실제 SES의 수신 identity 평가를 대체하지 않는다.
  정책 적용 뒤 정상 초대 API부터 실제 수신까지 검증해야 한다.

## Follow-up

- 정상 초대 재발급 → outbox → SES → 실제 수신함 → 설치 페이지·명령·enroll 증거를 연결한다.
- sandbox 해제나 수신 정책 변경 시 이 dev 전용 태그 정책의 범위를 다시 검토한다.

## Acceptance Criteria

- 합성 결과의 두 statement와 enrollment 전용 소유를 검증한다.
- 승인 태그·고정 발신자는 허용하고 태그 누락/불일치·다른 발신자·다른 리전/계정·관리 action은 거부한다.
- 실제 change set과 live 정책이 검토한 변경에 일치하며 실제 정상 초대 수신 증거는 별도로 남긴다.

## References

- [ADR 0043](0043-dev-invitation-mail-via-ses-and-csi.md)
- [SES v2 서비스 권한 표](https://docs.aws.amazon.com/service-authorization/latest/reference/list_sesv2.html)
- [SES FromAddress 조건](https://docs.aws.amazon.com/ses/latest/dg/control-user-access.html)
- `DevEksRuntime`의 enrollment 정책, [dev 메일 런북](../runbooks/dev-ses-invitation-mail.md)
