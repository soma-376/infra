# 0032. dev OIDC client secret은 CDK 원본의 고정 버전을 ECS와 EKS에 공급한다

## Status

Accepted (로컬 구현·검증 대상, 실제 AWS 배포·Cognito 로그인 검증 별도)

ADR-0028·0031의 Secret 공급·보존 범위를 enrollment OIDC client secret으로 확장한다.
기존 JWT·DB·HMAC·관리자 Secret 계약과 prod·cicd는 유지한다.

## Context

기존 Cognito 사용자 풀·앱 클라이언트는 이 결정의 생성·변경 대상이 아니다. backend의
`TenantOidcClients`는 조직 DB의 issuer·client ID·`config:<key>`와 서버의
`pulsemetry.oidc.client-secrets` 맵을 결합하지만 현재 dev 배포에는 그 비밀 공급 경로가 없다.
이 결정은 backend API나 DB 스키마를 바꾸지 않는 infra 단일 레포의 배포 구현 결정이다.

## Decision

- ECS `devDashboardRuntimeFile` JSON과 EKS `--runtime-values` YAML에 `oidc` 입력을 추가한다.
  생략은 비활성이다. `enabled`, `clients`의 `key`·`versionId`, HTTP/HTTPS `callbackBaseUrl`,
  선택적 `failureRedirectUri`, 기본값 `oidc`인 `callbackRegistrationId`를 받는다.
  `userAuth.allowedRedirectUris`는 정확한 HTTP/HTTPS 복귀 주소 목록이다.
  dev 입력과 Helm schema는 인증서 준비 전 HTTP 값도 받는다. 다른 scheme, userinfo,
  query·fragment·잘못된 URI 및 허용 목록 불일치 검사는 유지한다.
- CDK는 ECS 입력에 선언한 각 key마다 `soma-376/dev/oidc/clients/<key>`를 생성한다.
  `CfnSecret`의 `SecretString`·`GenerateSecretString`은 모두 생략한다. 빈 문자열이나
  임의 비밀번호 버전을 생성하지 않는다. 값은 운영자가 기존 Cognito client secret 문자열로 등록한다.
- Secret 이름·construct ID는 배열 순서가 아닌 key에 고정한다. 삭제·교체는 `Retain`,
  암호화는 기존 dev와 같은 `aws/secretsmanager`다. 자동 회전과 Cognito 변경은 하지 않는다.
- `DevDataStack`의 `OidcClientSecretArns` output은 key→ARN JSON 맵이다. DataStack만 먼저
  배포하는 bootstrap을 위해 이 output은 EdgeStack에 의존하지 않는다. 기존 output은 이동하지 않는다.
  ECS는 construct 참조를 사용하고 EKS 생성기는 이 output에서 선택한 key의 ARN을 가져온다.
  수동 runtime 입력의 ARN·원문 override는 허용하지 않는다.
- 활성 상태에서는 클라이언트마다 VersionId를 고정한다. ECS는 execution role의 지정 ARN 조회와
  ECS `secrets`로 전체 문자열을 공급한다. JWT writer·task role·이미지·volume은 변경하지 않는다.
- EKS enrollment Pod Identity는 선언된 원본 ARN만 읽는다. ECS의 enabled flag와 독립적이다.
  EKS 입력은 선언된 key의 부분집합을 선택할 수 있다. enrollment SPC가 고정 `objectVersion`의
  전체 문자열을 기존 configtree에 읽기 전용으로 mount하며 기존 init 검사에 포함한다.
- 정렬한 key별 `PULSEMETRY_OIDC_CLIENT_SECRET_<index>` 환경변수/EKS 파일 alias를 사용한다.
  `SPRING_APPLICATION_JSON`에는 정확한 bracket map key와 `${...}` placeholder만 넣고 기존
  JWT 공개키 파일 맵과 합친다. 비밀 원문은 values·CloudFormation·Helm manifest에 포함하지 않는다.
  dashboard·ingest에는 OIDC 설정이나 권한을 공급하지 않는다.
- EKS의 key·ARN·VersionId 변경은 앱 annotation을 바꿔 Pod 교체를 유발한다. runtime SPC와 앱
  values는 같은 생성 결과로 적용·복구한다. Kubernetes Secret 복제·자동 reload는 추가하지 않는다.
- 비활성 상태에서는 key만으로 빈 원본을 생성할 수 있다. ECS 주입·EKS OIDC object·필수 파일은
  생략한다. EKS 역할의 선언된 ARN 권한은 남지만 값 조회는 수행하지 않는다.

## Constraints

Secret 값은 합성 시 읽지 않는다. client key와 DB `config:<key>`는 정확히 일치해야 한다.
issuer·client ID·SSO·회원 정보는 DB의 기존 계약이며 배포 코드가 자동 수정하지 않는다.
values의 HTTP 허용은 backend·Cognito의 인증 정책 변경이 아니다. 현재 backend의 `requireOidcUrl`은
외부 HTTP callback·실패 복귀 주소를 거부하고 `UserAuthService.validateRedirect`도 원격 HTTP 복귀를
거부한다. Cognito 웹 callback의 HTTP 예외는 localhost 테스트용이다. 실제 원격 Cognito 로그인에는
여전히 HTTPS 진입점과 IdP callback 등록이 필요하며, HTTP 입력의 synth·render 성공을 로그인 성공으로
간주하지 않는다. local 프로필·localhost 예외를 자동 활성화하지 않는다. 실제 AWS 배포와 DB 변경은 별도 실행이다.

## Alternatives Considered

- Secret 한 개의 JSON 맵: 원본 수는 적지만 개별 클라이언트 교체·복구가 결합되어 채택하지 않는다.
- AWSCURRENT: 입력은 간단하지만 ECS/EKS 적용 버전과 rollback을 재현하기 어려워 채택하지 않는다.
- JWT writer 확장: ECS의 기존 Secret 주입으로 해결할 수 있어 새 이미지·파일 공급 책임을 추가하지 않는다.

## Consequences/Tradeoffs

### Positive

생성 코드의 공유 여부와 무관하게 기존 Cognito를 연결하며, 원본과 소비 버전을 명시적으로 관리한다.
값 등록 전에 DataStack만 배포할 수 있고 기존 앱과 JWT 공급을 유지한다.

### Negative

클라이언트별 Secret 비용과 수동 등록·버전 보존 책임이 늘어난다. EKS disabled 상태에도 선언된
원본 읽기 권한은 남는다. pinned Secret 버전의 보존과 Cognito에서 이전 값의 유효성은 별개다.
선언 key 제거는 보존된 Secret을 삭제하지 않지만 IAM 접근을 제거하므로 소비 중인 key를 먼저 제거하면 안 된다.

## Acceptance Criteria

빈 원본·보존·안정적 logical ID, 비활성 bootstrap, 입력 검증, ECS/EKS 권한 분리·버전 고정,
실제 Spring의 맵/placeholder binding, Helm rollout 및 기존 JWT·prod/cicd 보존을 로컬 검증한다.
합성·fixture 성공은 Secret 값 등록·CSI 접근·실제 로그인 성공 증거가 아니다.

## References

- [OIDC 준비 런북](../runbooks/dev-oidc-prerequisites.md)
- backend `docs/user-auth-operations.md`, `docs/cognito-dev.md`, `OidcLoginConfig`, `TenantOidcClients`
- [CloudFormation 빈 Secret](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-secretsmanager-secret.html)
- [ECS Secret 버전 주입](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/secrets-envvar-secrets-manager.html)
- [ASCP objectVersion](https://github.com/aws/secrets-store-csi-driver-provider-aws)
