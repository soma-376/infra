# Fluent Bit 5.1.3 ARM64 로컬 검증

`scripts/observability-fluent-bit-smoke.py`는 공식 이미지의 실제 바이너리로 두 가지를 확인한다.

1. `helm/dev/runtime/fluent-bit-values.yaml`의 실제 classic config와 관측 차트에서 렌더한 Events config에
   `--dry-run`을 적용한다. 둘 다 network none 컨테이너에서 exit 0이다. 의도적으로 존재하지 않는 dummy plugin
   설정을 넣으면 exit 1로 거부되어 plugin option 검증도 수행됨을 확인했다.
2. localhost에만 노출한 별도 dummy → null pipeline을 실제 실행하고 filesystem storage를 켠 뒤
   v1/v2 Prometheus endpoint와 `/api/v1/storage`를 조회한다. 외부 전송은 없고 컨테이너는 정리된다.

```bash
HELM_BIN=/path/to/helm python3 scripts/observability-fluent-bit-smoke.py
```

이미지 digest는 `evidence.json`에 기록한다. `events.conf`는 실제 Helm 렌더 결과이며 hash도 기록한다.
`kubernetes-events-help.txt`는 실제 binary의 plugin help다. `kube_retention_time`, `db`, `interval_sec`,
`storage.type`을 지원한다. dry-run은 Kubernetes 이벤트를 읽거나 CloudWatch로 보내지 않는다.

| endpoint | 실제 결과 |
|---|---|
| `/api/v1/metrics/prometheus` | input/output 지표는 있지만 `fluentbit_storage_*` 없음 |
| `/api/v2/metrics/prometheus` | storage_chunks, storage_fs_chunks, storage_fs_chunks_up/down, storage_mem_chunks 5개 노출 |
| `/api/v1/storage` | JSON으로 storage layer와 input chunk 상태 반환 |

따라서 buffer 관측용 ServiceMonitor는 **v2 Prometheus endpoint 하나**를 사용한다. v1/v2를 동시에 scrape해
동일 input/output counter를 중복 수집하지 않는다. `.prom` 파일은 실제 응답에서 input·output·storage 지표만
추출하고 sample timestamp를 제거한 fixture다. 동적 수치를 고정 기대값이나 성능 기준선으로 사용하지 않는다.

이 검증은 옵션 이름·로컬 exporter만 확인한다. Kubernetes API/RBAC, ASCP·Pod Identity, 실제 tail multiline/
DB 재시작, CloudWatch 권한·배송·재시도, Events PVC 중복 제거와 종료 노드 로그 보존은 검증하지 않았다.
