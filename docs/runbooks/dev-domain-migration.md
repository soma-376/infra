# dev 새 도메인 적용과 재배포 검증

대상은 프론트 `https://dev.pulsemetry.co.kr`와 백엔드 `https://api-dev.pulsemetry.co.kr`다.
[ADR-0040](../adr/0040-dev-public-origin-and-additional-certificates.md)에 따라 공개 URL과 인증서를 배포 입력으로 보존한다.
prod·DNS·ACM 발급·계정 생성은 이 절차에 포함하지 않는다.

## 1. 현재 적용값 확보

기존 AWS SSO와 EKS 운영자 터널로 접속한다. [EKS 런북](dev-eks-manual-deployment.md)의
전체 context, 고정 Secret 버전, 실제 이미지 digest를 유지한다. 현재 CloudFormation template·output,
ALB listener/certificate, ACM SAN·상태, Helm values/manifest/revision, Deployment를 접근 제한된
`RUN_DIR/before`에 저장한다. 토큰·쿠키·비밀번호·Secret 원문은 조회하거나 증거에 남기지 않는다.

과거 보고서의 runtime 파일은 현재 원본이 아니다. `helm get values`와 실제 Deployment가 다르면
차이를 먼저 해소한다. 특히 enrollment/ingest의 DB URL `sslmode=require`, ingest 모드와 tracing
sampling, 이미지, JWT·OIDC 버전을 확인한다. 현행 입력에서 표현하지 않는 override는 별도 파일로
보관하고 매번 생성 결과 뒤에 적용한다. 생성 결과만 수정하고 원본을 버리지 않는다.

## 2. CDK 입력

현재 전체 dev context에 다음 입력을 추가한다. account는 기존 `CDK_DEFAULT_ACCOUNT`를 사용한다.

| 입력 | 값 |
|---|---|
| `env` | `dev` |
| `devEksPublicBaseUrl` | `https://api-dev.pulsemetry.co.kr` |
| `devEksCertificateArn` | 현재 기본 인증서 ARN 유지 |
| `devEksAdditionalCertificateArns` | 현재 추가 인증서 목록에 새 API 도메인을 포함하는 인증서 ARN 추가 |
| `devEksAdditionalCertificateLogicalIds` | 이미 CFN이 관리하는 추가 인증서가 있으면 현재 ARN→logical ID 맵 |

추가 인증서는 native 배열 또는 JSON 배열 문자열로 전달한다. 기본 인증서와 중복하지 않는다.
리전·계정·ARN 검증과 별개로 실제 `ISSUED`, SAN과 DNS 연결을 확인한다. 기존 기본 인증서를
새 인증서로 덮어쓰지 않는다. 새 공개 URL은 경로·port·query·fragment 없는 HTTPS origin이다.
이미 배포된 인증서 연결의 ID가 ARN 해시 기반 ID와 다르면 호환 맵을 반드시 사용한다.
인증서를 추가한 뒤 같은 인증서의 기존 연결을 제거하는 change set은 허용하지 않는다.

전체 context로 합성하고 현재 **DevEdgeStack**과 비교한다. 기대 변경은 공개 URL output과 추가
`AWS::ElasticLoadBalancingV2::ListenerCertificate`뿐이다. ALB/listener/TG/WAF/라우팅 교체,
다른 dev 스택 또는 prod/cicd 변경이 있으면 적용하지 않는다. 검토한 change set만 실행한다.
이미 수동 연결된 인증서도 CDK에 선언해 후속 배포의 원본을 만든다.

## 3. runtime 원본과 Helm

현재 runtime 입력에서 아래 필드를 갱신하고, 기존 목록에 새 값을 추가한다.

| 필드 | 값 |
|---|---|
| `oidc.callbackBaseUrl` | `https://api-dev.pulsemetry.co.kr` |
| `oidc.failureRedirectUri` | `https://dev.pulsemetry.co.kr/auth/callback` |
| `userAuth.allowedOrigins` | `https://dev.pulsemetry.co.kr` 포함 |
| `userAuth.allowedRedirectUris` | `https://dev.pulsemetry.co.kr/auth/callback` 포함 |

`userAuth.issuer`는 접근 주소가 아니라 JWT 검증 식별자다. 기존 값·audience·키·버전을 유지한다.
localhost와 이전 도메인 허용값, `oidc.allowInsecureLocalhost`도 이 작업에서 제거하지 않는다.
OIDC client의 key·VersionId는 현재 입력을 보존하며 client Secret 원문을 저장하지 않는다.

CDK 적용 뒤 재조회한 Data·EKS·Edge output, 실제 이미지 digest, MSK bootstrap/list-nodes,
갱신한 **완전한** runtime 입력으로 `scripts/eks-values.mjs`를 실행한다. `ValidationPublicBaseUrl`은
enrollment의 `PULSEMETRY_PUBLIC_BASE_URL`이 된다. CORS는 enrollment/dashboard 양쪽,
callback·failure·allowed redirects는 enrollment에만 나타나야 한다.

현재 release의 전체 values를 보존한 override와 함께 렌더한다. DB TLS·tracing 등의 기존 override는
새 공개 URL을 다시 덮어쓰지 않도록 원본에서 갱신한다. 실제 적용 candidate와 현재 manifest를
구조적으로 비교하고, 도메인 관련 설정 외 차이가 없을 때만 runtime-config → enrollment → dashboard
순서로 적용한다. telemetry-ingest/Gateway/ClickHouse를 이 작업 때문에 재배포하지 않는다.
Helm upgrade에는 `--atomic --wait`와 기존 namespace `pulsemetry-dev`를 사용한다.

같은 원본으로 다시 생성해 candidate가 동일한지 확인하고, enrollment/dashboard의 동일 입력
재배포 후에도 두 앱이 Ready이며 다섯 설정과 issuer가 유지되는지 확인한다.

## 4. 프론트와 Cognito

프론트 dev Terraform의 `runtime.domain_name`, `runtime.certificate_arn`, 두 API upstream을 확인한다.
`BFF_ORIGIN`은 도메인에서 자동 생성된다. 이미지·AMI·자동 배포 flag·BFF key는 유지한다.
GitHub dev 환경의 `NEXT_PUBLIC_ENROLLMENT_API_URL`과 실제 배포 JS도 새 API origin이어야 한다.
빌드가 이미 올바르면 이미지 재빌드하지 않는다.

기본 배포 경로는 보호된 frontend-dev-apply CI다. 별도로 승인된 로컬 dev 적용은 같은 S3 backend와
계정 제한을 사용해 저장한 plan을 검토한 뒤 그 파일만 apply한다. 다른 프론트 CD 실행과 겹치지
않게 하고, 새 task가 같은 image digest·Secret 참조와 두 변경된 upstream만 갖는지 확인한다.

실제 dev Cognito client에서 아래 callback을 확인하고, 관리 주체와 입력 위치를 기록한다.
기존 callback을 제거하거나 prod 소유 client·스택을 임의로 바꾸지 않는다.

```text
https://api-dev.pulsemetry.co.kr/api/v1/auth/oidc/callback/oidc
```

2026-10-27 확인 시 `pulsemetry-dev-company-a/b` 두 풀의 `pulsemetry-dev-company-a/b-backend`
client에 위 callback이 등록돼 있었다. 이 값은 현재 CDK/Terraform이 소유하지 않으며,
기존 [OIDC 운영 절차](dev-oidc-prerequisites.md)의 운영자가 Cognito app client의
`CallbackURLs`에서 관리한다. 특정 개인·팀 담당자는 문서에서 확인되지 않았다.
EKS는 runtime의 `oidc.callbackBaseUrl`·client key/VersionId를, 조직 DB는 issuer/client ID/ref를
참조한다. backend의 `tools/dev-seed/config/cognito/`는 localhost용 공개 시드 입력이므로
배포 dev의 callback 원본으로 사용하지 않는다. 확인 과정에서 client Secret은 조회하지 않았다.

## 5. 검증과 복구

- TLS, 두 API의 새 origin CORS 허용·미허용 origin 거부, 익명 인증 거부, 프론트 로그인 화면을 확인한다.
  공개 `/api/v1/healthz`는 의도적으로 404이므로 장애로 해석하지 않는다. 앱 health는 TG와 내부 포트로 확인한다.
- 기존 활성 회원으로 로그인 → Cognito → backend callback → frontend callback → 조회·새로고침·
  세션 갱신·로그아웃을 확인한다. 새 origin에는 기존 세션 쿠키가 이전되지 않는다.
- 실패·취소·만료 복귀를 확인한다. 기록에는 URL의 origin/path만 남기고 code/state/token/cookie는 제외한다.
- 배포 dev에 로컬 전용 전체 E2E나 seed를 실행하지 않는다. 회원·데이터가 없으면 성공 로그인은
  **미검증**으로 기록한다. 401·CORS·Ready만으로 인증 완료를 선언하지 않는다.
- 실패하면 보관한 해당 release의 전체 values·revision과 이미지·Secret 버전을 사용해 복구한다.
  이전 공개 URL·추가 인증서 제거는 기존 도메인의 실제 TLS·로그인 지원을 확인한 뒤 판단한다.
  기본 인증서·키·DB·prod를 복구 과정에서 교체하지 않는다.

완료 기록은 코드/로컬 검증, AWS 적용, 재배포 유지, 실제 로그인 성공을 구분하고
[PROJ-261](https://team376.atlassian.net/browse/PROJ-261)에 증거 위치와 미통과 항목을 남긴다.
