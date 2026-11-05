# PROJ-311 dev 이미지 승격·기능 검증 운영

이 런북은 backend의 네 앱 이미지 묶음을 private Git으로 선택하고 Argo가 적용하는 경로를 다룬다.
[ADR 0056](../adr/0056-dev-argocd-gitops-operations.md),
[허브 공급 계약](https://github.com/soma-376/docs/blob/docs/PROJ-311-gitops-delivery-contract/contracts/generated-values-sync.md),
[수동 인계 런북](dev-argocd-operations.md)을 함께 따른다. prod·frontend·perf는 대상이 아니다.

## 1. 현재 범위와 활성화 관문

PROJ-311은 backend 생산 manifest·승격 workflow와 infra의 공통 상태/CAS·검증기 연결을 준비한다.
실제 AWS/클러스터 배포, verifier 이미지 게시, GitHub App 등록·키 입력, synthetic 계정·DB 사용자 생성,
private 저장소 게시와 운영 기능 검증은 이 로컬 구현의 완료 근거에 포함하지 않는다.
자동 스위치와 spring-app의 검증 Job은 기본 비활성이다.

다음 수락 근거가 모두 있어야 자동화를 켠다.

| 관문 | 필요한 근거 |
|---|---|
| PROJ-310 | 18개 수동 인계, cert-manager/LBC 인증서·admission, private Git 읽기, CMP, 실제 첫 sync·기능 검증 |
| 최초 정상 B | 새 배포 계약을 포함한 같은 SHA/run/attempt의 네 ARM64 이미지, 현재 schema와 전체 기능의 성공 증거 |
| 별도 infra 설정 publisher | 현재 B 보존·같은 공통 CAS·비이미지 소유권·충돌·owner 유실·복구 상태의 상호 운용 수락 |
| 배포 검증기 | 검토된 infra tooling full SHA, 게시한 verifier ARM64 digest, 고정 의존성 검증 |
| 권한·identity | 보호된 dev-gitops Environment, publisher Git 권한, 전용 observer·DB reader·synthetic 계정, 실제 허용/거부 검사 |
| 운영 복구 | blocked 회복·키 회전·maintenance·원래 실행 종료 확인 절차와 담당자 |

`dev/activation.json`에는 수락 결과와 비밀 없는 evidence hash를 기록한다. true 값을 수동으로 채워
실제 수락을 대신하지 않는다. image publisher는 이 파일을 변경하지 않는다. PROJ-279 사본 writer를
먼저 종료하며 H-only 생성기로 정상 B·V/P나 root를 꾸미지 않는다. 최초 정상 B를 확인한 별도 초기화
경로에서 root 연결·desired·delivery state를 준비한다. §1.1의 검토 root를 운영자가 먼저 적용한 뒤 초기 선택을 게시한다. 자동 prune·allowEmpty·삭제 finalizer는 계속 끈다.

### 1.1 검토·root 준비·최초 선택·수락 재시도

초기화 입력 JSON은 private 경로에 보관한다. `schemaVersion: 1`, `infraCommit`, `expectedHead`,
32자리 hex `operationNonce`, infra 실행의 `owner`, 검증한 생산 `provenance`, `activation`,
`normalBundleManifestSha256`, `normalBundleEvidenceSha256`, `renderEvidenceSha256`을 요구한다.
마지막 두 값은 이미 수행한 정상 B 기능 검증과 같은 C 렌더 검증의 증거 hash다. provenance에는 원본 run/attempt뿐 아니라 숫자 문자열 artifactId와 원본 artifact archive의 bare SHA-256 artifactSha256이 필요하다. B는 archive hash가 아니라 안에 든 완료 manifest 원본 바이트의 hash다.
generated 13개는 현재 실제 정상 B의 이미지를 선택하고 검증기 image도 activation과 같아야 한다.

```text
node scripts/dev-gitops/initialize.mjs --input initialization.json --candidate completion.json --generated-dir generated --output-dir NEW_REVIEW_DIR
```

기본 실행은 네트워크 게시 없이 새 디렉터리에 `root.yaml`, `snapshot/`, `initialization-review.json`을
만든다. snapshot의 private endpoint/ARN 때문에 결과물을 공개 artifact나 Git에 올리지 않는다.
아직 V/P를 만들지 않았으므로 review의 valuesCommit/desiredCommit은 null이다.

운영자는 PROJ-310 관리 권한·Project·Git reader의 실제 수락을 확인하고 이 root 선언을 기존 보호된
EKS operator context에서 검토·수동 적용한다. root는 private main의 `dev/applications`를 읽는다.
최초 P가 없을 때 경로 부재의 comparison 오류가 날 수 있지만 prune·allowEmpty를 켜서 우회하지 않는다.
root가 준비되면 명시적인 `DELIVERY_INITIALIZATION_ENABLED=true` 운영 세션에서 위 명령에 `--publish`를
추가하고 **다른 새 output 디렉터리**를 지정한다. 게시 전에 신뢰한 검증 코드가 GitHub API의 원본
성공 run/attempt·artifact ID/hash를 대조하고 원본 archive에서 얻은 manifest 바이트가 입력 B와 같은지
확인한다. immutable 이미지에서 packaged contract를 실행 없이 추출해 비교한다. 이 경로에는 원본
Actions 조회용 `GH_TOKEN`, 기존 네 ECR에 대한 read-only AWS identity, Docker가 필요하다. 수동 readiness
hash는 원본 출처·artifact·실제 이미지 계약 검증을 대체하지 않는다.
초기화는 V → P → 배포 중 상태 순으로 게시하고 실제
18개 child의 현재 C/V·기능 검증이 끝나야 첫 lastKnownGood과 idle을 기록한다. backend는 root를 apply하지 않는다.

관측 불명·실패는 초기화 owner와 선택을 보존한 blocked다. root·접근·검증 fixture를 복구한 뒤
`expectedHead`, 같은 `owner`, 같은 `generation`의 private 재수락 입력으로 다음을 실행한다.

```text
node scripts/dev-gitops/initialize.mjs --accept-existing initial-acceptance.json
```

이 명령도 초기화 활성화 스위치를 요구한다. 기존 초기화의 config 작업·lastKnownGood 없음·정확한
owner/generation/HEAD를 검사하고 **현재 P/V를 재관측**한다. 새 V/P나 정상 B를 다시 꾸미지 않는다.
수락 중 다른 owner나 HEAD가 바뀌면 추가 상태를 쓰지 않는다. 이미 정상 운영 중인 배포의 차단 해제나
일반 rollback을 이 초기화 전용 명령으로 우회하지 않는다.

## 2. 생산과 승격의 분리

생산 workflow는 네 앱 모두 같은 backend SHA/run/attempt로 ARM64 이미지를 게시한다. Gateway도 필수다.
Docker build output digest를 원본으로 삼고 mutable dev tag를 후보 발견·검증에 사용하지 않는다.
완료 artifact는 실행·시도마다 고유하며 90일 보존을 요청한다. B는 artifact manifest의 정확한 UTF-8
바이트 SHA-256이며 private bundle은 같은 바이트를 보존한다.

공개 artifact의 repository는 `soma-376/<app>`이다. 계정 ID·전체 ECR registry·ARN·private endpoint·
private values·검증 원문을 포함하지 않는다. 각 이미지의 deployment contract와 hash는 공개 가능한
migration/스키마 계약·envelope·설치 자산 checksum만 담는다.

승격 workflow는 default branch에 정의되어야 한다. `workflow_run`의 GITHUB_SHA/REF를 생산 develop
SHA로 읽지 않는다. 검토된 승격 코드가 원본 workflow ID/path, repository/head repository, event,
develop 이력, SHA/run/attempt, 최종 success와 정확한 artifact를 GitHub API로 대조한다. 생산 artifact나
producer checkout의 executable을 승격 자격으로 실행하지 않는다. 공통 infra tooling은 desired C와
별개의 검토된 full SHA로 고정한다.

backend producer의 완료 B 생성은 승격 스위치가 false여도 develop 생산 실행마다 수행된다.
기존 backend-dev 역할의 정확한 네 ECR repository에 `ecr:GetDownloadUrlForLayer`를 추가하는 IAM을
먼저 적용한 뒤 새 producer workflow를 develop에 머지한다. 이미지 push가 성공해도 이 권한이 없으면
실제 packaged contract를 읽는 완료 B 단계는 실패할 수 있다. `DEV_GITOPS_ENABLED`는 job-level if가
읽는 repository variable이며 Environment에만 두지 않는다.

생산 ECR push 역할과 `dev-gitops` Environment의 승격·관측 역할은 분리한다. 자동 스위치가 꺼져 있으면
workflow_run·수동 실행·30분 schedule 모두 승격하지 않는다. 활성화 후 세 경로는 같은 후보 적격성·공통
잠금·실패 fence를 적용한다. concurrency는 cancel-in-progress false이며 Git CAS를 대체하지 않는다.

## 3. 운영 입력과 읽기 경계

원문 credential은 Git·Helm values·공개 artifact·로그에 기록하지 않는다. AWS Secret은 runtime의
`asm-exec` 참조 또는 기존 CSI의 고정 버전 파일로 공급한다. 운영자가 값을 준비하며 모델 컨텍스트로
읽어 들이지 않는다. registry/Git writer, Argo reader, synthetic API identity와 DB reader는 분리한다.

| 관측 대상 | 허용 경로 | 허용하지 않는 대체 |
|---|---|---|
| EKS/Argo | 기존 private EKS SSM 터널, 원래 hostname·CA 검증, 전용 read-only AccessEntry/RBAC | operator/values-reader 확대, Kubernetes 쓰기, exec/port-forward |
| PostgreSQL | 기존 DB relay·5432, 전용 reader의 세 Flyway 이력과 catalog fingerprint | master·앱 DB 계정, 데이터 DML·일반 운영자 권한 |
| ClickHouse | 기존 DB relay·8123, schema와 synthetic tenant의 검증 행만 읽기 | 전체 고객 데이터·암호화 credential 조회 |
| Prometheus | 기존 Service의 정확한 services/proxy GET, 신선한 exporter/offset 지표 | 새 공개 endpoint·광범위 Service proxy |
| S3 | 정확한 archive key를 Prefix로 한 ListObjectsV2, MaxKeys=1 | GetObject·archive 본문 다운로드 |
| 인증 기능 | 전용 tenant/member/installation PIT, 실행마다 새 OIDC 로그인 | JWT 자체 서명, DB session INSERT, 고정 refresh token 재사용 |

PostgreSQL 이력은 `enrollment.flyway_schema_history`, `telemetry_ops.flyway_schema_history`,
`dashboard_cache.flyway_schema_history`다. 현재 catalog fingerprint와 migration 성공·checksum을 함께
검사한다. 검증 reader의 사용자 생성·grant·row policy 적용 후 실제 거부 검증을 별도로 남긴다.
기존 reader의 과도한 grant를 발견해도 자동 REVOKE하지 않는다.

### 3.1 infra 지원 chart와 역할

[`helm/dev/platform/delivery-verification`](../../helm/dev/platform/delivery-verification/)은 observer RBAC와
검증 Job의 전용 ServiceAccount·SecretProviderClass를 준비하는 별도 bootstrap 구성이다. 18개 기존
Application inventory와 generated 13개 목록을 늘리지 않는다. 적용 전 실제 Application 18개·Job 4개·
workload 4개의 이름을 고정하고 기존 Prometheus의 정확한 Service proxy 이름을 확인한다.
observer는 이 18개 child와 고정 `pulsemetry-dev-root` 하나를 읽는다. root는 별도 bootstrap이며 child inventory 수에 포함하지 않는다.
기본값의 빈 목록·빈 proxy/Secret 입력으로 활성화하지 않는다.

| 구성 | 입력/역할 |
|---|---|
| 지원 chart | `enabled`, `applicationNames`, `jobNames`, `workloadNames`, `prometheus.namespace`, `prometheus.proxyName`, `probeSecretArn`, `probeSecretVersionId` |
| 승격 IAM 역할 | `soma-376-backend-dev-gitops`; backend의 `dev-gitops` Environment |
| EKS 관측 IAM 역할 | `soma-376-dev-eks-delivery-observer`; 별도 `pulsemetry:dev:gitops-observer` group |
| DB 조회 IAM 역할 | `soma-376-dev-delivery-db-reader`; 기존 고정 relay 경로 |
| 검증 Pod | `pulsemetry-dev/deployment-verifier`; 앱의 ServiceAccount와 분리 |
| 검증 Job credential 원본 | 운영자가 준비하는 기존 `pulsemetry/dev/deployment-verifier`; chart는 ARN·고정 VersionId만 참조 |
| runner DB credential 원본 | 기존 `pulsemetry/dev/deployment-verifier-db-reader`; 고정 VersionId와 `gitops-` version stage를 교차 확인 |

원본 Secret을 이 변경에서 생성하거나 값을 조회하지 않는다. `probeSecretVersionId` 변경은 infra 설정
변경이며 일반 이미지 승격이 임의 회전하지 않는다. IAM·RBAC의 조회 권한이 응답 필드를 제한한다고
표현하지 않는다. Secret 조회는 metadata-only 요청을 강제하고 원문 fallback을 하지 않는다.

### 3.2 private activation·검증 입력

`dev/activation.json`의 `readiness`에는 handoffAccepted·infraPublisherAccepted·normalBundleAccepted와
acceptanceEvidenceSha256을, `inventory`에는 실제 18개 id/releaseName/namespace/installation을 둔다.
cert-manager만 고정 releaseName과 installation=new이며 나머지는 기존 release inventory를 따른다.
추가 runtime 입력은 다음과 같다. 실제 ARN·host·bucket/account 값은 private 파일에서만 공급한다.

| 객체 | 필드와 조건 |
|---|---|
| `verifier` | `repository`, `digest`, `arm64ManifestDigest`; 동일한 검토된 도구 이미지의 root·ARM64 child digest |
| `observer` | `roleArn`은 EksDeliveryObserverRoleArn, `relayInstanceId`는 기존 EKS API relay |
| `databaseObserver` | `roleArn`은 DeliveryDbReaderRoleArn, `relayInstanceId`는 기존 DB relay |
| `databaseObserver`의 Secret 참조 | `probeSecretName`=`pulsemetry/dev/deployment-verifier-db-reader`, 고정 `probeSecretVersionId`와 `gitops-`로 시작하는 `probeSecretVersionStage` |
| `databaseObserver.postgres` | 현재 RDS `host`, `database`=`controlplane`, `sslmode`=`require` 또는 `verify-full` |
| `databaseObserver.clickhouse` | 현재 schema 원본 `database`; host는 현재 Ready ClickHouse Pod 하나를 EKS에서 읽어 고정 SSM document에 전달 |

runner는 EKS의 원래 hostname·CA, PostgreSQL의 원래 host와 TLS mode를 유지하고 연결 주소만 loopback으로
바꾼다. DB Secret은 `DescribeSecret`으로 VersionId↔stage를 검사한 뒤 고정된 asm-exec로 runtime에서만
해석하며 검사 뒤에도 stage를 재확인한다. caller가 resolver endpoint·Python 실행 경로를 바꾸지 못한다.
DB reader Secret JSON은 postgres와 clickhouse 각각의 username/password만 포함한다. 일반 사용자·PIT·
OIDC credential은 runner DB reader에 공급하지 않는다.

네 앱의 고정 `deliveryVerification.config`는 schemaVersion 1과 postgres(host/port/database/sslmode),
clickhouse(origin/database), enrollmentOrigin·gatewayOrigin·dashboardOrigin을 담는다.
prometheus는 namespace·proxyName·topic·consumerGroup·exporterJob·collectionMaxSeconds·scrapeIntervalSeconds,
archive는 bucket·accountId, oidc는 idpOrigin·redirectUri를 사용한다. 수집/스크레이프 지연 합은 0초 초과
90초 이하이며 이 값보다 신선한 실제 sample을 요구한다. redirectUri는 계약에 등록한 127.0.0.1 loopback이다.

Job용 probe.json에는 synthetic tenantId·installationId·installationToken·유효 invitationCode,
postgres/clickhouse username/password와 oidc username/password를 둔다. 실제 값을 values나 문서에 쓰지
않고 고정 버전 CSI 파일로만 공급한다. invitation 만료·PIT 회수·IdP MFA/추가 동의/지원하지 않는 로그인
화면은 unknown으로 중단한다. 운영자가 fixture와 공급 버전을 검토·갱신하며 자동화를 위해 인증을 우회하지 않는다.

앱 Secret의 현재 mount만으로 rollback 호환성을 판정하지 않는다. verifier와 runner DB reader가 허용된
원본 ARN의 DescribeSecret metadata로 고정 objectVersion 또는 AWSCURRENT의 선택 VersionId를 읽고
현재 Pod들의 CSI mount 버전과 대조한다. 선택 metadata도 지문에 포함한다. stage 이동 뒤 Pod 재시작 전
불일치는 unknown/blocked이며, 복구 Pod가 새 키를 읽을 수 있으므로 이전 이미지 자동 복구를 시작하지 않는다.
이 권한은 앱 Secret 원문 읽기를 허용하지 않으며 기존 probe credential의 runtime 공급과 구분한다.

### 3.3 최소 DB 권한 검토

아래는 SQL을 출력할 뿐 실행하지 않는다. 실제 synthetic tenant와 installation UUID를 넣어 별도 DB
관리자가 검토·적용한다. reader LOGIN·암호·ClickHouse readonly profile과 제한 view의 owner 준비는
운영 작업이며 기존 master·앱 사용자 계정을 재사용하지 않는다.

```bash
python3 scripts/deployment-verifier/grants.py --tenant '<tenant UUID>' --installation '<installation UUID>' --database postgres
python3 scripts/deployment-verifier/grants.py --tenant '<tenant UUID>' --installation '<installation UUID>' --database clickhouse
```

ClickHouse는 전용 `deployment_verification.telemetry_events` view의 tenant·installation 조건과 허용
column만 읽는다. 원천 테이블의 전체 SELECT나 INSERT/ALTER 권한은 주지 않는다. 실제 적용 뒤 다른
tenant·원천·쓰기·추가 session 경로의 거부를 확인한다.

## 4. Git 게시와 gate

공통 publisher는 private main의 owner/generation·현재 P·예상 HEAD를 CAS로 비교한다. 한 owner가
V append, P 선택, 배포 관측, 필요한 한 번 rollback까지 잠금을 유지한다. 정상 fast-forward만 허용하고
force push·시간 기반 탈취를 하지 않는다. 응답 유실은 원격 commit과 내용을 대조하며 재게시를 추정하지 않는다.

V는 generated 13개·원본 bundle을 보존한다. 별도 P는 desired와 관련 child Application의 C/V를 한 번에
선택한다. P 자신의 SHA를 P 안에 넣지 않으며 같은 owner가 후속 상태 commit으로 expectedDesiredP와
currentSelection을 갱신한다. owner를 잃은 실행은 blocked 기록도 쓰지 않는다.

image publisher는 현재 C와 비이미지 바이트를 보존한다. 예외는 네 앱의 deliveryVerification 아래
operationNonce·infraCommit·bundleManifestSha256·imageDigest·contractSha256·contract 여섯 leaf뿐이다.
검증기 image·ServiceAccount·Secret·endpoint·timeout을 바꾸려면 infra 설정 경로를 사용한다.
nonce는 검증 Job 입력에만 반영하고 Deployment Pod template에는 반영하지 않는다.

| wave | PostSync의 기능 확인 |
|---|---|
| enrollment | 두 Flyway 이력, PIT의 telemetry JWT 발급, 고정 설치 bootstrap 자산 |
| ingest | 목표 digest workload·schema·저장 경로·TLS 준비 |
| Gateway | 고유 OTLP 한 번 ACK, ClickHouse 기대 관측 한 행, 정확한 archive key의 S3 metadata, Kafka commit watermark |
| dashboard | cache Flyway, 전용 사용자 실제 OIDC 로그인과 대표 조회 |

활성화한 root와 18개 child는 `syncPolicy.retry.limit: 0`을 명시한다. 동일 게시 operation을 자동
재시도해 PostSync 검증을 중복 실행하지 않도록 하며, 재검증은 새 nonce의 다음 게시나 명시적 운영 절차로 한다.
고정 이름의 Job은 BeforeHookCreation·backoffLimit 0을 사용하고 성공·실패 직후 삭제하지 않는다.
다음 검사가 시작될 때 이전 Job을 교체하므로 runner는 현재 nonce와 UID를 반드시 확인한다. 동일 이미지의
새 V와 rollback V도 네 gate를 다시 실행한다. selective sync·ApplyOutOfSyncOnly를 사용하지 않는다.
후보 이미지 코드를 검사 프로세스로 실행하지 않고 신뢰한 verifier가 계약을 대조한다.
Job은 자신의 Application operation 성공을 기다리지 않는다. Job 종료 뒤 runner·parent health가 현재
C/V와 Synced·Healthy·완료 operation을 확인한다. root의 Synced·Healthy·Succeeded와 실제 resolved revision도 확인하며 그 Git 이력에 현재 P가 포함돼야 한다.

Kafka 성공은 ACK 이후의 모든 partition end-offset 벡터와 그 이상인 이후 committed-offset 벡터를
신선한 sample에서 대조한다. topic/group·partition 집합·exporter UP이 맞아야 한다. lag 0이나 처리 로그는
commit 증거가 아니다. ACK 불명확 때 OTLP를 재송신하지 않는다. CH 기대 행과 archive reference로 S3
Key·Size·LastModified를 확인한다. synthetic 검사 성공을 전체 고객 데이터 정합·최대 부하 검증으로 확대하지 않는다.

## 5. 증거·실패·복구

termination message는 4KiB 미만 schemaVersion 1이며 nonce·stage·C·B·image digest·contract hash,
result·checks·checkedAt·evidence hash를 연결한다. runner가 실제 Job UID·Pod imageID·현재 Argo operation·
V/P를 추가로 대조한다. 정제된 root 증거는 선택적으로 uid·revision·startedAt·finishedAt만 기록한다. 메시지 잘림·결측·deadline·예상하지 않은 exit·조회 또는 IdP 장애는 unknown이다.
Job Failed나 timeout만으로 이미지의 확정 실패를 만들지 않는다.

private `dev/evidence/<operationNonce>.json`에는 정제된 결과·reason code·revision·검사 시각·fingerprint만
둔다. state는 경로와 원본 바이트 hash로 연결한다. 원문 HTTP/SQL/Prometheus 응답·token·사용자 데이터·
AWS 조회 전체·archive 본문은 남기지 않는다. Git 게시·Synced·Healthy·기능 성공은 각각 별도 증거다.

현재 P의 확정 실패이고 진행 operation이 끝났을 때 실패 B·전체 이미지 벡터·source·failure fence를 먼저
CAS로 기록한다. 신규 기록은 먼저 fenceSealed=false로 영속화하고 그 게시 성공 응답을 확인한 뒤의
시각으로 fenceSealed=true를 별도 CAS 기록한다. unsealed 기록만 남으면 자동 재개를 막는다. 전체 Git
이력에서 같은 실패 B/벡터의 가장 늦은 시각을 보존해 오래된 레코드가 fence를 낮추지 못하게 한다.
실패 시 재조회한 schema/migration, C/runtime, key/TLS metadata, envelope fingerprint가
배포 전 lastKnownGood과 모두 같을 때만 같은 owner가 이전 정상 이미지로 새 V/P를 한 번 선택한다.
schema 변경의 하위 호환성을 추정하지 않는다. 일반 이미지 rollback은 Argo sync/self-heal을 유지한다.

unknown·config 실패·정상 B 부재·fingerprint 변경/조회 실패·owner 소실·복구 실패는 blocked다.
DB downgrade·PVC 복원·Kafka offset reset을 수행하지 않는다. 복구 성공 뒤에도 누적 실패 B와 이미지
벡터를 보존한다. 실패 source의 strict descendant이며 failure fence 뒤에 원본 run이 새로 생성된 정상
후보만 재개한다. rerun attempt의 시작 시각이나 manifest 재포장으로 우회하지 않는다. unlock 시 이미
끝난 적격 후보도 다시 평가한다. 차단 해제는 원래 workflow와 Argo operation 종료·실제 상태를 확인한
운영자가 새 generation의 CAS로 수행하며 시간 경과만으로 잠금을 탈취하지 않는다.

## 6. 로컬 검증과 workflow 진입점

로컬 검증은 외부 저장소 대신 임시 bare Git을 사용한다. 실제 동시 CAS·push 응답 유실·V/P 사이 실패,
owner 소실·unknown·schema 변경·한 번 복구·누적 실패 fence와 비이미지 바이트 보존을 검사한다.

```bash
node --test test/dev-gitops/*.test.mjs
python3 -m unittest discover -s scripts/deployment-verifier -p 'test_*.py'
```

고정 Helm 3.22.0·kind·kubectl·Docker를 준비한 환경에서는 다음으로 실제 Argo 3.5.7 격리 시험을 재현한다.

```bash
python3 tools/deployment-verifier/argocd-integration.py --kind kind --helm helm
```

두 앱 fixture·두 source·현재 custom health·retry 0으로 7개 검사를 통과했다. 같은 이미지의 새 nonce가
Job UID만 바꾸고 앱 Pod UID는 보존했으며, 실패 PostSync는 다음 wave의 이전 V/Job을 유지하고 root
operation을 Failed로 종료했다. 실패 Job 보존도 확인했다. 이 kind 검증은 dev AWS·18개 실운영
Application·인증/수집 경로의 운영 수락을 대신하지 않는다.

보호된 backend 승격 workflow는 검증한 파일을 다음 진입점에 전달한다. 이는 별도 로컬 운영 우회 경로가
아니며 `DELIVERY_ENABLED=true`, 허용 main workflow identity, 전용 Git credential과 observer 입력을 모두
요구한다. default-branch 코드·tooling lock·원본 artifact 검증이 선행한다.

```text
node scripts/dev-gitops/promote.mjs --candidate completion.json --provenance provenance.json
```

종료 코드 0은 passed·no-op·superseded, 2는 blocked, 1은 안전하게 완료하지 못한 실행이다.
P 선택 전에 더 새로운 성공 생산 run이 있으면 이전 후보는 superseded다. 같은 owner·HEAD·원래 P를
확인해 잠금을 idle로 해제하고 backend가 최신 후보를 재평가한다. 미선택 V가 남아도 기존 P는 유지한다.
이 후보 교체를 일반적인 게시·관측 실패의 잠금 해제 근거로 확대하지 않는다. 공개 로그는 결과와
reason code만 남긴다. 실패 시 private 상태·현재 owner·실제 원하는 P를 먼저 확인하며 새 실행으로 잠금을
덮어쓰지 않는다. 로컬 단위/렌더 검증과 실제 Argo 3.5.7 wave·IAM/TLS·OIDC·DB/Kafka/S3 인수는 구분한다.
