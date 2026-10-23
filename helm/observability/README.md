# PROJ-191 관측 차트

Gateway HTTP ACK부터 MSK·Pipeline·ClickHouse 적재까지 같은 UTC 구간으로 진단한다. 애플리케이션 분산
trace를 구성하는 작업은 아니다. 운영 적용 순서와 로그/노드 진단은
[dev 관측 런북](../../docs/runbooks/dev-observability.md)을 따른다. 이 디렉터리의 로컬 검증 결과는 AWS 배포 완료를 뜻하지 않는다.

## 고정 구성과 수명

`pulsemetry-observability` namespace의 독립 Helm release다. 의존성은
[dependencies.lock.json](dependencies.lock.json)의 kube-prometheus-stack 81.2.2 archive SHA256으로 고정한다.
Prometheus 3.9.1, Grafana 12.3.1, operator 0.88.0, kube-state-metrics 2.18.0, node-exporter 1.10.2,
Fluent Bit 5.1.3을 사용한다. [ARM64 증거](tests/fixtures/arm64-images.json)는 공식 OCI index의 8개 이미지
ARM64 manifest 확인이며 실제 EKS 기동 검증과 구분한다. k6는 1.8.2를 사용한다.
8개 이미지는 values에서 tag와 그 multi-arch index digest를 함께 고정한다(runtime Fluent Bit DaemonSet 포함).
`observability-validate.mjs`가 렌더된 모든 컨테이너·config-reloader 이미지의 digest를 증거 파일과 대조한다.
버전을 바꿀 때는 `observability-image-contract.py`로 새 증거를 만들고 values의 digest를 함께 바꾼다.

- Prometheus: 단일 replica, scrape/evaluation 10초, 보존 7일 또는 블록 20GB 중 먼저 도달한 조건,
  PVC 30Gi. WAL/head는 블록 크기 제한 외 공간을 쓰므로 PVC 여유 경보도 확인한다.
- Grafana: 단일 replica, SQLite 포함 PVC 5Gi, Prometheus·CloudWatch datasource와 대시보드 파일 provision.
- Kubernetes Events: 단일 replica/Recreate, 이벤트 중복 제거 DB와 전송 spool용 PVC 1Gi.
  CloudWatch output queue 제한 256MiB, events 조회 보존 1시간. 수집기 중단·API 이벤트 만료·노드 장애에서 무손실은 보장하지 않는다.
- 전용 ARM64 observability 노드에 operator/Grafana/Prometheus/KSM/Events를 둔다. node-exporter는
  앱·ClickHouse·관측 노드의 taint를 허용하는 DaemonSet이다. 서비스는 모두 ClusterIP다.
- `gp3-observability` StorageClass와 PVC는 보존한다. Helm uninstall/rollback이 데이터 삭제 절차가 아니다.
  Alertmanager와 외부 알림 채널은 포함하지 않는다. 규칙 상태는 Prometheus/Grafana에서 확인한다.

## 재현과 설치

먼저 기존 platform, CSI/ASCP, Fluent Bit과 metrics가 켜진 Gateway/ingest/ClickHouse를 준비한다.
생성기의 `--msk-nodes` 입력은 실제 `list-nodes` 전체 결과여야 한다. bootstrap DNS만으로 3개 broker를 추정하지 않는다.
`generated/observability.yaml`에는 CDK의 cluster/region/log groups/Secret ARN/topic/group, 실제 broker DNS 3개,
upstream ServiceMonitor의 cluster/environment relabeling을 넣는다. 비밀 원문은 values에 없다.

```bash
node scripts/observability-prepare.mjs
# 네트워크 없는 검증은 위와 같은 SHA256의 archive를 --archive <tgz>로 공급한다.
HELM_BIN=/path/to/helm PROMTOOL_BIN=/path/to/promtool \
  KUBECONFORM_BIN=/path/to/kubeconform node scripts/observability-validate.mjs

# 검토 후 적용 단계에서만 실행한다. --create-namespace로 platform 선행 단계를 생략하지 않는다.
helm upgrade --install observability helm/observability/pulsemetry-observability \
  --namespace pulsemetry-observability \
  -f helm/observability/values-dev.yaml -f "$RUN_DIR/generated/observability.yaml" \
  --wait --timeout 10m
```

Helm 3.18.6과 promtool 3.9.1로 검증한다. 첫 설치는 의존 chart CRD를 Helm이 설치한다. 기존 설치의
Prometheus Operator CRD 업데이트는 자동 upgrade되지 않으므로 pinned chart CRD diff를 먼저 검토한다.
업그레이드에서 CRD를 무조건 삭제/재생성하지 않는다. `values-perf.yaml`은 재사용 가능한 환경 입력이며 별도 perf EKS를 생성하지 않는다.
리전은 `global.pulsemetry.region`을 받아 Secret ARN, broker DNS, AWS SDK 환경 변수와 모든 CloudWatch query에 동일하게 적용한다.
현재 CDK의 기본 배포 환경은 서울이다. 다른 리전은 해당 리전의 CDK 네트워크·IAM·로그/Secret 산출물이 별도로 필요하다.

운영자 SSM/kubeconfig 경로로 접속한 뒤 로컬에만 포워딩한다.

```bash
kubectl -n pulsemetry-observability port-forward --address 127.0.0.1 service/pulsemetry-grafana 3000:80
# 별도 터미널: /targets, /rules 또는 제한된 k6 smoke를 위한 연결
kubectl -n pulsemetry-observability port-forward --address 127.0.0.1 service/pulsemetry-monitoring-prometheus 9090:9090
```

Grafana admin password는 Secrets Manager 서버 측 생성값을 Pod Identity + CSI 파일로 읽는다.
초기 사용자는 `admin`이다. 암호는 터미널 로그/values/일반 Kubernetes Secret으로 출력·복제하지 않는다.
`GF_SECURITY_ADMIN_PASSWORD__FILE`은 SQLite DB 최초 초기화 때만 적용된다. **Secret 회전과 Pod 재시작만으로
기존 Grafana admin 암호가 변경되지 않는다.** 기존 DB를 유지한 회전은 승인된 운영 절차에서 Grafana UI/CLI의
암호 변경과 Secrets Manager 값을 함께 맞춘다. PVC를 지워 암호를 초기화하는 방법은 사용하지 않는다.

## 대시보드와 데이터 계약

| 대시보드 | 주요 관측과 해석 |
|---|---|
| 수집 경로와 k6 | ACK/record/attempt/row 단위 구분, k6 실행 한 개와 서버 시간 범위 대조 |
| Gateway | 응답 상태·latency·bytes·inflight, Kafka publish ACK/실패, producer buffer, JVM/Tomcat |
| MSK | JMX/node 3개씩 UP, bytes/records, ISR/offline, CPU/memory/network/disk, committed lag |
| Pipeline | 완료/영구거부/일시실패 attempt, stage latency, accepted→start/completion, retry·commit 실패 |
| ClickHouse | 앱 submitted rows/요청 결과와 서버 physical insert rows, merge/parts/memory/error/connection |
| Observability Health | scrape·rules·Prometheus 용량·configuration, Fluent Bit retry/drop·disk chunks·output queue capacity, 관측 Pod 자원 |
| System Diagnostics | CPU/throttle/memory/OOM/restart/Pending/eviction/node 상태, 앱·CH·MSK·Events·관측·EKS 로그 |

공통 `cluster`는 **EKS cluster**, `msk_cluster`는 **MSK cluster**다. app/CH ServiceMonitor가
`application`과 `service`를 `telemetry-gateway`, `telemetry-ingest`, `clickhouse`로 정규화한다.
`honorLabels: false`이므로 앱 공통 tag(`application`·`environment`·`service`)는 `exported_*` 사본이 된다.
target label이 기준이므로 metricRelabelings가 이 세 사본을 버린다. env/cluster/namespace/service/pod
필터는 실제 앱·CH 질의에, K8s는 cluster/namespace/pod에, MSK/node는 해당 cluster 범위에 적용한다.
서비스 선택으로 Pod 목록이 좁혀진다. 지표 패널의 진단 링크는 현재 시간과 선택한 service/pod를 넘긴다.
앱 로그는 실제 `kubernetes.container_name`으로 service를 좁히고 `log` 원문을 읽는다. INFO 시작/종료와
WARN/ERROR 모두 기본 조회한다. control-plane/MSK는 각 전용 로그 그룹을 사용한다.
로그 패널이 있는 System Diagnostics는 기본 15분·1분 갱신이다. Logs Insights 스캔량을 줄이기 위해 지표 대시보드의
30분·10초와 분리한다. 노드 디스크는 Bottlerocket의 읽기 전용 root가 아닌 쓰기 가능 data volume을 device별로 본다.

Prometheus/JMX/CH scrape는 10초다. **MSK commit 기준 lag는 AWS/Kafka CloudWatch 원본 60초**가 권위 출처다.
`SumOffsetLag`, `MaxOffsetLag`, `EstimatedMaxTimeLag`는 Cluster Name/Consumer Group/Topic 차원으로 조회한다.
STABLE/EMPTY와 committed offset 조건이 맞지 않으면 시계열이 없을 수 있다. consumer client fetch position을
committed lag로 바꿔 부르지 않는다. JMX offline/minISR가 실제 MSK에서 빠지면 CloudWatch 패널과 실제 endpoint를 대조한다.

0은 실제 표본이 0일 때만 표시한다. 미방출·수집 장애·histogram 표본 부족은 빈 패널로 남긴다.
빈 패널 문구는 이유별 고정 집합이다(`미수집`, `값 없음 · 첫 화면 수집 상태 확인`, http 모드 Kafka 해당 없음, 현재 Pod 종료 이력 없음, Gateway Hikari 미적용, k6 실행 없음). 검증기가 이 집합만 허용한다. 수집 경로와 k6 첫 행의 상태 표(`pulsemetry:collection_*` rule)로 대상 없음·수집 실패·정상을 먼저 구분한다.
`or vector(0)`, null 연결, percentiles의 평균은 쓰지 않는다. app latency는 선택 Pod의 bucket을 합산한 뒤 quantile을 계산한다.
GC는 실제 exporter의 summary `sum/count` 평균이며 p95가 아니다. Kafka records, OTLP event/point rows,
Pipeline attempts, CH physical inserts를 서로 빼 유실률을 만들지 않는다. 최종 정합성은 기존 verifier의 논리 `FINAL` readback으로 판단한다.

## k6 연결과 로컬 검증

k6 1.8.2의 `experimental-prometheus-rw`를 Prometheus 3.9.1 native histogram receiver에 연결한다.
server URL은 내부 `http://pulsemetry-monitoring-prometheus.pulsemetry-observability.svc:9090/api/v1/write` 또는
운영자의 localhost port-forward다. remote-write receiver는 별도 인증 없이 내부망에서 받으므로 public endpoint를 추가하지 않는다.
PROJ-192의 정식 runner/시나리오·합격 판정은 이 차트에 포함하지 않는다.

```bash
K6_PROMETHEUS_RW_SERVER_URL=http://127.0.0.1:9090/api/v1/write \
K6_PROMETHEUS_RW_TREND_AS_NATIVE_HISTOGRAM=true \
K6_PROMETHEUS_RW_PUSH_INTERVAL=5s K6_PROMETHEUS_RW_STALE_MARKERS=true \
  k6 run -o experimental-prometheus-rw \
  --tag environment=dev --tag cluster='<EKS cluster>' --tag testid='<unique run id>' \
  --tag phase=smoke --tag generator_id=one <approved-small-smoke.js>

# AWS 없는 독립 호환성 검증. 매번 새 evidence 경로를 사용한다.
python3 scripts/observability-remote-write-smoke.py --output /tmp/observability-remote-write-new.json
python3 scripts/observability-image-contract.py --output /tmp/observability-images-new.json
```

`scenario`는 k6 시나리오 태그를 유지한다. 공통 태그는 environment/cluster/testid/scenario/phase/generator_id이며
URL/name은 정적인 경로 이름으로 묶는다. token·tenant·request/trace ID를 태그로 넣지 않는다. 앱 지표에는 testid/run_id를 전파하지 않는다.
Grafana에서 선택하는 testid는 하나다. 서버 지표는 같은 UTC 구간의 환경 전체 값이며 공유 dev의 다른 트래픽이 섞일 수 있다.
실행 시작/종료·장애 주입·배포 시각, chart/image SHA, k6 결과와 lag drain/final readback을 실행 artifact에 함께 보존한다.
공유 Grafana annotation에는 `pulsemetry-run`과 해당 testid 두 태그를 붙인다. 7개 대시보드는 선택한 testid의
공유 annotation을 조회하며, annotation 자동 등록은 후속 runner의 책임이다.

[최종 로컬 증거](tests/remote-write/local-verification-cluster.json)는 ARM64에서 두 generator의 native histogram,
동일 cluster 보존, 합산 p95, stale marker를 검사한다. 10ms/200ms 분포의 합산 p95는 약 0.208초였으며
두 percentile의 평균이 아니다. 이 smoke는 local HTTP endpoint를 대상으로 한 호환성 검사이고 제품 성능/최종 적재 검증은 아니다.

## 검증 범위와 배포 후 수락

`observability-validate.mjs`는 dependency checksum, Helm lint/template, CRD schema, private service/ARM scheduling/PVC,
실제 custom metric fixture, PromQL syntax, 무트래픽/미수집/재시작/여러 Pod histogram 합산과 실패 알림을 검사한다.
[metric fixture 출처](tests/fixtures/provenance.json)에 실제 앱 registry/HTTP scrape와 외부 exporter 근거를 구분한다.
합성 fixture의 계정/DNS는 렌더링용이며 AWS 배포 결과가 아니다.
Fluent Bit 5.1.3 실측에서 v1은 storage 지표가 없어 **v2 단일 endpoint**로 counter와 storage를 함께 수집한다.
[v1/v2 증거](tests/fluent-bit/evidence.json)를 참고한다. disk-only chunk 10분 증가 >128이 5분 지속되는 경보는
초기 진단 문턱값이며 실제 부하 기준선으로 조정한다. chunk 개수는 byte 용량/유실 레코드 수가 아니다.

Backend scrape 사본 3개는 [provenance](tests/fixtures/provenance.json)에 생성 commit·명령·SHA256을 둔다.
검증기가 SHA256을 대조하고 대시보드의 custom 지표가 세 사본 중 하나에 있는지 확인한다.
재시도 소진·commit 실패 경보와 패널은 ingest가 두 counter를 실패 전부터 0으로 노출한다는 전제라, ingest 사본에서 이를 확인한다.

### 로컬 검증 기록 (2026-10-22)

| 검사 | 도구 | 결과 |
|---|---|---|
| `npx jest` (`HELM_BIN`·`PROMTOOL_BIN`·`KUBECONFORM_BIN` 지정) | Helm 3.22.0, promtool 3.9.1, kubeconform 0.8.0 | 31 suites, 716 통과, skip 0 |
| `observability-validate.mjs` | Helm 3.18.6·3.22.0, promtool 3.9.1 | 7 dashboards, 78 PromQL, 30 rules, digest·provenance 대조 통과 |
| `validate-helm-workloads.mjs` | Helm 3.22.0, kubeconform 0.8.0 | workload 147·platform 10 resource, 실패 입력 232 통과 |
| `eks-values-check-runtime.mjs` | 고정 CSI 1.6.1·ASCP 3.1.4·Fluent Bit chart 0.58.3 archive SHA256 | 통과 |
| `observability-log-envelope-smoke.py`·`observability-fluent-bit-smoke.py` | Fluent Bit 5.1.3 ARM64 | envelope 10건, runtime/Events dry-run 0 |
| `observability-metric-filter-check.mjs` | 로컬 부분 문자열, 가짜 `aws` 응답(eventNumber 0·1 시작) | 5 filter 통과. CloudWatch engine(`--aws`)은 미실행 |

AWS 배포·실제 scrape·로그 배송·TestMetricFilter는 실행하지 않았다.

배포 후에는 다음을 실제 증거로 추가해야 한다.

1. 앱 9404·CH 9363·MSK 11001/11002 전체 broker·kubelet/KSM/node-exporter·Fluent Bit/Events의 UP와 지표 이름/라벨.
2. CloudWatch datasource Pod Identity와 모든 로그 그룹, source resolution60초, 실제 commit lag 및 rebalance 동안의 No data.
3. Grafana CSI 읽기와 PVC 재기동 보존, events collector 재시작 뒤 배송, Fluent Bit retry/drop/긴 줄/재시작 경계.
4. 제한된 ingress client smoke, k6 측정 구간 annotation, 정상·실패·처리 drain과 CH 논리 정합성 결과.
5. 관측 CPU/memory/PVC·target series·scrape 지연 기준선, 수집 공백과 로그 손실 여부. 비용/성능 합격값은 실제 전용 테스트에서 결정한다.

## 출처

- [Prometheus native histograms](https://prometheus.io/docs/specs/native_histograms/), [k6 Prometheus remote write](https://grafana.com/docs/k6/latest/results-output/real-time/prometheus-remote-write/)
- [AWS MSK Open Monitoring](https://docs.aws.amazon.com/msk/latest/developerguide/prometheus-metrics.html), [CloudWatch metric dimensions](https://docs.aws.amazon.com/msk/latest/developerguide/metrics-details.html), [consumer lag 조건](https://docs.aws.amazon.com/msk/latest/developerguide/consumer-lag.html)
- [Fluent Bit Kubernetes Events](https://docs.fluentbit.io/manual/data-pipeline/inputs/kubernetes-events)
