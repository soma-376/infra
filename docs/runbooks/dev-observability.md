# dev EKS 관측·시스템 장애 진단 (PROJ-191)

이 문서는 dev Strimzi 경로의 관측 적용·검증 절차와 확인된 배포 증거를 구분해 관리한다.
[ADR-0037](../adr/0037-dev-observability-and-system-diagnostics.md),
[ADR-0049](../adr/0049-dev-strimzi-kafka-and-staged-msk-retirement.md), [Strimzi 런북](dev-strimzi-kafka.md),
[기존 EKS 런북](dev-eks-manual-deployment.md), [관측 차트 안내](../../helm/observability/README.md)를 함께 따른다.
전제는 JWT/Gateway/Kafka·mTLS와 내부 management 9404를 구현한 Backend 이미지다.
Grafana는 운영자 localhost port-forward로 접속하며 public ALB/Ingress를 추가하지 않는다.

## 확인된 기준선과 남은 완료 검증

2026-10-29 [PROJ-285](https://team376.atlassian.net/browse/PROJ-285)의 실제 검증에서 Strimzi target 7개,
main Gateway ACK→Kafka record→consume/commit→ClickHouse, sampled trace·양 앱 Loki 로그 연결,
30분 안정화 및 의도한 TLS 실패 경보 발생·해제와 broker 로그 배송을 확인했다.
MSK active scrape·전용 경보 제거 후 최종 추적 profile은 [infra #85](https://github.com/soma-376/infra/pull/85),
배포는 [CD #40877081590](https://github.com/soma-376/infra/actions/runs/40877081590)에 연결된다.
철거 후 두 요청은 unsampled이므로 trace 연결 증거는 앞선 sampled 요청을 사용한다.

[PROJ-255](https://team376.atlassian.net/browse/PROJ-255)·[PROJ-256](https://team376.atlassian.net/browse/PROJ-256)의
2026-10-26 HTTP/k6·Loki·Tempo·장애 격리·PVC 복구 증거도 해당 범위에서 재사용한다.
아래 절차를 처음부터 재실행하지 말고 현재 source SHA·image digest·Helm revision과 기준선의 차이를 먼저 확인한다.
Strimzi 전환 증거와 별도로 최신 lag 수집 판정, Grafana 패널 전수·실제 Kafka 로그↔trace UI 왕복,
Gateway·ingest 각각의 N5 허용 대조, Loki 72h·Tempo 48h 만료 삭제를 확인해야 세 티켓의 완료를 판정할 수 있다.
이번 완료 작업의 새 검증 결과는 실행 시각·배포 revision·판정·한계를 포함해 각 티켓에 추가한다.
이 절은 새 실행의 성공을 미리 선언하지 않으며 ADR-0039의 `Proposed` 상태도 바꾸지 않는다.

## 적용 순서와 입력

1. 기존 EKS 런북의 CDK diff를 검토한다. EKS 관측 SG, Grafana Secret/Pod Identity, 로그 그룹, 진단 S3,
   Strimzi metrics 접근이 의도한 범위인지 확인한다. 기존 Kafka broker/PVC·ClickHouse data PVC를 교체하지 않는다.
   이미 적용된 SG·로그 그룹은 검증을 위해 다시 생성하지 않으며 필요한 차이만 배포한다.
2. 추적 deployment profile/runtime과 실제 CDK output의 `KafkaProvider=strimzi`·stage·topic/group을 대조한다.
   [Strimzi 런북](dev-strimzi-kafka.md)에 따라 Secret 값 없이 UID/resourceVersion metadata를 조회해
   `--strimzi-secrets` 입력으로 사용한다. 현재 dev 생성에 `--msk-bootstrap`·`--msk-nodes`를 전달하지 않는다.
   MSK 호환 경로의 전체 broker 조회 검증은 기존 EKS 런북 §2-2에 보존한다.
3. `generated/base.yaml`로 platform release를 먼저 갱신한다. `pulsemetry-observability` namespace,
   `gp3-observability` StorageClass, 전용 NodeClass/NodePool이 생성된다. 전용 노드는 ARM64 m7g.large,
   CPU 한도 4, `workload=observability:NoSchedule`이다. 노드와 PVC가 다른 AZ에 묶이지 않았는지 확인한다.
4. 고정 CSI/ASCP release에 이 브랜치 values를 적용한다. 둘 다 관측 taint를 허용해야 Grafana가
   `grafana-admin` SPC 파일을 읽을 수 있다. 원본 암호는 서버 측에서 생성하며 values나 Kubernetes Secret에 복사하지 않는다.
5. Backend 새 digest로 Gateway/ingest를 기존 static values → generated values 순서로 갱신한다.
   ClickHouse에는 generated values의 `observability.enabled=true`를 적용한다. ConfigMap checksum으로
   StatefulSet이 교체되므로 dev 단일 replica의 짧은 중단을 예상하고 data PVC 유지부터 확인한다.
6. Fluent Bit release를 static runtime values → `generated/fluent-bit.yaml` 순서로 갱신한다.
   관측 차트는 [차트 안내](../../helm/observability/README.md)의 고정 dependency와
   `generated/observability.yaml`로 설치한다. Events collector는 그 차트의 단일 replica만 실행한다.
7. Pod/PVC 준비, target UP, 로그 전달, 비밀 권한을 확인한 뒤 부하 baseline을 기록한다.

추가 generated output은 `global.pulsemetry`(환경·EKS/Kafka 클러스터·공급자·로그 그룹·topic/group·Secret ARN)와
upstream ServiceMonitor의 cluster/environment relabeling이다. 배포 output을 수동 문자열로 대체하지 않는다.
별도 k6 인프라는 이번 범위에 없으며 새 환경을 만들 때 같은 관측 차트 입력·대시보드를 재사용한다.

**생성기는 관측을 항상 켠다.** 관측 output(`ObservabilityNodeSecurityGroupId`·`GrafanaAdminSecretArn`·로그 그룹 등)과
공급자별 입력이 없으면 values를 만들지 않는다. Strimzi는 Secret metadata, MSK 호환 경로만 `--msk-nodes`를 요구한다.
필요한 CDK output을 제공하는 배포가 생성기보다 먼저다. opt-in은 두지 않는다.
Fluent Bit envelope·관측 로그 그룹도 같은 CDK output에 의존하므로 생성기만 opt-in으로 바꿔도 관측 이전 output을
지원할 수 없기 때문이다. 9404가 없는 관측 이전 Backend 이미지는 `MANAGEMENT_SERVER_PORT`를 무시하고 그대로 동작한다.
이때 Gateway/ingest target은 down·미수집으로 남고 `GatewayMetricsUnavailable`·`PipelineMetricsUnavailable`이 울린다.
이 상태를 관측 정상으로 기록하지 않는다.

**GC/safepoint 로그.** runtime-values에 `jvmGcSafepointLog: true`를 넣으면 생성기가 Gateway·ingest에만
`JDK_JAVA_OPTIONS=-Xlog:gc,safepoint:stderr:utctime,level,tags`를 넣는다(옵션 문자열은 Backend 인계값, chart 고정).
생략하면 끈다. calibration부터 비교 시험이 끝날 때까지 값을 바꾸지 않고 실행 기록에 runtime-values를 남긴다.
기동 시 stderr 첫 줄이 `NOTE: Picked up JDK_JAVA_OPTIONS: ...`인지로 적용을 확인한다. 출력 형식은 Backend
`docs/telemetry-observability.md`를 따른다(tags 칸 공백 패딩 포함).
safepoint 줄은 부하에 비례해 늘어나므로 dev 상시 운영에서는 켜지 않는다. `JDK_JAVA_OPTIONS`·`JAVA_TOOL_OPTIONS`를
`env`로 직접 넣으면 chart가 거부한다.

2026-10-22 runtime 검증 중 CSI driver **같은 1.6.1 버전**의 기존 SHA256
`a3f9f5098cc1285f41c707a4de9bf06e27617ab792bef92c60ddc299f842dab0`가 현재 공식 archive와 불일치했다.
[공식 index](https://kubernetes-sigs.github.io/secrets-store-csi-driver/charts/index.yaml)와
[공식 tgz](https://kubernetes-sigs.github.io/secrets-store-csi-driver/charts/secrets-store-csi-driver-1.6.1.tgz)를
각각 조회하여 둘 다 `d312041d5334a1e5b0b9fe602a5cdcc1bfe028e0e9a4a8b3a14a24236497e1b6`임을 확인하고
`versions.json`의 핀을 교정했다. archive의 chart/appVersion은 1.6.1이다. 구 archive 원본은 확보하지 못해
이전 핀의 provenance와 재패키징 여부는 확인하지 못했다. 버전 업그레이드나 실제 배포가 아니다.

## 데이터 경로와 확인

| 대상 | 수집 경로 | 첫 확인 |
|---|---|---|
| Gateway/ingest | ClusterIP `*-metrics:9404/actuator/prometheus` | scrape UP, `environment`·`cluster`·`service` label, business port에서 actuator 접근 차단 |
| ClickHouse | `clickhouse-metrics:9363/metrics` | native metrics/events/async/errors 노출, 기존 8123 health/적재 정상 |
| Strimzi Kafka | broker JMX 3개·Kafka exporter 1개(9404), Cluster Operator 1개(8080), Topic/User Operator 각 1개(8080/8081), 10초 scrape | 7 target UP, ISR/min ISR/offline·TLS 실패·commit 기준 lag·CA 만료/갱신 지표 |
| Kubernetes | kubelet/cAdvisor·kube-state-metrics·node-exporter | 앱/CH/관측/Kafka 노드 전부 관측, broker Pod·PVC 3개와 restart/termination reason 지표 |
| 앱/CH 로그 | Fluent Bit → `/eks/dev/application` | 원문 `log`와 `kubernetes.*` metadata 동시 존재 |
| 관측 스택/Fluent Bit 로그 | Fluent Bit → `/eks/dev/observability` | 관측 taint 노드에서도 전송 |
| Kubernetes Events | 단일 collector → `/eks/dev/events` | 새 Warning 이벤트 수집 및 collector 재시작 후 이어받기 |
| Kafka broker·Entity Operator 로그 | Fluent Bit → `/eks/dev/application` 및 Loki | `pulsemetry-dev`의 broker·operator Pod별 최신 로그. Cluster Operator의 `strimzi-system` 로그 수집 여부는 별도로 확인 |
| EKS control plane | EKS → `/aws/eks/<cluster>/cluster` | 기존 5종 export 상태 확인 |

Grafana CloudWatch datasource는 Pod Identity로 허용된 그룹을 읽는다. 앱 로그의 최상위 필드는
`environment`, `cluster`, `kubernetes`, `stream`, `log`, `time`(CRI 원래 시각), `_p`(CRI 분할 표시)다.
`kubernetes`에는 `namespace_name`·`pod_name`·`pod_id`·`container_name`·`host`·`labels`·`docker_id`·`container_hash`·`container_image`가 있다.
annotation은 보내지 않는다. 구성요소는 `kubernetes.labels.app.kubernetes.io/name`으로 구분한다.
별도 `component`/`node` 최상위 필드나 request correlation ID를 기대하지 않는다. CRI가 나눈 줄은 결합되지만
`_p`는 첫 조각 값(`P`)으로 남으므로 분할 여부 판정에 쓰지 않는다. 필드 목록은 실제 Fluent Bit 5.1.3 출력
[envelope 증거](../../helm/observability/tests/fluent-bit/envelope-evidence.json)에서 확인했다(Kubernetes metadata는 Lua로 재현).
예를 들어 ClickHouse 종료 전후는 앱 로그 그룹에서 다음 Logs Insights query로 확인한다.

```text
fields @timestamp, kubernetes.pod_name, kubernetes.host, stream, log
| filter kubernetes.container_name = "clickhouse"
| sort @timestamp desc
| limit 200
```

Kafka는 앱 로그 그룹 또는 Loki에서 `pulsemetry-dev`·broker Pod로 시간 범위를 좁힌다. 서비스 재시작·
컨트롤러 선출·스토리지 오류를 broker별 JMX UP·Pod/PVC·ISR과 대조하고 Operator reconciliation·Kubernetes Events를 확인한다.
INFO 수준을 유지하며 부하 측정 중 DEBUG/TRACE를 켜지 않는다. 과거 MSK 전용 로그 그룹은 현행 로그 도착 경로가 아니다.

## 수집 상태와 빈 패널 읽기 (PROJ-255)

`수집 경로와 k6` 첫 행의 표가 구성요소별 상태를 보인다. 값은 `pulsemetry:collection_state` rule이다.

| 상태 | 의미 | 다음 조치 |
|---|---|---|
| 정상 | 기대 target이 모두 UP | 패널이 비면 패널 설명의 원인 후보(지표 미적용·필터 불일치·표본 부족)를 본다. 이벤트 없음은 원천 지표를 직접 확인한 뒤에만 판단한다 |
| 일부 실패 | 일부 target down, Strimzi broker JMX는 기대 3개 중 일부만 UP | 해당 target의 `lastError`와 성공률 확인 |
| 전체 실패 | target은 있으나 모두 down | Service·port·NetworkPolicy·SG 확인 |
| 대상 없음 | target 자체가 없음 | workload 배포·`metrics.enabled`·ServiceMonitor label 확인 |
| 최근 수신 없음 | k6 표본이 최근 5분에 없음 | 실행 여부·remote-write 경로 확인 |

- 앱 패널의 `값 없음 · 첫 화면 수집 상태 확인`은 위 표에서 구성요소가 정상인지 먼저 보라는 뜻이다.
  target UP은 scrape 성공만 뜻한다. 특정 지표 누락·label 필터 불일치·rate 창의 표본 부족은 UP이어도 빈 패널을 만든다.
- Pipeline 맨 위 `현재 ingest 모드`가 `http`면 Kafka 소비 패널(Consumer·lag·commit)은 해당 없음이다.
  모드는 telemetry-ingest Pod annotation `pulsemetry.io/ingest-mode`를 ServiceMonitor가 `ingest_mode` label로 옮긴 값이다.
  이 annotation을 처음 적용하면 ingest Pod가 한 번 재생성된다.
- Strimzi exporter UP만으로 main topic/group의 lag가 수집된다고 판단하지 않는다. committed offset이 없는 partition,
  누락된 lag 시계열, exporter 오류를 실제 backlog 0과 구분한다. consumer fetch position도 committed offset을 대신하지 않는다.
- `확인된 commit 기준 lag`는 `pulsemetry:kafka_committed_lag:sum`이며 offset·lag가 모두 유효하고 exporter가 UP인
  partition만 합산한다. 옆 `미커밋 partition 수`(`pulsemetry:kafka_uncommitted_partitions:count`)가 0보다 크면
  lag는 전체 backlog가 아닌 확인된 부분합이다. 모두 미커밋이거나 group 미생성·수집 실패이면 lag는 빈 값이다.
  미커밋 수에는 아직 메시지를 받지 않은 partition도 포함되므로 이를 backlog 건수로 읽지 않는다.

**과거 MSK 진단(현행 Strimzi에 적용하지 않음).** MSK JMX(11001)는 10초 간격에서 HTTP 429로 broker별 표본 약 1/3을 거부했다(2026-10-23). 60초로 늘린 뒤에도
  성공률이 1 미만이면 JMX 패널 값은 마지막 성공 표본이다. MSK node exporter는 `node_memory_*`·`node_network_*`를 내지 않아
  메모리·수신량은 CloudWatch `MemoryUsed`·`MemoryFree`·`BytesInPerSec`으로 본다. offline partition은 CloudWatch 값이 기준이다.

### k6 지표 확인

앱 노드 SG에서 관측 SG의 Prometheus 9090으로 가는 규칙이 없으므로 클러스터 안 k6는 remote-write에 닿지 않는다.
운영자 PC에서 Prometheus를 port-forward하고 [관측 차트 안내](../../helm/observability/README.md#k6-연결과-로컬-검증)의 명령으로
짧고 낮은 부하를 보낸다.

```bash
kubectl -n pulsemetry-observability port-forward svc/pulsemetry-monitoring-prometheus 9090:9090
```

실행 뒤 수집 경로와 k6에서 testid와 실행 구간을 골라 요청량·native histogram p95를 본다.

## PROJ-255 live 적용 순서

이미 검증한 단계를 재사용하고 남은 차이만 적용한다. 변경 단위마다 diff와 이전 revision·digest를 남긴다.

1. **기준선**: Helm list/values/manifest, Pod imageID, PVC UID·PV·volume ID, target health, Grafana datasource UID를
   접근 제한된 실행 디렉터리에 저장한다. telemetry JWT Secret 값 등록 여부와 ALB 대상·`ingestMode`도 기록한다.
2. **Grafana 로그 권한(G1)**: DevEksStack diff가 Grafana 역할 정책의 control-plane ARN 변경뿐인지 확인한 뒤 배포한다.
   System Diagnostics의 EKS control-plane 로그가 AccessDenied 없이 조회되는지 본다.
3. **ClickHouse exporter(G3)**: `observability.enabled=true`로 갱신한다. 단일 replica가 재시작하므로 data PVC 유지와
   8123 health·기존 데이터 조회를 먼저 확인한다.
4. **Gateway·ingest(G2)**: 검증한 digest와 generated values로 갱신한다. 9404 target UP과 무트래픽 gauge·counter를 확인한다.
5. **Fluent Bit(G4)**: static → generated 순서로 갱신한다. 새 로그에 원문 `log`와 `kubernetes.*`가 함께 있는지,
   관측 로그 그룹에 stream이 생기는지 본다. tail DB 첫 도입의 재전송 구간을 기록한다.
6. **관측 차트(G5·G7)**: Strimzi 대시보드·rule·PodMonitor를 반영한다. MSK active scrape·전용 rule이 없는지 확인하고
   30분 이상 JMX 3개·exporter·Operator target, ISR·lag·오류·Pod/PVC 자원을 기록한다.
7. **소량 E2E·k6(G6)**: 내부 Gateway 소량 요청의 publish ACK·소비·commit·ClickHouse 저장을 따로 대조하고 k6 smoke를 보낸다.
8. **전수 재점검(G8)**: 기준선 패널마다 이전·이후 상태와 남은 조치를 남긴다.

## PROJ-256 Loki·Tempo·플랫폼 trace 적용 (ADR-0039, Proposed)

각 단계에 필요한 PROJ-255 선행 항목을 실제 기준선과 대조한다. 이미 적용·검증된 Loki·Tempo·Collector와 HTTP 관측을
재사용하며 전체 PROJ-255의 재수행을 전제하지 않는다. 각 변경은 diff를 보고 하나씩 적용하며 이전 revision·digest를 기록한다.

| 단계 | 적용 | 확인 |
|---|---|---|
| 1 | DevNetworkStack diff → 배포(apps·ClickHouse → 관측 3100, apps → 관측 4318만 추가) | 다른 SG 변경 없음 |
| 2 | 관측 NodePool 여유 확인. 세 release request 합계 600m·1280Mi, PVC 41Gi | 한 노드에 안 들어가면 노드가 늘어난다. 비용·AZ를 기록 |
| 3 | NetworkPolicy 기준선(N0)과 controller 활성화(N1, 아래) | ConfigMap 하나만 는다. 10분간 nodeclaim 그대로·Drifted 없음 |
| 4 | 강제 여부 시험(N2, 아래) | deny-all에서 `TIMEOUT`·server 70초 Ready, label 허용 client만 `OPEN` |
| 5 | `loki` → `tempo` → `otel-platform` 순서로 설치(아래 명령, 수신 정책 포함) | PVC Bound·Pod Ready·고정 digest·NetworkPolicy 3개 |
| 6 | 관측 차트 upgrade(datasource 4개·Traces 대시보드·ServiceMonitor·rule) | Grafana Recreate 뒤 로그인·기존 Prometheus/CloudWatch, Loki·Tempo health |
| 7 | Fluent Bit: 정적 values → `fluent-bit-loki-values.yaml` → generated | 새 로그가 CloudWatch와 Loki 양쪽에 보인다 |
| 8 | 허용·차단 대조(N5, 아래). 9단계 뒤 다시 실행 | 비허용 송신자는 SG가 여는 경로에서도 `TIMEOUT`, 허용 대조는 성공 |
| 9 | tracing 이미지(backend ADR 0069) digest와 runtime-values `platformTracing: {enabled: true, sampleProbability: 1}`로 Gateway·ingest 갱신 | 소량 요청의 trace·Kafka commit·ClickHouse 저장 대조. 실패 span은 `status = error`로 찾힌다 |
| 10 | `sampleProbability`를 생략(0.1)해 다시 갱신하고 30분 관찰 | export 오류·queue·OOM·PVC 증가 없음 |

```bash
node scripts/observability-prepare.mjs
for release in loki tempo otel-platform; do
  helm upgrade --install "$release" "helm/observability/$release" -n pulsemetry-observability --wait --timeout 10m
done
```

세 release는 계정·클러스터별 값이 없어 generated values 없이 설치한다. `--atomic`이나 실패 시 자동 제거에 기대지 않는다.
PVC는 Retain이라 uninstall·rollback으로 지워지지 않는다.

- 주소: Loki `pulsemetry-loki.pulsemetry-observability.svc:3100`, Tempo 조회 `:3200`·수신 `:4317`, Collector `pulsemetry-otel-platform.pulsemetry-observability.svc:4318/v1/traces`.
- Loki label은 `environment, cluster, namespace, service_name, container`다. Pod는 `| json | kubernetes_pod_name=~"..."`로 좁힌다.
  app label이 없는 Pod는 `service_name` 없이 `container`로 찾는다.
- Loki 도입 전 로그·Kubernetes Events·EKS control-plane은 CloudWatch 경로를 유지한다. 과거 MSK broker 로그를 Loki로 옮기지 않는다.
  현재 Strimzi broker의 container 로그는 앱 로그 배송 경로로 CloudWatch·Loki 양쪽에서 확인한다.
- trace는 sampling(기본 10%)과 보존(48h) 때문에 없을 수 있다. trace 부재만으로 처리 실패를 판단하지 않는다.
- Loki 수신 상한은 `ingestion_rate_mb: 2`·`ingestion_burst_size_mb: 4`·limit 1Gi다. 이전 8MB/s 상한에서는 초당 약 5MB 지속 수신에 1분 안에 OOM이 났다.
  [용량 증거](../../helm/observability/tests/loki-tempo/capacity-verification.json)(로컬 Docker, Loki CPU 1·memory 1Gi, 대표 로그 label 조합 8개 stream):
  30분 1.9MiB/s에서 anon 표본 최대 limit의 39%·기울기 평탄, 5.5MiB/s 10분 제공에서 수락 2.0MiB/s(부하 시간 기준)·OOM 없음,
  burst 경계대로 수락·거절, 상한보다 큰 588MiB 수락 뒤 SIGKILL 복구 21초·수락 줄 전부 재조회. dev 앱 로그는 7일 평균 0.1KB/s다.
- 상한을 넘으면 Loki가 429를 낸다. Fluent Bit은 Loki 출력만 재시도하며 쌓고, 출력별 버퍼 상한(128M)을 넘은 chunk는 버린다.
  CloudWatch 출력은 영향을 받지 않는다([병행 배송 증거](../../helm/observability/tests/loki-tempo/fluent-bit-parallel-verification.json),
  Fluent Bit 3개·각 CPU 200m·256Mi, CloudWatch는 로컬 대역).
  - 합쳐 약 4MB/s로 60초를 쓰면 대역은 전부 받았고, Loki는 98%를 받았다. 나머지 약 2%는 Fluent Bit이 버렸고 drop 지표와 정확히 맞았다.
  - Loki를 120초 멈춘 뒤 되살리면 재시도로 전부 도착했다. Loki의 로그는 폭주 때 손실될 수 있고 CloudWatch가 기준이다.
  - Fluent Bit chunk는 보통 약 2MB지만 엄격한 상한이 아니다. burst(4MiB)보다 큰 요청은 받지 않으므로 drop·`rate_limited` 지표로 본다.
  - Docker 시험은 k8s 스케줄링·EBS·노드 간 네트워크를 재현하지 않는다. 실제 CloudWatch 배송은 live에서 확인한다.
  로그 폭주 때는 `loki_discarded_samples_total{reason="rate_limited"}`·Loki 메모리·재시작을 먼저 본다.

### 수신 NetworkPolicy (ADR-0039)

세 서비스의 **수신만** 제한한다. 허용 송신자는 아래 표가 전부다. 송신 정책은 없다.

| 대상 | 포트 | 허용 송신자 |
|---|---|---|
| Loki | 3100 | Fluent Bit(`pulsemetry-dev-logs`), Grafana, Prometheus |
| Loki | 모든 포트 | Loki(자기 자신) |
| Tempo | 4317 | Collector |
| Tempo | 3200 | Grafana, Prometheus |
| Tempo | 모든 포트 | Tempo(자기 자신) |
| Collector | 4318 | telemetry-gateway·telemetry-ingest(`pulsemetry-dev`) |
| Collector | 8888 | Prometheus |

2026-10-25 조회 당시 dev NodeClass 셋은 `networkPolicy: DefaultAllow`였다.
Strimzi 전환 후에는 Kafka 풀을 포함해 현행 NodeClass를 다시 조회한다. 정책 검증을 위해 NodeClass를 바꾸지 않는다(노드 교체).

**N0 기준선**

```bash
kubectl get networkpolicy -A
kubectl get crd policyendpoints.networking.k8s.aws --ignore-not-found -o name
kubectl -n kube-system get configmap amazon-vpc-cni --ignore-not-found -o name
kubectl get nodeclasses.eks.amazonaws.com -o custom-columns=NAME:.metadata.name,NETPOL:.spec.networkPolicy,LOG:.spec.networkPolicyEventLogs
kubectl get nodeclaims -o custom-columns=NAME:.metadata.name,CREATED:.metadata.creationTimestamp,DRIFTED:'.status.conditions[?(@.type=="Drifted")].status'
```

CRD 조회가 **종료 코드 0이며 출력이 없으면** `PolicyEndpoint CRD 미설치`로 기록하고 해당 리소스 조회는 생략한다.
CRD 이름이 출력된 경우에만 다음 명령으로 현재 PolicyEndpoint를 기록한다.

```bash
kubectl get policyendpoints.networking.k8s.aws -A
```

`amazon-vpc-cni` ConfigMap의 종료 코드 0·빈 출력은 최초 설치 전 기준선이다. 이름이 나오면 기존 설정과 소유자를 확인한다.
기존 controller가 활성화돼 있으면 N1을 재실행하지 않고 현행 정책·PolicyEndpoint를 검증한다.
각 조회의 `Forbidden`·연결 실패·timeout 등 **0이 아닌 종료 코드는 미설치로 취급하지 않고 중단한다.**

**N1 controller 활성화.** platform release(`pulsemetry-dev-platform`, `kube-system`)의 현재 manifest와 새 렌더를 비교해
`amazon-vpc-cni` ConfigMap 하나만 느는지 확인하고 승인받은 뒤 같은 values로 upgrade한다. 적용 뒤 10분간 위 nodeclaim 이름·생성 시각이
그대로이고 Drifted가 없어야 한다. **노드 교체 징후가 보이면 즉시 멈추고 보고한다.**

**N2 강제 여부.** 일회용 namespace `pulsemetry-np-probe`에서 정책 전후를 비교한다. 서버는 Deployment, client는 Job이다.
AWS는 controller가 없는 독립 Pod의 정책 적용이 불안정할 수 있다고 안내한다([고려사항](https://docs.aws.amazon.com/eks/latest/userguide/cni-network-policy.html)).

```bash
node scripts/observability-networkpolicy-probe.mjs --phase n2 --output <새 증거 파일>
```

스크립트 순서와 통과 기준:
1. controller ConfigMap이 켜져 있고 `pulsemetry-np-probe` 조회가 NotFound여야 시작한다. 조회 오류는 "없음"으로 보지 않고 멈춘다.
   namespace는 `kubectl create`가 성공했을 때만 이 실행이 만든 것으로 기록하고, 그것만 지운다.
2. 정책 전 label 없는 client가 `OPEN`이어야 한다.
3. deny-all을 건 뒤 label 없는 client가 120초 안에 `TIMEOUT`으로 바뀌어야 한다. 고정 대기로 판단하지 않고 5초마다 다시 본다.
4. `TIMEOUT`을 확인한 뒤(정책이 강제되는 동안) server를 시작 시각 기준 5초 간격으로 70초 동안 관찰한다. 판정은 표본 개수가 아니라
   실제 관찰 구간(70초 이상)과 최대 표본 간격(10초 이하)이다. 모든 표본이 Ready이고 restart가 늘지 않아야 한다(kubelet probe 통과).
5. label 허용 정책을 더하면 허용 client는 120초 안에 `OPEN`, label 없는 client는 계속 `TIMEOUT`이어야 한다.
6. 끝나면 `pulsemetry-np-probe` namespace만 지운다.

- 결과는 `OPEN`·`TIMEOUT`·`REFUSED`·`DNS_FAIL`·`TOOL_ERROR`·`JOB_FAILED`로 나뉜다. VPC CNI 정책은 패킷을 버리므로 차단은 `TIMEOUT`이다.
  `REFUSED`·`DNS_FAIL` 등은 차단 성공으로 세지 않는다.
- 3에서 `TIMEOUT`이 되지 않으면 **강제되지 않는 것이다.** 멈추고 "Pod 단위 접근 제한 없음(SG 범위만)"으로 보고한다. 대안은 다시 정한다.
- 4에서 NotReady가 되면 증거의 events·probe 실패 원인을 본다. **kubelet probe가 막혔을 수 있다.** 멈춘다.
  노드와 Pod가 같은 subnet을 쓰므로 노드 대역 ipBlock 허용은 정책을 무력화한다 — 그렇게 우회하지 않는다.

**N5 허용·차단 대조(5~7단계 뒤, 운영 정책을 지우지 않는다).**

```bash
node scripts/observability-networkpolicy-probe.mjs --phase n5 --output <새 증거 파일>
```

SG는 apps → 관측을 3100·4318만 연다. 관측 노드끼리는 모두 열려 있다. 그래서 apps 풀 송신자의 Tempo 3200·4317·Collector 8888 실패는
SG만으로도 생기므로 정책 증거가 아니다. 관측 풀(toleration 포함)의 송신자가 그 포트들의 정책 차단을 입증한다.

| 대상 | 허용 송신자 대조 | 비허용 송신자(label `app.kubernetes.io/name=np-probe-stranger`) |
|---|---|---|
| Loki 3100 | Grafana·Prometheus 포트 연결, Fluent Bit Loki 출력 처리량 | apps 풀(`pulsemetry-dev`, `pulsemetry-dev-logs`)·관측 풀 |
| Tempo 3200 | Grafana·Prometheus 포트 연결 | 관측 풀 |
| Tempo 4317 | Collector의 Tempo 전송 span(동작) | 관측 풀 |
| Collector 4318 | Gateway·ingest trace가 Tempo에서 검색됨(동작) | apps 풀·관측 풀 |
| Collector 8888 | Prometheus 포트 연결 | 관측 풀 |

- 사전조건: 세 NetworkPolicy, 그 정책을 가리키는 PolicyEndpoints, 대상 Pod Ready, 대상 Service port = container port.
  하나라도 어긋나면 모든 결과가 `INCONCLUSIVE`다.
- 판정: 비허용 송신자가 `TIMEOUT`이면서 SG가 그 경로를 열고, 같은 목적지·포트의 허용 대조가 성공했을 때만 `BLOCKED_BY_POLICY`다.
  SG가 막는 경로는 `SG_ALSO_BLOCKS`로 남기고, 그 밖의 실패는 `INCONCLUSIVE`다. `OPEN`은 `NOT_BLOCKED`이며 실패다.
- 포트 연결 대조와 동작 대조를 따로 기록한다. 동작 대조가 0이면 통신량이 없는 것이라 `PENDING`이다(trace를 켜기 전 4317·4318).
  9단계(tracing) 뒤에 n5를 다시 돌려 `PENDING`을 닫는다.
- 허용 송신자는 하나하나 성공해야 한다. 같은 목적지에 다른 송신자가 닿았다고 대신하지 않는다(예: Grafana → Loki가 막히면 FAIL).
- 증거에는 송신자의 namespace·label·노드 풀, 목적지·포트, 기대·실제 결과와 판정이 남는다. 시험 Job은 이 실행의 run label로만 지운다.
- `NOT_BLOCKED`가 나오면 정책·selector를 고치기 전에는 내부 접근이 제한됐다고 보고하지 않는다.

**동작 확인(N4, 5~10단계에 걸쳐).** Prometheus에서 `up{job=~"loki|tempo|otel-platform"}`이 모두 1이고, Fluent Bit Loki 출력의
`fluentbit_output_errors_total`·`fluentbit_output_retries_failed_total`이 늘지 않으며 Loki 수신 줄 수가 는다.
Grafana의 Loki·Tempo datasource health가 OK다. 이것은 포트 시험이 아니라 실제 로그·trace 전송 확인이다.

복구는 단계 역순이다.
0. NetworkPolicy: 먼저 세 release를 `--set ingressPolicy.enabled=false`로 upgrade하고 `kubectl get networkpolicy,policyendpoints -n pulsemetry-observability`가
   비었는지 본다. 그다음 platform release를 `--set networkPolicyController.enabled=false`로 upgrade한다. 정책을 남긴 채 controller만 끄지 않는다.
1. trace 문제: runtime-values의 `platformTracing`을 지우고 생성기·앱을 다시 적용한다(앱은 Tracer NOOP으로 돌아간다). Kafka payload·offset·모드는 바꾸지 않는다.
2. Loki 출력 문제: Fluent Bit을 overlay 없이 정적 → generated로 다시 적용한다. CloudWatch·tail DB·buffer는 그대로다.
3. Grafana: 이전 관측 chart revision으로 되돌리면 `prune`이 Loki·Tempo datasource를 지운다. 대시보드 링크를 확인한다.
4. 세 release를 내려도 PVC·데이터를 지우지 않는다. Tempo major downgrade(3→2)는 in-place rollback이 아니다.
5. 송신이 멈춘 것을 확인한 뒤 SG 규칙을 정리한다.

로컬 검증: `HELM_BIN=... node scripts/observability-platform-trace-validate.mjs`(렌더·digest·보존·예산·실패 입력),
`HELM_BIN=... node scripts/observability-loki-tempo-smoke.mjs --output <새 파일>`
(chart memory limit 아래 고정 이미지 왕복·예외 내용 삭제·Loki SIGKILL 뒤 WAL 복구·Collector queue·Tempo 재시작, [증거](../../helm/observability/tests/loki-tempo/local-verification.json)).
smoke는 Fluent Bit 병행 배송·Grafana UI 클릭·실제 앱 요청·NetworkPolicy 강제를 확인하지 않는다. 증거 파일의 `coverage`가 범위다.

보존 만료는 [격리 보존 검증](observability-retention-validation.md)을 함께 수행한다. dev의 Loki 72h·Tempo 48h
설정·override·삭제 작업 상태와 기존 만료 데이터 조회 결과를 별도로 기록한다. Tempo 3.1은 scheduler뿐 아니라
실제 삭제 worker의 `block_retention`도 48h여야 한다. 결과의 범위는 **dev 설정·상태 확인 및 동일 버전 격리 환경의 자동 삭제 검증**으로 명시한다.
수신 상한·장시간 메모리·burst·WAL 복구 부하는 `HELM_BIN=... node scripts/observability-loki-capacity.mjs --output <새 파일>`(약 50분),
Fluent Bit 병행 배송은 `HELM_BIN=... node scripts/observability-fluent-bit-loki-harness.mjs --output <새 파일>`(CloudWatch는 로컬 대역)이 맡는다.

## 로그 손실 경계와 회귀 검증

ClickHouse 24.8은 information 수준 JSON console 로그를 명시하며 file/error file 로그를 제거한다.
`kubectl logs -n pulsemetry-dev clickhouse-0`와 CloudWatch에서 같은 서버 시작·오류 메시지를 확인한다.
OOM/SIGKILL에는 마지막 로그가 없을 수 있다. `kubectl describe pod`, 이전 container 종료 사유, Events와
`kube_pod_container_status_last_terminated_reason`을 함께 본다. 노드가 소실되기 전 전송된 로그만 보존된다.

Fluent Bit은 `/var/log/fluent-bit-state/tail.db`와 같은 hostPath의 filesystem buffer를 사용한다.
이는 같은 노드의 Pod 교체에서 offset을 유지한다.

**tail DB 첫 전환의 중복 재전송.** 이 설정을 처음 적용하면 노드마다 tail DB가 비어 있고 `Read_From_Head On`이라
노드에 남은 대상 namespace 컨테이너의 현재 로그 파일을 처음부터 다시 보낸다. 범위는 컨테이너당 현재 파일
하나(kubelet `containerLogMaxSize`, 기본 10MiB)다. 회전된 파일은 `/var/log/containers` 대상이 아니다.
이전 설정이 이미 보낸 줄이 다시 들어가고 CRI parser가 원래 시각을 유지하므로 **과거 시각의** 로그·metric filter
집계가 중복된다. 실패 event 경보 중 영향을 받는 것은 threshold 50인 `gateway-rejected`의 적용 직전 5분 평가 구간뿐이다.
나머지 네 종은 threshold 1이라 원래 경보가 이미 울린 구간이다. 적용 직후 다음을 실행 기록에 남긴다.

```text
# 앱 로그 그룹, 시간 범위는 적용 2시간 전 ~ 적용 후 30분. <apply_ms>는 Fluent Bit 적용 시작 UTC epoch ms
fields @timestamp, @ingestionTime, kubernetes.host
| filter @ingestionTime >= <apply_ms> and @timestamp < <apply_ms>
| stats count(*) as replayed, min(@timestamp) as from, max(@timestamp) as to by kubernetes.host
```

노드별 `from`~`to`가 중복 가능 구간이다. 그 구간의 Logs Insights 결과와 `Pulsemetry/Dev/Telemetry` 지표는
중복을 포함한다고 표시하고 성능 판정 증거로 쓰지 않는다. 기간 안에 `gateway-rejected` 경보가 울렸다면 재전송 여부를 먼저 확인한다.
DB를 지우거나 hostPath를 바꾸면 같은 재전송이 다시 일어난다. 같은 노드의 Pod 재시작은 DB offset에서 이어 읽는다.

output queue는 앱 512MiB·관측 128MiB로 제한하며
가득 차면 가장 오래된 해당 output chunk가 버려질 수 있다. `Retry_Limit False`도 무한 저장 보장이 아니다.
DB/WAL, filesystem chunk 메타데이터와 rewrite emitter가 추가 공간을 쓰므로 **hostPath 전체 1GiB hard quota가 아니다**.
Kubernetes ephemeral-storage limit는 이 hostPath 전체를 제한하지 않는다. 노드 디스크 여유, queue backlog,
retry/drop 지표와 Fluent Bit 자체 로그를 함께 경보로 본다. 수집기 장애 시 부하 결과의 로그 공백을 기록한다.

CRI/docker multiline parser는 런타임 분할 레코드를 결합한다. Java stacktrace 의미 단위의 전체 결합까지
보장하지 않는다. 물리 라인 Buffer_Max_Size는 256KiB이며 긴 줄은 Skip_Long_Lines로 건너뛴다.
종료·회전된 파일의 발견 간격은 5초다. node-local buffer는 노드 종료, 로컬 디스크 손상과 재생성에서 사라진다.

기존 경보의 `"event=<code>"` filter 문구를 유지한다. JSON envelope의 `log`에도 원문이 그대로 있으므로
동일 term이 남아야 한다. 입력 샘플은 실제 Fluent Bit 5.1.3이 runtime 설정으로 만든 envelope 10건이다
([metric-filter-samples.jsonl](../../helm/observability/tests/fluent-bit/metric-filter-samples.jsonl)).
실패 event 5종, CRI 분할 줄, 경보 대상이 아닌 `telemetry_transient_failure`·시작·GC stderr·ClickHouse JSON을 담는다.
로컬 테스트는 부분 문자열 대조만 하며 CloudWatch filter engine을 실행하지 않는다.

**배포 전 관문.** 읽기 전용 `TestMetricFilter`로 5개 filter가 각각 기대 샘플만 일치하는지 확인한다.
하나라도 다르면 Fluent Bit 적용을 멈춘다. 결과 파일은 덮어쓰지 않으며 실행 기록에 경로를 남긴다.
응답은 `eventMessage`로 샘플에 대응시킨다. `eventNumber`가 0과 1 중 어디서 시작하는지는 AWS 문서 예시(0)로만
알고 있어서, 결과 파일의 `awsEventNumbers`에 원본 번호를 남겨 첫 실행에서 확인한다.

```bash
# 샘플은 합성 로그이며 비밀·payload가 없다. logs:TestMetricFilter 권한만 쓴다.
node scripts/observability-metric-filter-check.mjs --aws --region ap-northeast-2 \
  --output "$RUN_DIR/metric-filter-check.json"
# 샘플을 다시 만들 때(Fluent Bit·values 변경 시)
python3 scripts/observability-log-envelope-smoke.py
```

실부하 전에는 수집기 재시작/일시 전송 실패 후
배송 재개, 긴 stacktrace, ClickHouse 오류, Pod 재시작 이벤트를 검증한다. 원인 확인 없이 OOM이나 노드 손실을
강제로 유발하지 않는다. 테스트가 끝나도 lag가 0인지 뿐 아니라 마지막 committed offset·처리 결과를 확인한다.
Strimzi lag는 exporter의 main topic/group·partition과 committed offset 조건을 함께 확인하며 미존재를 0으로 채우지 않는다.

## Auto Mode 노드 진단

Auto Mode 노드의 SSH/SSM 접속을 전제하지 않는다. node monitoring agent/NodeDiagnostic CRD가 있는지
`kubectl get crd nodediagnostics.eks.amazonaws.com`으로 확인한다. `DiagnosticsBucketName` output의
private S3는 SSE-S3, 14일 수명이며 운영자 role에 `nodes/*` PutObject/GetObject만 있다. 해당 role을
실제로 assume한 AWS credential을 사용한다. kubeconfig의 `--role-arn`만 설정한 것은 로컬 SDK credential 전환이 아니다.

Python3+boto3가 있는 운영 환경에서 짧은 PUT URL을 생성한다. 아래 코드는 URL을 터미널에 출력하지 않고
권한 0600 임시 manifest에 저장한다. `DIAGNOSTIC_NODE`에는 `kubectl get nodes`에서 확인한 정확한 이름을 넣는다.

```bash
export DIAGNOSTICS_BUCKET='<DiagnosticsBucketName output>'
export DIAGNOSTIC_NODE='<node name>'
export DIAGNOSTIC_KEY="nodes/$DIAGNOSTIC_NODE/$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
export DIAGNOSTIC_MANIFEST="$RUN_DIR/nodediagnostic.json"
python3 - <<'PY'
import json, os
import boto3
from botocore.config import Config
url = boto3.client('s3', region_name=os.environ['AWS_REGION'], config=Config(signature_version='s3v4')).generate_presigned_url(
    'put_object', Params={'Bucket': os.environ['DIAGNOSTICS_BUCKET'], 'Key': os.environ['DIAGNOSTIC_KEY']},
    ExpiresIn=900, HttpMethod='PUT')
doc = {'apiVersion': 'eks.amazonaws.com/v1alpha1', 'kind': 'NodeDiagnostic',
       'metadata': {'name': os.environ['DIAGNOSTIC_NODE']}, 'spec': {'logCapture': {'destination': url}}}
fd = os.open(os.environ['DIAGNOSTIC_MANIFEST'], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
os.fchmod(fd, 0o600)
with os.fdopen(fd, 'w') as out:
    json.dump(doc, out)
PY
kubectl create -f "$DIAGNOSTIC_MANIFEST"
kubectl get nodediagnostic "$DIAGNOSTIC_NODE" -o jsonpath='{.status}'
# Success/SuccessWithErrors를 확인한 뒤 다운로드한다. 후자는 일부 로그가 빠질 수 있다.
aws s3api get-object --bucket "$DIAGNOSTICS_BUCKET" --key "$DIAGNOSTIC_KEY" "$RUN_DIR/node-diagnostic.tar.gz"
kubectl delete nodediagnostic "$DIAGNOSTIC_NODE"
rm "$DIAGNOSTIC_MANIFEST"
```

같은 이름의 진단이 이미 있으면 기존 상태와 산출물을 먼저 확인한다. 실패 시 URL 만료·역할·네트워크를 확인하고
새 URL로 재시도한다. presigned URL은 민감한 임시 credential이므로 manifest/CR 전체를 공유하지 않는다.
완전히 죽거나 이미 교체된 노드의 로컬 증거 복구는 보장하지 않는다. S3 bundle은 접근 제한된 사고 기록으로 취급한다.

## 복구와 배포 후 수락 조건

Grafana/Prometheus 장애는 앱 실행 경로를 차단하지 않아야 한다. 앱 metrics/로그 변경을 되돌릴 때에는 이전
image digest와 Helm revision으로 복구하고 CH data PVC, 관측 PVC, Secret과 로그 그룹을 삭제하지 않는다.
Grafana 비밀번호는 persistent DB 초기화와 회전이 다른 절차이므로 차트 안내를 따른다.

**배포 기준선 실측.** 다음 두 값은 실제 endpoint에서 측정한다. 과거 측정값을 현재 버전·부하의 결과로 재사용하지 않는다.

```text
# 1) 노드 data volume 경보 대상. 노드마다 쓰기 가능 device가 하나 이상 보여야 한다(Bottlerocket은 /local 등).
count by (instance, device, mountpoint, fstype) (
  node_filesystem_size_bytes{job="node-exporter"}
    unless on (instance, device, mountpoint) (node_filesystem_readonly{job="node-exporter"} == 1))
# 2) Strimzi exporter/Operator scrape 비용. 성능시험은 1시간 이상 부하 구간을 포함한다.
max by (job) (max_over_time(scrape_duration_seconds{job=~"strimzi-.*"}[1h]))
max by (job) (max_over_time(scrape_samples_scraped{job=~"strimzi-.*"}[1h]))
```

1)이 비어 있으면 `NodeDataDiskSpaceLow`가 울릴 수 없다. node-exporter의 mount/fs-type 제외 설정을 먼저 고친다.
2)의 duration이 Strimzi scrape timeout 5초의 절반을 넘으면 응답 크기·원인을 확인한 뒤 주기 조정을 검토한다.
`sample_limit`·`body_size_limit`을 도입할 때는 실측 최대값에 여유를 둔다. 응답 크기는 관측 경로에서
broker/exporter `:9404/metrics`와 Operator endpoint를 조회해 bytes를 기록한다.

부하 전 기준선에는 chart/image 버전, 시간대, target 100% UP, broker 3대, Pod/노드 자원, PVC 여유,
현재 lag/처리량과 Logs Insights 조회를 남긴다. 부하 후에는 수집 공백·drop, 처리량·지연·오류·backlog,
재시작/종료 사유와 시스템 로그를 같은 구간으로 대조한다. k6 요청 성공은 최종 ClickHouse 적재 성공과 별도로 해석한다.

## 근거

- 현행 [Strimzi 관측 계약과 고정 버전 근거](../../helm/observability/README.md#dev-strimzi-관측-adr-0049--proj-283), [실제 전환 검증 PROJ-285](https://team376.atlassian.net/browse/PROJ-285)
- 과거 MSK 진단: [Open Monitoring](https://docs.aws.amazon.com/msk/latest/developerguide/prometheus-metrics.html), [lag 조건](https://docs.aws.amazon.com/msk/latest/developerguide/consumer-lag.html), [broker logging](https://docs.aws.amazon.com/msk/latest/developerguide/msk-logging.html)
- [Fluent Bit tail](https://docs.fluentbit.io/manual/data-pipeline/inputs/tail), [buffer/storage 제한](https://docs.fluentbit.io/manual/administration/buffering-and-storage)
- [EKS NodeDiagnostic](https://docs.aws.amazon.com/eks/latest/userguide/auto-get-logs.html)
