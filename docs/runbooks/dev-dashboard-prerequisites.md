# dev dashboard 저장소·인증 준비 런북

> PROJ-222는 공통 Secret의 CDK 정의와 수동 준비 절차를 제공한다. 이 문서의 DB·AWS·키 생성 명령은
> 이번 작업에서 실행하지 않았다. Secret 정의·로컬 합성과 실제 리소스 생성·계정 준비·인증 성공은 다르다.
> 원본 소유·보존은 [ADR-0031](../adr/0031-manage-dev-dashboard-and-jwt-secrets-with-cdk.md),
> JWT 파일 공급은 [ADR-0030](../adr/0030-dev-user-jwt-keys-from-secrets-manager.md)을 따른다.

## 1. 실행 범위와 사전 조건

이 절차는 dev ECS와 dev EKS가 공유할 계정·키 원본·배포 입력을 준비한다. 실제 runtime 주입·IAM·키 파일
공급은 PROJ-230(ECS)·PROJ-231(EKS), 배포·기능·복구 확인은 PROJ-221·225가 담당한다.
prod·기존 enrollment/ingest의 자격증명은 변경하지 않는다.

- 대상 리전은 `ap-northeast-2`다. 운영자는 별도 승인된 배포로 CDK 원본이 생성됐는지 먼저 확인한다.
  이 작업은 `cdk deploy`를 실행하지 않으며, 합성된 리소스가 AWS에 이미 있다고 가정하지 않는다.
- DB 관리 접속, 현재 schema/table 소유자와 enrollment migration 실행 역할을 확인한다.
  RDS 두 연결은 같은 `controlplane` DB, ClickHouse 두 연결은 같은 server를 사용한다.
  현재 ClickHouse 원천 DB는 `default`, 양쪽 cache 이름은 `dashboard_cache`다.
- Secret 값은 승인된 운영자 환경에서만 사용한다. `aws-secrets-manager` 스킬과 `asm-exec`의
  `{{resolve:secretsmanager:...}}` 참조로 runtime에 연결하고, 원문 조회를 에이전트 문맥에 반환하지 않는다.
  현재 로컬에는 `asm-exec`가 없으므로 실제 비밀 취급 단계는 실행하지 않았다.
- 아래 키 초기화 예시에는 OpenSSL·jq·uuidgen·AWS CLI가 필요하다. shell tracing·세션 녹화·원문 로그를 끄고
  제한된 작업 디렉터리를 사용한다. 키·비밀번호·JWT를 문서·티켓·SQL 파일·명령 이력·이미지에 남기지 않는다.
- 설정명 전체와 DDL 책임은 [허브 dashboard 계약 §3·4](../../../docs/contracts/dashboard-api.md)를 따른다.
  backend 로컬 `DevDashboardSetup`의 개발 비밀번호·DB 이름·넓은 원천 grant를 배포용으로 복사하지 않는다.

## 2. CDK 원본과 후속 연결

`DevDataStack`은 기존 Secret 3개를 보존하고 아래 6개를 추가한다. 총 Secret 정의는 9개다.
신규 원본은 `aws/secretsmanager` 기본 암호화와 삭제·교체 시 `Retain`을 사용한다.
자동 회전은 없으며 기존 3개의 생성 속성·삭제 정책은 바꾸지 않는다.

| 용도 | Secret 이름 | username / 값 형식 | `DevDataStack` 참조 |
|---|---|---|---|
| RDS source | `soma-376/dev/dashboard/rds-source` | `dashboard_rds_source` | `dashboardRdsSourceSecret` |
| RDS cache | `soma-376/dev/dashboard/rds-cache` | `dashboard_rds_cache` | `dashboardRdsCacheSecret` |
| ClickHouse source | `soma-376/dev/dashboard/clickhouse-source` | `dashboard_ch_source` | `dashboardClickHouseSourceSecret` |
| ClickHouse cache | `soma-376/dev/dashboard/clickhouse-cache` | `dashboard_ch_cache` | `dashboardClickHouseCacheSecret` |
| JWT 개인키 | `soma-376/dev/user-jwt/private-key` | 최초에는 값 없음, 등록 후 PKCS8 PEM | `userJwtPrivateKeySecret` |
| JWT 공개키 | `soma-376/dev/user-jwt/public-keys` | 최초에는 값 없음, 등록 후 `kid → X.509 PEM` JSON | `userJwtPublicKeysSecret` |

DB Secret은 JSON `username`과 `password`를 가진다. username은 위 값으로 고정하고 password는 배포 시
Secrets Manager가 32자 영숫자로 생성한다. Secret 생성 자체가 DB 사용자·암호·grant를 적용하지 않는다.
운영자가 DB에 수동 접속해 각 Secret과 같은 username/password로 계정을 만든 뒤 §3의 권한을 적용한다.
기존 계정이 있으면 현재 소유·권한·사용자를 먼저 확인하고 암호나 소유권을 임의로 덮어쓰지 않는다.

각 참조에는 같은 이름 뒤에 `Arn`을 붙인 getter도 있다. PROJ-230은 `synthDev()`의 반환값 `data`에서
`ISecret`을 받아 기존 props 방식으로 전달한다. 이 단계에서는 앱 IAM·ECS secrets·writer·mount를 추가하지 않는다.
DB username/password는 후속 runtime에서 JSON 필드를 선택하고, JWT는 지정 버전을 파일로 공급한다.

운영자는 원문 없이 원본 메타데이터를 확인할 수 있다. 나머지 이름에도 같은 검사를 적용한다.

```bash
aws secretsmanager describe-secret --region ap-northeast-2 \
  --secret-id soma-376/dev/dashboard/rds-source \
  --query '{ARN:ARN,Name:Name,RotationEnabled:RotationEnabled}'
```

실제 ARN은 제한된 배포 입력에 보관한다. 공유 문서·출력은 account 부분을 `<account>`로 표시한다.
`Retain` 후 스택을 재생성할 때는 기존 원본의 import가 필요하다. 같은 이름으로 삭제·재생성하면 ARN이 바뀐다.
일반 재배포에서 DB password 생성 설정을 변경하거나 수동으로 새 값을 등록하면 DB 암호는 따라 바뀌지 않는다.
변경이 필요하면 DB 적용과 앱 재기동을 함께 조정한다.

## 3. DB 계정·권한·cache 준비

### 3-1. RDS source/cache

enrollment-api의 원천 Flyway를 먼저 완료한다. `enrollment`·`telemetry_ops`의 migration 이력과 테이블이
존재해야 한다. dashboard는 원천 Flyway를 실행하지 않고 source JPA는 `validate`만 사용한다.

아래는 네 계정을 수동 생성한 뒤 `controlplane`에 연결한 관리자가 적용할 grant 예시다.
source 계정에 superuser·CREATEDB·CREATEROLE·원천 소유권이나 광범위한 role membership을 주지 않는다.
`dashboard_cache`가 이미 있으면 실제 owner를 먼저 확인한다. `IF NOT EXISTS`는 소유권을 교정하지 않는다.

```sql
GRANT CONNECT ON DATABASE controlplane
TO dashboard_rds_source, dashboard_rds_cache;

GRANT USAGE ON SCHEMA enrollment, telemetry_ops TO dashboard_rds_source;
GRANT SELECT ON
  enrollment.alert_acknowledgements, enrollment.alert_rule_definitions,
  enrollment.installation_collection_segments, enrollment.installation_heartbeats,
  enrollment.installation_manifest_assignments, enrollment.installations,
  enrollment.managed_vendors, enrollment.manifests, enrollment.members,
  enrollment.operation_targets, enrollment.operations, enrollment.organization_alert_rules,
  enrollment.organization_policy_settings, enrollment.seat_assignment_events,
  enrollment.seat_assignments, enrollment.seat_controls, enrollment.team_memberships,
  enrollment.teams, enrollment.tenants, enrollment.user_sessions,
  enrollment.vendor_billing_periods, enrollment.vendor_catalog_observed_products,
  enrollment.vendor_catalog_plans, enrollment.vendor_catalog_products,
  enrollment.vendor_connections, enrollment.vendor_contract_versions,
  telemetry_ops.retention_operations, telemetry_ops.tenant_ingest_summary,
  telemetry_ops.tenant_retention_boundary, telemetry_ops.tenant_summary_backfill
TO dashboard_rds_source;

GRANT CREATE ON DATABASE controlplane TO dashboard_rds_cache;
CREATE SCHEMA IF NOT EXISTS dashboard_cache AUTHORIZATION dashboard_rds_cache;
GRANT USAGE ON SCHEMA telemetry_ops TO dashboard_rds_cache;
GRANT SELECT ON telemetry_ops.tenant_retention_boundary TO dashboard_rds_cache;
```

원천 테이블을 실제로 생성하는 migration 역할마다 다음 설정도 적용한다. `<migration_owner>`를 schema
owner로 추측하지 않는다. 역할마다 담당 schema가 다르면 해당 schema만 지정한다. default privileges는
기존 테이블의 grant를 바꾸지 않으므로 위 SELECT grant와 함께 필요하다.

```sql
ALTER DEFAULT PRIVILEGES FOR ROLE "<migration_owner>"
IN SCHEMA enrollment, telemetry_ops
GRANT SELECT ON TABLES TO dashboard_rds_source;
```

default privileges는 같은 역할이 이후 생성하는 모든 테이블에 적용된다. 신규 원천 테이블 migration은
해당 계정을 쓰는 ECS/EKS dashboard 전체를 중지하고 활성 DB 연결이 없는 점검 구간에서 수행한다.
migration 뒤 source의 두 schema SELECT를 모두 회수하고 현재 backend reader의 위 허용 목록만 재부여한 뒤
effective privileges를 검사하고 dashboard를 재개한다. 실행 중인 구 replica를 남긴 채 사후 회수하지 않는다.
`user_refresh_tokens`·`user_authorization_codes`·`auth_attempts`·`installation_credentials`는 현재 허용 목록이 아니다.

source에는 원천 쓰기·schema CREATE·소유권을 주지 않는다. cache는 자기 schema를 소유하고 원천에서는
retention boundary만 읽는다. RDS cache V1의 `CREATE SCHEMA IF NOT EXISTS`는 schema가 이미 있어도
최초 실행에 database `CREATE` 권한이 필요하다. V1 성공 이력과 다음 migration의 필요 권한을 확인한 뒤
그 추가 권한을 회수한다. 모든 재기동에 영구적으로 필요한 권한으로 취급하지 않는다.

### 3-2. ClickHouse source/cache

ingest가 원천 테이블·ledger를 준비했는지 확인하고 같은 ClickHouse server에서 적용한다.
cache DB 자체는 infra 운영자가 미리 생성한다. 현재 cache DDL·snapshot 복사·정리에 필요한 예시다.

```sql
CREATE DATABASE IF NOT EXISTS dashboard_cache;
ALTER USER dashboard_ch_source SETTINGS readonly = 2;
ALTER USER dashboard_ch_cache SETTINGS readonly = 0, allow_ddl = 1;

GRANT SELECT ON default.telemetry_events TO dashboard_ch_source;
GRANT SELECT ON default.telemetry_metric_points TO dashboard_ch_source;
GRANT SELECT ON default.telemetry_ingest_ledger TO dashboard_ch_source;

GRANT SELECT ON default.telemetry_events TO dashboard_ch_cache;
GRANT SELECT ON default.telemetry_metric_points TO dashboard_ch_cache;
GRANT SELECT, INSERT, CREATE TABLE, CREATE VIEW, ALTER DELETE
ON dashboard_cache.* TO dashboard_ch_cache;
```

source reader는 요청별 `readonly=2`와 query 한도를 전달하므로 계정 profile을 `readonly=1`로 잠그지 않는다.
실제 읽기 전용 경계는 SELECT grant다. cache의 원천 SELECT는 snapshot 복사용 두 테이블만 허용한다.
`ALTER DELETE`는 현행 snapshot 정리의 `DELETE FROM`에 필요하다. 다음 DDL이 추가되면 필요한 권한을
backend migration과 함께 검토하며 `default.*` 전체 권한으로 우회하지 않는다.

### 3-3. cache migration 뒤 확인

실제 dashboard 기동은 후속 배포에서 수행한다. `CacheSchemaInitializer`는 RDS 전용 Flyway
`db/dashboard-cache`를 먼저, ClickHouse `clickhouse/dashboard-cache` DDL을 다음에 실행한다.
어느 쪽이든 실패하면 기동 실패다. table/view DDL을 이 레포로 복제하거나 관리자가 별도로 변경하지 않는다.

RDS cache의 `alerts`가 생성된 뒤 실제 enrollment runtime 계정에 아래 권한을 적용·확인한다.
현재 기존 앱이 master 계정을 사용한다는 이유로 dashboard에도 그 계정을 공유하지 않는다.

```sql
GRANT USAGE ON SCHEMA dashboard_cache TO "<enrollment_runtime_user>";
GRANT SELECT ON dashboard_cache.alerts TO "<enrollment_runtime_user>";

-- V1 성공과 다음 migration의 필요 권한을 확인한 뒤에만 회수한다.
REVOKE CREATE ON DATABASE controlplane FROM dashboard_rds_cache;
```

준비 단계에서는 owner·role 상속·PUBLIC 권한·default privileges와 아래 결과를 함께 확인한다.
권한 부재를 확인하려고 실제 원천 데이터를 수정하지 않는다. cache table이 아직 없으면 그 검사는
DDL 이후 PROJ-221·225의 후속 검사로 남긴다.

```sql
SELECT has_schema_privilege('dashboard_rds_source', 'enrollment', 'USAGE');
SELECT has_table_privilege('dashboard_rds_source', 'enrollment.user_sessions', 'SELECT');
SELECT has_table_privilege('dashboard_rds_source', 'enrollment.user_sessions', 'INSERT');
SELECT has_table_privilege('dashboard_rds_cache', 'telemetry_ops.tenant_retention_boundary', 'SELECT');
SELECT has_table_privilege('dashboard_rds_source', 'enrollment.user_refresh_tokens', 'SELECT');
```

위 결과는 차례로 true·true·false·true·false여야 한다. 다른 원천의 UPDATE·DELETE·TRUNCATE·schema CREATE도
허용되지 않는지 확인한다. ClickHouse는 `SHOW GRANTS FOR dashboard_ch_source`·`dashboard_ch_cache`와
각 계정의 제한된 SELECT 성공을 확인한다. 인증 설정이 포함될 수 있는 `SHOW CREATE USER`는 증빙에 남기지 않는다.

## 4. JWT 최초 키 등록

### 4-1. 같은 키쌍과 작업 식별자 준비

이미 키가 등록된 환경에서 이 절을 최초 초기화로 재실행하지 않는다. 빈 원본 두 개와 작업 상태를 먼저
확인하고 기존 원본은 보존한다. 최초 생성·형식·소비 계약은 [허브 ADR-0022](../../../docs/adr/0022-user-jwt-key-provisioning.md)가 기준이다.

아래는 운영자가 별도로 수행할 예시이며 앱 시작·일반 재배포에서 실행하지 않는다.

```bash
umask 077
jwt_work_dir="$(mktemp -d)"
jwt_kid='key-<새로운-고유-식별자>'
operation_id="$(uuidgen | tr '[:upper:]' '[:lower:]')"
private_version_id="$(uuidgen | tr '[:upper:]' '[:lower:]')"
public_version_id="$(uuidgen | tr '[:upper:]' '[:lower:]')"
jwt_label="preserve-$operation_id"

openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 \
  -out "$jwt_work_dir/private.pem"
openssl pkey -in "$jwt_work_dir/private.pem" -pubout \
  -out "$jwt_work_dir/public.pem"
jq -n --arg kid "$jwt_kid" --rawfile pem "$jwt_work_dir/public.pem" \
  '{($kid): $pem}' > "$jwt_work_dir/public-keys.json"

printf '%s' 'pulsemetry-key-pair-check' > "$jwt_work_dir/challenge"
openssl dgst -sha256 -sign "$jwt_work_dir/private.pem" \
  -out "$jwt_work_dir/signature" "$jwt_work_dir/challenge"
openssl dgst -sha256 -verify "$jwt_work_dir/public.pem" \
  -signature "$jwt_work_dir/signature" "$jwt_work_dir/challenge"
```

정상 결과는 `Verified OK`와 exit 0다. 개인키는 PKCS8 `PRIVATE KEY`, 공개키는 X.509 `PUBLIC KEY` 형식의
RSA 2048bit 이상이어야 한다. 위 예시는 암호화된 개인키나 인증서를 만들지 않는다. 로컬 검증 성공은 아직
등록된 버전의 검증 성공이 아니다. `UserJwt`의 기동 시 modulus 검사도 시험 서명/검증을 대신하지 않는다.

작업 식별자·kid·두 요청 식별자와 제한된 원본 파일을 부분 실패 복구가 끝날 때까지 보존한다.
원문을 출력하거나 저장소로 옮기지 않는다. 복구 완료 뒤에는 임시 키 파일과 검증 산출물을 정리한다.

### 4-2. 기존 두 원본에 버전 등록

CDK가 만든 원본에 `put-secret-value`로 등록한다. `create-secret`을 다시 호출하거나 CDK 값 속성에
키를 넣지 않는다. 같은 재시도에는 같은 파일과 `ClientRequestToken`을 사용한다.

```bash
aws secretsmanager put-secret-value --region ap-northeast-2 \
  --secret-id soma-376/dev/user-jwt/private-key \
  --client-request-token "$private_version_id" \
  --secret-string "file://$jwt_work_dir/private.pem" \
  --version-stages "$jwt_label" --query VersionId --output text

aws secretsmanager put-secret-value --region ap-northeast-2 \
  --secret-id soma-376/dev/user-jwt/public-keys \
  --client-request-token "$public_version_id" \
  --secret-string "file://$jwt_work_dir/public-keys.json" \
  --version-stages "$jwt_label" --query VersionId --output text
```

두 등록은 원자적이지 않다. 한쪽 실패·응답 유실 시 metadata로 등록 VersionId를 확인하고 미완료 쪽만
같은 키로 복구한다. 다른 키나 값을 같은 요청 식별자로 덮어쓰지 않는다. 원래 쌍을 복구할 수 없으면
배포 참조를 확정하지 않고 해당 미배포 초기화를 폐기한 뒤 별도의 초기화를 시작한다.

```bash
aws secretsmanager list-secret-version-ids --region ap-northeast-2 \
  --secret-id soma-376/dev/user-jwt/public-keys \
  --query 'Versions[].{VersionId:VersionId,Stages:VersionStages}'
```

개인키 쪽도 같은 metadata 검사를 한다. 작업 전용 label이 각각 기록한 VersionId에 붙어 있는지 확인하고,
승인된 `asm-exec` 환경에서 선택 버전을 제한된 파일에 공급해 형식·kid·시험 서명/검증을 다시 확인한다.
검사 중 해당 label을 이동하지 않는다. 참조 형식은 `{{resolve:secretsmanager:<secret-id>:SecretString:<json-key>:<version-stage>}}`다.
공개키의 json-key는 kid, 개인키는 빈 json-key를 쓴다. 확인한 wrapper는 version-stage 형식이므로
지원하지 않는 VersionId 인자를 추측해 추가하지 않는다. 실제 배포 runtime은 label 대신 VersionId를 지정한다.

등록한 두 버전의 검증과 metadata 대응이 확정되기 전에는 최초 배포 입력을 확정하지 않는다.
같은 label 이름이 두 Secret을 원자적으로 전환한다는 뜻은 아니다.

## 5. 공통 배포 입력 확정과 인계

승인된 접근 제한 배포 기록에 저장한다. 실제 ARN 기록에 대한 접근과 각 Secret의 조회 권한을 구분하고,
dashboard에는 개인키 참조를 전달하지 않는다. 아래 표에 원문이나 JWT를 기록하지 않는다.

| 입력 | 확인할 내용 |
|---|---|
| 대상·artifact | dev·리전, ARM64 image digest·배포 revision, 관련 checkout |
| 네 DB 연결 | endpoint·database/schema, 위 표의 Secret 참조, 동일 RDS DB/CH server, 권한 검사 결과 |
| JWT 두 원본 | ARN·독립적인 두 VersionId, 작업·검증 결과, 보존 label |
| signer·verifier | enrollment active-kid, 정확한 `kid → 파일 경로`, issuer·audience |
| Web 설정 | `PULSEMETRY_USER_AUTH_ENABLED=true`, 명시적 allowed origins, management/mail capability 정합 |
| 운영 설정 | timeout·query 상한·snapshot/cleanup/alerts 등의 필수값, 결정 근거와 미확인 항목 |

설정명 전체와 값의 제약은 [공통 계약 §4](../../../docs/contracts/dashboard-api.md#4-runtime-설정-인터페이스)를 참조한다.
DB Secret은 username/password만 가지며 URL 등 비밀이 아닌 설정은 별도 입력이다. 초기 운영 수치를
추측해 확정값으로 고정하지 않는다. heartbeat·동기화 주기·평가 시간과의 관계도 실제 환경에서 확인한다.

`PULSEMETRY_USER_AUTH_PUBLIC_KEY_FILE`은 `kid=local` 경로만 바꾼다. 임의 kid나 복수 kid에는
`pulsemetry.user-auth.public-key-files`의 명시적 맵을 쓴다. 공개키 JSON 자체를 PEM 파일로 설정하지 않는다.
JWT 원문·PEM은 environment/values/configtree 설정에 넣지 않고 별도 파일의 경로만 전달한다.

PROJ-230은 네 DB Secret의 ECS 참조와 JWT task role·writer·공유 volume·SUCCESS 의존성을, PROJ-231은
Pod Identity·SPC·개별 VersionId·kid 추출 alias·별도 mount를 연결한다. enrollment는 JWT 두 원본,
dashboard는 공개키만, ingest는 JWT 권한 없음으로 제한한다. 실제 UID 10001 접근도 각 runtime에서 확인한다.

dashboard 인증은 서명만으로 끝나지 않는다. source RDS에서 `user_sessions`·`members`·`tenants`를 읽어
현재 세션의 만료·폐기, member/tenant 활성 상태, tenant/role 정합을 검사한다. HMAC·관리자 token·
raw S3 권한을 dashboard에 공유하지 않는다. 상세는 [backend 인증 운영](../../../pulsemetry-backend/docs/user-auth-operations.md)을 참조한다.

## 6. 변경·복구와 완료 판정

JWT 변경은 [기존 운영 절차 §11](dev-eks-manual-deployment.md)과
[ADR-0030 §5](../adr/0030-dev-user-jwt-keys-from-secrets-manager.md#5-교체와-복구)를 따른다.
전체 ECS/EKS enrollment/dashboard verifier에 신·구 공개키 → 전체 signer의 개인키/active-kid 전환 →
마지막 구 키 발급 후 330초 이상 → 구 공개키 제거 순서다. 마지막 발급 시각이 불명확하면 제거하지 않는다.
rollback도 verifier를 먼저 복구하고 신 키 AT가 남아 있는 동안 신 공개키를 유지한다.

VersionId 기록만으로 버전이 보존되지는 않는다. 활성·교체·승인된 rollback 버전의 label을 유지하고,
불필요한 버전의 label을 제거하기 전에 두 runtime의 배포 기록을 확인한다. AWSCURRENT/AWSPREVIOUS로
짝을 추측하지 않는다. DB password 변경도 Secret과 DB의 두 작업이며, 한쪽만 변경했다면 후속 배포를 멈추고 같은 값으로 맞춘다.

| 검사 | 이번 변경의 완료 범위와 후속 증거 |
|---|---|
| CDK 정의 | Secret 9개, 기존 3개 연속성, 신규 6개의 Retain, DB 생성 설정, JWT 값 없음을 로컬 test/synth로 확인 |
| DB 준비 | 운영자가 Secret과 같은 계정을 만들고 owner·grant·허용 SELECT·쓰기 금지를 확인. 이번에는 미실행 |
| cache DDL | RDS→CH 성공, alerts grant, snapshot 복사·재사용·삭제. PROJ-221·225에서 실행 |
| JWT 초기화 | 선택한 두 버전의 형식·kid·서명/검증, 부분 등록 복구·보존 label. 이번에는 미실행 |
| runtime | UID 접근·명시적 버전 소비·신구 AT와 현재 세션 판정·교체/rollback. PROJ-221·225에서 실행 |

health 200·Running/Ready·template 성공은 DB 권한·인증·snapshot 기능의 증거가 아니다.
실행 결과에는 checkout·설정 참조·exit code·성공/실패와 미검증 항목만 남기고 비밀이나 실제 account ID를 포함하지 않는다.

## 7. 참조

- [PostgreSQL GRANT](https://www.postgresql.org/docs/16/sql-grant.html), [default privileges](https://www.postgresql.org/docs/16/sql-alterdefaultprivileges.html)
- [ClickHouse GRANT](https://clickhouse.com/docs/sql-reference/statements/grant), [readonly/allow_ddl](https://clickhouse.com/docs/operations/settings/permissions-for-queries)
- [Secret 버전 등록](https://docs.aws.amazon.com/cli/latest/reference/secretsmanager/put-secret-value.html), [버전 보존](https://docs.aws.amazon.com/secretsmanager/latest/userguide/whats-in-a-secret.html)
- [AWS 공식 secret safety skill](https://github.com/aws/agent-toolkit-for-aws/blob/main/plugins/aws-core/skills/aws-secrets-manager/SKILL.md)
