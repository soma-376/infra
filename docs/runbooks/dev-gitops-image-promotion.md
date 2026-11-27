# dev values·이미지 게시와 Argo 자동 동기화 운영

[ADR 0056](../adr/0056-dev-argocd-gitops-operations.md)과 [허브 공급 계약 v2](https://github.com/soma-376/docs/blob/main/contracts/generated-values-sync.md)를 따른다. PROJ-334는 Git 게시, PROJ-335는 root·auto sync 연결을 담당한다. 대상은 공유 dev EKS이며 prod·frontend·perf는 제외한다.

## 1. 운영 흐름과 완료 의미

```text
infra develop → 기존 plan·승인·CDK deploy → 설정 재생성·게시
backend 생산 성공 → 원본 이미지 검증 → 이미지 게시
                         ↓
          private main의 desired·Application 참조
                         ↓
                 root → child auto sync
```

publisher는 Git 선택만 완료하고 Argo rollout을 기다리지 않는다. `published`는 실제 배포나 로그인·조회·수집·저장 성공이 아니다. 연속 변경에서는 중간 배포를 건너뛰고 최신 선택으로 수렴할 수 있다.

장기 CAS 잠금·owner/generation·초기화 readiness·CI observer·lastKnownGood·자동 이미지 rollback은 사용하지 않는다. 이전 PROJ-311 방식의 [고정 런북](https://github.com/soma-376/infra/blob/35188fd52279eab123fb5d659187512567e7d30c/docs/runbooks/dev-gitops-image-promotion.md)은 역사적 기록이며 새 경로의 활성화 관문이 아니다.

## 2. 배포 저장소

| 파일 | 역할 |
|---|---|
| `dev/generated/*.yaml` 13개 | 공식 생성기 결과. backend는 네 앱 digest만 수정 |
| `dev/infra-commit.txt` | chart·공식 입력·생성기의 infra 전체 SHA |
| `dev/bundle.json`, `dev/producer.json` | 완료 manifest 원본과 검증한 생산 출처 |
| `dev/desired.yaml` | schemaVersion 2, `infraCommit`, `valuesCommit`, `bundleManifestSha256` |
| `dev/applications/*.yaml` 18개 | 고정 infra·values SHA를 읽는 child 선언 |
| `dev/root.yaml` | `main/dev/applications`를 읽는 운영자 관리 root |

root만 `main`을 추적한다. 하위 chart와 values는 각각 전체 commit SHA로 고정한다. 현재 선택은 desired가 가리키는 values snapshot에서 읽으며 최신 main의 파일을 임의로 섞지 않는다. 과거 `delivery-state.json`·`activation.json`·`evidence/`가 있으면 자동 삭제·변환하지 않고 전환을 먼저 검토한다.

## 3. infra 설정 게시

기존 `dev-cdk-deploy.yml`의 plan → Environment 승인 → 같은 SHA/Assembly deploy → publish를 사용한다. `GENERATED_VALUES_SYNC_ENABLED`는 최초 연결 전까지 false로 유지하고, 연결 후 **새 plan**부터 켠다. Helm/chart 변경도 workflow 경로 필터에 포함하며 CDK no-op이어도 설정 게시를 수행한다.

plan의 generated 입력은 `enabled`와 `mode: simple-v2`다. 이전 backend 로그 기반 승인 입력은 새 경로에서 재사용하지 않는다. 설정 게시 직전에 현재 선택 V의 네 image repository/digest를 읽고 같은 source의 profile/runtime, 현재 AWS output·Strimzi metadata로 13개 values를 생성한다. bundle·producer와 이미지를 보존하며 최신 backend 태그나 실행을 선택하지 않는다.

```text
node scripts/dev-generated-values-sync.mjs --directory <승인 plan·receipt 디렉터리>
```

명령은 workflow가 호출한다. 원본 plan/deploy 성공·artifact hash·receipt·현재 baseline과 source 최신성 검사를 유지한다. deploy 이후 설정이 바뀌거나 develop이 전진하면 새 plan을 만든다. 기존 infra deploy·values-reader 권한과 SSM/TLS·PartialObjectMetadata 조회를 재사용한다. 새 infra GitOps 역할이나 observer trust 추가는 필요하지 않다.

## 4. backend 이미지 게시

`deploy_dev.yml`이 동일 SHA/run/attempt의 네 ARM64 이미지를 생산하고 최종 성공하면 `promote_dev.yml`이 게시한다. 수동 재실행도 같은 검증을 사용한다. 주기적인 배포 재평가 schedule은 사용하지 않는다.

검토한 default `develop`의 코드와 별도로 고정한 infra tooling을 실행한다. 원본 성공 run/attempt·artifact ID/ZIP hash·완료 manifest 원본·immutable 이미지의 packaged contract를 검증한다. 후보 이미지 코드를 실행하지 않는다.

```text
node scripts/dev-gitops/publish.mjs --candidate completion.json --provenance producer.json
```

이 진입점은 보호된 backend workflow 전용이다. 현재 infra SHA와 비이미지 바이트, Application 정책을 보존하고 네 앱 digest·bundle·producer·values 참조만 바꾼다. 게시 직전 최신 성공 생산 후보와 develop 계보를 다시 확인하며 이미 선택된 원본보다 오래된 run/attempt는 거부한다. 기존 ECR 읽기 역할을 재사용하고 SSM·EKS observer를 호출하지 않는다.

## 5. 충돌·재실행·실패

두 publisher는 현재 private main 위에 values commit과 그 SHA를 참조하는 Application commit을 로컬로 만든다. 마지막 commit을 예상 HEAD 검사와 함께 한 번 push한다. 게시 중 main이 바뀌면 최신 선택을 읽어 반대 영역을 보존한 후보를 재생성하며 최초 실행 포함 최대 3회 시도한다.

- 동일 내용과 선택은 `noop`이다. 불필요한 Pod 재시작을 만들지 않는다.
- push 응답이 유실되면 정확한 게시 commit이 원격 이력에 포함됐는지 확인한다. 확인 불가면 실패다.
- force push·자동 rebase·시간 기반 잠금 탈취는 없다.
- CDK 성공 후 게시만 실패하면 원본 plan·receipt가 유효한 동안 publish job을 재실행한다. source·baseline·증거가 달라졌으면 새 plan이 필요하다.
- 이미지 게시 실패는 원본 생산 증거와 최신 후보를 재확인해 workflow를 재실행한다.
- Argo 동기화 실패가 다음 Git 게시를 전역 차단하지 않는다. Argo에서 원인을 확인하고 수정 선언 또는 검토한 이전 선언을 수동 게시한다. DB downgrade·PVC 복원·offset reset은 자동 수행하지 않는다.

공개 Summary/artifact에는 결과만 남기고 private values·endpoint·조회 원문·credential을 넣지 않는다.

## 6. root 연결과 유지보수

PROJ-335의 초기 연결은 현재 18개 Application이 실제 쓰는 C·values·이미지·inventory를 보존한다. 새로운 코드·이미지 배포를 초기 연결에 섞지 않는다. 기존 AppProject·관리 RBAC·Git reader·CMP를 사용하고 root는 기존 EKS 운영자 context로 한 번 적용한다.

root와 child 모두 auto sync·self-heal을 켜되 prune·allowEmpty·삭제 finalizer는 끈다. retry limit은 0을 유지한다. 하위 Application은 고정 SHA를 사용하며 publisher는 기존 syncPolicy를 보존한다.

유지보수 때는 Git에서 대상 child의 auto sync·self-heal을 끄고 root 반영·진행 operation 종료를 확인한다. 두 publisher도 필요하면 중지한다. 종료 후 Git 정합과 실제 기능을 확인해 정책을 복원한다. root 자신을 조정해야 하면 기존 운영자 경로를 사용한다.

## 7. 검증과 현재 상태

로컬에서는 임시 bare Git으로 동시 게시·재시도·응답 유실·no-op·오래된 실행·상대 영역 보존을 검증한다. 기존 chart/schema·CSI·ClickHouse 메모리·CMP 검증을 유지한다.

실제 완료는 root+18개가 목표 revision의 Synced/Healthy에 도달하고, 초기 child·PVC·이미지·mount 보존과 Git 변경의 자동 반영·비파괴 self-heal을 확인했을 때 기록한다. 코드와 테스트 통과만으로 Git 게시·dev 활성화를 완료했다고 표현하지 않는다. 로그인·조회·수집·저장 및 인증서 회전 검증은 별도로 기록한다.

## 8. PROJ-304 파이프라인 자원 확대 적용

[ADR 0063](../adr/0063-dev-pipeline-resource-sizing.md)의 로컬 구현과 실제 적용을 구분한다.
Gateway·ingest 모두 request 500m/2Gi, limit 2 CPU/4Gi이며 replica 1·Recreate를 유지한다.
apps는 t4g.large, ClickHouse는 m7g.large이며 후자는 request 1500m/6Gi, memory limit 6Gi와
CPU limit 없음이다. CPU 예산 8/4는 유지하며 정상 apps 2대·ClickHouse 1대는 고정 대수가 아니다.
[ADR 0066](../adr/0066-dev-clickhouse-xlarge-memory.md)(PROJ-339)은 ClickHouse를 m7g.xlarge·1500m/13Gi·CPU 예산 8로 바꾼다.
적용하면 ClickHouse 노드가 교체되며 몇 분 중단된다. 아래 절차의 1500m/6Gi는 그 값으로 읽는다.
[ADR 0067](../adr/0067-dev-ingest-horizontal-scale.md)(PROJ-346)은 ingest만 replica 2·RollingUpdate·PDB로, apps CPU 예산을 12로 바꾼다.
아래 "두 Pod"는 Gateway 1개와 ingest 2개, 세 Pod로 읽는다. 반영 순서는 [Argo 운영 런북 §3.1](dev-argocd-operations.md#31-관리-구성-변경)이다.

### 적용 전

1. 현재 관리 주체가 Argo인지 확인하고 §6에 따라 대상 자동화를 중지한다. 수동 Helm과 Argo로
   같은 리소스를 동시에 수정하지 않는다. 생성 values를 직접 편집하지 않는다.
2. 현재 infra/values/image revision과 release, NodePool/NodeClaim/Pod 배치, allocatable,
   ClickHouse PVC/PV·EBS volume 식별자와 AZ를 기록한다. Secret 원문은 읽거나 기록하지 않는다.
3. 실제 시스템·DaemonSet 요청량과 앱 요청량을 allocatable과 대조한다. Gateway·ingest의
   hostname 분리와 ClickHouse 1500m/6Gi를 배치할 여유, 해당 AZ의 타입 용량과 quota를 확인한다.
   앱 2대의 모든 Pod가 memory limit까지 동시에 사용 가능하다고 가정하지 않는다.
4. 새 infra revision으로 13개 values와 18개 Application을 렌더하고 사양·기존 이미지·PVC·AZ
   보존을 확인한다. ClickHouse의 최종 `resources.limits`에는 memory만 있어야 한다.
   runtime의 `cpu: null`은 Helm 기본 CPU 제한을 지우는 입력이며 최종 Pod 값이 아니다.
5. 단일 replica 중단을 포함한 유지보수 구간을 확보하고 외부 쓰기를 중지한다. 현재 진행 중인
   처리와 consumer lag가 정리된 것을 확인한 뒤 §3의 새 plan·승인·CDK deploy(변경 없으면 no-op)·
   설정 게시를 사용한다. 게시 성공만으로 노드 교체나 workload 적용 완료를 판단하지 않는다.

### 순차 적용과 확인

1. base를 먼저 sync한다. NodePool의 타입 제약 변경은 기존 노드를 drift 대상으로 만들 수 있다.
   `WhenEmpty`도 drift/만료 교체를 막지 않는다. NodeClaim 교체·drain·노드 Ready와 새 타입을 확인한다.
   기존 CPU 예산은 새 노드를 먼저 확보할 여유를 남긴다. 교체가 막히면 원인을 조사하고 무조건 drain하지 않는다.
2. ClickHouse를 sync하고 기존 PVC/PV·AZ로 재연결되는지 확인한다. 기존 단일 Pod StatefulSet의
   순차 교체를 사용하며 PVC 삭제·새 초기화·스토리지 변경을 하지 않는다.
3. ingest → Gateway 순서로 sync해 Ready를 확인한다. 두 Pod가 서로 다른 hostname에 있고
   최종 resource가 목표값인지 확인한다. 노드가 부족하면 Pending으로 남는 것이 정상이며
   anti-affinity를 느슨하게 바꿔 통과시키지 않는다.
4. 쓰기를 재개하기 전 기존 DB 연결·배포된 이미지 보존과 Argo의 목표 revision Synced/Healthy를
   확인한다. 실제 요청의 Gateway ACK → Kafka consume/commit → ClickHouse 저장을 별도로 검증한다.
   ClickHouse 조회 전 운영자의 SSM 터널 상태를 확인한다.
5. §6에 따라 Git 자동화를 복원하고 node/pod 재시작·OOM·memory pressure·Pending·consumer lag와
   CPU throttling을 관찰한다. t4g의 실제 credit mode, CPUCreditBalance·CPUCreditUsage·
   CPUSurplusCreditBalance·CPUSurplusCreditsCharged를 성능 시험 기간과 함께 기록한다.

### 중단·복구

자원 부족, PVC 재연결 실패, 기능 오류가 있으면 쓰기 재개와 성능 측정을 중단한다. 기존 PVC와
Kafka offset을 보존한 상태에서 검토한 이전 infra·values 선택을 Git으로 게시하고 순차 sync한다.
리소스 복구는 데이터 복구가 아니며 PVC 삭제·DB downgrade·offset reset을 자동 수행하지 않는다.
불명확한 결과에서 무조건 재배포하거나 새 저장소를 만들지 않는다.
