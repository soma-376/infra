# dev EKS 관측·시스템 장애 진단 (PROJ-191)

이 문서는 로컬 구현의 적용·검증 절차다. AWS 배포, 실제 MSK exporter, 로그 배송, 장애 주입과 k6 실행의
완료 기록은 아니다. [ADR-0037](../adr/0037-dev-observability-and-system-diagnostics.md),
[기존 EKS 런북](dev-eks-manual-deployment.md), [관측 차트 안내](../../helm/observability/README.md)를 함께 따른다.
전제는 PROJ-245·246 JWT/Gateway/Kafka 변경과 내부 management 9404를 구현한 Backend 이미지다.
Grafana는 운영자 localhost port-forward로 접속하며 public ALB/Ingress를 추가하지 않는다.

## 적용 순서와 입력

1. 기존 EKS 런북의 CDK diff를 검토한다. EKS 관측 SG, Grafana Secret/Pod Identity, 로그 그룹, 진단 S3,
   MSK Open Monitoring만 의도한 변경인지 확인한다. 기존 MSK broker 수·스토리지·DEFAULT 경보와
   ClickHouse data PVC를 교체하지 않는다. 실제 적용은 리뷰된 수동 배포 단계에서 한다.
2. 배포 output에서 `MskClusterArn`을 읽고 `get-bootstrap-brokers`와 `list-nodes`를 각각 JSON으로 저장한다.
   CLI 기본 pagination을 유지하고 `--no-paginate`/`--max-items`를 사용하지 않는다. 생성기에 기존 입력과
   `--msk-nodes "$RUN_DIR/msk-nodes.json"`를 전달한다. 조회 명령 전체는 기존 EKS 런북 §2-2에 있다.
   생성기는 같은 cluster DNS의 실제 broker 3개를 검증한다. bootstrap은 일부 주소만 올 수 있다.
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

추가 generated output은 `global.pulsemetry`(환경·클러스터·로그 그룹·broker DNS·topic/group·Secret ARN)와
upstream ServiceMonitor의 cluster/environment relabeling이다. 배포 output을 수동 문자열로 대체하지 않는다.
별도 k6 인프라는 이번 범위에 없으며 새 환경을 만들 때 같은 관측 차트 입력·대시보드를 재사용한다.

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
| MSK | 실제 broker DNS 3개 × JMX11001/node11002 | exporter 6 target UP, broker 별 지표 존재 |
| Kubernetes | kubelet/cAdvisor·kube-state-metrics·node-exporter | 앱/CH/관측 노드 전부 관측, restart/termination reason 지표 |
| 앱/CH 로그 | Fluent Bit → `/eks/dev/application` | 원문 `log`와 `kubernetes.*` metadata 동시 존재 |
| 관측 스택/Fluent Bit 로그 | Fluent Bit → `/eks/dev/observability` | 관측 taint 노드에서도 전송 |
| Kubernetes Events | 단일 collector → `/eks/dev/events` | 새 Warning 이벤트 수집 및 collector 재시작 후 이어받기 |
| MSK broker 로그 | MSK → `/aws/vendedlogs/msk/soma-376-dev-telemetry` | 최신 broker 별 INFO/WARN/ERROR 로그 |
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

MSK는 broker 로그 그룹에서 시간 범위를 먼저 좁히고 `@logStream`과 `@message`를 본다. 서비스 재시작·
컨트롤러 선출·스토리지 오류와 같은 메시지를 broker별 UP/디스크/ISR 지표에 대조한다. MSK 운영 이벤트와
AWS Health/CloudTrail 조회가 추가로 필요할 수 있다. broker 로그만으로 AWS 내부 장애 원인 전체를 확정하지 않는다.
MSK INFO를 유지하며 부하 측정 중 DEBUG/TRACE를 켜지 않는다.

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
MSK lag는 group 상태와 committed offset 조건이 있어 미존재를 0으로 채우지 않는다.

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

부하 전 기준선에는 chart/image 버전, 시간대, target 100% UP, broker 3대, Pod/노드 자원, PVC 여유,
현재 lag/처리량과 Logs Insights 조회를 남긴다. 부하 후에는 수집 공백·drop, 처리량·지연·오류·backlog,
재시작/종료 사유와 시스템 로그를 같은 구간으로 대조한다. k6 요청 성공은 최종 ClickHouse 적재 성공과 별도로 해석한다.

## 근거

- [MSK Open Monitoring](https://docs.aws.amazon.com/msk/latest/developerguide/prometheus-metrics.html), [lag 조건](https://docs.aws.amazon.com/msk/latest/developerguide/consumer-lag.html)
- [MSK broker logging](https://docs.aws.amazon.com/msk/latest/developerguide/msk-logging.html)
- [Fluent Bit tail](https://docs.fluentbit.io/manual/data-pipeline/inputs/tail), [buffer/storage 제한](https://docs.fluentbit.io/manual/administration/buffering-and-storage)
- [EKS NodeDiagnostic](https://docs.aws.amazon.com/eks/latest/userguide/auto-get-logs.html)
