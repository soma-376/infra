# 0054. dev OIDC에 로컬 웹의 고정 콜백을 허용한다

## Status

Accepted — PROJ-305. ADR 0044의 query redirect 범위만 부분 확장한다. 실제 배포·로그인 검증은 별도다.

## Context

로컬 웹에서 dev API에 로그인하면 `http://localhost:3000/auth/callback`을 사용하는
OIDC authorize 요청이 ALB 측 HTML 403으로 거부된다. 같은 요청의 redirect만 등록된 dev HTTPS
콜백으로 바꾸면 Cognito authorize로 302 이동한다. 정확한 종료 규칙은 WAF 로그 확인 전이다.
`lib/dev/waf.ts`의 기존 예외는 CLI loopback이며, `config/dev/runtime.yaml`의 웹 콜백 목록에도
localhost가 없다. CORS allowedOrigins 등록만으로 redirect 허용 조건을 충족하지 못한다.

## Decision

1. dev runtime의 `userAuth.allowedRedirectUris`에 정확한 `http://localhost:3000/auth/callback`을 추가한다.
2. ADR 0044의 두 query label 예외에 같은 주소만 더한다. 기존 CLI host/port/path 범위는 그대로다.
3. 정확한 authorize GET, 필수 다섯 항목과 선택 login_hint, PKCE S256, 길이·중복·인코딩 검사를 공유한다.
   다른 port, scheme, host, path, userinfo, query, fragment는 로컬 웹 예외가 아니다.
4. 다른 query·body·header·URI 탐지, geo/IP/rate 차단과 로그 보호를 유지한다. 전체 Allow는 추가하지 않는다.
5. CLI token body 예외에는 웹 주소를 추가하지 않는다. Cognito 자체 callback은 기존 dev API 주소를 유지한다.

## Alternatives Considered

- localhost 전체/모든 포트 허용: 현재 개발 흐름보다 넓은 범위이므로 채택하지 않는다.
- WAF만 수정: backend redirect 검증이 남아 로그인할 수 없으므로 함께 수정한다.
- dev 웹에서만 검증: 로컬 프론트 변경을 dev API와 연결해 확인할 수 없어 채택하지 않는다.

## Consequences/Tradeoffs

### Positive

로컬 웹 로그인과 기존 CLI/HTTPS 웹 로그인을 같은 dev API에서 검증할 수 있다.

### Negative

개발 포트 변경 시 WAF와 runtime 허용 목록을 함께 검토해야 한다. 합성 테스트는 실제 관리형
signature·AWS PCRE 동작·인증 성공을 증명하지 못한다. localhost는 로그인하는 브라우저의 기기다.

## Follow-up

- 머지 후 DevEdgeStack과 enrollment runtime Helm 변경을 각각 반영한다.
- 배포 전 CheckCapacity, 배포 후 실제 브라우저 PKCE 왕복과 차단 회귀를 확인한다.

## Acceptance Criteria

- 합성 statement에서 로컬 웹 정상 요청과 기존 CLI를 허용하고 변형 주소·중복·다른 공격 label은 차단한다.
- runtime parser가 로컬 콜백과 기존 HTTPS 콜백을 보존한다.
- build·테스트·환경별 synth를 통과하고 prod/cicd 자원 변경이 없다.

## References

- [ADR 0044](0044-dev-waf-cli-oidc-loopback-query-exception.md)
- [배포·검증 런북](../runbooks/dev-installation-waf.md)
- backend `UserAuthService.validateRedirect`, `LoginRequestResolver.resolve`
