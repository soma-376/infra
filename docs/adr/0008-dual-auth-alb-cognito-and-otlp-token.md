# 0008. 인증 이원화 - 대시보드는 ALB authenticate-cognito, OTLP는 ALB jwt-validation

## Status

Proposed (부분 미결 - HTTPS/도메인 확보 방식 미정)

## Context

대시보드 사용자(브라우저)와 AI Tool(비대화형 클라이언트)의 인증 흐름은 서로 다르다. 대시보드는 브라우저 리다이렉트 기반의 로그인 플로우를 사용할 수 있지만, AI Tool은 리다이렉트 기반 Cognito 인증을 따라갈 수 없는 비대화형 클라이언트다. 한편 OTel(OpenTelemetry) 신호를 수신하는 엔드포인트는 인가된 사용자만 사용하도록 제한해야 하며, 인증되지 않은 트래픽은 VPC에 진입하기 전에 차단하는 것이 바람직하다.

## Decision

두 경로 모두 ALB 단에서 인증을 종결한다.

- `/api/*` 경로는 authenticate-cognito 액션(브라우저 리다이렉트 플로우)을 거친 뒤 대시보드 타깃 그룹으로 forward한다.
- `/v1/*`(OTLP: `/v1/traces`, `/v1/metrics`, `/v1/logs`) 경로는 jwt-validation pre-routing 액션을 거친다. AI Tool이 요청 헤더에 실어 보내는 Cognito 액세스 토큰(JWT)의 서명, iss(issuer), exp(만료)를 ALB가 검증한 뒤 Collector로 forward한다. JWKS endpoint는 Cognito User Pool의 `/.well-known/jwks.json`을 사용하고, Issuer는 User Pool URL로 지정한다. 검증에 실패하면 ALB가 요청을 거부한다.
- 앱(Collector/API 서버)에는 사용자와 조직 간 매핑 등 인가(authorization) 로직만 남긴다. 인증(authentication) 자체는 전적으로 ALB가 책임진다.

## Constraints

- jwt-validation 액션은 RS256 알고리즘만 지원한다. Cognito가 발급하는 토큰은 RS256이므로 이 조건을 충족한다.
- jwt-validation은 JWKS 응답이 150KB 이하이고 키 개수가 10개 이하여야 한다는 제약이 있다. Cognito User Pool의 JWKS는 이 조건을 충족한다.
- authenticate-cognito, jwt-validation 모두 HTTPS 리스너를 필수로 요구하므로, 도메인과 ACM 인증서 확보가 선행되어야 한다.
- jwt-validation은 비교적 최신 ALB 기능이라 CDK L2 construct에서 아직 지원하지 않을 수 있다. 이 경우 `CfnListenerRule`(L1)로 직접 정의해야 한다.

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

- 도메인 확보 방식이 아직 정해지지 않았다. 도메인 확보가 어려운 것으로 판명되면, 인증 전체를 API 서버(Spring Security + Cognito JWT 검증) 및 Collector의 auth extension으로 내리는 폴백 구성을 검토한다.
