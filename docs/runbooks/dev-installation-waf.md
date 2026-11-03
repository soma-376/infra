# dev 설치 경로 WAF 적용·검증·복구

기준은 ADR 0027·0044·0045와 PROJ-269다. 정확한 `/unix`, `/windows`와 기존 등록 API 세 조건이
출발지 IP별 300건/300초를 공유한다. bootstrap 두 조건은 URL_DECODE 한 번을 적용하여
`/%75nix`·`/%77indows` 같은 단일 인코딩 경로도 같은 예산에 넣고 나머지 예산에서 제외한다. `429`·`Retry-After: 60`은 재시도 안내이며 정확한 해제 시각은 아니다.

## 적용

1. 최신 `develop`에서 `npm run build`, `npm test -- --runInBand`, prod/dev/cicd synth를 실행한다.
2. 추적된 `config/dev/deployment.json`으로 합성하고 현재 DevEdgeStack 템플릿과 비교한다.
   WebACL의 등록·나머지 rate 범위에 두 URL_DECODE exact path가 이동하고, 정상 CLI OIDC loopback query에만
   SSRF·RFI 후속 Block 예외가 추가된다. ADR 0045 후속 변경은 정상 CLI token POST의 두 Body label
   조건만 좁힌다. 이외 변경이 있으면 먼저 원인을 확인한다.
3. 현재 EKS ALB ARN에 연결된 Web ACL과 관리형 버전 가용성을 읽고 합성 Rules의 `CheckCapacity`를 확인한다.
4. PR CI·필수 리뷰와 병합을 확인한 뒤 dev profile로 DevEdgeStack만 `--exclusively` 배포한다.
   다른 스택, prod, Helm 앱은 이 정책 변경의 배포 대상이 아니다.
5. 배포된 Web ACL의 `EnrollmentRateBlock`·`RemainingRateBlock`·`AppQueryLabelBlock`·`AppBodyLabelBlock`, association ARN을 다시 조회한다.

## 배포 전 경로 확인

2026-10-28 dev에 코드 없는 GET을 `curl --path-as-is`로 확인했다. `/unix`·`/%75nix`·`/u%6eix`,
`/windows`·`/%77indows`는 같은 bootstrap missing-code 400 응답이었다. `/unix/`·`/windows/`,
`/unix;foo`·`/windows;foo`, `//unix`·`/%2funix`·`/%2575nix`는 ALB 기본 404였다.
`/x/../unix`는 403, `/./unix`는 bootstrap과 다른 일반 Bad Request 400으로 거부되었다.
이 표본은 단일 URL_DECODE rate 보완의 근거이며 모든 URI 정규화의 동등성이나 배포 후 rate 차단 증거는 아니다.

## 실제 검증

- 사용자 승인된 dev 테스트 초대를 사용한다. 코드·토큰·query를 로그/증거/PR에 적지 않는다.
- 같은 출발지에서 `/unix`·`/windows`·`/api/v1/enroll`을 섞어 요청하되, 부하 생성에는 누락/무효 코드를
  사용한다. AWS 근사 판정 때문에 정확히 301번째 차단을 기대하지 않는다. 요청 횟수·시간·HTTP 상태·헤더만 남긴다.
- 429가 시작되면 세 경로와 인코딩 bootstrap 경로에서 `Retry-After: 60`을 확인한다. 차단 중 승인된
  유효 초대로 기존 enroll API를 한 번 호출하여 429와 같은 헤더를 확인한다. 요청 전후 DB를 읽어
  `used_at`·설치 수·멤버 상태가 변하지 않았음을 기록한다. 코드 원문은 출력하지 않는다.
- 다른 실제 출발지 IP(별도 dev 실행 위치)에서 정상 요청을 확인한다. 전달 헤더를 바꿔 다른 IP로 가장하지 않는다.
- 요청을 멈춘 뒤 회복을 확인한다. 공유 NAT의 정상 사용자 영향과 검증 시간대를 기록한다.
- 성공 증거에는 commit·PR·배포 시각·Web ACL ID·실제 요청 상태 요약·비소비 비교 결과를 남긴다.
  template assertion이나 WAF 로그의 COUNT만으로 실제 차단 완료를 표시하지 않는다.

## CLI OIDC 오탐 회귀 검증

배포 전 확인된 403은 정확한 `/api/v1/auth/oidc/authorize`의 `EC2MetaDataSSRF_QueryArguments`와
`GenericRFI_QueryArguments` label이 `AppQueryLabelBlock`에서 종료된 요청이다. query 원문은 계속 마스킹한다.
ADR 0044는 원문 GET·URI·필수 다섯 파라미터와 선택 hint·loopback URI 전체가 검증된 경우에만 이 두 label을 제외한다.

- 배포 전에 합성 Rules의 `CheckCapacity`가 성공하는지 확인한다. 2026-10-28 최종 후보는 1,407 WCU로 서비스 검증을 통과했다.
  불필요한 OR 직접 중첩은 평탄화했다. 합성 테스트와 `CheckCapacity`는 실제 요청 차단 검증을 대체하지 않는다.
- 정상 CLI PKCE 요청의 loopback과 기존 HTTPS 웹 callback이 제공자 authorize로 이동하는지 확인한다.
  실제 로그인은 정상 브라우저·callback·token 교환을 사용하며 로그/증거에 URL query·코드·토큰을 쓰지 않는다.
- 무인 공격 검증은 별도 비밀 없는 fixture로 수행한다. SSRF/RFI label을 유발하는 잘못된 redirect, 중복/unknown key,
  인코딩 구분자, 다른 query 공격 label 동시 탐지가 계속 403인지 확인한다. WAF가 탐지하지 않은 fixture는
  backend 400일 수 있으므로 403과 동일한 증거로 기록하지 않는다.
- 실제 로그에서는 URI·action·terminating rule·label·query redaction 여부만 수집한다. 모든 header/query 출력은 금지한다.
- 국가·IP·header·본문·URI·remaining rate 정책과 기존 sampling/data protection의 변경이 없어야 한다.

## CLI token 교환 본문 오탐 회귀 검증

정상 authorize 이후 POST `/api/v1/auth/cli/token`에서 SSRF·RFI 두 Body label과 `AppBodyLabelBlock` 종료를
확인했다. ADR 0045는 정확한 POST·원문 URI·JSON content type과 원문 본문 전체의 엄격한 세 필드 조건에만
두 label 예외를 적용한다. 본문은 1KB 이하, ALB 검사 한도 초과는 `NO_MATCH`로 예외를 닫는다.
JSON parser fallback이나 escape 변환은 사용하지 않는다.

- 최신 head의 전체 검사와 실제 `CheckCapacity` 이후, 기존 배포 대비 WebACL Rules의 의도한 변경만 있는지 확인한다.
  ADR 0045 후보는 1,440 WCU로 서비스 검증을 통과했고, 이전 query 수정 template와 비교하여
  `AppBodyLabelBlock` 이외의 11개 규칙·다른 리소스·로그 설정이 동일했다. 이는 실제 인증 성공 증거가 아니다.
- 새 정상 OIDC 세션으로 authorize → loopback callback → token 교환을 완료하고 API 인증을 확인한다.
  기존 code/verifier를 재사용하거나 실제 token·본문·요청 URL을 출력하지 않는다.
- 실패 응답은 비공개 600 파일에서만 검사한다. 공유 증거는 HTTP 상태·URI·terminating rule·label·시간으로 제한한다.
- 별도 비밀 없는 synthetic fixture로 중복/추가 key·잘린 JSON·oversize·잘못된 callback/PKCE와 다른 Body label의
  동시 탐지가 예외를 받지 않는지 확인한다. WAF 탐지 403과 backend 계약 거부 400/401을 구분한다.
- token endpoint의 code/PKCE/만료/원자적 1회 소비 검증과 query·header·rate 정책이 그대로임을 확인한다.

## 복구

배포 전 DevEdgeStack 템플릿·배포 commit을 보관한다. backend DB 사전 검증(PROJ-268)을 이미 공개했다면
먼저 그 기능을 포함하지 않은 검증된 enrollment 이미지로 되돌린 뒤 이전 정책 commit의 DevEdgeStack만
동일 profile로 배포한다. ALB/association·나머지 정책을 삭제하거나 rate 규칙을 임시 비활성화하지 않는다.
배포 후 경로 분류·정상 요청·차단 회복을 재확인한다.

## 로컬 웹 OIDC 콜백 (PROJ-305·ADR 0054)

- `http://localhost:3000/auth/callback`만 웹 예외다. 다른 포트와 `127.0.0.1` 별칭은 포함하지 않는다.
- PR 검증은 합성 statement와 runtime parser까지만 입증한다. 실제 차단 규칙은 보호된 WAF 로그의
  action·terminating rule·label로 확인하고 query·쿠키·code·token은 출력하지 않는다.
- 배포 전 합성 Rules로 `CheckCapacity`를 수행한다. DevEdgeStack의 WAF 변경과 추적
  `config/dev/runtime.yaml`을 사용하는 enrollment runtime Helm 변경을 모두 반영해야 한다.
  CDK 배포만으로 Helm ConfigMap이 갱신됐다고 판단하지 않는다. Helm은 기존 수동 배포 런북을 따른다.
- 프론트의 API origin 두 개는 dev API, BFF_ORIGIN은 `http://localhost:3000`으로 두고 새 로그인을 시작한다.
  Cognito 자체 callback은 기존 dev API 주소다. Cognito client에 localhost를 등록하는 변경은 필요하지 않다.
- 정상 브라우저에서 authorize → Cognito → dev API → localhost callback → BFF 세션 조회를 확인한다.
  기존 CLI·HTTPS 웹 로그인의 회귀도 확인한다. 주소의 port/path/host 변형, 중복 파라미터와 다른 공격 label은
  예외가 아니며 정상 형식의 요청도 다른 WAF 판정과 backend 인증 검증을 계속 받는다.
- 복구는 이 PR의 WAF 조건과 runtime callback 추가를 함께 되돌려 각각 재배포한다. 기존 HTTPS 웹과 CLI는 유지한다.
