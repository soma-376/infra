# 0056. dev Kubernetes 선언은 검증한 revision 묶음을 Argo CD로 적용한다

## Status

Accepted (PROJ-280 설계와 PROJ-311의 Argo 상태 기반 배포·단일 이미지 복구 경계 채택; 기존 PostSync 기능 검증·실환경 호환성 관문은 제거한다; Git 관리 자격증명 공급은 [ADR 0057](0057-dev-argocd-github-app-authentication.md)로 부분 대체한다. C/B/V/P·CSI·게시 권한 계약은 유지하며 실제 GitOps 인계는 별도 운영 수락 대상이다.)

[ADR 0028의 EKS 수동 Helm 전환](0028-dev-eks-auto-mode-transition.md) 중 인계된 리소스의
일반 배포 주체와 Argo 제외 결정을 부분 대체한다. CDK의 AWS 소유권, Auto Mode의 노드 관리,
ARM64·스토리지·Secret·private API 경계는 유지한다. [ADR 0049](0049-dev-strimzi-kafka-and-staged-msk-retirement.md)의
Strimzi 토폴로지·KafkaTopic 소유권·인증서 명시적 재배포도 유지하고 그 적용 주체만 인계 후 Argo로 바꾼다.
레포 간 계약은 [허브 ADR 0035](https://github.com/soma-376/docs/blob/docs/PROJ-311-gitops-delivery-contract/adr/0035-dev-gitops-delivery.md)과
[generated-values 계약](https://github.com/soma-376/docs/blob/docs/PROJ-311-gitops-delivery-contract/contracts/generated-values-sync.md)이 소유한다.
PROJ-277의 private 사본 공급·사용 절차 위에 이 결정을 쌓는다. 입력·생성기 소유권과 접근 제한은 계승하고,
인계된 대상의 수동 게시·Helm 적용 경로는 검증한 C/V/B/P 승격·Argo 적용으로 확장한다.

## Context

현재 dev는 Strimzi·`network-removed`·ALB Gateway·ingest `kafka` profile이며 Helm release로 운영한다.
Strimzi·관측의 실제 완료 근거는 [완료 기록](../runbooks/proj191-strimzi-completion.md)에 있다.
Argo 도입 여부와 이 기존 검증 결과는 별개다. 관측 ADR 0039의 `Proposed` 상태도 이번 결정으로 바꾸지 않는다.

`scripts/eks-values.mjs`의 `generateValues()`는 CDK output·추적 profile/runtime·네 앱 digest·Strimzi
Secret metadata로 값을 만든다. 현재 spring-app은 `image.repository`와 bare `image.digest`를 요구한다.
이미지를 생산한 backend 실행은 네 digest를 이미 알고 있다. 따라서 Image Updater 도입을 철회하고
backend workflow가 같은 실행의 완성 묶음을 검증해 이미지 갱신·롤백을 게시한다. infra는 설정 생성·게시를
소유하며 두 게시기는 공통 Git 잠금으로 같은 배포 선택을 직렬화한다. 기존 이미지 필드와 overlay 없는 구성을 유지한다.

Strimzi Operator는 vendor chart와 Helm 3.22.0, `scripts/strimzi-operator-post-render.mjs`를 함께 사용한다.
단순한 native Helm Application으로 바꾸면 namespace 검증·감시 범위 축소가 사라질 수 있다.
기존 Helm의 저장된 revision은 Argo 적용 이후의 실제 선언을 추적하지 못한다.

앱별 PostSync 검증기는 synthetic 계정·DB reader·검증 이미지·추가 IAM/RBAC와 실제 인증·저장 검사를
요구해 공유 dev의 운영 부담을 키웠다. 이 복잡도를 줄이기 위해 배포 성공은 현재 revision의 Argo 상태로
판정한다. 실제 기능 장애의 미탐지와 migration 후 이전 이미지의 비호환 위험을 수용하고 한 번의 자동 이미지 복구는 유지한다.

## Decision

### 0. Argo 인계 전 CD 사본 공급

PROJ-279는 [ADR 0048](0048-dev-cloudformation-cicd.md)의 성공한 CDK 배포 뒤 수동 Helm용 YAML
13개와 infra 전체 SHA를 private main에 공급한다. 최초 실제 사본도 CD가 생성·검증·게시한다.
plan에서 고정한 backend 성공 run/attempt·SHA·네 ARM64 digest와 로그 해시는 임시 이미지 입력이며,
완료 manifest B나 정식 GitOps 게시·승격 증거로 해석하지 않는다. backend 소스 변경은 이 경로의 범위가 아니다.

전용 reader·metadata-only 조회, 승인 시 활성 여부 고정, 배포 receipt와 사본 job 재시도는 ADR 0048을 따른다.
같은 infra SHA의 생성기·추적 입력과 재조회한 Outputs·Strimzi metadata로 전체 묶음을 검증한다.
private 시작 HEAD에 대한 정상 push로 14개 파일만 한 commit으로 공급하며 동일 내용은 no-op이다.
게시 직전 metadata를 재대조하고 경쟁·불명확한 응답·실패를 성공으로 숨기지 않는다. 응답 유실은 원격
commit·내용을 확인해 이미 성공한 게시를 중복하지 않는다. 이미지 선택을 바꾸는 재시도는 새 plan이 필요하다.

`dev/bundle.json`, `dev/desired.yaml`, `dev/applications/`, `dev/delivery-state.json` 중 하나라도 있으면
이 사본 writer는 중단한다. Argo 인계 전에 writer를 먼저 중지하고 실제 실행 중 이미지로 별도 handoff
snapshot H를 검증한다. 사본에 기록된 최신 성공 이미지가 현재 실행 이미지임을 가정하지 않는다.
인계 이후에는 아래 정식 publisher를 사용하며 이 사본 writer와 동시에 운영하지 않는다.
사본 공급 성공은 Helm 적용·Argo 설치·기능 성공을 뜻하지 않으며 Helm 적용은 인계 전까지 수동이다.

### 1. 범위와 소유권

- 대상은 공유 dev EKS다. prod·frontend Terraform·perf는 Application 대상에서 제외한다.
- CDK는 기존 AWS 리소스·IAM·SG·ALB/TG를 소유하고 [ADR 0048](0048-dev-cloudformation-cicd.md)의
  고정 Assembly 승인·배포를 유지한다. backend에는 CDK·Helm·Kubernetes·Argo 직접 변경 권한을 추가하지 않는다.
- Helm chart는 Kubernetes 선언의 원본이며, 인계 이후 Argo가 렌더·적용·상태 복구를 수행한다.
  Auto Mode는 노드를, Strimzi는 Kafka CR에서 파생한 리소스를 계속 관리한다.
- Argo CD 자체는 버전·chart checksum·이미지 digest를 infra에서 고정하고
  운영자가 수동 Helm으로 설치·업그레이드한다. 초기 자기 관리는 하지 않는다. 전용 `argocd` namespace,
  기존 ARM64 apps 노드의 비 HA 구성, ClusterIP와 기존 SSM/private EKS 접속을 사용한다.
- 초기 인계는 수동 diff·sync로 수행한다. 인계 후 모든 대상 Application은 자동 sync·self-heal을 사용하되
  `prune`·`allowEmpty`는 끈다. Application 삭제도 연쇄 리소스 삭제로 연결하지 않는다.
  PVC·Namespace·CRD와 Kafka/ClickHouse 제거는 별도 삭제 절차다. prune 비활성화는 CR spec 변경에 따른
  Operator의 데이터 삭제나 스토리지 변경까지 막는 장치가 아니므로 해당 변경은 승격 전 검토한다.

### 2. Application과 적용 순서

기존 namespace·`releaseName`·리소스 이름·selector·PVC를 보존한다. 기존 platform release 이름은
운영 기록과 실제 Helm inventory로 확정하며 문서 예시 이름으로 교체하지 않는다.

| 관리 단위 | Application 경계 | 선행 조건 |
|---|---|---|
| platform/base | 하나 | CDK output·NodeClass/NodePool·namespace 정합 |
| LBC, CSI driver, ASCP, Fluent Bit | 기존 release마다 하나 | 기반 준비, 필요한 CRD·Pod Identity |
| cert-manager | 신규 release 하나 | namespace 준비, 고정 CRD·webhook·startup API check |
| runtime-config | 하나 | CSI/ASCP 준비; 원문 없는 Secret 참조 |
| Strimzi Operator와 CRD | 하나 | 기반 준비; 고정 renderer 검증 |
| Kafka CR | Operator와 별도 하나 | CRD Established·Operator Ready; Kafka/Topic/User 상태 검증 |
| ClickHouse | 하나 | 기존 PVC·AZ·CSI 준비 |
| observability, Loki, Tempo, otel-platform | 기존 release마다 하나 | 기반·CSI·필요한 CRD 준비 |
| enrollment, ingest, Gateway, dashboard | 앱마다 하나 | 아래 앱 순서 |

[ADR 0058](0058-dev-lbc-cert-manager-and-argocd-handoff.md)은 cert-manager를 18번째 관리 대상으로 추가하고
LBC 인증서 소유권·수동 H 인계 출력을 구체화한다. 기존 17개 release 이름과 generated 13개 파일 계약은 유지한다.
cert-manager 준비·LBC 인증서 전환의 실제 수락 전에는 일반 인계를 진행하지 않는다.

`telemetry-kafka-admin`의 offset reset 등 수동 Job은 자동 sync/hook 대상이 아니다.
Strimzi가 생성하는 Pod·Service·PVC·Secret을 별도 Application으로 중복 선언하지 않는다.

상위 Application이 하위 Application 선언을 관리하는 app-of-apps 구조를 사용한다. 플랫폼·runtime·데이터
의존성 준비 후 **enrollment → ingest → Gateway → dashboard** 순서로 적용한다.
하위 Application의 custom health는 현재 spec과 `status.sync.comparedTo`, 원하는 C/V와
`status.sync.revision/revisions` 일치, Synced·Healthy,
진행 중/현재 revision 실패 operation 부재를 함께 요구한다. 이전 revision의 Healthy만으로 다음 wave를 열지 않는다.
Kafka CR은 Ready와 observedGeneration을 함께 검사한다. 일반 배포 순서가 JWT verifier→signer 같은
특수 순서를 대체하지 않으며, 그 변경은 일반 승격을 보류하고 별도 단계로 적용한다.

네 앱의 Git 선택은 한 번에 바꾸지만 Kubernetes 교체는 순차적이다. replica 1·Recreate를 유지하므로
중단과 혼합 버전 구간이 있을 수 있다. Flyway는 기존 앱 기동 경로에 남기며 별도 migration Job이나
PostSync 검증 Job을 만들지 않는다. 자동 배포는 Argo가 보고한 현재 revision의 상태를 신뢰하고
Flyway 이력·인증·조회·수집·저장·Kafka commit을 직접 검사하지 않는다.

### 3. 두 게시기와 revision 승격

허브 계약의 C(infra/chart full commit SHA), B(backend 완료 manifest 원본 바이트의 SHA-256),
V(private generated snapshot commit), P(protected main의 배포 선택 commit)를 사용한다.

1. backend 생산 workflow가 같은 SHA·run·attempt의 enrollment·ingest·Gateway·dashboard 네 ARM64 이미지와
   완료 manifest를 게시하고 **최종 성공한 뒤**, 별도의 backend 승격 workflow가 원본 실행·artifact·B를 검증한다.
   태그 감시나 manifest의 자기 선언은 성공 증거가 아니다. 누락·혼합·변조·과거 실행은 거부한다.
2. backend 게시기는 현재 C와 V의 비이미지 설정을 보존하고 네 앱의 `image.repository`·`image.digest`와
   관련 B/배포 metadata만 바꾼다. generated values의 비이미지 바이트에는 예외를 두지 않는다.
   `deliveryVerification`은 제거하고 operation nonce는 Git의 desired·state·evidence에서만 사용한다.
   repository는 기존 앱별 허용값을 유지한다. `image.digest`는 bare `sha256:<64 lowercase hex>`이고 기존 CLI의
   `repository@digest`, ARM64 및 initContainer/앱 동일 이미지 검증을 유지한다. 이미지 overlay를 추가하지 않는다.
3. infra 게시기는 C의 chart·profile·runtime과 현재 AWS output/Strimzi metadata를 검증해 generated를 만든다.
   설정 변경에서는 현재 선택된 B의 네 이미지를 그대로 주입한다. 새 ECR 태그를 발견해도 이미지 묶음을 바꾸지 않는다.
   두 게시기 모두 diff 허용목록과 반대 소유 영역 불변 검사를 통과해야 한다.
4. 검증한 generated 13개와 원본 B를 V로 먼저 보존한다. 이때 Application은 기존 V를 계속 가리킨다.
   이후 P 한 commit에서 `dev/desired.yaml`과 `dev/applications/`의 영향을 받는 모든 하위 Application C/V를 함께 바꾼다.
   상위 Argo는 private main의 Application 선언을, 하위 Argo는 고정 C/V를 읽는다. V 이후 P 이전 실패는
   기존 배포 선택을 유지하며, P의 선택을 조회해 게시 성공 여부를 확정하기 전에는 다음 배포를 시작하지 않는다.
5. `dev/delivery-state.json`의 공통 잠금을 두 게시기가 공유한다. PROJ-311의 공통 모듈과 별도 infra 설정 publisher가 이 계약을 공유한다.
   `schemaVersion: 1`, `state`(`idle|deploying|rolling_back|blocked`), 단조 증가 `generation`,
   `owner`(`repository`, `workflowRef`, `workflowRunId`, `workflowRunAttempt`), `expectedDesiredP`,
   `operation.kind`(`image|config|rollback`), `lastKnownGood`(`infraCommit`, `valuesCommit`,
   `bundleManifestSha256`, `desiredCommit`)를 기록한다. 실패 시 `failedRelease`에 B·backend SHA·앱별
   repository/digest·`failureRecordedAt`, `resumeFence`에 `active`·`failedBackendCommit`·`recordedAt`을 남긴다.
   정확한 필드 형식은 허브 공급 계약이 소유한다.
6. 잠금 획득은 예상 main HEAD와 현재 P를 읽은 뒤 일반 fast-forward push의 compare-and-swap(CAS)으로 한다.
   모든 후속 변경은 같은 owner·generation·현재 HEAD와 기준 P를 재확인한다. HEAD가 달라지면 최신 상태에서
   소유권·C/B/V/P·후보 적격성을 다시 검증하며 force push하지 않는다. 레포별 workflow concurrency만으로는
   상호 배제를 보장하지 않는다. 잠금은 Git 게시뿐 아니라 Argo 배포 판정과 필요한 복구까지 유지한다.
   `idle`은 owner가 없고, `blocked`는 owner·실패 증거를 보존한다. 시간 경과만으로 잠금을 탈취하지 않는다.
   잠금·관측 상태 commit과 배포 선택 P는 구분한다. P가 바뀌면 같은 owner가 `expectedDesiredP`를 CAS로 갱신한다.
   owner를 잃은 이전 실행은 blocked 기록도 덮어쓰지 않고 중지·보고한다. 현재 소유권을 가진 관리 경로가 보류를 확정한다.

`dev/infra-commit.txt`만 기록하고 chart의 `develop`과 values의 `main`을 독립 추적하지 않는다.
최초 인계의 과거 이미지 기록은 새 B나 자동 승격 증거가 아니다. 수동 인계 이후 첫 자동 이미지 승격부터
새 완료 manifest 계약을 요구한다. 같은 SHA의 다른 digest는 새 B로 재검증하며 동일한 선택은 no-op이다.

### 4. Strimzi 렌더와 자격증명 경계

Operator Application만 sidecar Config Management Plugin(CMP)으로 렌더한다. 동일 C의 vendor archive·
checksum·values·post-render script와 Helm 3.22.0을 사용하고 CRD를 포함한다. renderer의 Operator 개수·
namespace·원래 감시 목록 검증과 `pulsemetry-dev`로의 축소를 보존한다. 렌더 오류·checksum 불일치·빈 출력은
sync 실패이며 부분 출력이나 native Helm으로 대체하지 않는다. CMP는 렌더만 하고 클러스터에 적용하지 않는다.
stdout에는 최종 YAML만 내보내고 진단은 stderr로 보낸다. CMP의 executable bit 초기화를 고려해
고정 sidecar wrapper에서 `node`로 같은 C의 renderer를 실행하거나 `pipefail`을 적용한 pipeline을 사용한다.
`preserveFileMode`와 `provideGitCreds`는 끄며 공개 infra 렌더에 private Git credential을 전달하지 않는다.

| 주체 | 허용 범위 |
|---|---|
| Argo repo-server | infra와 private 배포 저장소 읽기; Git 쓰기 없음 |
| backend 생산 workflow | 기존 네 ECR 이미지 게시와 완료 manifest 발행 |
| backend 승격·복구 workflow | 성공한 원본 실행·이미지 조회, 이미지와 관련 metadata·V/P·공통 상태 게시, 배포 증거 읽기 |
| infra 게시기 | output/metadata 조회, 설정 생성·검증·V/P·공통 상태 게시; 현재 B 보존 |
| Argo application-controller | 대상 dev namespace와 명시한 cluster-scoped 종류 적용; AWS 배포 권한 없음 |

Git 읽기와 두 게시 identity를 분리하고 protected main의 쓰기 주체를 제한한다. Git 권한은 JSON/YAML
필드별 쓰기 격리를 제공하지 않으므로 두 게시기의 허용 diff·반대 영역 보존·공통 CAS 검증을 필수로 둔다.
backend의 배포 관측은 읽기 전용 증거로 제공하며 CDK·Helm·Kubernetes·Argo 변경 권한을 추가하지 않는다.
AppProject는 플랫폼의 필요한 CRD/RBAC/NodeClass/NodePool/StorageClass/Namespace 범위와 앱의
namespaced 리소스를 분리한다. 임의 저장소·클러스터·prod/perf namespace를 허용하지 않는다.
AppProject 제약과 Kubernetes RBAC는 별도 계층이며 둘 다 실제 거부 검증이 필요하다.

AWS Secret 원문은 Git·CI artifact·values로 복제하지 않고 기존 CSI 파일 공급을 유지한다.
Strimzi 인증서의 읽기 전용 mount 예외를 다른 Secret에 확대하지 않는다.
[ADR 0057](0057-dev-argocd-github-app-authentication.md)은 `argocd` namespace의 private 저장소용 native repository
Secret 하나에 전용 읽기 GitHub App 개인키를 등록하는 별도 예외다. 운영자 로컬 등록·키 교체만 허용하고,
AWS Secret 복제나 publisher 키 재사용·CMP 전달을 허용하지 않는다.
Git/Argo 관리 자격증명은 애플리케이션 Secret과 분리하고 원문을 문서·출력·검증 증거에 넣지 않는다.

### 5. 자동 이미지 복구와 운영 중지

자동 rollback은 **현재 owner의 이미지 배포에 귀속된 Argo operation의 확정 실패**에만 허용한다.
목표 C/V와 Application spec·comparedTo·resolved revision 및 완료 operation의 revision을 대조한다.
현재 operation이 `Failed` 또는 `Error`이고 root와 모든 child의 진행 중 operation이 없을 때만 실패로
판정한다. 관측 불가·과거 revision·`Degraded` 단독 상태·단순 timeout은 `unknown`으로 보류한다.

승격 직전에 확보한 마지막 정상 B가 있으면 같은 owner/generation이 `rolling_back`으로 전환해 현재 C와
비이미지 설정을 유지한 새 V/P로 한 번만 복구한다. 마지막 정상은 Argo 상태 기준이며 실제 기능 성공을
뜻하지 않는다. 실제 schema/migration·키·TLS·Kafka backlog 호환성은 조회하거나 비교하지 않는다.
실패한 배포의 migration이 이미 반영됐거나 설정·키가 바뀌어 이전 이미지가 비호환일 수 있는 위험을 수용한다.

일반 이미지 복구는 Argo 자동 sync·self-heal을 유지한다. 복구 revision도 같은 Argo 성공 조건을 충족해야
잠금을 해제하고 정상 근거를 갱신한다. 설정 변경 실패, 복구 B 부재, 관측 불가, owner 소실 또는 복구 실패는
`blocked`로 남기며 자동 재복구·잠금 탈취를 하지 않는다. DB downgrade·PVC·Kafka offset 복원은 자동화하지 않는다.

확정 실패는 먼저 `fenceSealed: false`인 durable CAS로 `failedRelease`와 `resumeFence`에 기록한다.
그 게시 성공 응답을 확인한 뒤의 시각으로 `fenceSealed: true`를 별도 CAS에 남긴다. unsealed 이력은 자동
재개를 막고 같은 실패 B/벡터의 가장 늦은 기록 시각을 보존한다. 복구 성공 후에도 실패 B와
동일한 네 이미지 조합을 차단한다. 후속 실패나 새 정상 배포가 이전 실패 거부 이력을 지우지 않는다. 자동 재개는 실패 source의 **엄격한 develop 후속 commit**이며, 실패 기록
이후 새로 생성된 **원본 생산 run**에서 정상 완료한 묶음부터 허용한다. 재시도 attempt의 시작 시각이나 새 B로의
재포장으로 차단을 우회하지 못한다. fence commit ID는 Git 이력으로 추적하며 자기 SHA를 파일에 넣지 않는다.
복구 중 들어온 후보도 unlock 시 다시 조회·평가해 유실과 조기 승격을 막는다.

offset reset·인증서/JWT 교체 등의 수동 maintenance는 공통 상태를 보류하고 두 게시기를 중지한다.
필요한 상위/하위 Application의 자동 sync·self-heal 중지는 infra 운영자가 Git 제어 선언에 반영하고
진행 중 operation 종료를 확인한다. Pod만 scale down한 상태는 중지 상태로 인정하지 않는다.
복구가 설정까지 바꾸거나 소유권을 잃었다면 운영자가 실제 상태·호환성·기존 실행 종료를 확인하고 새 generation으로
명시적으로 회복한다. Git 정합과 실제 기능을 확인한 뒤 보류를 해제한다. 상세 절차는 운영 런북을 따른다.

### 6. PROJ-311의 Argo 상태 기반 관측

생산의 기존 ECR push 역할과 별도 `dev-gitops` Environment의 승격 역할을 분리한다. `workflow_run`의
workflow/ref는 default branch에 속하며 생산 develop SHA가 아니다. 검토된 승격 코드가 원본 생산
workflow·run/attempt·최종 성공·artifact를 API로 대조한다. 공통 infra tooling도 desired C와 독립적으로
검토한 full SHA를 사용한다. 공개 artifact에는 account 없는 repository·digest·배포 계약만 담는다.
producer가 이미지에 포장한 계약과 B의 원본 계약 hash 검증은 유지하며 후보 이미지를 검사 프로세스로 실행하지 않는다.

runner는 전용 읽기 전용 역할과 기존 SSM EKS API relay로 `argocd`의 root·18개 child Application만
읽는다. Kubernetes/Argo 변경, exec·port-forward, workload/Job/Pod·DB·Prometheus·S3·Secret 조회 권한을
추가하지 않는다. Job 전용 ServiceAccount·Pod Identity·probe Secret·DB reader와 검증기 이미지는 제거한다.
기존 앱의 CSI·운영자 DB relay·PROJ-310의 수동 인수 절차는 유지한다.

성공은 모든 child의 현재 spec·comparedTo·resolved C/V 일치, `Synced`·`Healthy`, 진행 중 operation과
현재 목표 revision에 귀속된 실패 operation 부재를 요구한다. root도 현재 P를 포함하는 resolved revision의
`Synced`·`Healthy`여야 하며 해당 revision의 desired/Application 파일이 현재 선택과 같음을 대조한다.
같은 manifest의 새 V나 main 상태-only commit은 새 sync를 만들지 않을 수 있다. operationState 부재나
과거 terminal operation은 성공을 막지 않는다. 현재 revision에 귀속된 완료 Failed/Error는 성공보다 우선하며
관측 불명·진행 중 상태와 구분한다. root와 18개 child의 `syncPolicy.retry.limit: 0`은 유지한다.
Job UID·termination message·실제 Pod imageID·기능 결과·실환경 fingerprint는 성공 조건에서 제거한다.

operation nonce는 Git 상태와 정제된 Argo 증거의 식별자이며 generated values나 Deployment Pod template에
넣지 않는다. 같은 이미지의 새 V와 rollback V도 목표 C/V의 Argo 상태를 새로 관측한다.
정제된 Application UID·revision·operation 시각·결과를 private `dev/evidence/<operationNonce>.json`과
해시로 연결한다. `configurationFingerprint`는 generated 비이미지 바이트의 보존 확인용이며 실제 환경의
호환성을 증명하지 않는다. `lastKnownGood`은 이 Argo 성공 기준을 만족한 마지막 이미지 묶음이다.

`dev/activation.json`의 PROJ-310 인수·정상 B·별도 infra 설정 publisher/CAS 수락은 운영 준비의 입력이다.
H-only 생성기는 자동 root·bundle·desired·delivery state를 만들지 않으며 initializer는 정상 B와 수락 증거를 요구한다.
운영 준비와 검증 명령은 [PROJ-311 런북](../runbooks/dev-gitops-image-promotion.md)을 따른다.

## Alternatives Considered

- 수동 Helm 유지: 현재 도입 전 경로로 유지하지만 인계 이후의 지속적인 drift 복구와 Git 추적에는 Argo를 사용한다.
- Image Updater와 태그 감시: 생산 workflow가 이미 아는 digest를 재탐색하며 묶음 검증·복구는 별도 구현해야 하므로 철회한다.
- 별도 이미지 overlay: 기존 generated의 repository/digest 구조와 overlay 없는 구성을 유지한다.
- infra 단독 이미지 승격: backend가 생산부터 이미지 복구까지 책임지고 infra는 설정 게시에 집중하도록 두 게시기와 공통 잠금을 선택한다.
- native Helm만으로 Strimzi 렌더: 현재 post-render 검증을 보존하지 못하므로 해당 Application만 CMP를 사용한다.
- PostSync 기능 검증과 실환경 호환성 확인 유지: 인증 fixture·DB reader·검증 이미지·권한 운영 부담 때문에 제거한다. Argo 상태만으로 드러나지 않는 기능 장애와 이전 이미지 복구의 비호환 위험을 수용한다.
- Argo 자기 관리·자동 prune: 초기 장애 복구와 데이터 수명 확인을 위해 도입하지 않는다.

## Consequences/Tradeoffs

### Positive

선택한 코드·설정·이미지를 추적하면서 기존 AWS/Kubernetes 책임을 유지한다. 후보의 부분 게시·stale run을
실제 적용 전에 차단하고, Helm 인계 후 변경과 복구도 같은 Git 경로에 기록한다. 검증 Job과 synthetic
identity·DB reader 운영이 없어져 자동 배포 준비와 장애 대응 경로가 줄어든다.

### Negative

두 게시기·공통 잠금·두 단계 V/P 게시, CMP와 custom health의 운영 비용은 남는다. Argo Healthy여도
로그인·조회·수집·저장이 실패할 수 있고 자동 배포는 이를 탐지하지 않는다. 이미 적용된 migration이나
현재 키·TLS와 이전 이미지의 호환성을 확인하지 않고 복구하므로 장애가 지속되거나 악화될 수 있다.
Git/Argo 관측 장애는 새 배포를 막으며 자동 prune을 끄므로 제거된 선언의 리소스가 남을 수 있다.
Argo 자체는 초기 비 HA이며 데이터 복구나 네 앱의 동시 교체를 보장하지 않는다.

## Follow-up

허브 ADR 0035와 backend ADR 0081에 맞춰 PROJ-311의 이미지 공급·공통 CAS·검증 경계를 유지한다. 별도 infra 설정 게시기, Git 보호·권한과 최초 정상 B를 준비하고 실제 상호 운용·maintenance·복구를 수락한다. 기존 repository/digest 입력을 유지한다. [운영 런북](../runbooks/dev-argocd-operations.md)의 인계 수락 조건을
통과하기 전에는 기존 Helm 운영을 유지한다. PROJ-279의 사본 job 구현·활성화와 실제 게시 증거를
각각 확인하고, 이를 정식 publisher·Argo 인수 완료로 표현하지 않는다.

## Acceptance Criteria

허브 계약과 네 이미지 묶음·C/V/P·권한·배포 순서·rollback이 일치하고, 런북의 누락·혼합·변조·stale·충돌·
부분 실패·동시 게시·owner 소실·과거 revision·진행 중 operation·복구 실패·재개 시나리오가 잘못된 승격을 막아야 한다.
PostSync Job·probe 입력 없이 현재 root/child Argo 상태로 성공하고, 현재 terminal 실패에서만 이전 이미지를
한 번 선택해야 한다. Git 게시·Argo 성공과 실제 기능 성공을 구분하며 로컬 검증을 live 수락으로 표현하지 않는다.

## References

- [Argo Helm: 렌더와 releaseName](https://argo-cd.readthedocs.io/en/stable/user-guide/helm/)
- [Argo multiple sources](https://argo-cd.readthedocs.io/en/stable/user-guide/multiple_sources/)
- [Argo Application health](https://argo-cd.readthedocs.io/en/stable/operator-manual/health/#argocd-app)
- [Argo CMP](https://argo-cd.readthedocs.io/en/stable/operator-manual/config-management-plugins/)
- [Argo 자동 sync와 rollback 경계](https://argo-cd.readthedocs.io/en/stable/user-guide/auto_sync/)
- [backend ADR 0081](https://github.com/soma-376/pulsemetry-backend/blob/feature/PROJ-311-backend-image-promotion/docs/adr/0081-dev-앱-이미지는-검증한-묶음으로-GitOps에-인계한다.md)
