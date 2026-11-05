# 0058. dev LBC 인증서는 cert-manager가 관리하고 Argo 인계 선언은 별도로 생성한다

## Status

Accepted (PROJ-310; 인증서 소유권과 수동 인계 구성의 로컬 구현 결정이다. 실제 설치·인증서 전환·Git 연결·클러스터 인수는 별도 운영 수락이다.)

## Context

[ADR 0056](0056-dev-argocd-gitops-operations.md)은 기존 dev release를 Argo에 인계하되 이름·selector·PVC와
렌더 재현성을 보존한다. PROJ-287의 검토 생성기는 모든 Application의 reconcile을 중지한다. LBC upstream
chart는 `lookup`으로 기존 TLS Secret을 읽지 못하면 새 인증서와 webhook CA를 생성하므로 offline 렌더가
매번 달라진다. 인증서 차이를 숨기는 것만으로는 소유권·갱신·부분 소실 복구를 해결하지 못한다.

이 결정은 infra 내부의 Kubernetes 선언·관리 권한·운영 절차에 한정된다. 허브의 generated 13개 파일,
C/B/V/P 및 publisher CAS 계약과 [ADR 0057](0057-dev-argocd-github-app-authentication.md)의 reader 인증 경계는 바꾸지 않는다.

## Decision

### 1. 독립 cert-manager Application

- cert-manager **v1.21.3**의 공식 chart archive·checksum과 실행 이미지의 ARM64 digest를 고정한다. namespace와
  신규 release 이름은 `cert-manager`다. 기존 ARM64 apps 노드에 배치하고 webhook은 `hostNetwork=false`,
  `securePort=10250`을 사용한다. AWS 리소스·SG는 추가하지 않으며 실제 control plane 통신은 운영 수락으로 확인한다.
- 관리 catalog는 18개다. 기존 17개 release는 실제 inventory 입력을 보존하고 cert-manager는 신규 설치 대상으로
  구분한다. cert-manager의 정적 입력은 infra에 두며 generated values 목록은 13개를 유지한다.
- cert-manager chart가 namespace 선언을 소유한다. 관리 RBAC를 적용하기 전에 같은 고정 렌더의
  `Namespace/cert-manager`만 먼저 준비하며 base/management에 중복 선언하지 않는다.
  CRD·controller·webhook·cainjector와 startup API check 준비를 확인한 뒤 LBC의 Certificate를 적용한다.
  H 인계에는 root가 없으므로 wave annotation만으로 서로 다른 Application의 순서를 보장하지 않는다.

### 2. LBC 인증서의 선언과 수명

- LBC는 upstream `enableCertManager=true`를 사용한다. Certificate·Issuer는 Git/Argo, 인증서 Secret은
  cert-manager, webhook `caBundle`은 cainjector가 소유한다. 생성된 Secret 원문을 Git·Helm 입력·검증 출력에 복제하지 않는다.
- 차이 처리는 렌더한 정확한 LBC·cert-manager webhook 이름의 cainjector 소유 `caBundle` 필드만 허용한다. webhook 전체,
  TLS Secret 전체, 임의 manager의 모든 필드를 무시하지 않는다. Certificate·Issuer·SAN·Secret 참조와
  webhook의 CA 주입 annotation은 계속 비교한다.
- 기존 Helm LBC의 전환은 별도 유지보수다. 원래 TLS Secret에 `helm.sh/resource-policy=keep` metadata를
  먼저 적용하고 검증한 C/H·실제 release 이름·Helm 3.22.0으로 전환한다. Secret 삭제, 원문 추출,
  인증서 검증 비활성화나 무조건적인 Helm rollback을 사용하지 않는다.
- leaf 갱신·leaf Secret 소실·CA 주입 소실·root 교체/소실을 각각 운영 검증한다. CA Issuer의 root 변경은
  leaf 재발급을 자동 보장하지 않으므로 명시적 renew와 현재 serving certificate·주입 CA·실제 webhook
  요청의 일치를 확인한다. Ready만으로 갱신·복구 완료를 판단하지 않는다.

### 3. 검토 생성과 적용용 생성의 분리

- 기존 `dev-argocd-applications.mjs`와 `dev-argocd-management.mjs`의 기본 동작은 review-only다.
  별도 `dev-argocd-handoff.mjs`가 고정 infra C·private snapshot H·18개 inventory·CMP digest와 같은
  입력의 렌더 결과를 검증해 수동 sync용 Application·관리 values·인계 보고서를 새 디렉터리에 생성한다.
- 적용용 child 선언은 검토용 중지 annotation을 제거하되 자동 sync·self-heal·prune·allowEmpty를 끄고
  삭제 finalizer를 넣지 않는다. H 인계에서는 root·bundle·desired·delivery-state를 생성하지 않는다.
- 관리 활성화 출력에서만 `cluster.inClusterEnabled=true`와 `argocd-dev-in-cluster` 연결 Secret을 함께
  사용한다. `config: {}`로 기존 Argo ServiceAccount의 projected token·CA를 사용하며 별도 token/CA
  원문을 복제하지 않는다. bootstrap은 계속 비활성이다. cluster Secret의 Application용 skip-reconcile로
  연결 비활성을 대신하지 않는다.
- AppProject·Kubernetes RBAC에 cert-manager namespace와 실제 렌더에 필요한 리소스를 추가한다. cert-manager의 leader election namespace는 `cert-manager`이고
  aggregate ClusterRole은 비활성화한다.
  controller 쓰기/server 조회 분리·RBAC 이름 제한·CMP credential 비공급은 유지한다.
  기존 PROJ-279 `generated-values-reader` Group 연결은 정확한 RoleBinding과 같은 렌더의 Secret 5개 `get`
  규칙을 대조해 보존한다. 다른 Group 또는 확대된 Role을 허용하는 예외가 아니다.
  고정 관측 chart의 `pulsemetry-observability/pulsemetry-monitoring-prometheus-scrape-confg`는 `Opaque`의
  단일 `additional-scrape-configs.yaml` data가 정규 base64/UTF-8의 YAML 빈 배열일 때만 비인증 설정으로
  허용한다. 이 이름에 한정한 update/patch만 더하고 create/delete·MSK scrape·인증 Secret 쓰기는 허용하지 않는다.
  Secret 원문을 보고서/values에 복제하는 예외가 아니다. 인계 전 기존 Secret의 존재를 metadata로 확인한다.
  소실 시 운영자가 동일 C/H의 검증된 빈 배열 설정 Secret 하나만 복구하며 controller가 자동 재생성하지 않는다.
  Server-Side Apply도 새 Secret 생성에는 create 권한이 필요하므로 patch 권한을 생성 권한으로 해석하지 않는다.
- 인계는 base → cert-manager 준비 → LBC 및 기존 platform/runtime/data 의존성 → enrollment의 Flyway와
  기능 검증 → ingest → Gateway → dashboard 순서다. live evidence가 없는 보고서의 운영 수락은 `pending`이다.

## Alternatives Considered

- 기존 랜덤 Secret/CA 렌더와 광범위한 ignore: 갱신·복구 책임과 실제 TLS 정합을 증명하지 못해 채택하지 않는다.
- 고정 개인키·인증서를 values에 게시: 비밀 원문 비복제 원칙과 회전 책임을 훼손한다.
- 별도 자체 인증서 controller: 새 수명 관리 구현 대신 검증 가능한 upstream cert-manager 경로를 사용한다.
- 검토 생성기의 기본 reconcile 활성화: 기존 review-only 소비자의 안전한 기본 동작을 바꾸므로 별도 진입점을 사용한다.

## Consequences/Tradeoffs

### Positive

LBC 렌더가 인증서 원문 없이 재현되며 인증서와 CA 주입의 소유자가 명확해진다. 검토 산출물과 수동 인계
산출물이 분리되고 기존 13개 generated 계약·reader/publisher 권한 경계를 보존한다.

### Negative

cert-manager CRD·controller·webhook·cainjector의 자원과 업그레이드 부담이 추가된다. 인증서 전환은 webhook
일시 실패를 수반할 수 있으며 root 수명·leaf 재발급·부분 소실 복구를 운영자가 확인해야 한다. 로컬 렌더와
상태 검사는 실제 TLS·권한·기능 성공을 대체하지 않는다.

## Follow-up

- 운영자가 전용 GitHub App 설치·키 등록/교체, CMP 이미지 게시, C/H와 실제 inventory를 확정한다.
- PROJ-279 사본 writer의 종료와 진행 중 실행 부재를 확인한 뒤 첫 sync·인증서 전환·기능 검증을 수행한다.
- PROJ-311의 이미지 묶음·승격·복구와 별도 infra 설정 publisher·공통 CAS 구현 후 자동화 인계를 검증한다.
- 이번 변경에서는 GitHub App·이미지 registry·AWS·클러스터·private main을 변경하지 않는다.

## Acceptance Criteria

18개 적용용 Application과 관리 설정을 fixture에서 재현하고 고정 Helm 3.22.0/4.2.1 렌더·vendor checksum,
LBC의 랜덤 Secret/CA 부재, Certificate 참조·SAN·CA 주입, 권한·health·hook·입력 거부 회귀 검사를 통과한다.
실제 Git 읽기·RBAC 거부·webhook TLS·회전/복구·수집 기능은 별도 증거 없이는 `pending`이다.

## References

- [Argo 운영 런북](../runbooks/dev-argocd-operations.md)
- [cert-manager 지원 버전](https://cert-manager.io/docs/releases/)
- [cert-manager Helm 설치](https://cert-manager.io/docs/installation/helm/)
- [CA Issuer의 root 갱신과 leaf 재발급 제약](https://cert-manager.io/docs/configuration/ca/)
- [고정 LBC chart의 인증서 선언](../../helm/dev/platform/lbc/chart/templates/cert-manager.yaml)
- [Argo v3.5.7 cluster 연결 구현](https://github.com/argoproj/argo-cd/blob/v3.5.7/util/db/cluster.go)
