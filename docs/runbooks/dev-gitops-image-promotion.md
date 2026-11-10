# PROJ-311 dev 이미지 승격·Argo 상태 관측 운영

이 런북은 backend의 네 앱 이미지 묶음을 private Git으로 선택하고 Argo가 적용하는 경로를 다룬다.
[ADR 0056](../adr/0056-dev-argocd-gitops-operations.md),
[허브 공급 계약](https://github.com/soma-376/docs/blob/docs/PROJ-311-gitops-delivery-contract/contracts/generated-values-sync.md),
[수동 인계 런북](dev-argocd-operations.md)을 함께 따른다. prod·frontend·perf는 대상이 아니다.

## 1. 현재 범위와 활성화 관문

PROJ-311은 backend 생산 manifest·승격 workflow와 infra의 공통 상태/CAS·Argo 관측 연결을 준비한다.
실제 AWS/클러스터 배포, GitHub App 등록·키 입력, private 저장소 게시와 운영 수락은 이 로컬 구현의
완료 근거에 포함하지 않는다. 자동 스위치는 기본 비활성이며 spring-app의 PostSync 검증 Job은 제거한다.

다음 수락 근거가 모두 있어야 자동화를 켠다.

| 관문 | 필요한 근거 |
|---|---|
| PROJ-310 | 18개 수동 인계, cert-manager/LBC 인증서·admission, private Git 읽기, CMP, 실제 첫 sync·기능 검증 |
| 최초 정상 B | 새 배포 계약을 포함한 같은 SHA/run/attempt의 네 ARM64 이미지, 원본 출처·이미지 계약과 현재 Argo 상태의 수락 증거 |
| 별도 infra 설정 publisher | 현재 B 보존·같은 공통 CAS·비이미지 소유권·충돌·owner 유실·복구 상태의 상호 운용 수락 |
| 권한·identity | 보호된 dev-gitops Environment, publisher Git 권한, 전용 Argo observer, 실제 허용/거부 검사 |
| 운영 복구 | blocked 회복·키 회전·maintenance·원래 실행 종료 확인 절차와 담당자 |

`dev/activation.json`에는 수락 결과와 비밀 없는 evidence hash를 기록한다. true 값을 수동으로 채워
실제 수락을 대신하지 않는다. image publisher는 이 파일을 변경하지 않는다. PROJ-279 사본 writer를
먼저 종료하며 H-only 생성기로 정상 B·V/P나 root를 꾸미지 않는다. 최초 정상 B를 확인한 별도 초기화
경로에서 root 연결·desired·delivery state를 준비한다. §1.1의 검토 root를 운영자가 먼저 적용한 뒤 초기 선택을 게시한다. 자동 prune·allowEmpty·삭제 finalizer는 계속 끈다.

### 1.1 검토·root 준비·최초 선택·수락 재시도

초기화 입력 JSON은 private 경로에 보관한다. `schemaVersion: 1`, `infraCommit`, `expectedHead`,
32자리 hex `operationNonce`, infra 실행의 `owner`, 검증한 생산 `provenance`, `activation`,
`normalBundleManifestSha256`, `normalBundleEvidenceSha256`, `renderEvidenceSha256`을 요구한다.
마지막 두 값은 정상 B의 운영 수락과 같은 C 렌더 검증의 증거 hash다. provenance에는 원본 run/attempt뿐 아니라 숫자 문자열 artifactId와 원본 artifact archive의 bare SHA-256 artifactSha256이 필요하다. B는 archive hash가 아니라 안에 든 완료 manifest 원본 바이트의 hash다.
generated 13개는 현재 정상 B의 이미지를 선택한다. 검증기 image·probe·deliveryVerification 입력은 사용하지 않는다.

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
root와 18개 child의 현재 revision·Synced·Healthy·진행/현재 실패 operation 부재 관측이 끝나야 첫 lastKnownGood과 idle을 기록한다. backend는 root를 apply하지 않는다.

관측 불명·실패는 초기화 owner와 선택을 보존한 blocked다. root·접근·Application 상태를 복구한 뒤
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

runner는 기존 private EKS SSM 터널과 원래 EKS hostname·CA 검증을 유지하며 별도 read-only AccessEntry와
RBAC로 `argocd` namespace의 Application만 읽는다. operator·values-reader 권한은 확대하지 않는다.
DB relay·DB credential·synthetic 계정·Prometheus proxy·S3·앱 Secret metadata와 원문을 관측하지 않는다.
Kubernetes/Argo 쓰기·exec·port-forward 권한은 주지 않는다.

[`helm/dev/platform/delivery-observer`](../../helm/dev/platform/delivery-observer/)는 observer RBAC만 준비하는
별도 bootstrap chart다. `enabled`와 실제 `applicationNames` 18개를 입력하고 고정 `pulsemetry-dev-root`
하나를 함께 허용한다. root는 별도 bootstrap이며 child inventory 수에 포함하지 않는다. 18개 Application과
generated 13개 파일 목록은 늘리지 않는다. Job·ServiceAccount·SecretProviderClass·Pod Identity는 만들지 않는다.

| 구성 | 입력/역할 |
|---|---|
| 승격 IAM 역할 | `soma-376-backend-dev-gitops`; backend의 `dev-gitops` Environment |
| EKS 관측 IAM 역할 | `soma-376-dev-eks-delivery-observer`; 별도 `pulsemetry:dev:gitops-observer` group |
| `activation.observer.roleArn` | `EksDeliveryObserverRoleArn` |
| `activation.observer.relayInstanceId` | 기존 EKS API relay |

`dev/activation.json`의 readiness는 handoffAccepted·infraPublisherAccepted·normalBundleAccepted와
acceptanceEvidenceSha256을, inventory는 실제 18개 id/releaseName/namespace/installation을 사용한다.
cert-manager만 고정 releaseName·installation=new이며 나머지는 기존 release inventory를 따른다.
verifier·databaseObserver·probe 설정을 제공하지 않는다. 기존 앱의 Secret/CSI 공급과 운영자 DB 접근은 그대로다.

## 4. Git 게시와 Argo 성공 판정

공통 publisher는 private main의 owner/generation·현재 P·예상 HEAD를 CAS로 비교한다. 한 owner가
V append, P 선택, 배포 관측, 필요한 한 번 rollback까지 잠금을 유지한다. 정상 fast-forward만 허용하고
force push·시간 기반 탈취를 하지 않는다. 응답 유실은 원격 commit과 내용을 대조하며 재게시를 추정하지 않는다.

V는 generated 13개·원본 bundle을 보존한다. 별도 P는 desired와 관련 child Application의 C/V를 한 번에
선택한다. P 자신의 SHA를 P 안에 넣지 않으며 같은 owner가 후속 상태 commit으로 expectedDesiredP와
currentSelection을 갱신한다. owner를 잃은 실행은 blocked 기록도 쓰지 않는다.

image publisher는 현재 C와 generated의 비이미지 바이트를 보존한다. `deliveryVerification` metadata 예외를
제거하며 nonce는 desired·state·evidence에만 사용한다. Deployment Pod template에는 넣지 않는다.
producer의 immutable 이미지에 포장된 계약과 B의 원본 계약 hash 검증은 유지한다. 후보 이미지 코드를
검사 프로세스로 실행하지 않는다.

플랫폼 준비 뒤 enrollment → ingest → Gateway → dashboard 순서를 유지한다. 모든 child에서 다음을 확인한다.

- spec과 `status.sync.comparedTo`의 source가 현재 C/V에 고정되고 resolved revision도 일치한다.
- `Synced`·`Healthy`이며 진행 중 operation과 현재 목표 revision에 귀속된 실패 operation이 없다.
- root도 현재 P를 포함하는 resolved revision의 `Synced`·`Healthy`이며 해당 revision의 desired/Application
  파일이 현재 선택과 같아야 한다.

같은 manifest의 새 V나 main 상태-only commit은 새 sync를 만들지 않을 수 있다. operationState가 없거나
과거 terminal operation이어도 현재 spec·comparedTo·resolved revision과 상태가 맞으면 성공할 수 있다.
현재 revision에 귀속된 완료 Failed/Error는 성공보다 우선하며, 진행 중/관측 불명 상태에서는 보류한다.
root와 18개 child의 `syncPolicy.retry.limit: 0`은 유지한다.
PostSync Job·termination message·Job UID·실제 Pod imageID·Flyway 이력·로그인·수집·저장 성공은 검사하지 않는다.
같은 이미지의 새 V나 rollback V도 목표 revision의 Argo 상태를 다시 관측한다.

## 5. 증거·실패·복구

private `dev/evidence/<operationNonce>.json`에는 정제된 결과·reason code·C/V/P/B·Application UID·
operation 시각·resolved revision을 둔다. state는 경로와 원본 바이트 hash로 연결한다. 원문 API 응답과
자격증명을 기록하지 않는다. `configurationFingerprint`는 generated의 비이미지 바이트 보존 확인용이며
실제 DB·runtime·키·TLS의 상태나 호환성 증거가 아니다.

현재 C/V와 완료 operation의 revision이 일치하는 `Failed` 또는 `Error`만 확정 실패다. root와 모든 child의
진행 중 operation이 없어야 복구를 시작한다. 과거 상태·`Degraded` 단독 상태·조회 장애·불명확한 응답·timeout은
unknown이며 blocked로 보류한다. 초기화/config 실패도 자동 이미지 rollback 대상이 아니다.

현재 이미지 배포의 확정 실패라면 실패 B·전체 이미지 벡터·source·failure fence를 먼저 CAS로 기록한다.
신규 기록은 fenceSealed=false로 영속화하고 그 게시 성공 응답 뒤의 시각으로 fenceSealed=true를 별도 CAS
기록한다. unsealed 기록만 남으면 자동 재개를 막는다. 같은 실패 B/벡터의 가장 늦은 기록 시각을 보존한다.

마지막 Argo 정상 B가 있으면 같은 owner가 현재 C와 비이미지 설정을 보존한 이전 이미지로 새 V/P를 **한 번**
선택한다. 실제 schema/migration·키·TLS·Kafka backlog 호환성은 확인하지 않는다. 이미 적용된 migration이나
변경된 runtime과 이전 이미지가 맞지 않아 복구가 실패하거나 기능 장애가 지속될 수 있는 위험을 수용한다.
일반 이미지 rollback은 Argo sync/self-heal을 유지한다. 복구도 §4의 Argo 성공 기준을 만족해야 lastKnownGood을
갱신하고 잠금을 해제한다. 이 성공은 실제 로그인·조회·수집·저장 성공을 보장하지 않는다.

unknown·config 실패·정상 B 부재·owner 소실·복구 실패는 blocked다. DB downgrade·PVC 복원·Kafka offset
reset은 수행하지 않는다. 복구 성공 뒤에도 실패 B와 이미지 벡터를 보존한다. 실패 source의 strict descendant이며
failure fence 뒤에 원본 run이 새로 생성된 정상 후보만 재개한다. rerun attempt나 manifest 재포장으로 우회하지
않는다. unlock 시 이미 끝난 적격 후보도 다시 평가한다. 차단 해제는 원래 workflow와 Argo operation 종료·실제
상태를 확인한 운영자가 새 generation의 CAS로 수행하며 시간 경과만으로 잠금을 탈취하지 않는다.

## 6. 로컬 검증과 workflow 진입점

로컬 검증은 외부 저장소 대신 임시 bare Git을 사용한다. 동시 CAS·push 응답 유실·V/P 사이 실패,
owner 소실·unknown·한 번 복구·누적 실패 fence와 비이미지 바이트 보존을 검사한다. Argo 관측 테스트는
현재/과거 revision·완료/진행 operation·Synced/Healthy·root P 이력을 대조한다.

```bash
node --test test/dev-gitops/*.test.mjs
npm test -- --runInBand
```

과거 PostSync Job을 사용한 kind 시험은 제거된 설계의 기록이며 현재 Argo 상태 전용 경로의 live 수락
증거로 재사용하지 않는다. 로컬 단위·렌더·합성 검증과 실제 dev Argo/IAM/TLS 수락은 구분한다.

보호된 backend 승격 workflow는 검증한 파일을 다음 진입점에 전달한다. 이는 별도 로컬 운영 우회 경로가
아니며 `DELIVERY_ENABLED=true`, 허용 main workflow identity, 전용 Git credential과 observer 입력을 모두
요구한다. default-branch 코드·tooling lock·원본 artifact 검증이 선행한다.

```text
node scripts/dev-gitops/promote.mjs --candidate completion.json --provenance provenance.json
```

종료 코드 0은 passed·no-op·superseded, 2는 blocked, 1은 안전하게 완료하지 못한 실행이다.
P 선택 전에 더 새로운 성공 생산 run이 있으면 이전 후보는 superseded다. 같은 owner·HEAD·원래 P를
확인해 잠금을 idle로 해제하고 backend가 최신 후보를 재평가한다. 미선택 V가 남아도 기존 P는 유지한다.
후보 교체를 일반적인 게시·관측 실패의 잠금 해제 근거로 확대하지 않는다. 공개 로그는 결과와 reason code만
남긴다. 실패 시 private 상태·현재 owner·실제 원하는 P를 확인하며 새 실행으로 잠금을 덮어쓰지 않는다.
