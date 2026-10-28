# 0045. 정상 CLI 토큰 교환 본문에만 두 탐지의 후속 차단 예외를 둔다

## Status

Accepted — PROJ-269 실제 인증에서 확인한 오탐 수정. ADR 0027의 SSRF·RFI 두 Body label 후속 차단 조건만 부분 대체한다. ADR 0044의 authorize query 예외와 그 밖의 정책은 유지한다. 실제 배포·인증 성공은 별도 검증한다.

## Context

정상 OIDC authorize의 loopback callback 이후 POST `/api/v1/auth/cli/token`이
`EC2MetaDataSSRF_Body`·`GenericRFI_Body` 탐지를 거쳐 `AppBodyLabelBlock`에서 차단됐다.
원문 body·코드·verifier는 조회하거나 증거에 쓰지 않았다. 알려진 정상 요청에는 loopback `redirect_uri`가 있다.

backend `UserAuthController.CodeRequest`는 `code`·`redirect_uri`·`code_verifier` 문자열을 받고,
`UserAuthService.exchange`는 발급 코드와 PKCE·등록된 redirect를 검증한 뒤 잠금으로 코드를 한 번만 소비한다.
이는 정상 관리 로그인 helper의 기존 계약이며 telemetryctl rc.2 설치 바이너리의 요청 형식 변경이 아니다.
앱 계약·토큰 소비는 그대로 두고 dev WAF 구현만 좁히는 단일 레포 결정이다.

AWS JSON body 검사는 JSON 전체의 유효성 검사를 보장하지 않는다. 파싱이 성공하면 invalid fallback도
적용되지 않으며, 설정 생략 시 파싱 오류 이전의 일부 내용만 평가할 수 있다. 이 예외의 근거로 삼지 않는다.

## Decision

1. `AppBodyLabelBlock`의 SSRF·RFI 두 Body label만 다음 조건 전체를 만족할 때 제외한다.
   다른 일곱 Body label은 여전히 독립적으로 Block한다. 일반 Allow·그룹 제외·override 변경은 없다.
2. 원문 method `POST`, 원문 URI `/api/v1/auth/cli/token`, `application/json` content type을 요구한다.
   media type의 대소문자와 선택 `charset=utf-8`만 허용한다. `/api/v1/auth/token` 별칭은 예외가 아니다.
3. `Body` 원문에 `NONE` 변환과 `OversizeHandling: NO_MATCH`를 명시하고, 1,024바이트 이하로 한정한다.
   JSON 파서·URL/HTML/JSON decode·부분 내용 fallback을 사용하지 않는다. 8KB ALB 검사 한도를 넘겨도
   예외 조건은 false이므로 해당 두 label의 기존 Block이 유지된다.
4. 원문 전체 `\A`·`\z` 경계의 문법으로 정확히 세 string key/value를 가진 JSON object를 요구한다.
   JSON 공백 네 종류(space/tab/CR/LF), 모든 필드 순서와 바깥 공백을 허용한다. 각 필수 key/value의
   구조 경계를 함께 검사하므로 추가·누락·중복 key, 배열·중첩 object·null·숫자, 주석·trailing comma·
   잘린 JSON·이어 붙인 문서는 예외가 아니다. key와 값의 backslash escape·Unicode escape는 해석하지 않는다.
5. `code`는 `uac_` 뒤 43자 base64url, `code_verifier`는 RFC 7636 unreserved 43~128자다.
   `redirect_uri`는 256자 이하이며 ADR 0044와 동일한 `http://127.0.0.1:<port>/callback` 또는
   `http://[::1]:<port>/callback`만 허용한다. 명시 포트 1~65535와 선행 0은 허용하고
   userinfo·query·fragment·다른 host/path/scheme은 제외한다.
6. query·URI·header·국가·IP·rate 및 sampling·redaction·data protection은 그대로 유지한다.
   이 조건은 인증을 대신하지 않으며 실제 코드·PKCE·만료·소비 검증은 backend가 수행한다.

## Alternatives Considered

- `JsonBody`의 세 경로만 검사: 추가/중복 key·invalid JSON 전체 검증을 보장하지 못하므로 채택하지 않는다.
- 한 필드의 loopback 문자열만 검사하거나 인증 route 전체 Allow: 다른 본문 공격과 후속 정책까지 건너뛰므로 채택하지 않는다.
- 필드 순서를 고정한 단일 정규식: JSON 의미와 무관한 직렬화 순서에 의존하므로 채택하지 않는다.

## Consequences/Tradeoffs

### Positive

정상 관리 로그인과 기존 backend 소비 계약을 유지하면서 실제 두 오탐의 후속 차단만 좁힌다.
완전한 원문 문법·세 필수 필드·길이·oversize 조건을 함께 검사하여 부분 파싱의 예외 확대를 방지한다.

### Negative

유효 JSON이라도 escape를 사용한 동등한 표현, 1KB를 넘는 공백과 드문 content type 표현은 예외를 받지 못한다.
일반 JSON serializer의 현재 ASCII 요청은 포함되며, 새로운 client 표현을 허용하려면 계약과 정책을 다시 검토한다.
WCU가 추가되며 합성 fixture·CheckCapacity만으로 실제 인증·탐지 동작을 증명하지 못한다.

## Acceptance Criteria

- 필드 순서 6종·JSON 공백·두 host·포트/길이 경계와 Python helper의 기본 직렬화가 예외에 해당한다.
- unknown/duplicate/escaped key, malformed/truncated/oversize JSON, 잘못된 code/verifier/redirect는 예외에서 제외한다.
- 다른 Body label 동시 탐지·query·rate·그룹·로그 설정과 prod/cicd가 유지된다.
- build·전체 회귀·prod A/B/dev/cicd synth·실제 AWS CheckCapacity·독립 검토·CI를 통과한다.
- 병합·dev 배포 후 새 정상 OIDC 세션의 token 교환 성공과 비밀 없는 공격 fixture의 차단을 따로 기록한다.

## References

- [ADR 0027](0027-dev-alb-waf-policy.md), [ADR 0044](0044-dev-waf-cli-oidc-loopback-query-exception.md)
- backend `UserAuthController.CodeRequest`, `UserAuthService.exchange`·`validateRedirect`
- [AWS JsonBody](https://docs.aws.amazon.com/waf/latest/APIReference/API_JsonBody.html)
- [AWS Body oversize](https://docs.aws.amazon.com/waf/latest/APIReference/API_Body.html)
- [AWS regex syntax](https://docs.aws.amazon.com/waf/latest/developerguide/waf-regex-pattern-support.html)
