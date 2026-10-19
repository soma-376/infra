# 기존 Cognito 연결을 위한 dev OIDC 준비·배포·복구

> PROJ-237이 구현하는 [ADR-0032](../adr/0032-dev-oidc-client-secret-runtime-supply.md)의 ECS·EKS 공급 절차다.
> 이 문서의 AWS·DB·Helm 명령은 이번 구현에서 실행하지 않았다. 로컬 검증은 실제 Secret 등록,
> CSI 접근, Cognito 로그인 성공을 증명하지 않는다. Cognito 생성·HTTPS 구축·DB 변경은 별도 운영 작업이다.

## 1. 설정 위치와 사전 조건

기존 Cognito 사용자 풀·앱 클라이언트를 사용한다. 동료의 생성 커밋이나 local Spring 프로필은 필요하지
않지만 배포 이미지에 backend `OidcLoginConfig`·`TenantOidcClients`가 포함돼 있어야 한다.
사용자 JWT·DB·이미지 준비는 [공통 준비](dev-dashboard-prerequisites.md), runtime별 배포는
[ECS 입력](dev-dashboard-ecs-runtime.md)과 [EKS 수동 런북](dev-eks-manual-deployment.md)을 함께 따른다.

| 설정 | 소유·입력 위치 | 조건 |
|---|---|---|
| `oidc.enabled` | ECS JSON / EKS runtime YAML | `oidc` 생략은 비활성. 활성화는 `true` |
| `oidc.allowInsecureLocalhost` | 각 runtime 입력, 선택 | boolean만 허용, 기본값 `false`. 명시적 `true`는 backend의 HTTP loopback 예외 활성화 |
| `oidc.clients[].key` | ECS JSON이 원본 선언, EKS YAML이 소비할 key 선택 | `[A-Za-z0-9_-]{1,64}`, 최대 32개, 조직 DB의 `config:<key>`와 정확히 일치, 중복 금지 |
| `oidc.clients[].versionId` | 각 runtime 입력 | 활성화 시 `[A-Za-z0-9-]{32,64}`인 실제 VersionId 필수. 이동 label을 넣지 않음 |
| `oidc.callbackBaseUrl` | 각 runtime 입력 | HTTP/HTTPS enrollment origin. 선택적 끝 `/` 외 path·query·fragment·userinfo 금지 |
| `oidc.callbackRegistrationId` | 각 runtime 입력 | 기본값 `oidc`, `[A-Za-z0-9_-]+`. Cognito callback 마지막 경로와 일치 |
| `oidc.failureRedirectUri` | 각 runtime 입력, 선택 | HTTP/HTTPS이며 아래 허용 복귀 주소 목록에 정확히 포함, query·fragment 금지 |
| `userAuth.allowedRedirectUris` | 각 runtime 입력 | 활성화 시 정확한 HTTP/HTTPS 프론트 복귀 URL 목록, 각 256자 이하. 중복·userinfo·query·fragment·쉼표 금지 |
| `userAuth.allowedOrigins` | 기존 runtime 입력 | 브라우저/BFF 구성에 맞는 정확한 origin. 복귀 URL 목록과 구분 |
| `oidc_issuer`, `oidc_client_id`, `oidc_client_secret_ref`, `sso_enabled` | 조직 DB | 기존 Cognito 정보와 `config:<key>`, 준비 후 SSO 활성화 |
| client secret 원문 | CDK가 만든 Secrets Manager 원본 | JSON 포장 없는 문자열, enrollment만 소비 |
| Secret ARN | `DevDataStack.OidcClientSecretArns` output | JSON key→ARN 맵. 생성기가 generated values에 넣음 |

ECS `devDashboardRuntimeFile`은 `writerImage`·`userAuth`·`dashboard`를 포함한 기존 JSON에 `oidc`를
추가한다. EKS `--runtime-values` YAML에는 같은 구조를 쓰되 `writerImage`를 넣지 않는다.
EKS는 선언된 client key의 부분집합을 선택할 수 있다. 입력 파일에 ARN·client secret·client ID·issuer를
임의로 추가하지 않는다. Cognito issuer는 조직 DB, Pulsemetry 자체 JWT issuer는 `userAuth.issuer`다.
배포 코드는 `PULSEMETRY_OIDC_ENABLED`·`PULSEMETRY_OIDC_CALLBACK_BASE_URL`·선택적
`PULSEMETRY_OIDC_FAILURE_REDIRECT_URI`·`PULSEMETRY_USER_AUTH_ALLOWED_REDIRECT_URIS`를 구성한다.
registration ID·client secret 맵·`allow-insecure-localhost`는 `SPRING_APPLICATION_JSON`에 병합하므로 별도 env를 수동 추가하지 않는다.
URL의 빈 `?`·`#`, 원시 공백·backslash·잘못된 percent escape도 거부한다. 입력 URL을 자동 정규화하지
않으므로 Cognito·frontend·runtime의 문자열을 정확히 맞춘다.

dev 입력·Helm schema는 인증서 준비 전 HTTP 값도 받는다. 이는 실제 HTTP Cognito 로그인을 지원한다는
뜻이 아니다. 현재 backend `requireOidcUrl`은 외부 HTTP callback·실패 복귀 주소를 거부하고,
`UserAuthService.validateRedirect`는 원격 HTTP 프론트 복귀를 거부한다. local 프로필이나 localhost
예외를 자동 활성화하지 않는다. HTTP 값도 runtime 입력 파일에서 변경한 뒤 재생성하며 generated YAML은 직접 수정하지 않는다.

localhost callback 테스트에서는 **기존 `oidc` 객체에** `allowInsecureLocalhost: true`를 추가한다.
ECS JSON은 `"allowInsecureLocalhost": true`, EKS YAML은 아래처럼 지정하며 기존 client key·VersionId를 유지한다.

```yaml
# 기존 EKS runtime 입력의 oidc 객체에 반영할 항목이다. clients와 나머지 설정은 유지한다.
oidc:
  enabled: true
  allowInsecureLocalhost: true
  callbackBaseUrl: http://localhost:8080
  failureRedirectUri: http://localhost:3000/auth/callback
```

`userAuth.allowedRedirectUris`에는 `http://localhost:3000/auth/callback`을 정확히 포함한다.
위 예시의 Cognito callback은 `http://localhost:8080/api/v1/auth/oidc/callback/oidc`이며 IdP에도 등록한다.
브라우저의 localhost:8080 요청이 해당 enrollment runtime에 도달하도록 로컬 실행 또는 포워딩을 준비한다.
이 옵션은 `pulsemetry.oidc.allow-insecure-localhost`에 전달되며 backend의 `localhost`·`127.0.0.1`·`[::1]`
HTTP 예외만 켠다. 원격 HTTP 주소는 계속 거부하며 local Spring 프로필을 활성화하지 않는다.
테스트 후 `false`로 되돌리거나 입력을 생략한다. OIDC 비활성 상태에는 이 옵션을 앱에 주입하지 않는다.

운영자는 다음을 먼저 확인한다.

- 기존 dev Network/Data 스택과 승인된 전체 CDK context를 확보한다. EKS 활성화 상태, API/ALB CIDR,
  archive prefix와 이미지 선택을 유지한다. 이미 배포한 EKS에서 `devEksEnabled=true`를 누락하지 않는다.
- Cognito의 사용자 풀 issuer, confidential app client ID, client secret, 사용자 풀 로그인 domain을 확인한다.
  backend가 요청하는 `openid`·`profile`·`email`, Authorization Code와 S256 PKCE를 사용할 수 있어야 한다.
  issuer에는 로그인 domain이 아닌 해당 사용자 풀의 정확한 issuer URL을 사용한다.
- 실제 HTTPS 진입점에서 enrollment의 `/api/v1/auth/*` 경로가 동작해야 한다. 프론트/BFF도 해당 runtime의
  로그인 시작·코드 교환 경로를 사용한다. HTTP 검증 ALB나 localhost 허용으로 배포 검증을 대체하지 않는다.
- Cognito에 등록할 callback은 `<callbackBaseUrl>/api/v1/auth/oidc/callback/<callbackRegistrationId>`다.
  예: `https://auth.example.com/api/v1/auth/oidc/callback/oidc`. ECS/EKS의 주소가 다르면 각각 등록한다.
  `https://dashboard.example.com/auth/callback`은 Pulsemetry의 프론트 복귀 주소이며 Cognito callback과 다르다.
- ECS EC2 container agent는 고정 Secret 버전을 지원하는 1.37.0 이상이어야 한다. EKS의 CSI·ASCP·Pod Identity는
  기존 런북대로 설치한다. 필요한 Secrets Manager 접근과 IdP discovery/token endpoint egress를 확인한다.

Cognito의 웹 callback은 사전 등록된 HTTPS URL이어야 하며 HTTP 예외는 `http://localhost` 테스트용이다.
fragment를 허용하지 않는다. HTTP 입력의 synth·render 성공을 실제 로그인 성공으로 기록하지 않는다.
[AWS Cognito 문서](https://docs.aws.amazon.com/cognito/latest/developerguide/authorization-endpoint.html),
[ECS Secret 버전 주입 조건](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/secrets-envvar-secrets-manager.html)을 따른다.

## 2. OIDC 비활성 입력으로 빈 원본만 생성

아래는 **기존 ECS JSON에 추가할 조각**이다. 기존 JWT·dashboard·writerImage 설정을 지우지 않는다.
처음 사용할 모든 client key를 선언하되 VersionId 없이 OIDC를 비활성화한다.

```json
{
  "oidc": {
    "enabled": false,
    "clients": [{"key": "cognito-a"}, {"key": "cognito-b"}]
  }
}
```

client key마다 `soma-376/dev/oidc/clients/<key>`가 생성된다. CDK는 `SecretString`과
`GenerateSecretString`을 모두 생략하므로 **초기 버전 자체가 없다**. 빈 문자열이나 임의 비밀번호를 넣지 않는다.
기존 dev와 같은 `aws/secretsmanager` 암호화, 삭제·교체 시 `Retain`이며 자동 회전은 없다.
기존 9개 원본에 선언한 key 수만큼 추가된다. 배열 순서를 바꿔도 원본 이름·logical ID는 유지한다.

기존 배포 기록의 `cdk-context-args.txt`처럼 **인자 하나당 한 줄**인 전체 context 파일을 사용한다.
처음 기록한다면 기존 배포에 사용한 인자 배열을 `printf '%s\n' "${EKS_CONTEXT[@]}"`와 같은 방식으로 저장한다.
아래 Bash 명령은 `eval`·`source`로 기록을 실행하지 않는다. 기록의 runtime 경로가 준비한 JSON과 같아야 한다.

```bash
set -euo pipefail
umask 077
: "${CDK_DEFAULT_ACCOUNT:?대상 계정}"
export CDK_DEFAULT_REGION=ap-northeast-2
export AWS_REGION=ap-northeast-2
: "${ECS_RUNTIME_JSON:?기존 필수 설정과 비활성 oidc를 담은 JSON 절대 경로}"
: "${CDK_CONTEXT_FILE:?현재 배포의 전체 context 인자를 보존한 파일}"
: "${RUN_DIR:?새 배포 기록 디렉터리 절대 경로}"
mkdir -p "$RUN_DIR"
OIDC_CDK_CONTEXT=()
while IFS= read -r arg || [ -n "$arg" ]; do
  OIDC_CDK_CONTEXT+=("$arg")
done < "$CDK_CONTEXT_FILE"
printf '%s\n' "${OIDC_CDK_CONTEXT[@]}" | rg -Fx -- "env=dev"
printf '%s\n' "${OIDC_CDK_CONTEXT[@]}" | rg -Fx -- "devDashboardRuntimeFile=$ECS_RUNTIME_JSON"
printf '%s\n' "${OIDC_CDK_CONTEXT[@]}" > "$RUN_DIR/cdk-context-args.txt"
npx cdk synth DevDataStack "${OIDC_CDK_CONTEXT[@]}" --output "$RUN_DIR/cdk.out"
npx cdk diff DevDataStack --exclusively "${OIDC_CDK_CONTEXT[@]}"
```

diff에서 OIDC 원본 추가와 output 외 기존 원본·RDS의 교체/삭제가 없음을 확인한다.
**빈 원본 bootstrap은 `DevDataStack`만 배포**한다. `--exclusively`는 의존 스택을 함께 배포하지 않으므로
Network가 이미 배포돼 있고 참조가 유효한 기존 dev에서 실행한다. 새 환경 전체 생성 절차로 사용하지 않는다.

```bash
npx cdk deploy DevDataStack --exclusively "${OIDC_CDK_CONTEXT[@]}" \
  --outputs-file "$RUN_DIR/data-bootstrap-outputs.json"
aws cloudformation describe-stacks --stack-name DevDataStack --region "$AWS_REGION" \
  > "$RUN_DIR/DevDataStack.json"
jq -er '.Stacks[].Outputs[] | select(.OutputKey=="OidcClientSecretArns") | .OutputValue | fromjson' \
  "$RUN_DIR/DevDataStack.json" > "$RUN_DIR/oidc-client-secret-arns.json"
```

ARN output은 DataStack에서 직접 나오므로 EdgeStack 배포가 필요 없다. ARN에는 account ID가 있으므로
출력 파일은 제한된 기록에 보관한다. 비활성 상태에서 ECS 주입과 EKS OIDC object·필수 파일 검사는 없다.
EKS enrollment role의 선언된 원본 권한은 ECS 활성화 여부와 독립적이며 실제 값 조회는 활성화 이후에 발생한다.

## 3. Cognito 원문 수동 등록과 버전 보존

운영자가 Cognito 콘솔에서 확인한 **해당 앱 클라이언트의 client secret**을 같은 key의 Secrets Manager 원본에
수동 등록한다. 콘솔의 일반 텍스트 편집으로 문자열 자체를 저장한다. `{"clientSecret":"..."}` 같은 JSON,
따옴표 포장, 개행을 붙이지 않는다. 기존 원본을 편집하며 이름이 같은 새 원본을 만들지 않는다.
원문을 values·환경 입력 JSON·Git·채팅·티켓·명령 이력에 복사하지 않는다.

등록 뒤 다음 명령으로 원문 없이 ARN·VersionId·label만 확인한다. 실제로 승인한 버전을 기록하며
첫 번째 목록 항목이나 `AWSCURRENT` 문자열을 VersionId로 사용하지 않는다.

```bash
: "${OIDC_CLIENT_KEY:?예: cognito-a}"
OIDC_SECRET_ARN=$(jq -er --arg key "$OIDC_CLIENT_KEY" '.[$key]' "$RUN_DIR/oidc-client-secret-arns.json")
aws secretsmanager describe-secret --secret-id "$OIDC_SECRET_ARN" --region "$AWS_REGION" \
  --query '{ARN:ARN,Name:Name,VersionIdsToStages:VersionIdsToStages,RotationEnabled:RotationEnabled}'
aws secretsmanager list-secret-version-ids --secret-id "$OIDC_SECRET_ARN" --region "$AWS_REGION" \
  --include-deprecated --query 'Versions[].{VersionId:VersionId,VersionStages:VersionStages,CreatedDate:CreatedDate}'
```

활성·다음 배포·승인된 rollback 버전에 별도 보존 label을 유지한다. VersionId를 파일에 적는 것만으로는
오래된 무라벨 버전의 정리를 막지 못한다. `AWSCURRENT` 이동은 이미 고정한 ECS/EKS 버전을 바꾸지 않는다.
[Secrets Manager 버전 수명](https://docs.aws.amazon.com/secretsmanager/latest/userguide/whats-in-a-secret.html)을 따른다.
비밀 값 조회 명령과 mount 내용·프로세스 환경 출력은 검증 절차에 넣지 않는다.

## 4. 조직 DB와 로그인 대상 준비

운영 DB에는 backend의 기존 migration이 먼저 적용돼 있어야 한다. `enrollment.tenants`의
OIDC 필드와 기존 `members`·세션 구조를 확인한다. issuer·client ID·`config:<key>`는 검증한 Cognito
앱 클라이언트와 일치해야 한다. 배포 입력의 client key는 DB에 자동 등록되지 않는다.

관리자가 대상 tenant UUID와 활성 상태를 확인하고 로그인 허용 회원의 이메일·역할을 사전 등록한다.
최초 연결 회원의 `oidc_subject`는 NULL이며 Cognito의 검증 이메일로 연결한다. 기존 sub를 임의로
교체하거나 전체 개발 시드를 실행하지 않는다. Cognito 개발 연결에서는 `oidc_require_verified_email=true`를
사용하고 ID Token의 `email_verified=true`를 확인한다. 역할은 IdP가 아닌 서비스 DB가 결정한다.

아래는 **신규 연결 검토용 SQL**이며 자동 실행하지 않는다. 실제 UUID·issuer·client ID로 바꾸고
백업·회원 준비를 확인한다. `RETURNING`이 정확히 한 조직인지 검토하고 승인된 적용에서만 마지막을
`COMMIT`으로 바꾼다. 0행이면 기존 연결 또는 상태를 조사하며 조건을 제거해 덮어쓰지 않는다.

```sql
BEGIN;
UPDATE enrollment.tenants
SET oidc_issuer='https://cognito-idp.ap-northeast-2.amazonaws.com/<user-pool-id>',
    oidc_client_id='<검증한 app client ID>',
    oidc_client_secret_ref='config:cognito-a',
    oidc_require_verified_email=true,
    sso_enabled=true
WHERE id='<검증한 tenant UUID>'::uuid
  AND status='active' AND deleted_at IS NULL
  AND NOT sso_enabled AND oidc_issuer IS NULL
  AND oidc_client_id IS NULL AND oidc_client_secret_ref IS NULL
RETURNING id, oidc_issuer, oidc_client_id, oidc_client_secret_ref, sso_enabled;
ROLLBACK;
```

기존 issuer/client를 교체하는 작업에는 이 신규 연결 SQL을 사용하지 않는다. 먼저 신규 로그인 허용을
중지하고 기존 회원 sub의 신원 확인과 해당 회사의 서비스 세션·단회 코드 폐기를 포함한 절차를 수립한다.
상세 권한·로그 마스킹·회원 연결 계약은 [backend 인증 운영](../../../pulsemetry-backend/docs/user-auth-operations.md)을 따른다.

## 5. 활성화 입력과 ECS·EKS 적용

아래는 기존 입력에 병합할 **비밀 없는 YAML 조각**이다. JSON은 같은 필드 구조로 표현한다.
기존 `userAuth`의 JWT 버전·kid·issuer·audience·origin과 `dashboard` 설정을 모두 유지한다.
`<등록한 VersionId>`는 §3에서 기록한 실제 값으로 바꾼다.

```yaml
oidc:
  enabled: true
  callbackBaseUrl: https://auth.example.com
  callbackRegistrationId: oidc
  failureRedirectUri: https://dashboard.example.com/auth/callback
  clients:
    - key: cognito-a
      versionId: <등록한 VersionId A>
    - key: cognito-b
      versionId: <등록한 VersionId B>
userAuth:
  # 기존 JWT 설정과 allowedOrigins는 그대로 유지한다.
  allowedRedirectUris:
    - https://dashboard.example.com/auth/callback
```

ECS JSON의 `clients`는 전체 원본 선언이기도 하다. EKS에서 사용하는 key를 ECS에서 당장 로그인에
쓰지 않는다는 이유로 제거하지 않는다. ECS 전체 OIDC를 끄더라도 `enabled:false`와 key 목록은 유지할 수 있다.
EKS는 이 선언의 일부만 선택하고 ECS와 다른 callback·VersionId를 사용할 수 있다. 비교 검증 시에는
실제로 선택한 버전과 주소를 각각 기록한다.

**ECS:** 활성화된 JSON으로 합성·전체 diff를 검토하고 기존 context를 그대로 사용해 배포한다.
enrollment execution role과 task definition의 `secrets`가 선택한 전체 SecretString·VersionId를 공급한다.
정렬된 key별 내부 변수와 bracket map placeholder가 기존 `SPRING_APPLICATION_JSON`의 JWT 맵에 병합된다.
JWT writer·task role·이미지·volume에는 OIDC 공급 책임을 추가하지 않는다.

```bash
npx cdk synth --all "${OIDC_CDK_CONTEXT[@]}" --output "$RUN_DIR/cdk-active.out"
npx cdk diff --all "${OIDC_CDK_CONTEXT[@]}"
npx cdk deploy --all "${OIDC_CDK_CONTEXT[@]}" --outputs-file "$RUN_DIR/cdk-active-outputs.json"
```

위 명령은 dev의 전체 context다. 다른 변경이 섞인 diff를 그대로 적용하지 않는다. VersionId 변경은
CDK task definition 갱신과 새 task 시작이 필요하며 기존 definition의 force-new-deployment만으로는
다른 버전으로 전환되지 않는다. [ECS runtime 런북](dev-dashboard-ecs-runtime.md)의 기존 검증도 수행한다.

**EKS:** [EKS 런북 §2](dev-eks-manual-deployment.md#2-eks-활성화-설정과-cdk-배포)처럼
`DevEksStack`·`DevEdgeStack`·`DevDataStack`의 **배포된 output을 모두** 모은다. `--outputs-file` 하나가
항상 모든 output을 포함한다고 가정하지 않는다. 생성기에 output·세 앱 digest·runtime YAML을 전달한다.
미등록 key와 수동 ARN override는 거부한다. `generated/enrollment-api.yaml`의 env만 수동 수정하지 않는다.

```bash
: "${RUNTIME_VALUES:?활성화할 EKS runtime YAML 절대 경로}"
for stack in DevEksStack DevEdgeStack DevDataStack; do
  aws cloudformation describe-stacks --stack-name "$stack" --region "$AWS_REGION" \
    > "$RUN_DIR/$stack.json"
done
jq -s '{Stacks: [.[].Stacks[]]}' "$RUN_DIR/DevEksStack.json" "$RUN_DIR/DevEdgeStack.json" \
  "$RUN_DIR/DevDataStack.json" > "$RUN_DIR/deployed-outputs.json"
node scripts/eks-values.mjs --outputs "$RUN_DIR/deployed-outputs.json" \
  --output-dir "$RUN_DIR/generated" --runtime-values "$RUNTIME_VALUES" \
  --enrollment-image "$ENROLLMENT_IMAGE" --ingest-image "$INGEST_IMAGE" --dashboard-image "$DASHBOARD_IMAGE"
helm upgrade --install runtime-config helm/dev/runtime/chart --namespace pulsemetry-dev \
  --values "$RUN_DIR/generated/runtime.yaml" --wait --timeout 5m
helm upgrade --install enrollment-api helm/dev/workloads/spring-app --namespace pulsemetry-dev \
  --values helm/dev/workloads/enrollment-api.yaml --values "$RUN_DIR/generated/enrollment-api.yaml" \
  --wait --timeout 10m
kubectl -n pulsemetry-dev rollout status deployment/enrollment-api --timeout=5m
```

기반 chart·CSI·ASCP·ServiceAccount와 Pod Identity가 준비된 뒤 위 runtime → enrollment 순서로 적용한다.
runtime 입력 YAML을 Helm에 직접 중첩하지 않는다. SPC는 고정 `objectVersion`의 전체 문자열을
`PULSEMETRY_OIDC_CLIENT_SECRET_<index>` 파일로 기존 configtree에 mount한다. UID 10001 initContainer가
필수 파일을 출력 없이 검사한다. key·ARN·VersionId가 변하면 앱 annotation이 바뀌어 Pod를 교체한다.
Kubernetes Secret 복제나 자동 reload는 없고 dashboard·ingest에는 OIDC 설정·권한을 추가하지 않는다.

## 6. 수락·오류·교체·복구

ECS task 시작·EKS Ready와 함께 다음을 각각 확인한다. 실행 기록에는 commit·이미지 digest·task revision/
Helm revision·key/ARN/VersionId·성공/실패만 남긴다. 로그인 URL의 code/state/login_hint, 쿠키·JWT·원문을
로그·스크린샷·HAR·증거 파일에 남기지 않는다.

| 관문 | 실제 확인 |
|---|---|
| 공급 | enrollment만 고정 버전 참조, ECS execution role / EKS enrollment Pod Identity, 파일 검사 통과 |
| 로그인 | 사전 등록 회원의 회사 탐색 → Cognito authorize → 등록된 HTTPS callback → 프론트 복귀 |
| 서비스 인증 | 단회 코드 교환·자체 JWT 발급, dashboard의 현재 세션·회원/회사 상태 검증, 갱신·로그아웃 |
| 실패 | 미등록 회원·허용되지 않은 redirect 거부, 잘못된/만료된 흐름 실패, 다른 회사로 연결되지 않음 |
| 배포 비교 | ECS/EKS 각각의 주소·이미지·버전으로 위 검증 수행. 한쪽 성공을 다른 쪽의 증거로 쓰지 않음 |

원본에 버전을 등록하기 전에 `enabled:true`로 배포하면 ECS Secret 주입 또는 EKS CSI mount가 실패한다.
key/VersionId 누락·부적합 URL은 입력 단계에서 거부하지만 **입력 검증은 AWS 버전 존재를 확인하지 않는다**.
SPC만 바꾸면 기존 앱이 새 값을 읽지 않는다. 공급은 성공해도 DB `config:<key>` 불일치·discovery 장애는
로그인 단계에서 `auth_unavailable`이 될 수 있다. callback 불일치·Cognito scope·회원 이메일 검증을 구분한다.
원문을 출력해 진단하지 않는다.

교체는 Cognito에서 새 값의 유효성을 확인 → 같은 원본에 새 버전 등록·label 보존 → runtime 입력의 VersionId
갱신 → ECS task 및 EKS runtime/앱 재배포 → 실제 로그인 수락 순서다. 새 버전 등록만으로 앱은 갱신되지 않는다.
원본 값이 Cognito와 다르면 재기동을 반복해도 해결되지 않는다.

복구 시 ECS는 이전 승인 입력·버전으로 CDK를 다시 배포한다. EKS는 이전 실행 디렉터리의
`generated/runtime.yaml`을 **먼저**, 같은 기록의 `generated/enrollment-api.yaml`을 **그다음** 적용하고
rollout·로그인을 다시 확인한다. `helm rollback enrollment-api`만 실행해 SPC를 새 버전에 남기지 않는다.
같은 runtime release의 JWT·dashboard 설정도 돌아가므로 다른 변경이 있었다면 이전 OIDC 선택만 복구한
새 입력으로 모든 values를 재생성하고 기존 JWT verifier/signer 순서를 지킨다.

Secrets Manager에 구 버전이 남아 있어도 Cognito가 구 값을 폐기했다면 로그인 복구에 사용할 수 없다.
그 경우 승인된 새 값으로 전진 수정한다. OIDC 비활성화는 신규 로그인 경로를 닫는 조치이며 이미 발급된
서비스 세션의 폐기는 별도다. 사용 중인 key를 CDK 선언에서 먼저 제거하면 보존된 원본은 남아도 IAM 접근이
제거될 수 있다. 모든 소비·rollback 필요가 끝난 뒤 제거를 검토하며 Retain 원본 재연결은 import로 처리한다.

로컬 검증은 `npm run build`, `npm test -- --runInBand`, 기존 Helm/schema 검사와
`python3 scripts/test-oidc-config.py`를 수행한다. 마지막 fixture는 실제 backend `OidcProperties`·
`UserAuthProperties`와 Spring Boot에서 ECS 환경변수·EKS configtree의 synthetic 값 및 기존 JWT 맵을
검사하며 `allowInsecureLocalhost`의 생략·false·true 바인딩도 확인한다.
backend 위치는 `--backend`, Helm 경로는 `HELM_BIN`으로 지정할 수 있다.
이 결과는 실제 Secrets Manager 조회·Cognito 인증 성공과 구분한다.

## 참조

- [ADR-0032](../adr/0032-dev-oidc-client-secret-runtime-supply.md), [ECS runtime](dev-dashboard-ecs-runtime.md), [EKS runtime](../../helm/dev/runtime/README.md)
- [backend 인증 운영](../../../pulsemetry-backend/docs/user-auth-operations.md), [Cognito 로컬 안내](../../../pulsemetry-backend/docs/cognito-dev.md) — local callback·시딩 절차는 이 배포에 그대로 적용하지 않는다.
- [CloudFormation 빈 Secret](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-secretsmanager-secret.html)
