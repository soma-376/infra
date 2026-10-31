# 0054. dev Kubernetes 선언은 검증한 revision 묶음을 Argo CD로 적용한다

## Status

Accepted (PROJ-280 설계 채택; chart·workflow·Argo 설치·기존 release 인계는 후속 구현·검증 대상)

[ADR 0028의 EKS 수동 Helm 전환](0028-dev-eks-auto-mode-transition.md) 중 인계된 리소스의
일반 배포 주체와 Argo 제외 결정을 부분 대체한다. CDK의 AWS 소유권, Auto Mode의 노드 관리,
ARM64·스토리지·Secret·private API 경계는 유지한다. [ADR 0049](0049-dev-strimzi-kafka-and-staged-msk-retirement.md)의
Strimzi 토폴로지·KafkaTopic 소유권·인증서 명시적 재배포도 유지하고 그 적용 주체만 인계 후 Argo로 바꾼다.
레포 간 계약은 [허브 ADR 0030](https://github.com/soma-376/docs/blob/main/adr/0030-dev-gitops-delivery.md)과
[generated-values 계약](https://github.com/soma-376/docs/blob/main/contracts/generated-values-sync.md)이 소유한다.
PROJ-277의 private 사본 공급·사용 절차 위에 이 결정을 쌓는다. 입력·생성기 소유권과 접근 제한은 계승하고,
인계된 대상의 수동 게시·Helm 적용 경로는 검증한 C/V/B/P 승격·Argo 적용으로 확장한다.

## Context

현재 dev는 Strimzi·`network-removed`·ALB Gateway·ingest `kafka` profile이며 Helm release로 운영한다.
Strimzi·관측의 실제 완료 근거는 [완료 기록](../runbooks/proj191-strimzi-completion.md)에 있다.
Argo 도입 여부와 이 기존 검증 결과는 별개다. 관측 ADR 0039의 `Proposed` 상태도 이번 결정으로 바꾸지 않는다.

`scripts/eks-values.mjs`의 `generateValues()`는 CDK output·추적 profile/runtime·네 앱 digest·Strimzi
Secret metadata로 값을 만든다. 현재 spring-app은 `image.repository`와 bare `image.digest`를 요구한다.
Image Updater의 Helm tag 출력은 `tag@sha256:…`이므로 기존 digest 필드에 직접 연결할 수 없다.
또한 앱별 write-back은 네 이미지가 같은 backend 실행의 완성 묶음이라는 보장을 제공하지 않는다.

Strimzi Operator는 vendor chart와 Helm 3.22.0, `scripts/strimzi-operator-post-render.mjs`를 함께 사용한다.
단순한 native Helm Application으로 바꾸면 namespace 검증·감시 범위 축소가 사라질 수 있다.
기존 Helm의 저장된 revision은 Argo 적용 이후의 실제 선언을 추적하지 못한다.

## Decision

### 1. 범위와 소유권

- 대상은 공유 dev EKS다. prod·frontend Terraform·perf는 Application·ImageUpdater 선택자에서 제외한다.
- CDK는 기존 AWS 리소스·IAM·SG·ALB/TG를 소유하고 [ADR 0048](0048-dev-cloudformation-cicd.md)의
  고정 Assembly 승인·배포를 유지한다. 앱 CI에는 CDK·Helm·Kubernetes 쓰기 권한을 추가하지 않는다.
- Helm chart는 Kubernetes 선언의 원본이며, 인계 이후 Argo가 렌더·적용·상태 복구를 수행한다.
  Auto Mode는 노드를, Strimzi는 Kafka CR에서 파생한 리소스를 계속 관리한다.
- Argo CD와 Image Updater 자체는 버전·chart checksum·이미지 digest를 infra에서 고정하고
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
| runtime-config | 하나 | CSI/ASCP 준비; 원문 없는 Secret 참조 |
| Strimzi Operator와 CRD | 하나 | 기반 준비; 고정 renderer 검증 |
| Kafka CR | Operator와 별도 하나 | CRD Established·Operator Ready; Kafka/Topic/User 상태 검증 |
| ClickHouse | 하나 | 기존 PVC·AZ·CSI 준비 |
| observability, Loki, Tempo, otel-platform | 기존 release마다 하나 | 기반·CSI·필요한 CRD 준비 |
| enrollment, ingest, Gateway, dashboard | 앱마다 하나 | 아래 앱 순서 |

`telemetry-kafka-admin`의 offset reset 등 수동 Job은 자동 sync/hook 대상이 아니다.
Strimzi가 생성하는 Pod·Service·PVC·Secret을 별도 Application으로 중복 선언하지 않는다.

상위 Application이 하위 Application 선언을 관리하는 app-of-apps 구조를 사용한다. 플랫폼·runtime·데이터
의존성 준비 후 **enrollment의 Flyway 성공 → ingest → Gateway → dashboard** 순서로 적용한다.
하위 Application의 custom health는 현재 spec과 `status.sync.comparedTo`, 원하는 C/V와
`status.sync.revision/revisions` 일치, Synced·Healthy,
진행 중/실패 operation 부재를 함께 요구한다. 이전 revision의 Healthy만으로 다음 wave를 열지 않는다.
Kafka CR은 Ready와 observedGeneration을 함께 검사한다. 일반 배포 순서가 JWT verifier→signer 같은
특수 순서를 대체하지 않으며, 그 변경은 일반 승격을 보류하고 별도 단계로 적용한다.

네 앱의 Git 선택은 한 번에 바꾸지만 Kubernetes 교체는 순차적이다. replica 1·Recreate를 유지하므로
중단과 혼합 버전 구간이 있을 수 있다. Flyway 성공·필수 기능 증거를 수집하는 검증기는 후속 구현에 포함하되,
DDL 자체를 migration Job이나 Argo hook으로 옮기지 않는다. gate가 없는 상태에서는 자동화를 활성화하지 않는다.

### 3. 이미지 후보와 revision 승격

허브 계약의 C(infra/chart commit), V(private generated snapshot commit), B(backend 완료 manifest 원본 바이트의 SHA-256),
P(protected main의 배포 선택 commit)를 사용한다.

1. 생성기는 C의 chart·profile·runtime과 현재 AWS output/Strimzi metadata를 검증하고 generated를 만든다.
   설정 재생성에서는 현재 선택된 B의 네 이미지를 보존한다. ECR의 최신 태그를 임의로 다시 선택하지 않는다.
2. ImageUpdater CRD는 네 앱의 `dev` 태그를 `digest` 전략·`linux/arm64`로 추적한다. Gateway도 같은
   tracking tag를 필수로 공급한다. Git write-back은 private 저장소 `candidate/dev`에만 쓴다. 네 앱 generated의
   `image.ref`만 허용하며 `repository[:tag]@sha256:<64 lowercase hex>` 형식을 검증한다.
   digest 없는 참조는 거부한다. `manifestTargets.helm.spec=image.ref`와 repository-root 기준 앱별
   `helmvalues` 대상, write-back repository·branch를 명시한다. pinned V에서 branch를 추론하거나
   `.argocd-source`/Application parameter override를 배포 경로로 사용하지 않는다.
3. infra 소유 승격기는 허용 backend workflow의 성공 실행·시도와 manifest를 대조하고 네 repository·digest·
   ARM64·같은 B, 비이미지 필드 불변, 현재 C/V/P 기준을 검증한다. 누락·혼합·과거 실행·기준 변경은 실패다.
   같은 SHA의 다른 digest는 새 B로 재검증한다. Git diff 허용목록은 토큰의 필드별 권한을 대신하는 검증이다.
4. 검증된 generated와 B를 V로 먼저 보존한다. 이때 Application은 기존 V를 계속 가리킨다.
   이후 P 한 commit에서 `dev/desired.yaml`과 `dev/applications/`의 영향을 받는 모든 하위 Application C/V를 함께 바꾼다.
   상위 Argo는 private main의 Application 선언을, 하위 Argo는 고정 C/V를 읽는다.
5. 단일 publisher가 배포 선택을 직렬화한다. Git head가 바뀌면 최신 상태에서 재검증하고 재시도하며
   force push·마지막 쓰기 우선 덮어쓰기를 금지한다. V 이후 P 이전 실패는 기존 배포 선택을 유지한다.
   진행 중인 묶음의 성공/실패 판정 전에는 다음 묶음을 적용하지 않는다.

candidate의 중간 혼합 상태는 배포하지 않는다. `dev/infra-commit.txt`만 기록하고 chart의 `develop`과
values의 `main`을 독립 추적하는 방식은 C/V 결합을 보장하지 못하므로 사용하지 않는다.
현재 chart/schema/생성기의 `repository+digest`에서 `image.ref`로의 변경은 후속 구현이며,
기존 CLI의 `repository@digest` 입력과 ARM64·initContainer/앱 동일 이미지 검증을 보존한다.
Git write-back의 source/write branch는 `main:candidate/dev`로 명시한다. 최초 인계의 과거 이미지 기록은
새 B가 아니며 자동 승격을 허용하는 증거로 사용하지 않는다. 수동 인계 이후 첫 자동 이미지 승격부터
새 완료 manifest 계약을 요구한다.

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
| Image Updater | 네 ECR 이미지 조회와 candidate branch 쓰기; protected main 승격·보호 우회 없음 |
| infra publisher | output/metadata와 backend 성공 산출물 조회, 생성·검증·V/P 게시 |
| Argo application-controller | 대상 dev namespace와 명시한 cluster-scoped 종류 적용; AWS 배포 권한 없음 |
| backend CI | 기존 이미지 게시와 완료 manifest 발행; private Git·Kubernetes 쓰기 없음 |

Git 읽기·후보 쓰기·승격 identity를 분리하고 protected main의 승격 주체를 제한한다. Updater의 registry
조회에는 전용 Pod Identity를 사용하고 ECR push·CloudFormation·Secret 값 읽기 권한을 주지 않는다.
AppProject는 플랫폼의 필요한 CRD/RBAC/NodeClass/NodePool/StorageClass/Namespace 범위와 앱의
namespaced 리소스를 분리한다. 임의 저장소·클러스터·prod/perf namespace를 허용하지 않는다.
AppProject 제약과 Kubernetes RBAC는 별도 계층이며 둘 다 실제 거부 검증이 필요하다.

AWS Secret 원문은 Git·CI artifact·values로 복제하지 않고 기존 CSI 파일 공급을 유지한다.
Strimzi 인증서의 읽기 전용 mount 예외를 Git 자격증명이나 다른 Secret에 확대하지 않는다.
Git/Argo 관리 자격증명은 애플리케이션 Secret과 분리하고 원문을 문서·출력·검증 증거에 넣지 않는다.

### 5. 운영 중지와 복구

offset reset·인증서/JWT 교체·rollback 전에는 Git의 maintenance 상태로 publisher·Updater와 해당
Application의 자동 sync/self-heal을 정지한다. 상위 Application이 이 상태를 되돌리지 않도록 상위가
생성하는 선언에도 반영하고, 진행 중 operation 종료를 확인한다. 운영자가 Pod만 scale down한 상태는
중지 상태로 인정하지 않는다. 임시 변경은 종료 전에 Git과 정합을 맞춘다.

복구는 현재 runtime·schema·Kafka backlog·키·인증서와 호환되는 이전 네 앱 B를 선택하여 생성·승격한다.
Git 전체 revert나 Helm history만으로 현재 설정을 복원하지 않는다. 전체 설정까지 되돌려야 하면 별도로
검증된 C/V/B 조합을 선택한다. DB downgrade·PVC/offset 복원·MSK 복구는 자동 수행하지 않는다.
정상 기능을 확인하고 잘못된 후보의 재승격을 차단한 뒤 자동화를 재개한다.

## Alternatives Considered

- 수동 Helm 유지: 현재 도입 전 경로로 유지하지만 인계 이후의 지속적인 drift 복구와 Git 추적에는 Argo를 사용한다.
- Updater가 배포 branch에 앱별 즉시 write-back: 완성되지 않은 네 앱 묶음과 C/V 불일치가 노출되어 제외한다.
- 별도 이미지 overlay: 쓰기 주체 분리는 단순하지만 사용자가 선택한 generated 직접 수정 예외를 적용한다.
- 기존 bare digest 필드에 Updater tag 연결: 입력 형식이 맞지 않아 제외한다.
- native Helm만으로 Strimzi 렌더: 현재 post-render 검증을 보존하지 못하므로 해당 Application만 CMP를 사용한다.
- Argo 자기 관리·자동 prune: 초기 장애 복구와 데이터 수명 확인을 위해 도입하지 않는다.

## Consequences/Tradeoffs

### Positive

선택한 코드·설정·이미지를 추적하면서 기존 AWS/Kubernetes 책임을 유지한다. 후보의 부분 게시·stale run을
실제 적용 전에 차단하고, Helm 인계 후 변경과 복구도 같은 Git 경로에 기록한다.

### Negative

후보 검증 publisher, 두 단계 V/P 게시, CMP와 custom health의 구현·운영 비용이 생긴다.
Git이나 검증 경로 장애는 새 배포를 막으며 자동 prune을 끄므로 제거된 선언의 리소스가 남을 수 있다.
Argo 자체는 초기 비 HA이며 데이터 복구나 네 앱의 동시 교체를 보장하지 않는다.

## Follow-up

허브 PROJ-281 계약 이후 PROJ-280·286의 문서를 정합화한다. 후속 구현에서 chart/schema/생성기 입력 전환,
backend 완료 manifest, 공급·승격 workflow, Git 보호·권한, Argo/Updater 고정 설치, CMP·Application·health,
maintenance·검증 결과 기록을 구현한다. [운영 런북](../runbooks/dev-argocd-operations.md)의 인계 수락 조건을
통과하기 전에는 기존 Helm 운영을 유지한다. 현재 CloudFormation workflow가 values 게시까지 수행한다고 표현하지 않는다.

## Acceptance Criteria

허브 계약과 네 이미지 묶음·C/V/P·권한·배포 순서·rollback이 일치하고, 런북의 누락·혼합·변조·stale·충돌·
부분 실패 시나리오가 승격 또는 다음 wave를 막아야 한다. 설치 전 로컬 검증과 실제 인계·기능 검증을 분리한다.
Git 게시, Synced, Healthy, 실제 로그인·조회·Gateway ACK→consume→commit→S3/ClickHouse 성공을 각각 기록한다.

## References

- [Argo Helm: 렌더와 releaseName](https://argo-cd.readthedocs.io/en/stable/user-guide/helm/)
- [Argo multiple sources](https://argo-cd.readthedocs.io/en/stable/user-guide/multiple_sources/)
- [Argo Application health](https://argo-cd.readthedocs.io/en/stable/operator-manual/health/#argocd-app)
- [Argo CMP](https://argo-cd.readthedocs.io/en/stable/operator-manual/config-management-plugins/)
- [Image Updater Git write-back](https://argocd-image-updater.readthedocs.io/en/stable/basics/update-methods/)
- [backend ADR 0075](https://github.com/soma-376/pulsemetry-backend/blob/develop/docs/adr/0075-dev-앱-이미지는-검증한-묶음으로-GitOps에-인계한다.md)
