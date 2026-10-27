# 0042. dev 초대 메일은 SES와 EKS 전용 암호화 키 원본으로 보낸다

## Status

Accepted (PROJ-267 구현; 실제 DNS 인증·수신·설치 검증은 별도)

## Context

enrollment-api의 SES 공급자는 구현되어 있지만 dev runtime은 관리·메일을 끄고 활성 입력을 거부한다.
관리 명령 응답과 outbox 본문은 서로 다른 AES-256-GCM 키를 필요로 한다. 현행 dev는 EKS이며
기존 ASCP/CSI/configtree 공급과 Pod Identity를 유지해야 한다.

## Decision

- DevDataStack은 관리 응답 키와 메일 본문 키의 빈 Secrets Manager 원본 두 개를 만들고 Retain한다.
  값은 별도 초기화에서 각 32바이트 난수를 Base64로 등록한다. 일반 배포는 키를 생성·회전하지 않는다.
- enrollment Pod만 두 원본을 읽는다. runtime 입력은 VersionId만 받고 CSI가 고정 버전을
  `PULSEMETRY_MANAGEMENT_RESPONSE_ENCRYPTION_KEY`·`PULSEMETRY_MAIL_ENCRYPTION_KEY` 파일로 공급한다.
  ARN·원문은 runtime 입력에서 받지 않으며 requiredFiles 검사를 유지한다. 다른 앱은 키를 읽지 않는다.
  키 참조·VersionId의 hash를 enrollment Pod annotation에 넣어 명시 버전 변경 때 재기동한다.
- dev SES 도메인은 `pulsemetry.co.kr`, 발신자는 `no-reply@pulsemetry.co.kr`, 리전은 `ap-northeast-2`다.
  DevDataStack은 Easy DKIM identity를 관리하고 DNS CNAME 참조만 출력한다. 외부 DNS는 기존 소유자가
  등록한다. 기존 루트 SPF·DMARC는 자동 변경하지 않는다.
- enrollment Pod Identity에 해당 identity의 `ses:SendEmail`만 허용하고 `ses:FromAddress`를 고정한다.
  정적 AWS 키·SMTP fallback·다른 Pod/EC2 역할의 발송 권한은 추가하지 않는다.
- 관리·메일 활성화에는 각각 명시 설정과 키 버전이 필요하다. 초대 SSO URL과 설치 페이지 URL은
  분리하며 후자는 `https://dev.pulsemetry.co.kr/install`이다. 사용자 지정 수신함만 실제 발송한다.
- sandbox·identity 검증·DNS 인증·수신 제한을 배포 전에 확인한다. `sent`와 SES MessageId는
  실제 받은 메일이나 설치 성공의 증거로 대신하지 않는다. AWS production access는 자동 요청하지 않는다.

## Alternatives Considered

- 관리 키나 token hash 재사용: 키 수명과 유출 범위가 섞이므로 제외한다.
- 환경 변수·Kubernetes Secret 복제: 기존 CSI/configtree와 원문 비기록 계약을 유지한다.
- SMTP/Mailpit 우회: 실제 SES 수신 요구를 충족하지 않으므로 제외한다.

## Consequences/Tradeoffs

### Positive

- 코드·배포 입력·권한·키 공급을 함께 검증하면서 기존 outbox 재시도와 암호화를 유지한다.
- 발신 identity와 발신 주소, workload를 제한하고 prod는 변경하지 않는다.

### Negative

- 외부 DNS와 sandbox 수신자 검증은 별도 절차다. 코드 병합만으로 실제 발송을 보장하지 않는다.
- 키 교체는 이전 암호문과 멱등 응답의 수명을 고려해야 한다. 배포 때 임의 회전할 수 없다.
- 단일 replica의 명시 재배포에는 기존 Recreate 중단이 있다.

## Acceptance Criteria

- 원본 두 개의 Retain·빈 값·독립성, enrollment 전용 읽기와 SES 최소 권한을 합성 검사한다.
- 잘못된 버전·URL·발신자·원문 입력을 거부하고 고정 버전의 CSI 파일과 필수 환경 설정을 렌더링한다.
- 정상 초대 API → outbox → SES → 지정 수신함 → 설치 링크 → 원격 CLI → enroll 증거를 별도 기록한다.
