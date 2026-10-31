# dev Argo CD 도입·인계·검증·복구

[ADR 0054](../adr/0054-dev-argocd-gitops-operations.md)·PROJ-280의 운영 계약이다.
**설계만 채택했으며 이 문서 추가는 Argo 설치·workflow 구현·Helm 인계 완료의 증거가 아니다.**
도입 전에는 [EKS 수동 런북](dev-eks-manual-deployment.md)과 [Strimzi 런북](dev-strimzi-kafka.md)을 따른다.
아래 단계는 후속 구현이 갖춰진 뒤 수행할 절차이며 이번 문서 작업에서 실행하지 않는다.

## 1. 기준과 책임

- 공유 dev만 대상으로 한다. prod·frontend·perf 및 수동 Kafka 관리 Job을 포함하지 않는다.
- 현재 Strimzi·`network-removed`·main `eks`·ALB Gateway·ingest `kafka`를 보존한다.
  기존 관측·수집 완료 결과는 [완료 기록](proj191-strimzi-completion.md)을 따른다.
- AWS 갱신은 [CloudFormation CI/CD](dev-cloudformation-cicd.md), Kubernetes 적용은 인계 후 Argo가 맡는다.
  CDK 적용 성공이 generated 게시나 앱 배포 성공을 뜻하지 않는다.
- Argo/Updater 자체는 고정된 Helm으로 수동 관리한다. UI/API는 ClusterIP로 두고 기존 SSM EKS 터널과
  별도 kubeconfig·원래 서버 hostname/CA 검증을 유지한다. 새 public ALB/DNS를 만들지 않는다.
- 배포 단위와 파일 형식은 [허브 generated-values 계약](https://github.com/soma-376/docs/blob/main/contracts/generated-values-sync.md)이
  단일 출처다. C=infra/chart SHA, V=generated snapshot commit, B=backend 완료 manifest 원본 바이트의 SHA-256,
  P=배포 선택 commit이다.

## 2. 최초 설치와 기존 Helm 리소스 인계

### 2.1 인계 전 준비

1. 대상 context·계정·리전·cluster를 확인하고 다른 Helm 배포와 자동 publisher 실행을 중지한다.
   `helm list --all-namespaces`와 기존 배포 기록으로 release/namespace, revision, chart 버전,
   앱 digest, PVC/PV, selector, 리소스 UID, Kafka 설정·offset 기준을 수집한다. Secret 원문은 조회하지 않는다.
   values/manifest 기록도 민감정보 포함 여부를 검사하고 비공개 증거로 보관한다.
2. 현재 선언을 재현할 C와 비공개 인계 snapshot H를 준비한다. 현재 이미지가 새 완료 manifest 계약 이전에 게시됐다면
   운영자가 출처·네 digest·호환성·실제 동작을 확인한 **초기 인계 기록**으로만 보존한다.
   서로 다른 과거 이미지를 같은 SHA의 B로 꾸미거나 자동 승격 후보로 인증하지 않는다.
   최초 자동 이미지 승격은 새 계약을 통과한 네 앱 B부터 허용한다.
   H는 정상 V가 아니며 `dev/bundle.json`·`dev/desired.yaml`을 꾸며 만들지 않는다. 정상 B가 없을 때는
   운영자가 C/H에 고정한 하위 Application을 수동으로 만들고 자동 sync/self-heal을 끈 상태에서 인계한다.
   아직 root의 `dev/applications/` 자동 관리와 P 선택 계약에는 연결하지 않는다.
3. 후속 구현의 chart/schema/생성기 `image.ref` 정합, 고정 의존성·digest, Argo/Updater·CMP,
   C/V health gate와 기능 검증 경로, Git 권한·branch 보호·maintenance를 확인한다.
   초기 인계 선언도 기존 실제 이미지를 그대로 렌더해야 한다.
4. Argo와 Updater를 수동 설치하되 Updater·자동 sync·self-heal·prune은 비활성 상태로 시작한다.
   private Git 읽기와 후보 쓰기, ECR 조회, 보호된 main 쓰기 거부를 각 identity로 검증한다.
   Git/Argo 관리 자격증명의 런타임 공급·회전·회수를 검증하고 원문을 Git·로그에 저장하지 않는다.

### 2.2 동일성 비교와 첫 sync

1. 기존 release마다 Application 하나를 준비한다. 기존 `releaseName`, namespace, 값 파일 순서를 유지하고
   Argo의 annotation 기반 resource tracking을 사용한다. 기존 `app.kubernetes.io/instance`와 selector를
   Argo Application 이름에 맞추려고 변경하지 않는다.
2. 고정 C/H(이미 정상 B가 있으면 C/V)로 렌더하고 기존 최종 Helm manifest·실제 리소스와 비교한다. 이미지·env·mount·PVC·Service·TGB·
   NodeClass/NodePool·NetworkPolicy·인증서 revision이 의도 없이 바뀌면 인계를 중단한다.
   tracking metadata 이외의 diff는 사유와 별도 변경 범위를 명시하고 인계와 섞지 않는다.
3. Strimzi는 기존 Helm post-render 이후 결과와 CMP 결과를 비교한다. Operator 하나, `strimzi-system`,
   감시 namespace `pulsemetry-dev`, CRD/RBAC와 vendor checksum이 같아야 한다.
   CRD의 Established와 Operator Ready 후 Kafka CR을 인계한다. Operator 생성 리소스는 직접 추적하지 않는다.
4. 플랫폼 → controller/CSI·runtime·데이터·관측 의존성 → enrollment → ingest → Gateway → dashboard
   순서로 수동 sync하고 목표 revision·rollout·기능을 확인한다. Kafka/Topic/User의 Ready와
   observedGeneration도 확인한다. 예상 밖 교체·삭제·권한 오류는 다음 단계 진행을 막는다.
5. 기존 Helm release를 uninstall하지 않는다. Helm metadata는 과거 기록으로 보존하되 인계 이후의
   변경 이력으로 사용하지 않는다. Argo는 `helm template` 결과를 적용하며 Helm revision을 증가시키지 않는다.
6. 실제 namespace/release/Application 대응표, C/H 또는 정상 C/V/P, 리소스 보존 대조와 기능 결과를 기록한다.
   H로 인계했다면 새 정상 B를 검증해 최초 V/P를 만든 뒤 같은 하위 Application들을 root 관리로 넘긴다.
   이때 최초 B의 이미지 변경은 인계 동일성 비교와 분리한 일반 배포로 검증한다. root 인계와 정상 B 검증을
   마친 대상에서 Git의 제어 선언으로 자동 sync·self-heal을 켠다. prune은 계속 끈다.

자동 prune을 끈 것만으로 CR 내부 변경·스토리지 축소·Application 연쇄 삭제를 안전하다고 판정하지 않는다.
Namespace·CRD·PVC·Kafka·ClickHouse 삭제는 대상·데이터 영향·복구 근거를 확인한 별도 작업이다.

## 3. 일반 변경의 공급과 승격

1. backend의 허용 workflow가 같은 SHA·run·attempt의 네 ARM64 이미지와 완료 manifest를 게시하고
   최종 성공했는지 확인한다. 개별 태그나 manifest의 자기 선언만으로 성공을 판정하지 않는다.
2. Updater는 네 앱 `dev` 태그를 `digest` 전략·`linux/arm64`로 추적해 `candidate/dev`의 네 앱 `image.ref`만 갱신한다.
   배포 Application은 candidate를 읽지 않는다.
   writer branch·private repository·앱별 `helmvalues` 경로를 명시하고 V의 SHA로부터 branch를 추정하지 않는다.
3. publisher는 현재 선택된 C/V/P와 candidate의 기준을 대조한다. 네 digest가 하나의 B와 일치하고
   비이미지 diff가 없어야 한다. 후보가 덜 완성됐으면 기존 desired를 유지한다.
4. 설정 변경은 생성기를 통해 별도로 재생성하고 현재 B를 유지한다. 추적 profile/runtime과 AWS output,
   Strimzi metadata가 맞지 않으면 실패한다. Secret 내용이 아닌 UID/resourceVersion만 tlsRevision에 사용한다.
5. 검증 결과를 V로 먼저 게시하고 기존 Application 참조가 그대로인지 확인한다. 그 다음 P에서 desired와
   Application C/V 참조를 함께 갱신한다. Git head 변경은 최신 기준 재검증으로 처리하며 force push하지 않는다.
6. 승격 중인 묶음이 끝나기 전에는 다음 묶음을 적용하지 않는다. 같은 digest·설정이면 no-op으로 기록하고,
   같은 SHA라도 다른 digest는 별도 B로 검증한다. 과거 실행을 자동 경로로 재승격하지 않는다.
7. Argo는 모든 대상의 검증된 설정 변경을 자동 적용한다. schema·키·인증서·runtime 변경 중 별도 조정이
   필요한 것은 P 승격 전에 일반 경로를 멈추고 해당 운영 절차를 수행한다.

chart·runtime만 바뀐 경우에도 C/V를 새로 검증해 함께 선택한다. 가변 `develop` chart와 최신 values를
따로 읽거나 Application parameter/`--set`으로 Git 바깥 값을 덧씌우지 않는다.

## 4. 순차 적용과 성공 판정

상위 Application의 wave는 하위 Application custom health와 연결한다. **현재 원하는 C/V의 적용 성공과
Healthy**를 모두 확인하기 전에는 다음 wave로 넘어가지 않는다. status가 없거나 과거 revision, OutOfSync,
진행 중 operation, 실패 operation이면 대기/실패로 남긴다. sync wave annotation만으로 순서가 보장됐다고 하지 않는다.

| 단계 | 진행 조건 | 증명하지 못하는 것 |
|---|---|---|
| 기반·runtime·데이터 | NodePool/CSI·필요 CRD·SPC·PVC, Kafka/Topic/User 현재 generation Ready | 실제 앱의 권한·인증서 파일 읽기 |
| enrollment | 목표 digest rollout·init 검사, 해당 schema의 Flyway 성공 | ingest/조회 경로의 성공 |
| ingest | 목표 digest·현재 schema/TLS 연결, 이전 Kafka envelope 호환 | Gateway ACK만으로 실제 저장 |
| Gateway | 목표 digest·Kafka 접속, 인증 요청의 ACK | consume·commit·적재 완료 |
| dashboard | 목표 digest·cache DDL/조회 연결, 로그인과 대표 조회 | 전체 데이터 정합·SLO |

앱 health 200·Pod Ready만으로 schema 적용이나 적재를 완료 처리하지 않는다. 실제 검증기는 rollout 상태와
enrollment migration 결과, 인증·로그인·대표 조회, 고유 식별 요청의 ACK→consume→commit→S3/ClickHouse를
각각 대조해야 한다. 인증 원문을 기록하지 않고 결과·식별자·시각·revision만 보관한다.
PodSpec이 B의 digest에 고정됐는지 확인하고 실제 Pod imageID와 연결한다. ECR digest가 index이면
검증된 `linux/arm64` child manifest를 해석해 대조하며 index digest와 runtime imageID의 문자열 동일성을 요구하지 않는다.

Git 게시, Argo Synced, Healthy, 기능 검증 결과를 별도 항목으로 남긴다. 단계가 실패하면 후속 앱과 다음
묶음을 보류하고 마지막 성공 단계 및 실제 실행 digest를 기록한다. 부분 실패를 네 앱 전체 성공으로 보고하지 않는다.
Argo·Updater·publisher의 오류/중단, sync 지연·Degraded, 후보 정체를 관측할 수 있어야 한다.
`argocd` namespace가 기존 Fluent Bit 수집 범위에 자동 포함된다고 가정하지 않고 후속 관측 연결을 검증한다.

## 5. 운영 중지·인증서 교체·offset reset

1. maintenance 대상·사유·현재 P·진행 중 operation과 원래 자동화 설정을 기록한다.
2. Git에서 publisher 승격·Updater와 대상 Application의 자동 sync/self-heal을 중지한다.
   상위가 생성하는 하위 Application 선언에도 같은 상태를 넣어 상위 self-heal이 되돌리지 않게 한다.
   보호된 수동 운영 경로로 중지 선언을 먼저 적용하고 동작 중 sync의 종료를 확인한다.
3. offset reset은 [Strimzi 런북](dev-strimzi-kafka.md)의 ingest 중지·group 상태·plan/execute 대조를 따른다.
   Job은 수동으로만 실행하고 Argo hook/주기 sync로 반복 생성하지 않는다. Group Read의 commit/reset 의미는 유지한다.
4. 인증서 교체는 현재 Secret UID/resourceVersion만 수집해 generated의 tlsRevision을 갱신한다.
   Git 승격과 명시적 재배포 뒤 실제 Pod revision·mTLS·ACK/consume/commit/저장을 검증한다.
   파일 mount 갱신이 앱의 자동 재로딩을 뜻하지 않는다. JWT는 기존 verifier→signer→구 키 제거 순서를 유지한다.
5. maintenance 중 승인한 수동 P 선택·sync는 가능하지만 자동 후보 승격은 계속 중지한다.
   runtime·replica 등 최종 선언을 Git에 반영하고 실제 동작과 대조한 다음 원래 자동화 설정을 복구한다.

## 6. rollback과 Argo 장애 복구

1. §5에 따라 자동화를 멈추고 실패 P/B, 실제 실행 이미지, 적용된 migration·키/TLS revision을 확인한다.
2. 이전에 기능 검증한 네 앱 B 중 현재 schema·Kafka backlog·runtime·JWT·인증서와 호환되는 것을 고른다.
   선택한 B를 생성기에 주입하고 현재 비이미지 설정을 보존한 V/P로 복구한다. generated를 사람이 직접 고치지 않는다.
3. config/chart까지 복원해야 하면 검증된 C/V/B 전체 조합과 데이터 호환성을 별도로 확인한다.
   과거 Git commit 전체 revert, DB 자동 downgrade, PVC/offset 복원, 만료 인증서·MSK 경로 복귀를 기본 복구로 삼지 않는다.
4. 순차 sync와 §4 기능 검증 후 실패 후보의 재승격을 차단한다. 최신 태그가 여전히 실패 digest를 가리키면
   Updater를 재개하지 않는다. 새 정상 후보 또는 명시적 보류 상태를 확인한 뒤 자동화를 켠다.
5. Argo 자체 장애는 수동 Helm 설치 입력과 고정 버전으로 복구한다. 일시적인 앱 Helm 조작이 필요하면
   Argo reconcile·publisher·Updater 정지를 먼저 확인하고, 현재 C/V로 렌더한 정확한 선언만 사용한다.
   과거 Helm history가 인계 후 배포를 나타낸다고 가정하지 않는다. 긴급 변경 후 Git 정합을 복원해야 인계를 재개한다.

## 7. 후속 구현 수락 시나리오

| 입력 상황 | expected behavior |
|---|---|
| Gateway 누락·게시 실패·실패한 workflow의 manifest | V/P 승격 없음, 기존 묶음 유지 |
| 네 앱 SHA/run/attempt 혼합·digest/repository/ARM64 불일치 | 후보 거부 |
| candidate에서 env·replica·revision metadata 변경 | 허용 필드 외 diff로 거부 |
| 설정 재생성 중 새 태그 발견 | 현재 B 유지; 별도 검증된 후보만 승격 |
| 동일 SHA 재실행, 같은 네 digest | 불필요한 rollout 없는 no-op; 실행 증거는 기록 |
| 동일 SHA 재실행, 다른 digest | 새 B로 검증; 과거 attempt와 혼합 금지 |
| 과거 실행·기준 C/V/P 변경·동시 Git 갱신 | 최신 상태에서 재검증, force push 없음 |
| V 게시 후 P 게시 실패 | 기존 Application C/V 유지, 배포 성공으로 기록하지 않음 |
| 이전 revision은 Healthy지만 목표 revision은 미적용 | 다음 wave 차단 |
| Flyway/ingest/Gateway 단계 실패 | 후속 단계·다음 묶음 보류, 부분 상태 보존 |
| CMP checksum·원래 감시 목록 불일치·빈 출력 | 렌더/sync 실패, namespace 확대나 fallback 없음 |
| offset reset을 위해 ingest 중지 | 상위/하위 self-heal과 Updater가 중지를 되돌리지 않음 |
| 이미지 rollback 후 실패 태그가 여전히 최신 | 자동 재승격 차단 유지 |
| 인계 diff에 selector/PVC/리소스 삭제·교체 포함 | 인계 중단, 원인과 별도 변경 범위 검토 |

문서 단계에서는 링크·상태·계약 정합과 위 시나리오의 기대 동작을 검토한다. 후속 구현에서는 fixture/render·
승격 경쟁·실패 주입을 자동 검증하고, 실제 설치/인계에서는 리소스 보존·권한 거부·기능·복구를 검증한다.
실제 결과를 얻기 전에는 체크리스트가 존재한다는 이유로 PASS를 기록하지 않는다.
