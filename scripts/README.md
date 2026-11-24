# 인프라 스크립트 인덱스

작업에 맞는 진입점을 고른 뒤 연결된 런북에서 실행 환경, 권한과 순서를 확인한다.
경로는 저장소 루트를 기준으로 한다. **CLI**는 직접 실행, **모듈**은 import, **런타임**은 Terraform·Helm·컨테이너가 실행하는 파일이다.
**검증**의 결과는 해당 fixture 또는 시험 환경에 한정한다. 추적된 자체 운영·검증 스크립트를 대상으로 하며 의존 차트, IaC 라이브러리와 테스트 fixture는 각 구성 문서에서 찾는다.

| 작업 | 시작점 | 절차 |
|---|---|---|
| dev 인프라 변경, Helm values 생성 | [CDK와 배포 입력](#cdk와-배포-입력) | [CloudFormation CI/CD](../docs/runbooks/dev-cloudformation-cicd.md), [EKS 수동 배포](../docs/runbooks/dev-eks-manual-deployment.md) |
| Argo CD 인계, GitOps 초기 연결, 이미지·설정 게시 | [Argo CD와 GitOps](#argo-cd와-gitops) | [인계](../docs/runbooks/dev-argocd-operations.md), [root 연결](../docs/runbooks/dev-argocd-simple-auto-sync.md), [게시](../docs/runbooks/dev-gitops-image-promotion.md) |
| Kafka 인증서 metadata와 오프셋, dev DB 접근 | [Kafka와 데이터베이스](#kafka와-데이터베이스) | [Strimzi](../docs/runbooks/dev-strimzi-kafka.md), [DB 접속](../docs/runbooks/dev-database-access.md) |
| 지표·로그·trace 검증, k6 결과 추출 | [관측과 부하 시험](#관측과-부하-시험) | [관측](../docs/runbooks/dev-observability.md), [dev 파이프라인 부하 시험](../docs/runbooks/dev-pipeline-loadtest.md) |
| 격리 perf 환경 입력과 정리 | [perf 환경](#perf-환경) | [환경 준비](../docs/runbooks/perf-environment.md), [예산과 정리](../docs/runbooks/perf-budget-cleanup.md) |
| 프론트 Terraform 검사, 대시보드, 호스트 수집기 | [프론트엔드](#프론트엔드) | [Terraform](../frontend/README.md), [대시보드](../frontend/observability/dashboards/README.md), [호스트 수집기](../frontend/observability/host-agent/README.md) |

## CDK와 배포 입력

| 파일 | 입력과 출력 | 호출처와 실행 영향 |
|---|---|---|
| [dev-cdk-pipeline.mjs](dev-cdk-pipeline.mjs) | `plan`, `verify`, `deploy`, `verify-publish`와 artifact 디렉터리 → 계획·배포·게시 검증 결과 | CLI · [PR](../.github/workflows/dev-cdk-pr.yml) 및 [배포 CI](../.github/workflows/dev-cdk-deploy.yml). AWS baseline 조회와 로컬 artifact 생성, `deploy`에서 CloudFormation 변경 |
| [dev-cdk-pipeline.cjs](dev-cdk-pipeline.cjs) | source SHA·baseline·Assembly·receipt → 단계별 검증과 배포 결과 | 모듈 · 위 CLI와 설정 게시기가 사용. AWS 호출 여부는 호출 단계에 따름 |
| [eks-values.mjs](eks-values.mjs) | CDK output·이미지 digest·runtime·profile·Strimzi metadata → Helm values YAML | CLI/모듈 · `npm run values:dev -- …`, 설정 게시기. 로컬 파일 생성. MSK 입력은 호환 경로 |
| [dev-generated-values-inputs.mjs](dev-generated-values-inputs.mjs) | 배포 stack·EKS·Secret metadata → 생성기 입력과 재검증 함수 | 모듈 · 설정 게시기와 Kafka 오프셋 workflow. AWS 조회·AssumeRole·SSM 연결·metadata-only 조회 |
| [generated-values-github.mjs](generated-values-github.mjs) | run·attempt·receipt artifact → 승인된 원본 증거 판정 | 모듈 · 설정 게시기의 GitHub API 조회 |
| [validate-generated-values.mjs](validate-generated-values.mjs) | 생성 YAML 13개·이미지·공식 입력 → hash와 렌더 검증 결과 | 모듈 · 설정 게시기가 호출. 고정 Helm 렌더, chart 준비에 따른 다운로드와 임시 파일 사용 |
| [backend-image-inputs.mjs](backend-image-inputs.mjs) | 이전 backend workflow 로그 → 네 ARM64 이미지 digest와 출처 | 모듈 · 이전 로그 기반 선택 구현. [회귀 테스트](../test/scripts/backend-image-inputs.test.ts)와 CI 변경 경로 필터에 남아 있음 |
| [eks-values-check-runtime.mjs](eks-values-check-runtime.mjs) | 고정 chart package·MSK fixture → runtime 렌더 검사 | 검증 · Helm·kubeconform으로 CSI, configtree, Fluent Bit 등 옛 fixture 계약 재현 |
| [validate-helm-workloads.mjs](validate-helm-workloads.mjs) | workload chart·fixture → 정상 및 오류 입력 렌더·셸 검사 | 검증 · [workload 차트](../helm/dev/workloads/README.md)의 로컬 Helm·kubeconform 회귀 |

## Argo CD와 GitOps

현재 dev 게시 계약은 schemaVersion 2다. 최초 root 연결은 PROJ-335, 이후 이미지 게시와 설정 게시는 PROJ-334의 Git 게시 경로를 사용한다.
Git 게시 결과, Argo sync 결과와 실제 기능 확인은 각 런북에서 확인한다.

| 파일 | 입력과 출력 | 호출처와 실행 영향 |
|---|---|---|
| [dev-argocd-applications.mjs](dev-argocd-applications.mjs) | 고정 source·values와 release inventory → Application 검토 JSON | CLI/모듈 · 수동 인계와 Application 생성 코드가 재사용. 로컬 검토 출력 |
| [dev-argocd-management.mjs](dev-argocd-management.mjs) | CMP digest·렌더된 manifest → Argo Helm values·관리 RBAC values | CLI/모듈 · 수동 인계 생성기가 재사용. 로컬 출력, CLI 기본값은 reconciliation 비활성 |
| [dev-argocd-handoff.mjs](dev-argocd-handoff.mjs) | 고정 H 입력·18개 렌더·CMP digest → child Application·관리 values·`pending` 보고서 | CLI · [수동 인계](../docs/runbooks/dev-argocd-operations.md). 실행 결과는 새 로컬 디렉터리 |
| [dev-argocd-prepare-charts.mjs](dev-argocd-prepare-charts.mjs) | 고정 archive·checksum·풀어 둔 chart → 일치 여부 | CLI · [배포 입력 CI](../.github/workflows/dev-deployment-inputs.yml)는 `--check`를 사용. `--write`는 지정 archive로 저장소의 chart 파일 갱신 |
| [dev-gitops/bootstrap.mjs](dev-gitops/bootstrap.mjs) | 실제 child 18개·values 13개·이미지 원본 증거 → 초기 snapshot과 root 선언 | CLI · [최초 연결](../docs/runbooks/dev-argocd-simple-auto-sync.md). 기본 로컬 생성, `--publish`는 검증 후 private Git 게시 |
| [dev-gitops/publish.mjs](dev-gitops/publish.mjs) | backend 성공 run의 후보와 provenance → 네 앱 digest·bundle·producer 갱신 | CLI · backend `promote_dev.yml`이 호출. 원본과 이미지 계약을 확인한 뒤 private Git 게시 |
| [dev-generated-values-sync.mjs](dev-generated-values-sync.mjs) | 승인 plan·deploy receipt·공식 profile/runtime·현재 네 이미지 → 새 values 13개 | CLI · [infra 배포 CI](../.github/workflows/dev-cdk-deploy.yml)가 `verify-publish` 이후 호출. AWS·metadata 읽기, 렌더 후 private Git 게시 |
| [dev-gitops/publication.mjs](dev-gitops/publication.mjs) | 현재 HEAD와 새 snapshot → values 및 Application 커밋·게시 결과 | 모듈 · bootstrap·이미지/설정 게시기. 두 커밋을 한 번 push하며 일반 게시에서 예상 HEAD 경합 시 최대 3회 시도 |
| [dev-gitops/simple-release.mjs](dev-gitops/simple-release.mjs) | values·이미지·고정 SHA → schemaVersion 2 desired·Application·snapshot | 모듈 · bootstrap·이미지/설정 게시기의 로컬 검증과 데이터 변환 |
| [dev-gitops/validate-render.mjs](dev-gitops/validate-render.mjs) | source와 생성 values·Application → 전체 렌더 검사 | 모듈 · 설정 게시기가 호출. native Helm 4와 고정 Strimzi CMP 경로 사용 |
| [dev-gitops/source-proof.mjs](dev-gitops/source-proof.mjs), [source-proof.py](dev-gitops/source-proof.py), [verify_image_contracts.py](dev-gitops/verify_image_contracts.py) | run·artifact·digest → 원본 bundle, ARM64 manifest와 이미지 내 계약 검증 | 모듈 및 내부 helper · bootstrap·이미지 게시기. GitHub·ECR/Docker 조회와 임시 파일·이미지 사용 |
| [dev-gitops/contract.mjs](dev-gitops/contract.mjs), [release.mjs](dev-gitops/release.mjs) | candidate·values·배포 참조 → 계약·hash·snapshot 변환 | 모듈 · 이전 PROJ-311 계약과 현행 게시의 공용 상수·검증·값 변환 |
| [dev-gitops/initialize.mjs](dev-gitops/initialize.mjs), [promote.mjs](dev-gitops/promote.mjs) | 이전 activation·후보 → 초기화 또는 관측 기반 승격·복구 | 이전 PROJ-311 CLI · [회귀 테스트](../test/dev-gitops). 이전 흐름은 private Git 쓰기·AWS/SSM 조회를 포함 |
| [dev-gitops/engine.mjs](dev-gitops/engine.mjs), [git-store.mjs](dev-gitops/git-store.mjs), [observer.mjs](dev-gitops/observer.mjs), [runtime.mjs](dev-gitops/runtime.mjs) | 이전 상태·backend 실행·Argo 관측 → 게시 또는 복구 판정 | 모듈 · 이전 PROJ-311 CLI와 회귀 테스트가 사용. 주입된 adapter가 Git·AWS/SSM·Argo에 접근 |

## Kafka와 데이터베이스

| 파일 | 입력과 출력 | 호출처와 실행 영향 |
|---|---|---|
| [strimzi-secret-metadata.mjs](strimzi-secret-metadata.mjs) | `main` 또는 `validation`·대상 파일 → TLS revision 계산용 metadata JSON | CLI · [Strimzi 런북](../docs/runbooks/dev-strimzi-kafka.md). 현재 kubectl context 조회와 로컬 파일 저장 |
| [strimzi-values.mjs](strimzi-values.mjs) | stage·output·metadata → Strimzi 배포 값 | 모듈 · values 생성기와 관리 작업의 로컬 변환 |
| [strimzi-operator-post-render.mjs](strimzi-operator-post-render.mjs) | stdin의 Helm manifest·환경 → 감시 namespace가 제한된 YAML | CLI · 수동 Helm과 CMP의 post-render. stdin/stdout으로 변환 |
| [dev-kafka-offsets.mjs](dev-kafka-offsets.mjs) | `plan`/`execute` 요청과 group·기준 시각 또는 partition/offset → 검토 결과 또는 적용된 offset | CLI · [수동 workflow](../.github/workflows/dev-kafka-offsets.yml)의 `validate`·`prepare`·`run`. AWS·metadata 조회 후 Kubernetes Job 생성, `execute`에서 Kafka committed offset 변경 |
| [client-tls.sh](../helm/dev/workloads/telemetry-kafka-admin/scripts/client-tls.sh), [topic-init.sh](../helm/dev/workloads/telemetry-kafka-admin/scripts/topic-init.sh), [offsets.sh](../helm/dev/workloads/telemetry-kafka-admin/scripts/offsets.sh) | TLS mount·Kafka 관리 입력 → client 설정, topic 대조·생성, offset 계획·반영 | 런타임 · [Kafka 관리 차트](../helm/dev/workloads/telemetry-kafka-admin)의 include 및 수동 Job. topic 생성과 offset 변경 가능 |
| [dev-db-tunnel.mjs](dev-db-tunnel.mjs) | DB 종류·프로필·배포 output, ClickHouse의 경우 EKS context → 로컬 접속 포트 | CLI · [DB 접속 런북](../docs/runbooks/dev-database-access.md). PostgreSQL·ClickHouse에 SSM 세션을 연다 |
| [dev-dashboard-read-grants.py](dev-dashboard-read-grants.py) | `prepare`/`verify`·DB 접속·역할 → catalog 결과와 검토용 SQL | CLI · [조회 권한 런북](../docs/runbooks/dev-dashboard-read-grants.md). DB catalog 읽기와 로컬 파일 생성 |
| [dev-clickhouse-capacity-guard.py](dev-clickhouse-capacity-guard.py) | 현재 이미지와 사전 증거 → 용량 변경 전 drift 판정 JSON | CLI · [ClickHouse 용량 런북](../docs/runbooks/dev-clickhouse-seed-capacity.md). Helm·Kubernetes 조회와 Pod 내 검사 |

## 관측과 부하 시험

Helm·이미지·로컬 smoke 검증의 상세 입력은 [관측 차트](../helm/observability/README.md)를 따른다. 증거 출력 경로가 필요한 도구는 별도 경로를 지정해 기존 증거를 보존한다.

| 파일 | 입력과 출력 | 호출처와 실행 영향 |
|---|---|---|
| [observability-prepare.mjs](observability-prepare.mjs) | 고정 chart lock·선택 archive → checksum 검증된 chart 의존성 | CLI · 로컬 chart 준비. 다운로드 또는 제공 archive를 사용해 chart 경로에 파일 기록 |
| [observability-validate.mjs](observability-validate.mjs), [lib/observability-logql.mjs](lib/observability-logql.mjs) | chart·Strimzi/MSK fixture·이미지 증거 → 렌더·규칙·대시보드 검사 | 검증과 LogQL 모듈 · 고정 `HELM_BIN`·`PROMTOOL_BIN`으로 로컬 검사 |
| [observability-platform-trace-validate.mjs](observability-platform-trace-validate.mjs) | 고정 chart·fixture → Loki·Tempo·Collector 렌더와 수신 정책 검사 | 검증 · [배포 입력 CI](../.github/workflows/dev-deployment-inputs.yml) 경로의 로컬 렌더 검사 |
| [observability-image-contract.py](observability-image-contract.py) | 관측·trace·loadtest 이미지 집합 → ARM64 manifest 증거 JSON | 검증 · Docker buildx로 registry OCI manifest 조회 |
| [observability-metric-filter-check.mjs](observability-metric-filter-check.mjs) | Fluent Bit envelope 표본과 metric pattern → 대조 결과 | 검증 · 기본 fixture 검사, `--aws`는 CloudWatch `TestMetricFilter` 조회와 증거 출력 |
| [observability-networkpolicy-probe.mjs](observability-networkpolicy-probe.mjs) | `--phase n2/n5`와 증거 경로 → 송신자 접근 결과 JSON | CLI · 현재 kubectl context에 probe Job을 만들고 정리. n2는 격리 namespace·정책도 사용. `--render-only`는 로컬 YAML |
| [observability-clickhouse-smoke.py](observability-clickhouse-smoke.py), [observability-fluent-bit-smoke.py](observability-fluent-bit-smoke.py), [observability-log-envelope-smoke.py](observability-log-envelope-smoke.py) | 고정 이미지·설정 → 로그·지표·envelope 증거 | 검증 · 로컬 Docker 시험. ClickHouse/Fluent Bit chart smoke는 Helm 렌더도 사용 |
| [observability-remote-write-smoke.py](observability-remote-write-smoke.py) | 출력 경로 → k6 remote write의 native histogram과 stale marker 증거 | 검증 · 격리 Docker 네트워크에서 k6와 Prometheus를 실행하고 정리 |
| [observability-loki-tempo-smoke.mjs](observability-loki-tempo-smoke.mjs), [observability-retention-smoke.mjs](observability-retention-smoke.mjs) | 고정 chart·증거 경로 → log/trace 왕복 또는 보존·재시작 결과 | 검증 · 로컬 Helm·Docker. [보존 검증](../docs/runbooks/observability-retention-validation.md)은 격리 저장소 정책 사용 |
| [observability-loki-capacity.mjs](observability-loki-capacity.mjs), [observability-fluent-bit-loki-harness.mjs](observability-fluent-bit-loki-harness.mjs), [lib/observability-load-judge.mjs](lib/observability-load-judge.mjs) | 부하·실패/복구 표본 → 용량 또는 병행 배송 판정 | 검증과 판정 모듈 · 로컬 Helm·Docker, 병행 배송은 CloudWatch 대역 사용 |
| [loadtest-results-export.mjs](loadtest-results-export.mjs), [lib/loadtest-queries.mjs](lib/loadtest-queries.mjs), [lib/loadtest-judge.mjs](lib/loadtest-judge.mjs) | Prometheus 구간·k6 summary·시나리오 → 원본 응답·판정·보고서 | CLI와 쿼리/판정 모듈 · Prometheus 조회와 로컬 결과 저장. `drain-plan`은 로컬 계산 |

## perf 환경

| 파일 | 입력과 출력 | 호출처와 실행 영향 |
|---|---|---|
| [perf-values.ts](perf-values.ts), [perf-provisional.ts](perf-provisional.ts), [perf-resolve.ts](perf-resolve.ts) | 환경 요청·stack output·profile·runtime·관측 입력 → Helm values와 provisional/resolved JSON | CLI · [환경 런북](../docs/runbooks/perf-environment.md)의 `tsx` 진입점. 준비 단계에 맞춰 로컬 산출물 생성 |
| [perf-execution-gate.ts](perf-execution-gate.ts), [perf-inventory.ts](perf-inventory.ts) | 환경 ID·수집된 비용/리소스 증거 → 실행 허용 또는 정리 잔존 판정 | CLI · [예산·정리 런북](../docs/runbooks/perf-budget-cleanup.md). 수집한 JSON을 로컬에서 검사 |
| [driver.py](../lib/perf/cleanup/driver.py), [kubernetes.py](../lib/perf/cleanup/kubernetes.py) | TTL·환경 ID·소유권 정보 → 정리 상태와 잔존 목록 | 런타임 · Guardrail의 Lambda 및 SSM payload. 승인된 perf 환경의 AWS/Kubernetes 리소스를 삭제할 수 있음 |

## 프론트엔드

| 파일 | 입력과 출력 | 호출처와 실행 영향 |
|---|---|---|
| [check.sh](../frontend/scripts/check.sh) | Terraform root와 fixture → fmt·validate·mock test 결과 | 검증 · [frontend CI](../.github/workflows/frontend-terraform-pr.yml). 로컬 provider 준비와 Python 검사 |
| [bootstrap-plan-digest.py](../frontend/scripts/bootstrap-plan-digest.py), [shared-peers.py](../frontend/scripts/shared-peers.py) | plan JSON → 정규화 hash, 기존 state·EC2 태그 → peer tfvars | CLI · frontend Terraform CI. peer 수집기는 EC2 조회와 로컬 파일 생성 |
| [dashboard-deploy-route.py](../frontend/scripts/dashboard-deploy-route.py), [deploy-dashboards.py](../frontend/scripts/deploy-dashboards.py), [dashboard-release.py](../frontend/scripts/dashboard-release.py) | 이벤트 diff·대시보드 bundle → 게시 순서·payload 검증·Grafana 반영 결과 | CLI와 SSM 런타임 · [대시보드 CI](../.github/workflows/frontend-dashboards.yml). `--deploy`에서 EC2를 확인하고 SSM으로 대상 파일·Grafana를 갱신 |
| [bootstrap.sh.tftpl](../frontend/modules/observability/bootstrap.sh.tftpl), [install.sh.tftpl](../frontend/observability/faro/install.sh.tftpl) | 관측 구성·볼륨 또는 Faro 설정 → EC2 스택 또는 수신기 기동 | 런타임 · Terraform EC2 user data·SSM 문서. 호스트 설정과 Compose 서비스 변경 |
| [start-ecs.sh](../frontend/observability/host-agent/start-ecs.sh), [cleanup-legacy.sh](../frontend/observability/host-agent/cleanup-legacy.sh) | 호스트 ID/AZ·Alloy 설정 또는 기존 Docker 상태 → 수집기 기동·옛 컨테이너 정리 | 런타임 · dev ECS task command와 전환 SSM 문서. 실행 위치의 컨테이너 상태 변경 |
| [install-dev.sh](../frontend/observability/host-agent/install-dev.sh) | OTLP endpoint·EC2 ID·Alloy 설정 → 호스트 수집기 | CLI · [수동 복구](../frontend/observability/host-agent/README.md). 대상 EC2의 파일과 소유 컨테이너 변경 |
| [deploy.sh.tftpl](../frontend/observability/host-agent/deploy.sh.tftpl) | 예전 설치기·Alloy 설정 → 설치 후 컨테이너 상태 확인 | 이전 SSM 설치 래퍼 · `test-host-agent.py`만 참조 |
| [test-bootstrap-plan.py](../frontend/scripts/test-bootstrap-plan.py), [test-shared-peers.py](../frontend/scripts/test-shared-peers.py), [test-dashboard-deploy-route.py](../frontend/scripts/test-dashboard-deploy-route.py), [test-dashboards.py](../frontend/scripts/test-dashboards.py) | plan·peer·이벤트·대시보드 fixture → 정책과 실패 처리 판정 | 검증 · Terraform/대시보드 CI의 로컬 회귀 |
| [test-host-agent.py](../frontend/scripts/test-host-agent.py), [test-observability.py](../frontend/scripts/test-observability.py), [test-faro.py](../frontend/scripts/test-faro.py) | 호스트 command·관측/브라우저 수집 설정 → 전환·OTLP·Faro 검증 | 검증 · [프론트 관측 CI](../.github/workflows/frontend-observability-check.yml). 호스트 명령은 테스트 대역, 관측/Faro는 격리 Docker |

## 빌드 및 호환 검증

| 파일 | 입력과 출력 | 호출처와 실행 영향 |
|---|---|---|
| [install-helm.mjs](../helm/dev/platform/argocd/cmp/install-helm.mjs), [render-strimzi.mjs](../helm/dev/platform/argocd/cmp/bin/render-strimzi.mjs) | 고정 Helm/아키텍처 또는 Strimzi release·values → Helm 바이너리 또는 manifest | 런타임 · [CMP](../helm/dev/platform/argocd/cmp/README.md)의 build·generate. 빌드 중 다운로드, 렌더 중 임시 파일과 stdout 사용 |
| [test-configtree.py](test-configtree.py), [test-oidc-config.py](test-oidc-config.py) | backend Spring 설정·파일/환경 fixture → 바인딩 검사 | 검증 · [EKS 로컬 검증](../docs/runbooks/dev-eks-local-validation.md). JVM·Gradle cache, OIDC는 values 생성기와 Helm 사용 |
| [test-blocked-certs.py](test-blocked-certs.py) | 로컬 ARM64 이미지·인증서 fixture → JVM 차단 목록 동작 검사 | 검증 · [EKS 수동 배포 런북](../docs/runbooks/dev-eks-manual-deployment.md). 로컬 Docker 사용 |
| [test-dev-clickhouse-capacity-guard.py](test-dev-clickhouse-capacity-guard.py), [test-dev-dashboard-read-grants.py](test-dev-dashboard-read-grants.py), [test-dev-dashboard-grant-guards.py](test-dev-dashboard-grant-guards.py) | DB/용량 검증 fixture → drift·권한·SQL 생성·거부 조건 회귀 결과 | 검증 · 용량 및 조회 권한 도구의 로컬 회귀 |
| [test-perf-cleanup.py](test-perf-cleanup.py) | AWS/Kubernetes 대역과 시간·소유권 fixture → 정리 제어 회귀 결과 | 검증 · perf 정리 런타임의 로컬 회귀 |

스크립트 추가·삭제나 호출 경로 변경 시 이 인덱스도 갱신한다. 삭제 후보는 CI·npm·import·Dockerfile·Terraform·Helm·수동 런북 순으로 참조를 대조한다.
