# 0044. 정상 CLI OIDC loopback 요청에만 두 query 탐지의 후속 차단 예외를 둔다

## Status

Accepted — PROJ-269 실제 검증에서 확인한 오탐 수정. ADR 0027의 query 후속 Block 중 아래 두 label의 조건만 부분 대체한다. 실제 배포·정상 인증·공격 차단 증거는 별도다. [ADR 0054](0054-dev-local-web-oidc-callback.md)가 고정 로컬 웹 콜백을 query 예외에 추가하며 나머지 조건은 유지한다.

## Context

dev의 정상 CLI OIDC Authorization Code + PKCE 요청이 `/api/v1/auth/oidc/authorize`에서 403으로 차단됐다.
보호된 로그에서 `EC2MetaDataSSRF_QueryArguments`와 `GenericRFI_QueryArguments`가 Count로 탐지된 뒤
`AppQueryLabelBlock`이 종료한 사실을 확인했다. query는 redaction 상태였으므로 원문 매칭 문자열을 기록하지 않는다.
기존 HTTPS 웹 callback은 인증 제공자로 이동했고, 이번 요청의 알려진 차이는 loopback callback이다.

backend `UserAuthService.validateRedirect`는 등록된 웹 주소 외에도 명시 포트의
`http://127.0.0.1:<port>/callback`과 `http://[::1]:<port>/callback`을 허용한다.
`LoginRequestResolver.resolve`는 필수 파라미터의 단일 값과 PKCE·회사·회원 조건을 검증한다.
앱 계약을 바꾸지 않고 infra의 query 예외를 그 정상 흐름에 맞춰 좁히는 단일 레포 결정이다.

## Decision

1. 기존 `AppQueryLabelBlock`에서 SSRF·RFI 두 query label만 다음 조건 전체를 만족할 때 후속 Block에서 제외한다.
   전체 Allow 규칙, 관리형 그룹 scope-down/override 변경, 등록·나머지 rate 변경은 추가하지 않는다.
2. method는 원문 `GET`, URI는 원문 `/api/v1/auth/oidc/authorize`와 정확히 같아야 한다.
3. query는 URL_DECODE 한 번으로 검사하며, 정확히 다섯 필수 파라미터 또는 `login_hint`를 포함한 여섯 파라미터만 허용한다.
   순서는 자유다. 항목 수와 각 필수 key/value의 경계를 함께 확인하므로 알 수 없는 key·중복 key·빈 항목은 예외가 아니다.
   원문 `%26`은 예외에서 제외하여 decode 이후 생긴 `&`를 실제 파라미터 구분자로 오인하지 않는다.
4. `redirect_uri`는 backend와 같은 두 loopback host, 소문자 `http`, 명시 포트 1~65535, 정확한 `/callback`,
   decode한 URI 길이 256자 이하를 요구한다. 포트의 선행 0은 허용한다. userinfo·query·fragment·다른 host·path·scheme은 제외한다.
5. 나머지 값은 정상 CLI가 생성하는 좁은 형식으로 제한한다. `tenant_id`는 표준 UUID,
   `state`는 16~256자 URL-safe opaque 문자열, `code_challenge`는 43자 base64url,
   `code_challenge_method`는 `S256`, 선택 `login_hint`는 254자 이하 일반 ASCII 이메일이다.
   이 예외 밖의 backend 유효 입력도 자동 허용하지 않으며 기존 WAF 판정과 앱 검증을 따른다.
6. 다른 query label, 본문·URI·header·국가·IP·rate 차단은 계속 적용한다. 정상 loopback 형식에 SQLi 등 다른 label이 함께 있으면 차단한다.
   query/자격 헤더 마스킹, match 상세 보호, sampling 비활성화와 로그 보존은 유지한다.

## Alternatives Considered

- 인증 경로 전체 Allow 또는 관리형 그룹 제외: 다른 공격·국가·IP·rate 차단까지 건너뛰므로 채택하지 않는다.
- `redirect_uri` 단일 값의 regex만 검사: AWS의 중복 query 값 OR 검사와 다른 파라미터의 공격 문자열을 놓칠 수 있어 채택하지 않는다.
- helper에서 인코딩/호스트 표현을 바꿔 탐지를 회피: 공개 계약과 배포 정책의 충돌을 해결하지 않으므로 채택하지 않는다.

## Consequences/Tradeoffs

### Positive

정상 CLI PKCE 로그인과 기존 웹 로그인을 보존하면서 두 확인된 오탐의 차단 조건만 좁힌다.
기존 인증·redirect 검증은 계속 backend가 수행하며 WAF 통과를 인증 성공으로 취급하지 않는다.

### Negative

query 문법과 backend의 redirect 계약을 함께 관리해야 한다. 드문 이메일·state 표현은 이 좁은 예외를 받지 못할 수 있다.
regex·크기 조건의 WCU가 추가되며 합성 테스트만으로 AWS PCRE 수용·관리형 탐지 동작을 증명할 수 없다.

## Acceptance Criteria

- 합성 statement fixture가 두 loopback host·포트 경계·파라미터 순서·선택 hint의 정상 요청을 검증한다.
- 잘못된 host/port/path/scheme/userinfo/query/fragment, 길이 초과, unknown/duplicate key, 인코딩된 구분자·이중 인코딩을 예외에서 제외한다.
- 두 label 외 query 공격·본문·URI 차단과 기존 rate 범위·응답·logging 정책이 유지된다.
- build·필수 회귀·prod/dev/cicd synth 후 서비스 `CheckCapacity`로 regex와 WCU를 확인한다.
- 실제 dev 배포 후 정상 CLI/웹 authorize와 공격 fixture 차단을 확인하고 query·code·token 없이 판정만 기록한다.

## References

- [ADR 0027](0027-dev-alb-waf-policy.md), [설치 WAF 런북](../runbooks/dev-installation-waf.md)
- backend `apps/enrollment-api/.../auth/OidcLoginConfig.kt`의 `LoginRequestResolver.resolve`
- backend `libs/security/.../user/UserAuthService.kt`의 `validateAuthorizationRequest`·`validateRedirect`
- [AWS query parameter 검사](https://docs.aws.amazon.com/waf/latest/developerguide/waf-rule-statement-fields-list.html)
- [AWS regex 제약](https://docs.aws.amazon.com/waf/latest/developerguide/waf-regex-pattern-support.html), [RegexMatchStatement](https://docs.aws.amazon.com/waf/latest/APIReference/API_RegexMatchStatement.html)
