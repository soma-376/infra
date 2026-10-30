# perf Helm 구성

perf 전용 EKS(`soma-376-perf-eks`)에 설치하는 Kubernetes 선언이다. AWS 자원은 CDK `-c env=perf`가,
노드 생성·교체는 Auto Mode가, 아래 release는 Helm이 소유한다. runtime 인증서 입력이 있으면
ADR-0051의 HTTPS ALB·LBC·Gateway TGB를 추가한다. dashboard·사용자 JWT·OIDC는 설치하지 않는다. 배포·실행 절차는 [perf 환경 런북](../../docs/runbooks/perf-environment.md)을 따른다.

> Strimzi 설치와 v3 입력은 [현재 런북](../../docs/runbooks/perf-environment.md)을 먼저 따른다. 아래 MSK 설명은 v2 호환 경로이며 공개 경로의 실제 성공·실행 예산·24시간 정리 검증 완료를 뜻하지 않는다.

## values의 출처

| 입력 | 만드는 곳 | 내용 |
|---|---|---|
| `helm/perf/workloads/*.yaml` | 이 디렉터리(정적) | `environment: perf`, Service 형식, ingest 모드 |
| `generated/*.yaml` | `npx tsx scripts/perf-values.ts` | CDK output·프로필·요청 이미지·provider별 Kafka metadata/조회 결과의 참조. Secret 값 없음 |
| job values JSON | load-tests `perf job-values` | run 식별자·이미지·deadline·endpoint. chart가 이 환경 값과 대조한다 |

생성기 입력은 ready request, `describe-stacks` 결과, perf runtime YAML(telemetry JWT VersionId·kid·파일 맵,
`enrollmentReplicas`, `jvmGcSafepointLog`), `get-bootstrap-brokers`, 전체 `list-nodes` JSON이다.
request의 프로필 경로·SHA-256·`infra.parameters`·Secret 참조 이름이 배포 output과 다르면 생성하지 않는다.

## release와 설치 순서

| 순서 | release | namespace | chart | values |
|---|---|---|---|---|
| 1 | perf-platform | default | `platform/` | `generated/platform.yaml` |
| 2 | secrets-store-csi-driver | kube-system | csi driver 1.6.1 | `addons/csi-driver-values.yaml` |
| 3 | secrets-provider-aws | kube-system | ASCP 3.1.4 | `addons/ascp-values.yaml` |
| 4 | fluent-bit | pulsemetry-perf-logs | fluent-bit 0.58.3 | `addons/fluent-bit-values.yaml` |
| 5 | perf-runtime | pulsemetry-perf | `runtime/` | `generated/runtime.yaml` |
| 6 | observability | pulsemetry-observability | `../observability/pulsemetry-observability` | `../observability/values-perf.yaml`, `generated/observability.yaml` |
| 7 | clickhouse | pulsemetry-perf | `../dev/workloads/clickhouse` | `workloads/clickhouse.yaml`, `generated/clickhouse.yaml` |
| 8 | enrollment-api | pulsemetry-perf | `../dev/workloads/spring-app` | `workloads/enrollment-api.yaml`, `generated/enrollment-api.yaml` |
| 9 | telemetry-kafka-admin | pulsemetry-perf | `../dev/workloads/telemetry-kafka-admin` | `workloads/telemetry-kafka-admin.yaml`, `generated/telemetry-kafka-admin.yaml` |
| 10 | telemetry-ingest | pulsemetry-perf | `../dev/workloads/spring-app` | `workloads/telemetry-ingest.yaml`, `generated/telemetry-ingest.yaml` |
| 11 | telemetry-gateway | pulsemetry-perf | `../dev/workloads/spring-app` | `workloads/telemetry-gateway.yaml`, `generated/telemetry-gateway.yaml` |
| 12 | perf-job-access | pulsemetry-perf | `job-access/` | 없음 |

CSI·ASCP·Fluent Bit chart archive와 SHA256은 [`helm/dev/runtime/versions.json`](../dev/runtime/versions.json)과 같다.
CH `/ping` → enrollment 기동·Flyway → topic 관리 Job → Consumer(DDL 소유자) → Gateway 순서는 PLAN §4.3 5단계다.

공유 workload chart(`helm/dev/workloads/*`)는 `environment: perf`일 때만 perf namespace·NodePool·ClusterIP·
perf Kafka 이름을 쓴다. Gateway만 선택적 NodePort/TGB를 지원하며 내부 Service 주소는 같다. 기본값 dev의 렌더 결과는 바꾸지 않는다(ADR-0050).

## NodePool

pool마다 NodeClass(`perf-<pool>`, 공통 노드 SG + pool SG)와 고정 용량 NodePool(`replicas` = 프로필 노드 수,
`limits.nodes` = +1)을 둔다. 측정·관측 pool은 `workload=<pool>:NoSchedule` taint를, system pool은 taint 없이
준비 도구·enrollment·CSI를 받는다. 모든 pool의 disruption budget은 `nodes: "0"`이다. drift 교체를 막지만
만료·강제 interruption·수동 삭제·static scale은 막지 못하므로 run 전 NodeClaim 만료 여유를 확인한다(PLAN §4.1).

## Job template

`jobs/`는 seed·prepare·smoke·sentinel·runner·verify Job 하나를 `job` 값으로 고른다. 입력 키는 telemetry-load-tests
`docs/contracts/perf-jobs.md`(perf Job 계약)의 job values다. Job 이름·환경 변수·볼륨·권한은 그 문서와 같은 변경 묶음으로 바꾼다.
chart는 namespace·cluster·environment·endpoint·evidence 경로·이미지 저장소·JWT kid를 `generated/jobs.yaml`과
대조해 다르면 렌더링하지 않는다. Job은 덮어쓰지 않도록 `kubectl create`로 만든다.

```bash
helm template "k6-${RUN_ID}" helm/perf/jobs --namespace pulsemetry-perf-runner \
  -f "$RUN_DIR/generated/jobs.yaml" -f "$RUN_DIR/job-values.json" --set job=runner | kubectl create -f -
```

- seed·prepare는 CSI 파일(`/mnt/secrets/PGUSER` 등)을 셸에서 읽어 계약의 환경 변수로 넘긴다. Kubernetes Secret 복제는 없다.
- runner는 generator pool에만, 나머지는 system pool에 간다. k6 REST API는 `127.0.0.1:6565`로 Pod 안에만 연다.
- lock ConfigMap은 chart가 만들지 않는다. 운영자의 `perf lock`이 만든다.
