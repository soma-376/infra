# dev Application 검토와 수동 인계

`catalog.json`은 기존 release 17개와 신규 cert-manager를 합친 18개 관리 단위를 정의한다. 기존 release의
실제 이름과 namespace는 운영 inventory를 입력하며 예시로 대체하지 않는다. 신규 항목만 `id`, `releaseName`,
`namespace`를 `cert-manager`로 고정하고 `installation: new`를 명시한다. 수동 `telemetry-kafka-admin`과
Argo 자체는 카탈로그 밖이다. generated values 13개 목록은 유지한다.

## 검토 출력

`scripts/dev-argocd-applications.mjs --input <JSON> --output-dir <새 디렉터리>`는
`application-review.json`만 만든다. Kubernetes 적용용 manifest가 아닌 검토 보고서다. 모든 정의는
`skip-reconcile=true`, 자동 sync·self-heal·prune·allowEmpty 비활성이다. 기존 생성기에 활성화 우회 옵션은 없다.
검토 readiness는 항상 `blocked`, 배포 가능한 Application 수는 0이다.

- 공통 입력: `schemaVersion: 1`, `mode`, `infraRevision`(lowercase full SHA), 18개 `inventory`.
- `mode: handoff`: `handoffRevision` H만 받는다. B/V와 root/P를 만들지 않는다.
- `mode: gitops`: `valuesRevision` V와 `bundleManifestSha256` B를 받는다. 입력값 자체가 생산 run·manifest
  검증 성공을 증명하지 않는다. root도 중지된 template로만 포함한다.

`dev-argocd-management.mjs`의 기존 CLI도 검토용이며 `cluster.inClusterEnabled=false`를 유지한다.

## 적용용 수동 인계 출력

[ADR 0058](../../../docs/adr/0058-dev-lbc-cert-manager-and-argocd-handoff.md)의 별도 진입점을 사용한다.

```bash
node scripts/dev-argocd-handoff.mjs \
  --input /path/to/handoff-input.json \
  --rendered-manifests /path/to/render-directory \
  --cmp-image 'registry.example/strimzi-cmp@sha256:<검증한 64자리 digest>' \
  --output-dir /path/to/new-handoff-directory
```

입력은 `mode: handoff`의 고정 C/H·inventory다. 렌더 디렉터리에 같은 입력의 `input.json`과 catalog ID별
`<id>.yaml` 18개를 둔다. 실제 이름과 고정 C의 정적 values 뒤에 H의 generated를 넣어 렌더하고 Strimzi만
고정 CMP 경로를 쓴다. 생성기는 외부 checkout·조회·게시·적용을 하지 않는다. 같은 입력이라는 로컬 대조와
실제 Git SHA·운영 inventory 확인은 별도이며 운영자가 둘 다 검증한다.

출력은 `applications/<id>.yaml` 18개, `argocd-values.yaml`, `management-values.yaml`,
`handoff-report.json`이다. 기존 출력은 덮어쓰지 않는다. Secret 원문·입력 렌더 원문은 출력에 복제하지 않는다. 렌더 입력의 Secret data는 비인증 관측 빈 scrape 설정의 정확한 이름/빈 배열
예외만 허용하며 인증값·MSK 설정은 거부한다.
적용용 Application은 검토용 중지 annotation만 제거하고 자동 sync·self-heal·prune·allowEmpty와 삭제
finalizer는 계속 비활성이다. 보고서의 운영 수락은 `pending`이다. H에서는 root·bundle·desired·delivery-state를 만들지 않는다.

관리 chart 적용 전 같은 cert-manager 렌더의 Namespace 하나를 먼저 준비한다. 이 namespace는 이후
cert-manager Application이 추적하며 base/management가 중복 소유하지 않는다. 관리 출력은 in-cluster 활성화와 `config: {}`의 연결 Secret을 함께 준비하며 기존 ServiceAccount token/CA를
사용한다. bootstrap·검토 기본값은 유지한다. Git reader 원문을 CMP에 공급하지 않는다.

## 렌더·상태·수동 순서

LBC의 `enableCertManager=true` 경로는 Certificate/Issuer만 선언하고 TLS Secret은 cert-manager가 만든다.
LBC와 cert-manager의 정확한 webhook에서 cainjector 소유 `caBundle`만 차이 처리한다. 기존 LBC는 일반
인계와 분리해 TLS Secret 보존 전환·root/leaf 갱신·CA 주입·실제 serving TLS를 검증한다.

native Helm Application은 테스트 Pod/Job을 제외한다. CRD 소유 Application에는 `ServerSideApply=true`를
두고 `Replace`·`Force`는 사용하지 않는다. admission과 cert-manager startup API check hook은 유지하며
phase·RBAC·재실행·정리 정책을 확인한다. 실제 CRD 소유권과 필드 충돌은 별도 수락한다.

`health/application.lua`는 현재 spec·comparedTo·revision·Synced·Healthy·operation을 대조한다.
Kafka health는 Kafka/Topic/User의 현재 generation Ready를 요구한다. cert-manager Certificate/Issuer도
현재 generation Ready와 발급 상태를 검사하며 오래된 Ready를 통과시키지 않는다. 이 상태 검사는 실제
webhook TLS·Flyway·수집 기능 검증을 대체하지 않는다.

H에는 root가 없으므로 wave만으로 순서를 강제하지 않는다. base → cert-manager 준비 → LBC 및 기존
platform/runtime/data/관측 의존성 → enrollment → ingest → Gateway → dashboard 순서로 수동 sync하고
각 단계의 실제 증거를 남긴다. Git 연결·CMP 게시·PROJ-279 writer 종료·첫 sync·기능 검증과 후속 자동화는
[운영 런북 §2](../../../docs/runbooks/dev-argocd-operations.md#2-최초-설치와-기존-helm-리소스-인계)를 따른다.
