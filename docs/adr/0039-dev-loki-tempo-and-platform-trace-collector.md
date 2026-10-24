# 0039. dev EKS 관측에 Loki·Tempo·플랫폼 trace Collector를 독립 release로 더하고 CloudWatch 로그와 병행한다

## Status

Proposed (PROJ-256). 채택되면 [ADR-0037](0037-dev-observability-and-system-diagnostics.md)의
"별도 k6 인프라·Loki·Tempo·분산 tracing은 만들지 않는다" 중 Loki·Tempo·분산 tracing 부분을 대체한다.
0037의 나머지(관측 NodePool, Prometheus·Grafana, CloudWatch 로그 그룹·보존, Events·NodeDiagnostic)는 유효하다.
채택 전까지는 0037이 기준이다.

## Context

PROJ-191·255로 Prometheus 지표와 CloudWatch 로그를 Grafana 한 곳에서 본다. 그래도 요청 하나가
Gateway → Kafka → ingest → ClickHouse를 어떻게 지났는지는 이어 볼 수 없다.
CloudWatch Logs Insights는 조회마다 스캔 비용이 들고 trace와 오갈 수 없다.

backend는 플랫폼 처리 경로의 span을 만들기로 제안했다([백엔드 ADR 0069](https://github.com/soma-376/pulsemetry-backend/blob/develop/docs/adr/)).
endpoint·서비스 이름·sampling·속성은 backend와 infra가 함께 지키는 계약이다. 허브 계약 반영은 이번 작업에서 제외했다(2026-10-24 결정).
그때까지 이 ADR과 backend ADR 0069에 같은 값을 적는다.

현재 사실:

- 관측 NodePool은 ARM64 m7g.large, CPU 한도 4이고 `workload=observability:NoSchedule`이다(0037).
- Fluent Bit은 `application.*`·`observability.*`를 각각 CloudWatch 그룹으로 보낸다. tail DB·filesystem buffer를 쓴다.
- apps·ClickHouse 노드 SG에서 관측 SG로 들어오는 규칙이 없다. 관측 SG에서 나가는 규칙만 있다.
- 관측 차트의 Grafana datasource는 `prune: true`라 배열에서 빠진 datasource를 지운다.

## Decision

### 구성

- dev EKS 관측 namespace에 세 구성요소를 독립 Helm release로 더한다. 기존 `observability` release는 Grafana datasource·대시보드만 바뀐다.

| release | 구성 | 저장 | 초기 보존 |
|---|---|---|---|
| `loki` | grafana-community `loki` chart, `Monolithic` 1 replica | filesystem + gp3 PVC 20Gi | 로그 72h |
| `tempo` | grafana-community `tempo` chart(단일 바이너리), Tempo 3.x 1 replica | local backend + gp3 PVC 20Gi | trace 48h |
| `otel-platform` | open-telemetry `opentelemetry-collector` chart, `statefulset` 1 replica | 전송 queue용 PVC 1Gi | — |

- 세 chart는 infra의 wrapper chart가 감싼다. upstream chart 버전·archive checksum과 이미지 digest를 lock에 고정한다.
- upstream의 부가 구성요소는 끈다: MinIO·gateway·canary·cache·self-monitoring·test.
  렌더 결과에 남는 리소스 종류·자원 예산·PVC 보존을 검증기가 검사한다.
- values만으로 이 최소 구성을 안정적으로 표현하지 못하는 구성요소는 그 구성요소만 자체 chart로 바꾼다.
- Collector 이미지는 `file_storage`와 속성 처리기가 있는 배포판(contrib 또는 k8s)이다. core 배포판에는 둘 다 없다.
- 모두 ARM64, 관측 nodeSelector·toleration, 기존 `gp3-observability` StorageClass를 쓴다.
  PVC는 Helm 삭제·재설치로 지워지지 않도록 retain 정책을 명시한다.
- Loki WAL 복구 메모리(`ingester.wal.replay_memory_ceiling`)는 Pod memory limit의 절반 이하로 명시한다(1Gi에 512MB).
  기본 4GB로 두면 WAL이 쌓인 뒤 재시작할 때 복구 중 OOM이 날 수 있다. wrapper chart가 렌더 단계에서 강제한다.

### 고정 주소

| 연결 | 주소 |
|---|---|
| Grafana·Fluent Bit → Loki | `pulsemetry-loki.pulsemetry-observability.svc:3100` |
| Grafana → Tempo (조회) | `pulsemetry-tempo.pulsemetry-observability.svc:3200` |
| Collector → Tempo (OTLP/gRPC) | `pulsemetry-tempo.pulsemetry-observability.svc:4317` |
| 앱 → Collector (OTLP/HTTP) | `http://pulsemetry-otel-platform.pulsemetry-observability.svc:4318/v1/traces` |

- Service 이름은 `fullnameOverride`로 고정한다. 자동 생성 이름을 추측하지 않는다.
- public Ingress·ALB·NodePort를 만들지 않는다. 운영자는 기존 Grafana port-forward로만 본다.

### 로그

- 기존 Fluent Bit에 native `loki` output을 더한다. CloudWatch 두 output은 그대로 둔다.
- Loki stream label은 `environment`·`cluster`·`namespace`·`service_name`·`container`뿐이다.
  `service_name`은 Pod label `app.kubernetes.io/name`이다. Pod 이름·trace ID·사용자 ID는 label이 아니라 본문(JSON)에 둔다.
- Loki output은 노드당 filesystem queue 128MiB로 제한한다. 넘치면 Loki 쪽만 버리고 CloudWatch 배송은 계속한다.
- CloudWatch의 과거 로그는 Loki로 옮기지 않는다. Kubernetes Events·EKS control-plane·MSK broker 로그는 CloudWatch에만 남는다.

### trace

- backend 설정 계약(backend ADR 0069)을 chart values로 공급한다:
  `PULSEMETRY_TRACING_ENABLED`, `PULSEMETRY_TRACING_OTLP_TRACES_ENDPOINT`, `PULSEMETRY_TRACING_SAMPLE_PROBABILITY`(dev 0.1),
  `PULSEMETRY_TRACING_CLUSTER`, Downward API의 `POD_NAMESPACE`·`POD_NAME`. 대상은 Gateway·ingest뿐이다.
- Collector는 trace pipeline 하나만 연다: `memory_limiter → 속성 정리 → batch → otlp/tempo`.
  exporter queue는 `file_storage`로 PVC에 두고 재시도 시간을 유한하게 둔다.
- 플랫폼 자체 span만 저장한다. 고객이 보낸 OTLP payload와 trace는 Tempo로 복제하지 않는다.

### 통신

- NetworkStack이 cross-SG 규칙을 소유한다(0037). 다음 두 규칙만 더한다.
  - apps·ClickHouse 노드 SG → 관측 SG: Loki 3100 (각 노드의 Fluent Bit).
  - apps 노드 SG → 관측 SG: Collector 4318 (Gateway·ingest).
- ClusterIP는 인증 장벽이 아니다. NetworkPolicy 강제 여부를 dev에서 확인한다.
  강제되지 않으면 내부 접근 제한이 됐다고 보고하지 않고 SG 범위로만 설명한다.

### Grafana

- datasource 배열에 Loki(`pulsemetry-loki`)·Tempo(`pulsemetry-tempo`)를 더한다. 기존 Prometheus·CloudWatch UID와 기본값은 그대로다.
- Loki derived field(`trace_id=<32 hex>`) → Tempo, Tempo trace → logs(같은 service·namespace·시간 범위)로 왕복한다.

## Alternatives Considered

- **자체 최소 chart로 시작**: 구성요소를 통제하기 쉽다. 하지만 세 제품의 배포 템플릿을 직접 유지해야 한다.
  기존 lock·digest·ARM64·렌더 검증 체계를 넓히는 편이 싸서 upstream wrapper로 시작한다. 표현이 안 되는 구성요소만 전환한다.
- **CloudWatch만 유지**: trace와 왕복이 안 되고 조회 비용이 쿼리마다 든다. 기각한다.
- **S3 저장·HA**: dev 소량 운영에는 과하다. 저장량이 PVC 예산을 넘을 때 별도 결정으로 다룬다.
- **기존 업무용 MSK를 trace 수집에 쓰기**: 업무 경로와 장애가 섞인다. 기각한다.
- **prod ECS용 Collector 설정 재사용**: 수집 대상과 책임이 다르다. 기각한다.

## Consequences/Tradeoffs

### Positive

- Grafana에서 로그 검색과 trace waterfall을 오가며 처리 경로를 따라간다.
- CloudWatch 경보·metric filter·보존은 그대로라 기존 운영 증거를 잃지 않는다.

### Negative

- 관측 노드에 request 600m CPU·1280Mi memory, EBS 41Gi가 는다. 한 대에 들어가지 않으면 관측 노드가 늘어난다.
- Fluent Bit은 두 목적지에 보낸다. 프로세스·디스크를 공유하므로 Loki 장애가 CloudWatch 배송에 영향을 주는지 시험해야 한다.
- 단일 replica라 Loki·Tempo·Collector 재시작 중 수집 공백이 생긴다. retention은 디스크 상한이 아니다.
- 기존 앱 Pod는 trace 설정 env·annotation 변경으로 한 번 재생성된다.

## Follow-up

- 저장 증가량을 실측해 PVC·보존을 다시 정한다(70% 경고, 85% 위험).
- 허브 계약에 endpoint·서비스 이름·속성 허용목록을 옮긴다.
- NetworkPolicy 강제 여부를 확인하고, 불가하면 인증 proxy 같은 대안을 별도 결정으로 다룬다.

## Acceptance Criteria

- 새 로그가 CloudWatch와 Loki 양쪽에서 조회된다. 기존 CloudWatch 패널·경보는 그대로다.
- 합성 trace와 실제 Gateway → Kafka → ingest → ClickHouse trace가 Tempo에서 조회되고, 같은 요청의 로그와 왕복된다.
- Loki·Tempo·Collector 장애나 재시작이 앱 응답·Kafka ack·commit·CloudWatch 배송을 막지 않는다.

## References

- [Loki monolithic Helm](https://grafana.com/docs/loki/latest/setup/install/helm/install-monolithic/), [Loki 보존](https://grafana.com/docs/loki/latest/operations/storage/retention/)
- [Tempo 3.0](https://grafana.com/docs/tempo/latest/release-notes/v3-0/)
- [OpenTelemetry Collector 구성](https://opentelemetry.io/docs/collector/configuration/)
- [Fluent Bit Loki output](https://docs.fluentbit.io/manual/data-pipeline/outputs/loki)
