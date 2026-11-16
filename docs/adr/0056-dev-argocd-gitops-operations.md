# 0056. dev Kubernetes 선언은 검증한 revision 묶음을 Argo CD로 적용한다

## Status

Accepted — 게시·활성화·복구 정책은 [허브 ADR 0036](https://github.com/soma-376/docs/blob/main/adr/0036-simple-dev-git-publication-and-argocd-sync.md)으로 부분 대체한다. PROJ-334·335는 장기 CAS 잠금·CI observer·자동 이미지 rollback·초기화 readiness 대신 짧은 Git 게시와 Argo 자동 sync를 사용한다. Argo CD 채택, infra·이미지 소유권, 고정 C/V 참조, CSI·스토리지·Strimzi 경계는 유지한다. Git 인증 공급은 [ADR 0057](0057-dev-argocd-github-app-authentication.md)을 따른다. 코드 구현과 실제 dev 적용은 구분한다.

[ADR 0028](0028-dev-eks-auto-mode-transition.md)의 인계된 리소스에 대한 일반 배포 주체와 Argo 제외 결정을 부분 대체한다. CDK의 AWS 소유권과 Auto Mode의 노드 관리는 유지한다. [ADR 0049](0049-dev-strimzi-kafka-and-staged-msk-retirement.md)의 Strimzi 토폴로지·KafkaTopic 소유권·인증서 명시적 재배포도 유지하며 적용 주체만 인계 후 Argo로 바꾼다.

레포 간 파일·게시 계약은 [generated values 공급 계약](https://github.com/soma-376/docs/blob/main/contracts/generated-values-sync.md)이 소유한다. 이 문서는 infra의 렌더·Application·운영 경계를 정한다.

## Context

현재 dev는 Strimzi·`network-removed`·ALB Gateway·ingest `kafka` profile을 사용한다. 기존 Strimzi·관측의 실제 완료 범위는 [완료 기록](../runbooks/proj191-strimzi-completion.md)이 소유하며 Argo 도입 상태와 구분한다. 관측 ADR 0039의 `Proposed` 상태는 바꾸지 않는다.

`generateValues()`는 CDK output·공식 profile/runtime·네 앱 digest·Strimzi Secret metadata로 values를 만든다. backend는 이미지 생산 출처를, infra는 chart와 실행 설정을 알고 있다. 두 저장소의 게시가 충돌할 수 있으므로 반대 영역 보존과 Git HEAD 검증이 필요하다.

PROJ-311의 기존 설계는 Git 게시 이후 Argo 관측·자동 복구까지 잠금을 유지했다. PROJ-334·335는 이를 분리한다. Git에는 검증한 최신 선언을 게시하고 실제 동기화는 Argo CD가 수행한다. 중간 배포가 생략될 수 있는 최신 상태 수렴을 선택한다.

## Decision

### 1. 범위와 소유권

- 대상은 공유 dev EKS의 18개 Application이다. prod·frontend Terraform·perf는 제외한다.
- CDK는 AWS 리소스·IAM·SG·ALB/TG를 소유하며 [ADR 0048](0048-dev-cloudformation-cicd.md)의 plan·승인·같은 SHA/Assembly 배포를 유지한다.
- Helm chart는 Kubernetes 선언의 원본이고 Argo CD가 렌더·적용·drift 복구를 수행한다. backend와 infra publisher에는 Kubernetes·Argo 쓰기 권한을 추가하지 않는다.
- Argo CD 자체는 고정 chart/checksum·ARM64 digest와 기존 수동 Helm 경로로 관리한다. root가 Argo 자신을 관리하지 않는다.
- Image Updater·mutable tag 추적·image overlay를 사용하지 않는다. 기존 `image.repository` + bare `image.digest`를 유지한다.

### 2. Application과 기존 자원 보존

[ADR 0058](0058-dev-lbc-cert-manager-and-argocd-handoff.md)의 cert-manager·LBC 인증서 소유권과 수동 인계 절차를 유지한다. 기존 namespace·releaseName·리소스 이름·selector·PVC·values 파일 순서를 보존한다. 실제 inventory를 사용하고 예시 release 이름을 운영값으로 추정하지 않는다.

- platform/base, LBC, CSI, ASCP, Fluent Bit, runtime-config, Strimzi Operator, Kafka, ClickHouse, observability, Loki, Tempo, otel-platform, cert-manager와 앱 네 개를 기존 release 단위로 관리한다.
- `telemetry-kafka-admin` values는 generated 13개에 포함하되 수동 Job을 자동 sync/hook으로 실행하지 않는다.
- Strimzi가 생성하는 Pod·Service·PVC·Secret을 별도 Application으로 중복 관리하지 않는다.
- 기반·runtime·데이터 준비 뒤 enrollment → ingest → Gateway → dashboard 순서를 기존 wave와 child health로 유지한다. 현재 spec·comparedTo·resolved C/V 및 Synced/Healthy를 함께 확인한다.
- Flyway는 기존 앱 기동 경로에 남기며 PostSync 기능 검증 Job을 만들지 않는다. JWT verifier→signer, 인증서 교체, offset reset 같은 특수 작업은 별도 운영 절차를 따른다.

### 3. 두 publisher의 짧은 Git 게시

C는 infra 전체 commit, B는 backend 완료 manifest 원본 바이트 hash, V는 generated snapshot commit, P는 desired·Application 참조를 선택한 commit이다.

1. infra는 기존 `dev-cdk-deploy.yml`의 승인된 CDK deploy가 끝난 뒤 현재 선택 V의 네 이미지를 유지하며 공식 입력으로 13개 values를 재생성한다. 최신 backend 로그·태그를 설정 게시 입력으로 선택하지 않는다.
2. backend는 최종 성공한 원본 run/attempt·artifact hash·네 ARM64 이미지·packaged contract를 검증한 뒤 digest와 원본 bundle·producer 증거를 바꾼다. 현재 C와 generated의 비이미지 바이트를 보존한다.
3. 현재 private main 위에 V와 V를 참조하는 P를 로컬로 만든 뒤 P까지 한 번의 정상 fast-forward push로 게시한다. desired는 schemaVersion 2와 C/V/B만 기록한다.
4. 게시 직전 예상 main HEAD를 대조한다. 충돌하면 최신 선택을 읽고 후보를 다시 생성하며 최초 시도를 포함해 최대 3회 시도한다. force push·자동 rebase는 하지 않는다.
5. 동일 선택은 no-op이다. 응답 유실은 원격 이력에 정확한 게시 commit이 있는지 확인한다. 확인할 수 없으면 workflow 실패다.

`delivery-state.json`, `activation.json`, 배포 nonce, `evidence/`, lastKnownGood, 실패 fence를 생성하거나 자동 변환하지 않는다. 기존 형식이 있으면 명시적 전환이 필요하다. Git 게시 이후 Argo 완료를 기다리지 않으므로 중간 선택은 건너뛸 수 있고 이후 게시를 이전 rollout 실패로 차단하지 않는다.

### 4. root와 자동 sync

root는 private `main/dev/applications`의 18개 child 선언만 읽는다. 하위는 C/V 전체 SHA를 고정한다. 초기 연결에서는 실제 사용 중인 C·values·이미지·inventory를 보존하고, 새로운 chart·이미지 전환은 별도 변경으로 검토한다.

root는 기존 EKS 운영자 context로 한 번 적용한다. root와 child는 `automated.enabled=true`, `selfHeal=true`를 사용하며 `prune=false`, `allowEmpty=false`, `retry.limit=0`, 삭제 finalizer 없음은 유지한다. 후속 publisher는 Git의 syncPolicy를 보존하므로 유지보수 중지를 되돌리지 않는다.

`published`는 Git 선택 완료만 뜻한다. 실제 rollout과 오류는 Argo UI와 기존 관측에서 확인한다. 로그인·대표 조회·수집·저장은 별도 기능 확인이며 Argo Healthy가 이를 보장하지 않는다.

### 5. 렌더와 자격증명 경계

Strimzi Operator만 기존 CMP의 Helm 3.22.0·vendor checksum·post-render를 사용한다. namespace·감시 범위 검증, `preserveFileMode=false`, `provideGitCreds=false`를 유지한다. 오류·빈 출력에 native Helm fallback을 하지 않는다.

기존 AppProject·관리 RBAC·Git reader와 infra deploy/values-reader·backend ECR 읽기 역할을 재사용한다. 단순 게시 연결만을 위한 별도 infra GitOps 역할이나 CI observer를 요구하지 않는다. Git repository 쓰기 권한은 필드별 격리가 아니므로 파일 허용목록·반대 영역 보존 검증을 유지한다.

Secret 원문·개인키·token·kubeconfig·원문 API 응답을 Git·values·공개 artifact에 넣지 않는다. 기존 CSI 파일 공급과 Strimzi 인증서 읽기 전용 mount 예외는 유지한다. native repository Secret의 운영자 등록 예외는 ADR 0057을 따른다.

### 6. 실패와 유지보수

Git 게시 실패는 원본 workflow의 재실행으로 처리한다. Argo 동기화 실패는 오류 원인을 수정하거나 검토한 이전 선언을 수동 게시해 복구한다. 자동 이미지 rollback, DB downgrade, PVC 복원, Kafka offset reset을 수행하지 않는다.

유지보수는 Git에서 대상 child의 자동화를 끄고 root 반영과 진행 중 operation 종료를 확인한 뒤 수행한다. 양 publisher도 필요하면 중지한다. 운영 종료 후 Git 정합·실제 기능을 확인하고 자동화를 복원한다. prune 비활성화는 CR 변경이나 스토리지 축소로 인한 데이터 손실을 막는 보장이 아니다.

## Alternatives Considered

- 장기 CAS·Argo observer·단일 자동 rollback: 배포와 복구 제어는 가능하지만 최초 활성화와 실패 회복의 운영 부담이 커 허브 ADR 0036으로 대체했다.
- child가 가변 develop/main을 각각 추적: 검증하지 않은 chart·values 조합을 읽을 수 있어 고정 C/V를 유지한다.
- CI가 Kubernetes Application을 직접 patch: CI에 클러스터 쓰기를 주지 않기 위해 root의 Git 적용을 사용한다.

## Consequences/Tradeoffs

### Positive

기존 AWS/Kubernetes 소유권과 검증한 코드·설정·이미지 추적을 유지하면서 게시와 Argo 적용을 분리한다. 별도 상태 머신·초기화 readiness·자동 복구 관문이 줄어든다.

### Negative

모든 중간 선택의 적용을 보장하지 않으며 이전 실패 뒤에도 새 선택이 게시될 수 있다. 실제 기능 장애는 Argo 상태만으로 드러나지 않을 수 있다. 오류 확인과 수동 복구는 운영자 책임이고, prune을 끄므로 삭제한 선언의 리소스는 남을 수 있다.

## Follow-up

- PROJ-334의 publisher 구현·계약 테스트와 PROJ-335의 root·auto sync 실제 연결을 각각 검증한다.
- 기존 PROJ-310의 수동 인계·인증서 전환 결과와 새 Git 게시·Argo 적용 결과를 구분해 기록한다.

## Acceptance Criteria

동시 push·응답 유실·no-op·오래된 source·반대 영역 보존을 검증한다. 초기 root 연결에서 child·PVC·이미지·mount를 보존하고, Git 변경의 root → child 적용과 비파괴 self-heal을 확인한다. 코드·Git 게시·Argo 성공·실제 기능 성공을 각각 보고한다.

## References

- [허브 ADR 0036](https://github.com/soma-376/docs/blob/main/adr/0036-simple-dev-git-publication-and-argocd-sync.md)
- [간소화 게시 운영](../runbooks/dev-gitops-image-promotion.md)
- [Argo 인계 운영](../runbooks/dev-argocd-operations.md)
- [기존 상세 설계의 고정 기록](https://github.com/soma-376/infra/blob/35188fd52279eab123fb5d659187512567e7d30c/docs/adr/0056-dev-argocd-gitops-operations.md)
