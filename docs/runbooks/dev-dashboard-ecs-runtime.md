# dev dashboard ECS runtime 입력과 로컬 검증

PROJ-230은 네 DB 연결 helper와 enrollment JWT writer를 제공한다. PROJ-221은 dashboard
서비스·공개키 writer·전용 TG·backend dev 재배포 권한을 연결한다. 원본은 `DevDataStack`의 기존 `ISecret`이며 실제 키 생성·등록·DB 계정 준비는
[공통 준비 런북](dev-dashboard-prerequisites.md)과 ADR-0030·0031의 수동 절차를 따른다.
이 구현과 fixture 검증은 실제 원본·이미지·AWS 배포의 존재를 증명하지 않는다.
기존 Cognito 연결은 [OIDC 준비·배포 런북](dev-oidc-prerequisites.md)과
[ADR-0032](../adr/0032-dev-oidc-client-secret-runtime-supply.md)을 따른다.
외부 ACM 인증서를 연결하는 선택적 HTTPS와 두 단계 적용·복구는
[dev ALB HTTPS 런북](dev-alb-https.md)을 따른다. 인증서 연결은 기존 공개 URL·endpoint output을 바꾸지 않는다.

## 명시적 입력

dev 합성에는 `-c devDashboardRuntimeFile=/접근제한/배포/runtime.json`이 필수다.
파일 누락·잘못된 JSON·불완전 설정은 실패한다. prod·cicd에는 이 입력을 요구하지 않는다.
`test/fixtures/dashboard-runtime.json`은 **로컬 검증 전용** 구조 예시다. 계정·digest·VersionId와
운영 수치는 가짜 값이며 배포 기본값이 아니다. 실제 입력은 저장소 밖에 보관한다.

- `writerImage`: 외부 공급한 `soma-376/jwt-key-writer@sha256:...` ARM64 이미지의 ECR URI.
- `userAuth`: 개인키·공개키 `VersionId`, `activeKid`, 전체 `publicKeys`의 `kid`/안전한 `.pem` alias,
  `issuer`, `audience`, 정확한 `allowedOrigins` 목록. 공개키 버전의 kid 집합과 맵이 같아야 한다.
- `oidc`: 생략은 비활성이다. `enabled:false`와 `clients:[{key:...}]`로 빈 원본만 선언할 수 있다.
  활성화에는 HTTP/HTTPS `callbackBaseUrl`, 각 client의 고정 `versionId`, `userAuth.allowedRedirectUris`가 필요하다.
  `callbackRegistrationId` 기본값은 `oidc`이며 선택적 `failureRedirectUri`는 허용 복귀 주소여야 한다.
  이 JSON의 모든 client key는 CDK 원본 선언이므로 EKS에서 소비하는 key도 유지한다.
- `dashboard`: `managementEnabled`, `mailEnabled`, backend 계약의 모든 `settings`.
  두 flag는 현재 `false`만 허용한다. 관리 응답/메일 암호화키와 transport 설정 공급은 별도 작업이며,
  선행 설정 없는 활성화는 합성 단계에서 거부한다. 설정 값은 문자열이다. duration은 정수와 `ms`, `s`, `m`, `h`, `d` 단위이며 양수 제한과 ingest 시간 관계를 검사한다.

ARN·DB endpoint는 CDK가 소유한다. PEM·비밀번호·token 원문, 미지의 필드는 입력할 수 없다.
EKS 생성기의 runtime YAML은 같은 `userAuth`·`dashboard`·`oidc` 구조를 사용하고 `writerImage`를 제외한다.
같은 릴리스의 VersionId·kid 맵·issuer·audience·origin과 앱 이미지 digest를 함께 기록한다.
ECS 앱 이미지는 기존 `devImageTag` 입력으로 선택하므로, ECS/EKS 비교 시 그 태그의 실제 digest를
외부 릴리스 기록과 대조해야 한다. 이 로컬 검증은 ECR manifest를 조회하지 않는다.
OIDC URL 입력은 HTTP도 허용하지만 현재 backend와 Cognito의 원격 로그인에는 HTTPS가 필요하다.
입력·합성 통과가 HTTP 로그인 지원을 의미하지 않으며 [OIDC 런북](dev-oidc-prerequisites.md)의 인증 경계를 따른다.

## 파일 공급과 권한

독립 Node.js 24 writer 모듈은 `runtime/jwt-key-writer/`에 있다. 이미지 빌드·공급은 별도 작업이다.
writer는 task별 host 경로 없는 volume에 RW로 접근하고 앱은 RO로 접근한다.
완성된 파일은 `/mnt/user-jwt/keys/`에 게시한다. 앱 UID/GID는 10001이며 파일 0440과
디렉터리 접근을 검사한다. enrollment는 개인키와 공개키, dashboard는 공개키만 소비한다.
ingest에는 JWT 권한·컨테이너·mount를 추가하지 않는다.

writer의 task role은 지정 ARN의 `GetSecretValue`만 받는다. 앱과 writer는 ECS task role을
공유하며 컨테이너 단위 IAM 경계가 아니다. DB credential 주입과 ECR pull은 execution role이다.
writer는 essential=false, 앱은 SUCCESS 의존성이다. writer의 startTimeout은 60초다.
SDK 연결 2초·요청 5초·최대 3회와 전체 30초 제한을 사용하며 예약 64 MiB·상한 128 MiB다.
이 수치는 초기 설정이며 실제 ARM64 실행·OOM·ECS placement로 검증해야 한다.

공개키 맵은 `SPRING_APPLICATION_JSON`의 bracket map으로 생성한다. PEM은 환경변수나
CloudFormation에 들어가지 않는다. 기존 backend의 빈 `local` 항목은 앱의 기존 필터가 제외한다.
키 교체는 verifier 전체 → signer → 마지막 구 발급 후 330초 이상 → 구 공개키 제거 순서이며
일반 task 시작에서 생성·등록·자동 회전을 수행하지 않는다.

OIDC 활성화 시 enrollment execution role만 client별 원본 조회 권한을 받고 ECS `secrets`가
고정 VersionId의 전체 SecretString을 내부 환경변수로 공급한다. `SPRING_APPLICATION_JSON`은
기존 JWT 맵과 정확한 client key의 placeholder 맵을 함께 갖는다. 원문은 합성·일반 environment에 없다.
JWT writer는 OIDC secret을 다루지 않는다. dashboard·ingest에는 OIDC 설정·권한을 추가하지 않는다.
빈 원본 생성 → 운영자 값 등록 → 활성화 배포 순서이며 아직 없는 버전을 참조하면 task 시작이 실패한다.

## 로컬 관문과 미실행 항목

`npm run build`, `npm test -- --runInBand`, writer 디렉터리의 `npm test`,
`python3 scripts/test-oidc-config.py`를 실행한다. OIDC JVM fixture는 실제 backend 설정 DTO와 Spring Boot에서
ECS 환경변수·EKS configtree의 synthetic 값 및 JWT 맵 보존을 검사하며 AWS·Cognito를 호출하지 않는다.
fixture account와 AZ context를 사용해 lookup 없는 synth를 수행한다. writer는 AWS mock과
매번 생성하는 시험 키로 버전·맵·RSA·키쌍·경로·권한·deadline·비밀 없는 오류를 검사한다.

Docker daemon이 없는 환경에서는 이미지 실행과 UID10001의 Linux/Docker 동작·메모리 상한을
검증한 것으로 기록하지 않는다. CDK의 SUCCESS 의존성 검사는 실제 ECS 실패 시 미기동 증거와
구분한다. 실제 Secret 조회, 이미지 push, DB 준비, CDK/Helm 배포, 인증·snapshot·복구 검증은
이 작업에서 수행하지 않는다.

## PROJ-221 서비스와 라우팅

dev는 enrollment-api·telemetry-ingest·dashboard-api·clickhouse 네 서비스다. dashboard는
8081·bridge·동적 host port·1024 MiB 소프트 예약이며 기존 app capacity provider와 0/100
교체 정책을 공유한다. 앱 셋의 3072 MiB에 writer 두 개의 64 MiB 예약을 더하면 3200 MiB다.
실제 placement와 동시 peak 여유는 배포 후 확인해야 한다.

`lib/dev/app-routing.ts`가 허브 계약의 path·method·OPTIONS를 ECS/EKS 공통으로 설치한다.
조직 onboarding·invitations GET과 auth/me는 enrollment에 남고 dashboard GET과 기존 쓰기를
분리한다. preflight는 지원 path와 Access-Control-Request-Method가 모두 맞을 때만 전달한다.
HEAD·미지원 method·여분 segment·공개 health 경로는 default 404다. 기존 OTLP 세 경로는
priority 1의 path 조건을 유지한다. vendor catalog 두 경로의 WAF 검사만 추가하고 기존 넓은
조직/auth 검사·등록 rate 세 조건·OTLP Count/Block 경계를 유지한다.

backend dev 역할에는 dashboard-api의 UpdateService/DescribeServices만 추가한다.
기존 ECR 공급 권한과 prod·다른 역할·trust는 보존한다. 앱 레포 workflow는 이 변경에서 수정하지 않는다.
