# PROJ-262: dev dashboard 조회 권한 복구

[ADR-0041](../adr/0041-dev-dashboard-read-grants-repair.md)에 따른 기존 역할의 누락 권한 복구다.
일반 배포와 분리하며 **dev 적용은 로컬 전체 시나리오 검증·사용자 확인 후** 수행한다.
ClickHouse·이미지·조회 한도·계정·암호·업무 행·Flyway 이력을 변경하지 않는다.

## 대상과 코드 근거

backend develop `42316d6d8b85365639c928de80dd4f8e0879b721` 기준이다.

| 연결 | 필요한 권한 | 코드 근거 |
|---|---|---|
| dashboard source | enrollment/telemetry_ops USAGE, 명시 29 table SELECT | AnalyticsConfig의 source 조립, AlertEvaluator, AlertService, SnapshotReferenceCopier, SeatLedgerReader, OperationReader, VendorCatalog, UserAuthRepository의 session/member 조회 |
| source vendor 연결 | 비밀 아닌 18열 SELECT | VendorConnectionStore.kt의 VendorConnections.COLUMNS와 active의 WHERE deleted_at. dashboard SettingsService는 이 reader를 사용하며 암호문 SELECT 또는 SELECT *를 하지 않음 |
| dashboard cache | telemetry_ops USAGE, tenant_retention_boundary SELECT | SnapshotManifestStore의 ready 공개 CAS가 cache 연결에서 policy_epoch를 확인 |
| enrollment runtime | dashboard_cache USAGE, alerts SELECT | AlertRules.acknowledge가 tenant/qualified/version을 확인 |

source의 members/user_sessions는 현재 repository가 `m.*`/`SELECT *`를 사용하므로 테이블 단위다.
V28에서 제거한 `members.password_hash`가 남은 스키마에는 준비를 거부한다. tenants의
`oidc_client_secret_ref`는 비밀 원문이 없는 `config:<키>` 참조다. 토큰·암호문 저장 테이블은 허용하지 않는다.

## 준비와 검토

1. [DB SSM 릴레이](dev-database-access.md)로 승인된 dev target에 접속한다. 새 접속 정보를 추정하지 않는다.
   `PGHOST/PGHOSTADDR/PGPORT/PGUSER/PGSSLMODE/PGSSLROOTCERT/PGPASSFILE` 또는 libpq service를
   운영자 환경에서 공급한다. password를 명령 인자·stdout·티켓에 넣지 않는다. `controlplane` DB와
   현재 enrollment runtime 역할을 실제 연결 설정에서 확인한다.
2. 원천 Flyway와 cache Flyway가 완료되고 source/cache 기존 역할이 존재해야 한다. 신규 계정 준비는
   [공통 준비 런북](dev-dashboard-prerequisites.md) 범위다. 이 도구는 기존 broad grants를 자동 회수하지 않는다.
3. 다른 DB 권한/role/schema migration 작업을 멈춘 점검 구간에서 아래 **읽기 전용** 준비를 수행한다.
   업무 행이 아니라 catalog·권한만 읽으며 timeout은 30초다.

```bash
python3 scripts/dev-dashboard-read-grants.py prepare \
  --database controlplane --enrollment-role '<확인한_runtime_역할>' \
  --out '<새로운_제한된_작업_디렉터리>'
```

`before.json`과 `plan.json`의 대상·역할·누락 grant, `apply.sql`을 검토한다. 출력은 0600이며 baseline은
덮어쓰지 않는다. 필요한 테이블/열이 없거나 source/cache에 이미 허용목록 밖 유효 권한이 있으면 중단한다.
원본은 추적된 script/런북이고 개인 reports의 생성 SQL은 해당 상태에만 유효한 적용·복구 증빙이다.

## 승인된 적용과 확인

```bash
psql -X --dbname=controlplane --file='<작업_디렉터리>/apply.sql'
python3 scripts/dev-dashboard-read-grants.py verify \
  --database controlplane --enrollment-role '<같은_runtime_역할>' \
  --out '<같은_작업_디렉터리>'
```

`apply.sql`은 트랜잭션 시작 시 전체 관측 catalog가 baseline과 같은지 검사한다. 누락된 GRANT만 적용하고
필수 조회 권한·이전 거부 권한을 다시 검사한 뒤 commit한다. 읽기 전용 연결에서 실행하면 실패한다.
운영자는 적용용 세션의 read-only 제한만 명시적으로 해제한다. 도구는 이를 자동 우회하지 않는다.

같은 파일을 무작정 재실행하지 않는다. 재시도 전 새 디렉터리에 prepare하면 이미 유효한 grant는 제외된다.
모두 적용됐다면 missingGrants=0이므로 권한 변화가 없는 SQL이 나온다. COMMIT 응답이 유실됐으면 먼저 verify로
현재 상태를 확인한다. 검증은 catalog/ACL 추가분 외 변화가 없고 원래 ACL이 보존됐는지도 확인한다.

verify 성공 후 `after.json`, `verification.json`, `rollback.sql`이 생성된다. catalog만으로 완료하지 말고
별도로 실제 계정의 SSO→dashboard 로그인, 목록/상세/설정/알림, cache snapshot 생성·재사용과 서버 로그를 확인한다.
권한 거부 검사는 실제 업무 행 변경 대신 metadata 함수 또는 rollback되는 로컬 테스트에서 수행한다.

## 복구

권한 복구 전 최신 ACL을 점검한다. verify가 만든 `rollback.sql`은 관측된 after와 일치할 때만 **이번에
추가한 grant**를 회수한다. 원래 있던 권한·소유자·role membership·default ACL을 회수하지 않는다.
동시 권한 변경이 있으면 자동 복구를 거부한다. 새 상태를 보존하고 담당자가 ACL 차이를 검토한다.

```bash
psql -X --dbname=controlplane --file='<작업_디렉터리>/rollback.sql'
```

복구는 원래 조회 장애도 되돌린다. 적용 후 verify 전에 연결이 끊겼다면 before/plan을 보존하고 연결 복구 후
같은 디렉터리에서 verify를 실행해 rollback을 만든다. 자료가 없을 때 전체 REVOKE로 추정 복구하지 않는다.

## 로컬 검증

새 격리 PostgreSQL과 실제 backend migration을 사용한다. 로컬 container 입력은
`--docker-container <전용_컨테이너> --docker-user <관리자>`이며 dev 터널과 섞지 않는다.
source USAGE가 없는 상태의 42501, 수정 후 같은 JOIN/인증 reader의 성공, INSERT/UPDATE/DELETE/DDL·
credential 열/테이블 거부를 검증한다. 별도 fixture 역할의 enrollment→cache alerts 읽기/쓰기 경계,
무변경 재준비, drift 거부, rollback 전후 ACL 동등성도 확인한다. 실제 앱 API E2E 결과와 함께 기록한다.
