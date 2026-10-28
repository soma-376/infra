# dev SES 초대 메일 준비·발송·복구

ADR 0043가 원본·권한·공급을, backend ADR 0037·0057이 outbox와 발송을 소유한다.
대상은 `ap-northeast-2` dev EKS다. 코드·합성·SES 접수와 실제 수신·설치는 각각 증거를 남긴다.

## 1. 원본과 DNS 준비

PR CI·리뷰·병합 뒤 현재 배포 profile로 Data와 EKS의 diff를 먼저 확인한다.
Data 변경은 관리 응답/메일 키 원본 두 개·SES domain identity·출력, EKS 변경은 enrollment 역할의
두 원본 읽기·해당 발신 identity의 SendEmail만 있어야 한다. 기존 JWT/OIDC/DB 원본과 prod는 유지한다.
먼저 DevDataStack을 단독 배포해 빈 원본과 identity를 만든다. 자동으로 메일을 보내지 않는다.

`MailDkimRecords` output의 CNAME 세 개를 외부 DNS에 등록한다. DNS 변경에 별도 사용자 확인이
요청되었다면 정확한 이름·값을 보여주고 확인 후 적용한다. 기존 MX·SPF·DMARC를 덮어쓰지 않는다.
`sesv2 get-email-identity`로 VerificationStatus, VerifiedForSendingStatus, DKIM signing/status를 확인하고
DNS의 DKIM CNAME·DMARC 정책을 대조한다. DKIM 정렬로 DMARC를 충족하며 custom MAIL FROM은 사용하지 않는다.

`sesv2 get-account`로 sandbox와 발송 중지·한도·suppression을 확인한다. sandbox에서는 사용자 지정
수신 주소의 검증이 필요하다. 검증 메일도 지정 수신함에만 보내고 실제 수신 확인·링크 클릭을 받는다.
production access 또는 다른 수신자를 자동 요청·사용하지 않는다.

## 2. 키 초기화

새 원본에 버전이 없는 것을 확인한 뒤 각각 독립적인 Base64 32바이트 난수를 등록한다.
이 작업은 초기화 때만 하며 일반 배포에서 반복하지 않는다. 셸 추적(`set -x`)은 끈다.

```sh
umask 077
key_file=$(mktemp)
openssl rand -base64 32 | tr -d '\n' > "$key_file"
aws secretsmanager put-secret-value --secret-id <원본 ARN> --secret-string "file://$key_file" \
  --query VersionId --output text
rm "$key_file"
```

관리 응답 키와 메일 키는 서로 다른 값을 쓴다. 원문은 로그·PR·Jira·runtime YAML에 기록하지 않는다.
출력된 VersionId와 원본 이름만 배포 증거에 기록한다. 기존 원본에 값이 있으면 재생성하지 않는다.
암호화한 멱등 응답·대기 메일이 남아 있는 동안 이전 키 버전을 제거하거나 임의 회전하지 않는다.

## 3. 활성화 입력과 배포

`config/dev/runtime.yaml`에 실제 VersionId로 아래 값을 추가하고 dashboard의 두 flag를 true로 바꾼다.
가짜 VersionId로 기동하거나 flags만 먼저 켜지 않는다. 설정 변경도 PR 검증·리뷰·병합을 거친다.

```yaml
management:
  responseKeyVersionId: <관리 응답 키 VersionId>
  onboardingOtlpEndpoint: https://api-dev.pulsemetry.co.kr
  invitationAcceptUrl: https://dev.pulsemetry.co.kr/login
  installationPageUrl: https://dev.pulsemetry.co.kr/install
mail:
  encryptionKeyVersionId: <메일 키 VersionId>
  provider: ses
  from: no-reply@pulsemetry.co.kr
  region: ap-northeast-2
  dispatchInterval: PT5S
  retryInterval: PT1M
  maxAttempts: 3
  sendTimeout: PT15S
```

5초 dispatch는 실행 주기이며 개별 메일 사이의 간격을 보장하지 않는다. 한 실행은 대기 outbox를 순차 소진한다.
현재 sandbox 초당 1건 한도에서 검증은 한 번에 테스트 초대 하나만 생성하고 수신 확인 후 다음 초대를 진행한다.
backlog가 쌓이면 burst가 SES throttling과 재시도로 분류될 수 있으므로 활성화 전 대기 건수를 확인한다.
기본 공급자 체인이 EKS Pod Identity 자격을 받아야 한다. 정적 자격·SMTP 설정은 넣지 않는다.

DevEksStack의 diff를 다시 확인하고 단독 배포한다. 생성기의 공식 `values:dev` 명령에 현재 CDK output·
검증한 앱 digest·MSK bootstrap/list-nodes를 전달한다. 기존 DB TLS·tracing·JWT/OIDC·ingest mode를 보존한다.
생성된 runtime release를 먼저 적용하고 PROJ-266이 포함된 enrollment 이미지를 배포해 Ready를 확인한다.
initContainer는 필수 키 파일을 확인하고 backend가 Base64·길이를 검증한다. 파일 내용·env 전체를 출력하지 않는다.

## 4. 실제 검증 관문

1. 사용자 인증을 사용한 정상 조직 초대 생성 API로 지정 수신자에게 초대를 만든다. 정적 admin 초대 API나 SES 직접 호출로 대체하지 않는다.
2. 초대 ID·outbox ID·상태·시도·SES 접수 ID를 연결한다. 로그에는 코드·수신자·본문을 남기지 않는다.
3. 실제 수신함에서 발신/수신/제목/본문/수신시각과 X-Pulsemetry-Mail-Id·DKIM/DMARC 결과를 확인한다.
4. 메일의 설치 링크로 dev 공개 페이지를 열어 올바른 코드의 OS별 명령을 확인한다. SSO URL에는 코드가 없어야 한다.
5. 재발급의 새 코드·이전 코드 거부와 동일 멱등 요청의 초대/outbox 중복 없음도 확인한다.
6. WAF(PROJ-269) 적용·실제 차단 검증 후 backend 사전 검사(PROJ-268)를 공개한다.
7. 원격 v0.1.0-rc.2 CLI 6종의 해시 검증(PROJ-146) 후 실제 수신 메일→페이지→명령→다운로드→enroll 성공을 확인한다.

발송 실패는 outbox failure_code/detail과 재시도·최대 시도로 판정한다. 실패를 `sent`로 바꾸지 않는다.
사용자가 지정하지 않은 주소·simulator에는 발송하지 않는다. 실패 검증이 별도 허용되지 않았다면 로컬 테스트와
실환경 미검증을 구분한다. `sent`·MessageId만으로 수신 완료를 주장하지 않는다.

## 5. 복구

배포 전 Helm revision·enrollment digest·runtime 파일·원본 VersionId와 대기 outbox 수를 기록한다.
문제 발생 시 새 초대 생성을 멈추고 실패 분류를 확인한다. 권한·DNS·기동 설정 오류는 원본 키를 유지한 채 고친다.
이전 Helm revision/digest로 복구할 때도 queued/sending의 암호문을 읽는 키와 버전은 유지한다.
`mailEnabled=false`는 적재도 중지하여 새 업무 메일을 잃으므로 일시 발송 정지로 사용하지 않는다.
SMTP fallback·sent 재적재·암호화 키 재생성은 하지 않는다. 삭제된 본문은 정상 재발급으로만 다시 만든다.

증거에는 PR·commit·image digest·Helm revision·원본 VersionId·초대/outbox ID·상태와 비밀을 제거한 결과만 남긴다.
