# 0047. dev SES identity 권한은 실행 계정·리전과 고정 발신 주소로 제한한다

## Status

Accepted (ADR 0046 대체; 실제 정상 초대 수신·설치 검증은 별도)

## Context

ADR 0046은 SES가 수신 identity의 SendEmail 권한을 거부한 실제 오류에 대응해 승인 태그 조건을
추가했다. 지정된 검증 완료 EMAIL_ADDRESS 하나의 태그와 enrollment 역할의 실제 정책을 대조했고,
후보 정책 IAM 시뮬레이션 12개는 모두 기대대로 판정되었다. 그러나 해당 정책 배포 후 같은 Pod와
SDK로 수행한 한 번의 고정 진단도 승인된 수신 identity의 `ses:SendEmail`을 403으로 거부했다.
오류 원문·개인 주소·수신 ARN은 남기지 않았다. 이 관측만으로 AWS 구현의 결함이나 태그 지원 범위를
단정하지 않는다. IAM 시뮬레이션이 실제 SES 수신 권한 평가를 대체하지 않는다는 한계는 확인했다.

정상 dev 초대는 검증된 지정 수신함에 메일을 보내야 한다. 개인 주소를 IAM·CloudFormation·Git에
나열할 수 없고 기존 고정 FromAddress 제한, dev 계정·리전 제한, SendEmail 단일 action을 유지해야 한다.
현재 계정의 SES sandbox 검증·한도와 사용자 지정 수신함만 사용하는 실제 검증 원칙은 별도 조건이다.

## Decision

- enrollment Pod 역할의 SES 권한을 단일 statement로 정리한다. action은 `ses:SendEmail`,
  resource는 실행 계정·리전의 `identity/*`, 조건은 `StringEquals`의
  `ses:FromAddress=no-reply@pulsemetry.co.kr` 정확 일치다.
- 중복 발신 도메인 statement와 수신 identity의 태그 조건 statement를 제거한다. 수신 주소를
  정책에 넣지 않는다. `SendRawEmail`, 관리·태그 API, 다른 계정·리전, configuration set은 허용하지 않는다.
- 이 IAM 정책은 수신 주소 allowlist가 아니다. 실제 발송은 사용자 지정 수신함만 사용하고
  SES sandbox의 수신 identity 검증·계정 한도·발송 중지 여부를 별도로 확인한다.
- 임시 승인 태그는 권한 관문으로 사용하지 않는다. 운영자는 이전 검증에서 추가한 태그만 제거하고
  다른 태그를 보존한다. 앱에는 태그 변경 권한을 주지 않는다.
- PR CI·독립 검토·병합 뒤 실제 change set의 enrollment IAM 수정과 CDK 메타데이터만 확인해
  DevEksStack에 적용한다. EC2·RDS·LaunchTemplate 교체와 앱·prod·DNS 변경은 하지 않는다.
- 배포 후 지정 수신함에 코드·링크 없는 고정 진단을 한 번만 시도해 권한을 확인한다. 성공하더라도
  정상 초대 API → outbox → SES → 실제 수신 → 설치·enroll 검증을 대체하지 않는다.

## Alternatives Considered

### A. 태그 조건을 유지하며 정상 초대를 재발급
- 장점: 추가 identity 권한에 운영자 승인이 필요하다.
- 단점: 같은 조건의 실제 단회 진단이 계속 거부되었다.
- 탈락 이유: 실패한 초대를 더 만들기 전에 권한 검증을 해결해야 한다.

### B. 수신 주소를 IAM resource에 나열
- 장점: 수신 identity를 정확히 제한한다.
- 단점: 개인 주소가 저장소와 배포 이력에 남는다.
- 탈락 이유: 개인 주소 비공개 제약을 위반한다.

### C. 모든 resource 또는 SES action 허용
- 장점: 없다. 실제 거부는 동일 계정·리전의 identity에 대한 SendEmail이다.
- 단점: 발신·리전·action 제한을 불필요하게 넓힌다.
- 탈락 이유: 필요한 범위를 넘어선다.

## Consequences/Tradeoffs

### Positive
- 개인 주소를 배포 산출물에 넣지 않고 고정 발신자와 단일 SES API를 유지한다.
- 실제 진단과 정상 초대 검증을 분리하여 실패 기록과 성공 근거를 보존한다.

### Negative
- 같은 계정·리전의 다른 identity도 고정 발신 주소 조건에서는 IAM resource 범위에 포함된다.
  IAM만으로 지정 테스트 수신함을 제한하지 않으므로 운영 절차와 SES sandbox 검증을 유지한다.
- 실제 SES 발송 결과는 배포 후 별도로 확인해야 한다.

## Follow-up

- 단회 권한 진단 후 정상 재발급과 실제 메일 수신·설치·enroll의 증거를 연결한다.
- SES sandbox 해제 또는 수신 정책 변경 전 dev 권한 범위를 재검토한다.

## Acceptance Criteria

- 합성 및 live 정책에 enrollment 전용 SES statement 하나만 있고 FromAddress 조건이 정확히 일치한다.
- 다른 발신 주소·누락, 다른 계정·리전, Raw·관리·태그 action 및 configuration set은 거부된다.
- 실제 변경 집합과 배포 후 정책을 대조하고 실제 초대 수신 완료는 별도로 기록한다.

## References

- [ADR 0043](0043-dev-invitation-mail-via-ses-and-csi.md), [ADR 0046](0046-dev-ses-tagged-recipient-authorization.md)
- [SES FromAddress 조건](https://docs.aws.amazon.com/ses/latest/dg/control-user-access.html)
- [SES v2 서비스 권한 표](https://docs.aws.amazon.com/service-authorization/latest/reference/list_sesv2.html)
- `DevEksRuntime`, [dev 메일 런북](../runbooks/dev-ses-invitation-mail.md)
