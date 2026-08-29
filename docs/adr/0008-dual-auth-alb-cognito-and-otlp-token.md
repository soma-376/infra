# 0008. 인증 이원화 - 대시보드는 ALB authenticate-cognito, OTLP는 ALB jwt-validation

## Status

Superseded by [허브 ADR 0001](../../../docs/adr/0001-otlp-authentication-model.md) — ALB 단 인증(authenticate-cognito · jwt-validation)을 양 경로 모두 채택하지 않는다. ALB 는 TLS 종단만 담당하고, 토큰 인증은 애플리케이션 계층이 수행한다(dev·prod 동일). Cognito 는 사용하지 않는다. OTLP 인증 모델은 허브 ADR 이 소유한다.

## Context

대시보드 사용자(브라우저)와 AI Tool(비대화형 클라이언트)의 인증 흐름은 서로 다르다. 대시보드는 브라우저 리다이렉트 기반의 로그인 플로우를 사용할 수 있지만, AI Tool은 리다이렉트 기반 Cognito 인증을 따라갈 수 없는 비대화형 클라이언트다. 한편 OTel(OpenTelemetry) 신호를 수신하는 엔드포인트는 인가된 사용자만 사용하도록 제한해야 하며, 인증되지 않은 트래픽은 VPC에 진입하기 전에 차단하는 것이 바람직하다.

## Decision

두 경로 모두 ALB 단에서 인증을 종결한다.

- `/api/*` 경로는 authenticate-cognito 액션(브라우저 리다이렉트 플로우)을 거친 뒤 대시보드 타깃 그룹으로 forward한다.
- `/v1/*`(OTLP: `/v1/traces`, `/v1/metrics`, `/v1/logs`) 경로는 jwt-validation pre-routing 액션을 거친다. AI Tool이 요청 헤더에 실어 보내는 Cognito 액세스 토큰(JWT)의 서명, iss(issuer), exp(만료)를 ALB가 검증한 뒤 Collector로 forward한다. JWKS endpoint는 Cognito User Pool의 `/.well-known/jwks.json`을 사용하고, Issuer는 User Pool URL로 지정한다. 검증에 실패하면 ALB가 요청을 거부한다.
- 앱(Collector/API 서버)에는 사용자와 조직 간 매핑 등 인가(authorization) 로직만 남긴다. 인증(authentication) 자체는 전적으로 ALB가 책임진다.

> **대체 후의 모드 A / 모드 B 정의** — 다른 ADR(0017·0021·0022·0023)이 인용하는 "모드 A/모드 B"의
> 현행 정의는 *ALB 인증 유무*가 아니라 **TLS 종단 유무**다. `lib/prod/edge-stack.ts`의
> `isHttps = Boolean(certificateArn)` 한 줄이 분기한다 —
> 모드 A: 인증서 제공 → 443 HTTPS + 80→443 리다이렉트. 모드 B: 미제공 → 80 HTTP + synth 경고.
> 어느 모드든 토큰 인증은 앱 계층이 한다([허브 ADR 0001](../../../docs/adr/0001-otlp-authentication-model.md)).

## Constraints

- jwt-validation 액션은 RS256 알고리즘만 지원한다. Cognito가 발급하는 토큰은 RS256이므로 이 조건을 충족한다.
- jwt-validation은 JWKS 응답이 150KB 이하이고 키 개수가 10개 이하여야 한다는 제약이 있다. Cognito User Pool의 JWKS는 이 조건을 충족한다.
- authenticate-cognito, jwt-validation 모두 HTTPS 리스너를 필수로 요구하므로, 도메인과 ACM 인증서 확보가 선행되어야 한다.

## Alternatives Considered

- **Collector의 oidc auth extension에서 검증**: 미인증 트래픽이 VPC 내부까지 진입한 뒤에야 걸러지므로 기각.
- **API Gateway JWT Authorizer**: 요청당 과금이 추가되고 VPC Link 구성이라는 추가 인프라가 필요해 기각.
- **ALB 헤더 조건 + 고정 시크릿**: 사용자별 구분, 토큰 만료, 회수(revoke)가 불가능해 기각.

## Consequences/Tradeoffs

### Positive

- 미인증 신호가 VPC 내부까지 진입하지 못하게 되어 보안이 강화된다.

### Negative

- OTLP 클라이언트(AI Tool) 쪽에 토큰 발급과 갱신 플로우(client credentials 등)를 설계해야 하는 과제가 새로 생긴다.

## Follow-up

- **대체됨** — 이 ADR 의 인증 결정 전체가 [허브 ADR 0001](../../../docs/adr/0001-otlp-authentication-model.md) 로 대체됐다.
  토큰 검증은 앱 계층(현행 auth-proxy → backend Spring Security 이관, Cognito 무관)이 수행한다.
- 도메인·ACM 인증서 확보 방식은 여전히 미결이다 — 단 걸려 있는 것은 인증이 아니라 **TLS 종단**(모드 A 전환)이다.
- `lib/prod/edge-stack.ts` 의 Cognito 구축 코드(User Pool·`AuthenticateCognitoAction`)와 모드 A 의
  `/v1/*` `authenticateJwt` 는 **의도적 잔존**이다.
  Spring Security 대체 시 함께 걷어낸다.
