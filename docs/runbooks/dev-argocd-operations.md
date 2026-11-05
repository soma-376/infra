# dev Argo CD 도입·인계·검증·복구

[ADR 0056](../adr/0056-dev-argocd-gitops-operations.md)·PROJ-280의 운영 계약이다.
PROJ-274의 [고정 설치 구성·로컬 검증·접속 절차](../../helm/dev/platform/argocd/README.md)를 추가했다.
2026-11-04 운영자가 실제 dev 클러스터 설치 완료를 확인했다. 이 변경에서는 live 상태를 재조회하지 않았다.
**UI 로그인·재기동·권한 거부의 검증 근거, workflow 구현과 기존 Helm 인계는 별도로 확인한다.**
도입 전에는 [EKS 수동 런북](dev-eks-manual-deployment.md)과 [Strimzi 런북](dev-strimzi-kafka.md)을 따른다.
PROJ-287의 검토 구성 위에 PROJ-310은 [ADR 0058](../adr/0058-dev-lbc-cert-manager-and-argocd-handoff.md)의
cert-manager와 적용용 수동 인계 산출물을 추가한다. 이번 변경은 코드·로컬 검증·절차 작성이며 실제 Git 연결·
이미지 게시·클러스터 적용은 수행하지 않는다. 아래 운영 절차는 실제 수락 근거를 갖춘 뒤 수행한다.

## 1. 기준과 책임

- 공유 dev만 대상으로 한다. prod·frontend·perf 및 수동 Kafka 관리 Job을 포함하지 않는다.
- 현재 Strimzi·`network-removed`·main `eks`·ALB Gateway·ingest `kafka`를 보존한다.
  기존 관측·수집 완료 결과는 [완료 기록](proj191-strimzi-completion.md)을 따른다.
- AWS 갱신은 [CloudFormation CI/CD](dev-cloudformation-cicd.md), Kubernetes 적용은 인계 후 Argo가 맡는다.
  CDK 적용 성공이 generated 게시나 앱 배포 성공을 뜻하지 않는다.
- Argo 자체는 고정된 Helm으로 수동 관리한다. UI/API는 ClusterIP로 두고 기존 SSM EKS 터널과
  별도 kubeconfig·원래 서버 hostname/CA 검증을 유지한다. 새 public ALB/DNS를 만들지 않는다.
- 배포 단위와 파일 형식은 [허브 generated-values 계약](https://github.com/soma-376/docs/blob/docs/PROJ-281-dev-gitops-contract/contracts/generated-values-sync.md)이
  단일 출처다. C=infra/chart SHA, V=generated snapshot commit, B=backend 완료 manifest 원본 바이트의 SHA-256,
  P=배포 선택 commit이다. backend는 이미지 갱신·롤백, infra는 설정 생성·게시, Argo는 적용·self-heal을 맡는다.
- 두 게시기는 후속 `dev/delivery-state.json`의 owner·generation·기준 P와 main HEAD를 CAS로 검증한다.
  배포/복구 판정까지 잠금을 유지하며 state commit은 배포 선택 P와 구분한다. 실제 상태 파일은 이번에 만들지 않는다.

## 2. 최초 설치와 기존 Helm 리소스 인계

### 2.0 PROJ-274 설치 기반

Argo 자체는 `argocd` namespace/release, chart 10.11.7·Argo CD v3.5.7·Helm 3.22.0으로 고정한다.
[설치 안내](../../helm/dev/platform/argocd/README.md)가 checksum·로컬 검사, SSM 전용 kubeconfig/context 확인,
수동 Helm 설치 → CRD Established → 별도 default Project 제한 적용, loopback TLS 접속과 초기 admin 정리를 소유한다.

초기에는 namespaced Role만 사용하고 `cluster.inClusterEnabled=false`, ApplicationSet `replicas=0`으로 둔다.
PROJ-287의 관리 구성은 bootstrap과 별도로 선택한다. private Git 연결·관리 RBAC 적용·Application/CMP 실행과
중앙 관측의 실제 연결은 아직 운영 수락 범위다.
운영자 설치 완료 확인 이후에도 기존 workload의 적용 주체는 수동 Helm이며, 상세 운영 수락 결과는 별도 증거로 남긴다.

### 2.0.1 PROJ-287 로컬 구성과 배포 입력

`helm/dev/gitops/`의 catalog는 PROJ-310에서 cert-manager를 더한 하위 Application 18개를 정의한다. `scripts/dev-argocd-applications.mjs`는
infra C 전체 SHA, private H/V 전체 SHA, 실제 release inventory를 받아 로컬 검토 산출물을 만든다.
root·platform·workload Project와 관리 RBAC는 `helm/dev/platform/argocd/management/`에서 별도로 준비한다.
기본 bootstrap만 적용하면 로컬 클러스터 관리는 계속 비활성이다.

| 관리 묶음 | 대상 |
|---|---|
| 기반·런타임 | base, cert-manager(신규), LBC, CSI driver, ASCP, Fluent Bit, runtime-config |
| 데이터 | Strimzi Operator, Kafka CR, ClickHouse |
| 관측 | observability, Loki, Tempo, otel-platform |
| 앱 | enrollment, ingest, Gateway, dashboard |

inventory의 namespace·releaseName은 `helm list --all-namespaces`와 기존 배포 기록에서 확정한다.
`pulsemetry-dev-platform`과 `dev-platform` 등 문서의 예시를 실제 release 이름으로 추정하지 않는다.
fixture inventory는 로컬 검증 전용이며 운영 기본값이 아니다. Application 이름과 기존 Helm release 이름은
다를 수 있고 annotation 기반 tracking을 유지한다.

입력 JSON은 다음 필드를 사용한다. `inventory`의 `id`는 catalog의 18개 항목과 정확히 대응해야 한다.

| 필드 | 요구사항 |
|---|---|
| `schemaVersion` | `1` |
| `mode` | `handoff` 또는 `gitops` |
| `infraRevision` | C의 40자리 전체 SHA |
| `inventory` | 기존 `{id, releaseName, namespace}` 17개와 `{id: "cert-manager", releaseName: "cert-manager", namespace: "cert-manager", installation: "new"}` 1개 |
| `handoffRevision` | `handoff`에서만 H 전체 SHA; V/B 필드는 금지 |
| `valuesRevision`, `bundleManifestSha256` | `gitops`에서만 V 전체 SHA와 B의 64자리 SHA-256; H 필드는 금지 |

```bash
set -euo pipefail
: "${ARGOCD_APPLICATION_INPUT:?검토한 입력 JSON 파일 경로}"
ARGOCD_REVIEW_PARENT="$(mktemp -d)"
node scripts/dev-argocd-applications.mjs \
  --input "$ARGOCD_APPLICATION_INPUT" --output-dir "$ARGOCD_REVIEW_PARENT/review"
```

출력 디렉터리는 새 경로여야 한다. `application-review.json`은 Kubernetes manifest가 아닌 검토 보고서다.
`readiness.status=blocked`, `deployable=false`, `deployableApplicationCount=0`을 유지한다.
18개 정의는 `review-only` 상태이고, 모든 하위 선언과 gitops root 템플릿은
`skip-reconcile=true`다. `handoff`의 `rootTemplate`은 null이다. 생성기에 자동화 활성화·차단 우회 옵션은 없다.
이 보고서를 `kubectl apply`하거나 private main에 그대로 게시하지 않는다.

관리 구성은 고정 C와 inventory로 렌더한 리소스 목록에서 필요한 RBAC 이름을 추출한다. 다음 명령도
로컬 파일만 생성하며 Git 또는 클러스터에 적용하지 않는다. 입력 manifest는 접근 제한 경로에서 취급하고
원문을 검증 로그에 출력하지 않는다.

```bash
: "${ARGOCD_CMP_IMAGE:?게시·검증한 CMP repository@sha256 digest 또는 로컬 fixture의 명시 입력}"
: "${ARGOCD_RENDERED_MANIFESTS:?고정 C와 inventory로 렌더한 manifest 파일 경로}"
node scripts/dev-argocd-management.mjs \
  --cmp-image "$ARGOCD_CMP_IMAGE" --rendered-manifests "$ARGOCD_RENDERED_MANIFESTS" \
  --output-dir "$ARGOCD_REVIEW_PARENT/management"
```

`argocd-values.yaml`은 기존 bootstrap values 뒤에 더할 관리 overlay이고, `management-values.yaml`은
수동 release `argocd-management`의 입력이다. 실제 게시 전 CMP digest를 운영값으로 꾸며 넣지 않는다.
관리 chart는 root/platform/workload Project와 controller Role·server 조회 Role을 분리한다.
`resource.respectRBAC=strict`와 명시된 관리 namespace를 사용하며 cluster-scoped 리소스도 필요한 종류로 제한한다.
검토 생성기의 overlay는 `cluster.inClusterEnabled=false`, 관리 values는 `reconciliationEnabled=false`를
유지하므로 cluster Secret을 렌더하지 않는다. 적용용 활성화 출력은 §2.0.4의 별도 생성기를 사용한다. cluster Secret의 `skip-reconcile` annotation을 비활성화 수단으로
사용하지 않는다. 해당 annotation은 Application용이다.
PROJ-310의 적용용 출력에 사용하는 연결 템플릿은 `argocd-dev-in-cluster`이며 별도 bearer token이나
PEM 없이 `config: {}`와 기존 in-cluster ServiceAccount token·CA를 사용한다. Git reader repository Secret과는
다른 구성 객체다. 두 관리 입력은 동일한 인계 생성 결과를 함께 사용하고 검토 출력에 임의 override를 추가하지 않는다.

권한 생성기는 렌더 결과의 RBAC 이름만 출력에 사용하고 Secret data를 복사하지 않는다. `bind`·`escalate`는
렌더에서 확인한 Role/ClusterRole 이름으로 제한한다. CSI·관측의 hook 재실행·정리에 필요한 ServiceAccount
삭제는 렌더에서 확인한 hook 이름에만 허용하며 일반 ServiceAccount·Pod·PVC·Secret 삭제로 확대하지 않는다.
기존 `generated-values-reader` Group 연결은 정확한 binding과 Secret 5개 `get` 규칙만 보존한다.
다른 Group이나 확대된 reader 권한이 발견되면 인계 생성을 거부한다.
다만 Kubernetes `create`는 `resourceNames`로 제한할 수
없고 cluster-scoped 권한도 종류 단위의 범위가 있으므로 이를 강한 테넌트 격리로 설명하지 않는다.
AppProject 제한과 Kubernetes RBAC는 다른 계층이며 실제 거부 검증이 모두 필요하다.

하위 Application은 고정 C와 H/V를 함께 읽고 정적 values 뒤에 generated 값을 적용한다. H 인계 시에는
하위 선언만 수동 검토하며 root를 활성화하지 않는다. 정상 B·V/P·공통 상태가 준비된 뒤에만 root가 private
`main`의 `dev/applications/`를 관리한다. 두 모드 모두 초기 자동 sync·self-heal·prune·allowEmpty는 비활성이고
Application 삭제 finalizer를 넣지 않는다. `telemetry-kafka-admin.yaml`은 사본 목록에 남지만 자동 Job 실행 대상은 아니다.

생성기는 Git 게시나 클러스터 적용을 수행하지 않는다. 결과를 private main에 수동 복사하지 않는다.
`dev/bundle.json`, `dev/desired.yaml`, `dev/applications/`, `dev/delivery-state.json` 중 하나라도 게시하면
PROJ-279 사본 writer가 중단하므로, 실제 최초 게시·writer 전환은 §2.1의 인계 절차로 조정한다.

### 2.0.2 GitHub App 등록·교체·회수

[ADR 0057](../adr/0057-dev-argocd-github-app-authentication.md)에 따라 읽기 App은 `soma-376` 소유이며
`infra-generated-values` 하나에만 설치한다. 권한은 `Contents: read`와 기본 Metadata 읽기다.
공개 infra는 인증 없이 읽고 publisher App 개인키를 Argo에 등록하지 않는다. App ID와 Installation ID는
다른 값이며 실제 선택 저장소·권한과 함께 대조한다. OAuth/SSO와 webhook은 이 등록에 포함하지 않는다.

다음은 **운영자가 실제 인계 시 수행하는 절차**다. PROJ-310의 이번 구현·로컬 검증·CI·에이전트 도구에서는 실행하지 않는다.
운영자는 기존 SSM/private EKS 경로에서 확인한 Argo context로 로그인하고 TLS 검증과 loopback 접속을 유지한다.
GitHub에서 발급한 PEM 파일은 운영자만 읽을 수 있도록 보관하며 화면 공유·명령 추적·세션 기록을 끈다.

```bash
set +x
: "${ARGOCD_CONTEXT:?확인한 dev Argo CLI context 이름}"
: "${ARGOCD_READER_APP_ID:?전용 읽기 GitHub App ID}"
: "${ARGOCD_READER_INSTALLATION_ID:?private 저장소 설치 ID}"
: "${ARGOCD_READER_KEY_FILE:?보호된 로컬 PEM 파일 경로}"
chmod 600 "$ARGOCD_READER_KEY_FILE"
argocd repo add https://github.com/soma-376/infra-generated-values.git \
  --argocd-context "$ARGOCD_CONTEXT" \
  --github-app-id "$ARGOCD_READER_APP_ID" \
  --github-app-installation-id "$ARGOCD_READER_INSTALLATION_ID" \
  --github-app-private-key-path "$ARGOCD_READER_KEY_FILE" --upsert
```

`--github-app-private-key-path`는 파일 내용을 Argo에 전달해 `argocd` namespace의 native repository Secret에
저장한다. CSI 경로 등록이 아니다. 위 명령의 인자·환경에는 식별자와 파일 경로만 들어가며 PEM 원문을 `cat`,
환경변수, 명령 치환, `kubectl -o yaml`, Helm values, 로그·artifact로 출력하지 않는다. 다른 URL을 위한
credential template이나 별도 repository Secret을 추가하지 않는다. 등록 후 임시 PEM은 운영자 보관 정책에
따라 정리하고, 원문을 성공 근거로 첨부하지 않는다.

실제 수락은 private 읽기 성공, reader 쓰기 거부, 미설치 private 저장소 접근 거부, repo-server 재시작 후 읽기,
한 시간을 넘긴 installation token 갱신을 각각 확인한다. 기존 token의 캐시 hit만으로 새 키를 검증하지 않는다.
키 교체는 새 키 발급 → 같은 credential 갱신 → 새 인증·재시작·token 갱신 후 읽기 확인 → 이전 키 폐기 순서다.
App 개인키 폐기가 이미 발급한 token을 즉시 폐기한다고 가정하지 않는다. 긴급 회수는 설치 중지·해제와 token의
잔여 수명을 함께 확인한다. Secret 소실 시에는 새 키를 발급해 복구하며 publisher 키나 PAT로 대체하지 않는다.
Argo native token 갱신을 사용하므로 갱신 CronJob이나 별도 token Secret은 만들지 않는다.

### 2.0.3 렌더러와 운영 수락 관문

Argo 자체 설치용 Helm 3.22.0과 repo-server의 native Helm은 다르다. Argo CD 3.5는 native Helm 4를 사용하며
`spec.source.helm.version: v3`로 이전 버전을 선택할 수 없다. 고정 이미지의 실제 바이너리 버전을 확인하고
일반 Application은 기존 3.22.0 결과와 의미상 같은 리소스를 렌더하는지 대조한다.
의존 chart는 lock/checksum과 같은 bytes를 Git에서 재현해야 하며 렌더 중 최신 dependency를 받지 않는다.

Tempo의 비활성 receiver endpoint는 빈 문자열로 고정하고, 플랫폼 OTel Collector는 upstream의
`alternateConfig`로 완전한 설정을 공급한다. 이는 Helm 3·4의 null 병합 차이로 비활성 수신기·pipeline·기본
memory limiter 설정이 되살아나는 것을 막는 입력 정합화다. 기존 self-metrics 자원 속성 여섯 개도 명시적으로
보존한다. 수신 포트·실제 Collector 설정·리소스의 기존 Helm 3 렌더와 새 Helm 3/4 렌더 동일성이 수락 기준이며,
관측 정책 변경이나 배포 완료로 해석하지 않는다.

Strimzi Operator만 CMP에서 별도 Helm 3.22.0·고정 Node/의존성으로 렌더한다. 동일 C의 vendor checksum과
post-render script를 사용하고 오류·빈 결과는 실패다. 이미지 정의·로컬 검증과 실제 registry 게시·ARM64 digest
선택은 구분한다. CMP에 Kubernetes credential이나 Git reader Secret을 mount하지 않으며
`preserveFileMode=false`, `provideGitCreds=false`와 repo-server와 분리된 임시 디렉터리를 유지한다.

| 관문 | 로컬 구성의 처리 | 실제 인계에서 필요한 증거 |
|---|---|---|
| cert-manager와 LBC 인증서 | ADR 0058에 따라 Certificate·Issuer 선언과 cainjector CA 주입을 사용해 랜덤 Secret/CA 렌더를 제거한다. | CRD·startup API check, 기존 TLS Secret 보존 전환, leaf/root 회전·부분 소실 복구, 실제 webhook 요청을 검증한다. |
| 관측 webhook hook | 기존 인증서 생성/patch hook·RBAC·phase·삭제 정책과 반복 실행 계약을 검증한다. | 실제 hook 재실행·권한·인증서 정합, patch Job 소유 `caBundle`·`failurePolicy`의 차이 처리를 확인한다. |
| 상태·기능 | 목표 spec/comparedTo/revision과 Synced·Healthy·operation·Kafka generation을 검사한다. | Flyway, 로그인·조회, ACK→consume→commit→저장을 목표 revision에 연결한다. |

LBC와 cert-manager의 정확한 webhook 이름에서 cainjector 소유 `caBundle` 필드만 차이 처리한다.
Secret 전체·webhook 전체·다른 controller 필드를 무시하지 않는다. 인증서 개인키를 Git values에 복사하지 않는다. 관측 hook을 일괄 제거하거나 patch Job만 끄지 않는다. Grafana의 기존 CSI 암호
공급과 비활성 CRD upgrade Job을 유지한다. Loki의 live `lookup` 기반 hook을 Argo의 스토리지 변경 복구로 사용하지 않는다.

위 표의 로컬 검증은 실제 인증·권한·TLS·기능 성공을 증명하지 않는다. 적용용 생성이 성공해도 운영 수락은
`pending`이다. 실제 인계를 완료한 대상만 일반 수동 Helm 운영을 종료하며 root·자동화 활성화는 후속 계약을 따른다.

### 2.0.4 PROJ-310 적용용 수동 인계 출력

이 절의 생성 명령은 로컬 파일만 작성한다. 실제 App 설치·키 등록·CMP 이미지 게시·AWS/클러스터 변경과
private main 게시를 수행하지 않는다. 운영 수락은 항상 `pending`이며 생성 성공을 실제 인계 완료로 보고하지 않는다.

입력 JSON은 §2.0.1의 `mode: handoff`, 고정 C/H, 실제 17개 기존 release inventory와 신규 cert-manager 항목을
사용한다. cert-manager 항목은 `id`, `releaseName`, `namespace` 모두 `cert-manager`이고 `installation: new`를
명시한다. 기존 release를 같은 이름의 신규 설치로 취급하지 않는다. CMP 이미지에는 검증한 `repository@sha256:`를 쓴다.

`--rendered-manifests`는 **디렉터리**다. 동일 입력을 담은 `input.json`과 catalog ID별 `<id>.yaml` 18개를
준비한다. C의 chart·정적 values 뒤에 H의 generated values를 넣고 실제 releaseName/namespace로 렌더한다.
Strimzi Operator만 같은 C의 vendor·Helm 3.22.0·post-render/CMP 경로를 사용한다. cert-manager는 고정
정적 values만 사용한다. 생성기는 외부 checkout·Git 조회를 하지 않으므로 운영자가 입력 출처와 SHA를 먼저
대조해야 한다. 다른 C/H의 렌더를 재라벨링하거나 빈 manifest를 넣지 않는다. 렌더 원문은 접근 제한 경로에
두고 출력 보고서에는 SHA-256과 리소스 식별자만 남긴다. Secret data는 원칙적으로 거부한다. 예외는 고정 관측
chart의 `pulsemetry-observability/pulsemetry-monitoring-prometheus-scrape-confg` 하나이며 `Opaque`, 단일
`additional-scrape-configs.yaml` data가 정규 base64/UTF-8의 YAML 빈 배열일 때만 비인증 설정으로 허용한다.
MSK scrape 설정·다른 key·인증값은 거부하고 이 data를 출력 보고서에 복제하지 않는다.

```bash
set -euo pipefail
: "${ARGOCD_HANDOFF_INPUT:?검토한 C/H와 실제 inventory의 JSON 파일}"
: "${ARGOCD_HANDOFF_RENDERS:?input.json과 ID별 YAML 18개가 있는 디렉터리}"
: "${ARGOCD_CMP_IMAGE:?검증한 CMP repository@sha256 digest}"
ARGOCD_HANDOFF_PARENT="$(mktemp -d)"
node scripts/dev-argocd-handoff.mjs \
  --input "$ARGOCD_HANDOFF_INPUT" \
  --rendered-manifests "$ARGOCD_HANDOFF_RENDERS" \
  --cmp-image "$ARGOCD_CMP_IMAGE" \
  --output-dir "$ARGOCD_HANDOFF_PARENT/handoff"
```

출력은 `applications/<id>.yaml` 18개, `argocd-values.yaml`, `management-values.yaml`,
`handoff-report.json`이다. 출력은 새 디렉터리를 사용하고 기존 검토/인계 결과를 덮어쓰지 않는다.
적용용 Application에는 `skip-reconcile`이 없지만 자동 sync·self-heal·prune·allowEmpty는 모두 꺼져 있고
삭제 finalizer도 없다. H 인계에서는 root, `bundle`, `desired`, `delivery-state`를 만들지 않는다.
이 파일들을 private `dev/applications/`에 수동 복사해 PROJ-279 writer 중단을 대신하지 않는다.

관리 overlay와 management values는 한 묶음이다. overlay의 `cluster.inClusterEnabled=true`와
management chart의 `reconciliationEnabled=true`가 함께 활성화된다. 연결 Secret의 `config: {}`는 기존
controller/server ServiceAccount의 in-cluster token·CA를 사용하며 입력이나 출력에 인증 원문을 추가하지 않는다.
server에는 조회, controller에는 필요한 쓰기를 부여한다. cert-manager namespace는 추가하지만 임의 namespace나
reader repository credential을 CMP에 공급하는 권한은 주지 않는다.

운영 적용은 §2.1의 context·identity·C/H 검증과 §2.0.2의 실제 Git 인증이 완료된 뒤에만 진행한다.
관리 chart의 namespaced Role 생성 전에 같은 C의 cert-manager 렌더에서 `Namespace/cert-manager` 한 개만
분리해 먼저 적용한다. namespace가 이미 있다면 소유권·기존 사용자를 확인하며 삭제·강제 인수하지 않는다.
이 namespace의 선언 소유자는 cert-manager chart이고, 이후 cert-manager Application이 추적한다. base나
management chart에 중복 선언하지 않는다. 그런 다음 `argocd-management`를 같은 C의 management chart와 생성한 values로 적용해 Project/RBAC·연결 Secret을
준비하고, Argo 자체는 고정 chart에 bootstrap values 다음으로 생성한 overlay를 전달해 수동 Helm 적용한다.
관측의 비인증 빈 scrape 설정 Secret에만 이름을 한정한 update/patch를 허용하며 create/delete를 추가하지 않는다.
그 외 Secret 쓰기나 인증 원문 비복제 경계는 유지한다. 인계 전에 기존
`pulsemetry-observability/pulsemetry-monitoring-prometheus-scrape-confg`의 존재를 metadata-only 조회로
확인한다. SSA의 새 리소스 생성에도 create 권한이 필요하므로 controller는 이 Secret을 자동 재생성할 수 없다.
소실했다면 운영자가 동일 C/H에서 렌더·검증한 비인증 빈 배열 설정 Secret 한 개만 명시적으로 복구한 뒤
sync를 재개한다. 인증 Secret 복사나 controller의 일반 Secret create 권한 추가로 우회하지 않는다.
기존 Argo release와 overlay가 아닌 다른 values를 혼합하거나 `--reuse-values`로 대체하지 않는다.
Application 등록 후에도 수동 sync만 허용한다. 이후 일반 Helm과 Argo가 같은 workload를 동시에 변경하지 않는다.

| 순서 | 다음 대상으로 넘어가기 전 운영 관문 |
|---|---|
| base | 기존 namespace·NodeClass/NodePool·StorageClass·리소스 식별자 보존 |
| cert-manager | chart가 소유하는 cert-manager namespace, 6개 CRD Established, controller/webhook/cainjector Ready, startup API check 성공, 실제 webhook 호출·ARM64 imageID 확인 |
| LBC | §2.0.5의 별도 인증서 전환·CA 주입·serving certificate·실제 admission 성공 |
| 기존 controller/CSI·runtime·데이터·관측 | CSI/ASCP·Strimzi/CRD·Kafka Ready/observedGeneration·PVC 보존, 관측 hook의 반복 실행과 필수 endpoint 준비 |
| enrollment → ingest → Gateway → dashboard | 각 단계에서 목표 revision·Synced·Healthy·operation 종료와 §4의 Flyway·기능 증거 확인 |

H 인계에는 root가 없어서 서로 다른 Application의 wave가 위 순서를 강제하지 않는다. 운영자가 각 관문을
기록하고 다음 Application을 수동 sync한다. cert-manager startup API check와 관측 인증서 hook은 phase·RBAC·
삭제 정책까지 검증하며 `--no-hooks`로 우회하지 않는다. cert-manager startup hook의 SA/RBAC은
weight -5, Job은 1이며 `post-install,post-upgrade`는 Argo PostSync로 실행한다. `before-hook-creation,hook-succeeded`
정리 정책과 반복 sync 성공을 실제 수락으로 확인한다. Certificate·Issuer health는 현재 generation의 Ready와
발급 상태를 확인하고 오래된 Ready를 성공으로 보지 않는다. 실제 TLS·기능 검증은 Lua health 밖의 별도 증거다.

### 2.0.5 LBC 인증서 전환·회전·부분 소실 복구

[ADR 0058](../adr/0058-dev-lbc-cert-manager-and-argocd-handoff.md)의 cert-manager 도입은 인증서 소유권을
바꾸는 유지보수다. 일반 drift 인계에 섞어 자동 sync하지 않는다. C의 LBC 렌더에서 root/serving Certificate,
Issuer, Secret 이름과 DNS SAN·Service·webhook 이름을 확인하고 기존 release의 값과 대조한다.
TLS Secret 원문과 Helm release Secret 원문은 추출하지 않는다. 서명 키를 백업 artifact나 values로 복사하지 않는다.

1. PROJ-279의 `GENERATED_VALUES_SYNC_ENABLED`를 비활성으로 두고 진행 중 plan/deploy/copy와 재시도 실행이
   모두 종료됐음을 확인한다. 새 승인 plan에도 비활성을 고정한다. 다른 게시기나 Argo 자동 sync가 이미 있으면
   §5에 따라 공통 상태·상위/하위 reconcile도 멈춘다. H 단계에 없는 `delivery-state`를 가짜로 만들지 않는다.
2. cert-manager를 먼저 준비하고 CRD·API webhook·startup check를 통과시킨다. LBC의 기존 TLS Secret 이름을
   현재 Deployment mount와 신규 Certificate의 `spec.secretName`으로 대조한다. 같은 Secret을 사용해야 한다.
3. 기존 Secret의 UID/resourceVersion·보존 annotation 등 metadata만 기록한다. 운영자가 확인한 dev context에서
   해당 Secret에 `helm.sh/resource-policy=keep`을 먼저 붙이고 metadata 조회로 반영을 확인한다.
   Helm 3.22.0의 upgrade 삭제 경로는 live 객체의 annotation을 다시 읽는다. 이 보존은 Secret 내용이나
   전체 release rollback 안전성을 보장하지 않는다. `keepTLSSecret` 값은 Helm resource-policy와 다른 기능이다.
4. 실제 release 이름과 고정 Helm 3.22.0으로 cert-manager를 켠 LBC chart/values를 적용한다. 이때 생성되는
   root/serving Certificate·Issuer 외의 workload·selector·Service·TGB 변경이 없는지 먼저 diff를 검토한다.
   Secret 삭제·`--force`·자동 rollback을 쓰지 않는다. 전환 중 cainjector와 serving certificate가 맞춰지기 전
   admission 요청이 실패할 수 있으므로 후속 workload sync는 보류한다.
5. 두 Issuer와 두 Certificate의 현재 generation Ready, leaf 발급 완료·revision·만료 시각, Secret metadata,
   두 webhook의 CA 주입 참조와 CA hash를 확인한다. 실제 Service에서 제시하는 인증서의 SAN·유효기간·서명
   chain이 주입 CA와 맞고 실제 LBC admission이 성공해야 한다. 필요 시 승인된 LBC rollout 후 다시 검사한다.
6. 같은 C/H로 Argo diff를 확인하고 LBC만 수동 인계한다. 인증서 Secret은 Argo 직접 소유 목록에 없어야 하고,
   차이 처리는 정확한 Mutating/ValidatingWebhookConfiguration의 `webhooks[].clientConfig.caBundle`만이다.
   cert-manager 자체 webhook도 cainjector가 관리하는 같은 필드로 한정하며 failurePolicy·rules·Service·annotation은 비교한다.

실제 실행 명령은 운영자가 위에서 확인한 이름을 입력한다. 아래 명령은 **문서화한 운영 절차이며 이번 구현에서 실행하지 않는다**.

```bash
: "${KUBECONFIG:?EKS SSM 전용 kubeconfig}"
: "${EKS_CONTEXT_NAME:?확인한 dev SSM context}"
: "${LBC_TLS_SECRET:?기존 Deployment와 새 Certificate에서 대조한 Secret 이름}"
kubectl --kubeconfig "$KUBECONFIG" --context "$EKS_CONTEXT_NAME" -n kube-system \
  annotate secret "$LBC_TLS_SECRET" helm.sh/resource-policy=keep --overwrite
kubectl --kubeconfig "$KUBECONFIG" --context "$EKS_CONTEXT_NAME" -n kube-system \
  get secret "$LBC_TLS_SECRET" \
  -o go-template='{{.metadata.uid}} {{.metadata.resourceVersion}} {{index .metadata.annotations "helm.sh/resource-policy"}}{{"\n"}}'
```

인증서 장애는 아래를 구분한다. 시험에서 실자원을 임의 삭제하지 않으며 소실 복구는 승인된 격리 검증 또는
실제 사고 절차로 확인한다. 로그에는 PEM·개인키를 남기지 않고 Certificate/Issuer 이름·generation/revision·
Secret metadata·공개 인증서 fingerprint·만료 시각·CA hash·실제 요청 결과만 남긴다.

| 상황 | 복구와 수락 기준 |
|---|---|
| 정상 leaf 갱신 | cert-manager 자동 발급을 관찰하고 새 revision·유효기간, LBC가 실제 제시하는 새 serving certificate와 admission 성공을 대조한다. Secret mount 갱신만으로 완료 처리하지 않는다. |
| leaf Secret 소실 | 기존 Certificate/Issuer 선언·root를 유지한다. cert-manager의 동일 이름 재발급·새 Secret metadata·LBC reload/필요한 rollout·실제 admission을 확인한다. 원문 수동 복제로 복구하지 않는다. |
| webhook CA 주입 소실 | 정확한 inject-ca annotation과 cainjector Ready·RBAC·원본 Certificate/Secret 참조를 검사한다. cainjector의 재주입과 serving chain 일치를 확인한다. validation을 끄거나 광범위 ignore를 추가하지 않는다. |
| root 교체·소실 | maintenance를 유지하고 root Certificate와 self-signed Issuer 복구·발급을 확인한다. CA Issuer의 Secret 변경만으로 기존 leaf가 재발급되지 않으므로 `cmctl renew`로 serving Certificate를 명시 갱신한다. 새 root/leaf·주입 CA·실제 serving chain·admission을 모두 확인한다. |
| cert-manager 자체 webhook 장애 | cert-manager Deployment·동적 CA Secret의 metadata·cainjector 주입·API startup check를 검사한다. LBC Certificate 조작을 먼저 반복하거나 CRD를 삭제하지 않는다. |

root는 leaf보다 오래 유효해야 하며 root/leaf 각각의 만료·갱신 실패·Ready/Issuing 상태를 운영 관측에 포함한다.
`cmctl renew`는 보호된 operator context에서 정확한 serving Certificate 하나에 실행하고 명령 성공 뒤에도
새 revision과 실제 serving certificate를 확인한다. 인계 후 과거 Helm history를 그대로 rollback하면 cert-manager
소유 Secret과 충돌할 수 있다. 실패 시 현재 소유권·C/H·실제 인증서 상태를 보존한 채 선언·controller를 복구하고,
전체 수집 기능과 Git 정합을 확인한 뒤 일반 운영을 재개한다. 새 자동 publisher·root 활성화는 PROJ-311 및
별도 infra 설정 publisher/CAS 구현·수락 이후다.

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
3. 후속 구현의 기존 `image.repository`·`image.digest` 정합, 고정 의존성·digest, Argo·CMP,
   C/V health gate·기능 검증·공통 상태·자동 복구 경로, Git 권한·branch 보호·maintenance를 확인한다.
   초기 인계 선언도 기존 실제 이미지를 그대로 렌더해야 한다.
4. §2.0의 설치를 검증한 뒤 후속 관리 RBAC·AppProject와 Git 읽기 연결을 준비하고 로컬 클러스터 관리를 활성화한다.
   초기 Application의 자동 sync·self-heal·prune은 비활성 상태로 시작한다.
   repo-server의 private Git 읽기 전용, 두 게시기의 허용 Git 쓰기·diff 검증, backend의
   CDK·Helm·Kubernetes·Argo 변경 거부를 각 identity로 검증한다.
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
4. base → cert-manager 준비 → LBC 및 controller/CSI·runtime·데이터·관측 의존성 → enrollment → ingest → Gateway → dashboard
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

1. 이미지 변경은 backend의 허용 생산 workflow가 같은 SHA·run·attempt의 네 ARM64 이미지와 완료 manifest를
   게시하고 최종 성공한 뒤 별도의 backend 승격 workflow가 처리한다. 원본 실행과 artifact를 조회해 B·repository·
   digest·ARM64·source 및 재개 fence를 검증한다. 개별 태그나 manifest의 자기 선언은 성공 증거가 아니다.
2. 설정 변경은 infra 게시기가 현재 C/B/V/P를 조회해 현재 B의 네 이미지를 생성기에 주입한다. 추적 profile/runtime과
   AWS output·Strimzi metadata가 맞지 않으면 실패한다. Secret 내용이 아닌 UID/resourceVersion만 tlsRevision에 사용한다.
3. 두 게시기는 예상 main HEAD와 현재 P에서 공통 상태가 `idle`인지 검사하고 새 owner/generation을 CAS로 획득한다.
   repo별 concurrency 외에 Git 기반 상호 배제가 필요하다. 잠금 획득 뒤에도 후보 적격성과 현재 C/B/V/P를 다시 확인한다.
   이미지 게시기는 비이미지 값을 보존하고 infra 게시기는 B를 보존한다. 반대 영역 diff는 거부한다.
4. generated 13개와 B를 V로 먼저 게시하고 기존 Application 참조가 그대로인지 확인한다. 그 다음 P에서 desired와
   영향을 받는 모든 Application C/V 참조를 함께 갱신한다. 모든 push는 owner/generation/예상 HEAD/기준 P를 대조한다.
   HEAD 변경은 최신 상태 재검증으로 처리하며 force push하지 않는다. V 게시 후 P 실패는 기존 배포를 유지한다.
   응답 유실로 성공 여부가 불명확하면 원격 선택을 확인하고, 확정할 수 없으면 보류한다.
5. 같은 선택이면 no-op으로 기록하고, 같은 SHA라도 다른 digest는 새 B로 검증한다. 과거 실행·혼합 attempt를 자동으로
   재승격하지 않는다. 잠금은 §4 성공 판정 또는 §6 복구 판정까지 유지한다. 성공 근거와 lastKnownGood을 기록한 뒤
   owner를 비워 `idle`로 전환한다. owner 소실·관측 불명확은 `blocked`이며 timeout만으로 탈취하지 않는다.
   이전 owner가 쓰기 권한을 잃었다면 상태도 덮어쓰지 않고 보고하며 현재 관리 경로에서 보류를 확정한다.
6. unlock 시 두 게시기는 대기 중 후보를 다시 조회·검증한다. 복구 도중 받은 이벤트를 버리거나 이전 검사 결과만으로
   게시하지 않는다. image/config 후보가 동시에 도착하면 먼저 잠금을 얻은 결과를 기준으로 나머지를 재평가한다.
7. schema·키·인증서·runtime 변경 중 별도 조정이 필요한 것은 P 승격 전에 일반 경로를 멈추고 해당 운영 절차를 수행한다.

chart·runtime만 바뀐 경우에도 C/V를 새로 검증해 함께 선택한다. 가변 `develop` chart와 최신 values를
따로 읽거나 Application parameter/`--set`으로 Git 바깥 값을 덧씌우지 않는다. `image.repository` +
`image.digest`와 overlay 없는 구성을 유지하며 Image Updater·태그 감시는 도입하지 않는다.

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
Argo·두 게시기의 오류/중단, 공통 상태·owner·generation, sync 지연·Degraded, 후보 정체와 복구 결과를 관측해야 한다.
검증 결과는 정확한 P/C/V/B·현재 operation과 연결하며 관측 불가를 이미지 실패로 분류하지 않는다.
`argocd` namespace가 기존 Fluent Bit 수집 범위에 자동 포함된다고 가정하지 않고 후속 관측 연결을 검증한다.

## 5. 운영 중지·인증서 교체·offset reset

1. maintenance 대상·사유·현재 P·진행 중 operation과 원래 자동화 설정을 기록한다.
2. 공통 상태를 명시적으로 보류하고 두 게시기의 자동 승격을 중지한다. infra 운영자가 Git에서 대상 Application의 자동 sync/self-heal을 중지한다.
   상위가 생성하는 하위 Application 선언에도 같은 상태를 넣어 상위 self-heal이 되돌리지 않게 한다.
   보호된 수동 운영 경로로 중지 선언을 먼저 적용하고 동작 중 sync의 종료를 확인한다.
3. offset reset은 [Strimzi 런북](dev-strimzi-kafka.md)의 ingest 중지·group 상태·plan/execute 대조를 따른다.
   Job은 수동으로만 실행하고 Argo hook/주기 sync로 반복 생성하지 않는다. Group Read의 commit/reset 의미는 유지한다.
4. 인증서 교체는 현재 Secret UID/resourceVersion만 수집해 generated의 tlsRevision을 갱신한다.
   Git 승격과 명시적 재배포 뒤 실제 Pod revision·mTLS·ACK/consume/commit/저장을 검증한다.
   파일 mount 갱신이 앱의 자동 재로딩을 뜻하지 않는다. JWT는 기존 verifier→signer→구 키 제거 순서를 유지한다.
5. maintenance 중 승인한 수동 P 선택·sync는 가능하지만 자동 후보 승격은 계속 중지한다.
   runtime·replica 등 최종 선언을 Git에 반영하고 실제 동작과 대조한 다음 원래 자동화 설정을 복구한다.
   기존 owner 실행 종료·원격 P·실제 상태를 확인해 새 generation으로 회복하고 보류를 해제한다. §6의 일반 자동 이미지
   rollback에는 이 sync 중지 절차를 적용하지 않는다.

## 6. 자동 이미지 rollback·재개와 수동 복구

1. 이미지 승격 직전 lastKnownGood을 고정한다. 목표 P/C/V/B에 귀속된 rollout 또는 기능의 **확정 실패**만 자동
   rollback 대상으로 분류한다. 원격 선택·실제 digest·operation·migration·키/TLS 상태를 확인하고 진행 중 적용
   operation이 끝날 때까지 새 복구 P를 게시하지 않는다. 과거 Healthy·관측 불가·단순 timeout은 확정 실패가 아니다.
2. 같은 owner/generation이 실패 B·backend SHA·앱별 repository/digest와 실패 시각을 durable CAS commit에 기록한다.
   `resumeFence`는 이 실패 기록을 기준으로 한다. commit ID는 Git 이력에서 얻으며 상태 파일에 자기 SHA를 기록하지 않는다.
3. 마지막 정상 B를 **현재 실제 schema**·Kafka backlog·C/runtime·JWT·인증서와 다시 대조한다. 실패 전에 Flyway가
   진행됐을 수 있으므로 배포 전 검사만 재사용하지 않는다. 호환성 불명확·정상 B 부재·설정 변경 실패·관측 불가·
   owner 소실이면 `blocked`로 남긴다. 잠금 age만으로 다른 실행이 인계하지 않는다.
4. 안전한 경우 같은 owner가 `rolling_back`으로 전환해 현재 비이미지 설정을 보존한 새 V/P를 **한 번만** 게시한다.
   Argo 자동 sync·self-heal은 유지하고 §4의 순차 적용·기능 검증을 반복한다. 복구 실패면 blocked이며 재귀적인 자동
   rollback은 금지한다. backend는 Git의 desired를 바꾸며 Argo rollback 명령이나 Kubernetes를 직접 조작하지 않는다.
5. 복구 성공 후 lastKnownGood과 복구 증거를 갱신하고 잠금을 해제하되 실패 B와 동일한 네 이미지 조합의 차단은 유지한다.
   자동 재개는 실패 source의 엄격한 develop 후속 commit에서, 실패 기록 이후 생성된 **원본 생산 run**이 정상 완료한
   묶음부터 허용한다. 원본 `created_at`을 비교하며 attempt 재시작 시각은 사용하지 않는다. 새 manifest/B로 실패 이미지를
   재포장해도 거부한다. unlock 시 복구 중 도착한 후보를 다시 조회·검증한다.
6. 보류된 실패는 운영자가 원인·실제 상태·기존 owner 종료·호환성을 확인하고 공통 상태를 명시적으로 회복한다.
   config/chart까지 복원해야 하면 검증된 C/V/B 전체 조합과 데이터 호환성을 별도로 확인한다. Git 전체 revert,
   DB 자동 downgrade, PVC/offset 복원, 만료 인증서·MSK 경로 복귀를 기본 복구로 삼지 않는다.
7. Argo 자체 장애는 수동 Helm 설치 입력과 고정 버전으로 복구한다. 일시적인 앱 Helm 조작이 필요하면 §5에 따라
   Argo reconcile·두 게시기를 먼저 멈추고 현재 C/V로 렌더한 정확한 선언만 사용한다. 과거 Helm history가 인계 후
   배포를 나타낸다고 가정하지 않는다. 긴급 변경 후 Git 정합·실제 기능·소유권을 복원해야 자동화를 재개한다.

## 7. 후속 구현 수락 시나리오

| 입력 상황 | expected behavior |
|---|---|
| Gateway 누락·게시 실패·실패한 workflow의 manifest | V/P 승격 없음, 기존 묶음 유지 |
| 네 앱 SHA/run/attempt 혼합·digest/repository/ARM64 불일치 | 후보 거부 |
| backend 이미지 게시에 env·replica 등 비이미지 변경 포함 | 반대 소유 영역 diff로 거부 |
| infra 설정 재생성 중 새 태그/새 B 발견 | 선택된 B 유지; 이미지 변경은 backend 별도 승격 |
| 동일 SHA 재실행, 같은 네 digest | 정상 상태에서는 rollout 없는 no-op; 실패 조합이면 차단 |
| 동일 SHA 재실행, 다른 digest | 새 B로 검증하되 실패 후 재개 fence는 우회 불가 |
| image/config 동시 게시·오래된 C/V/P 또는 실행 | 한 owner만 CAS 획득; 나머지는 최신 상태 재검증 |
| 잠금 획득 뒤 HEAD 변경·owner 소실 | owner/generation/기준 P 재확인; 권한 소실 시 게시 중지·보류 |
| V 게시 후 P 실패·응답 유실 | 기존 참조 유지 또는 원격 P 조회로 성공 여부 확정; 불명확 시 보류 |
| 이전 revision Healthy·관측 불가 | 다음 wave 차단; 자동 이미지 실패/복구로 오판하지 않음 |
| 현재 이미지의 확정 실패·안전한 마지막 정상 B | operation 종료 뒤 같은 owner가 새 V/P로 한 번 복구 |
| migration 적용 후 과거 B 호환성 불명확·정상 B 부재 | blocked; schema·DB·PVC·offset 자동 복구 없음 |
| 설정 실패·rollback 실패·복구 중 owner 소실 | blocked; 자동 재복구·시간 기반 탈취 없음 |
| 복구 성공 후 실패 B/동일 이미지 재포장·옛 run 재실행 | 재승격 거부; 후속 source + fence 이후 원본 run만 재개 |
| 복구 중 새 후보 도착 | unlock 시 후보 재조회·적격성 재평가 |
| CMP checksum·원래 감시 목록 불일치·빈 출력 | 렌더/sync 실패, namespace 확대나 fallback 없음 |
| offset reset을 위해 ingest 중지 | 상위/하위 self-heal과 두 게시기가 중지를 되돌리지 않음 |
| 인계 diff에 selector/PVC/리소스 삭제·교체 포함 | 인계 중단, 원인과 별도 변경 범위 검토 |

문서 단계에서는 링크·상태·계약 정합과 위 시나리오의 기대 동작을 검토한다. 후속 구현에서는 fixture/render·
승격 경쟁·실패 주입을 자동 검증하고, 실제 설치/인계에서는 리소스 보존·권한 거부·기능·복구를 검증한다.
실제 결과를 얻기 전에는 체크리스트가 존재한다는 이유로 PASS를 기록하지 않는다.
