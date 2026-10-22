# ClickHouse 24.8 로컬 ARM64 검증

`scripts/observability-clickhouse-smoke.py`는 **실제 workload Helm chart가 렌더한 ConfigMap XML**을 mount한다.
별도 테스트 XML이나 서버 튜닝을 쓰지 않는다. chart의 이미지·환경변수를 읽고 EKS limit와 같은 CPU 1·메모리 2GiB로
Docker ARM64 컨테이너를 실행한다. HTTP와 metrics 포트는 임의의 localhost 포트에만 publish한다.

검증 순서는 기존 설정으로 새 전용 volume에 MergeTree 테이블/3행 생성 → 정상 종료 → 같은 volume에 관측 설정을
추가해 재기동 → DDL/3행/default DB/data 경로 확인 → 2행 추가 → 의도한 SELECT/INSERT 오류 → 9363 scrape →
native 9000 확인 → 정상 종료다. 시작·오류·종료 server 로그가 JSON이며 비어 있지 않은 중복 파일 로그가 없는지 확인한다.
임시 container/volume은 실행 고유 label로 식별해 finally에서 정리하며 기존 Docker 리소스·AWS를 변경하지 않는다.

```bash
# repository에서 npm ci, Docker ARM64 engine 및 Helm 준비 후 실행한다.
HELM_BIN=/path/to/helm python3 scripts/observability-clickhouse-smoke.py \
  --expected-image-digest clickhouse/clickhouse-server@sha256:b002e56ed5c16e224c312527f6fcba7e77216fec5d7a88a7828f59efc614feb5
```

기록한 tag의 실제 서버 버전은 **24.8.14.39**, architecture는 **arm64**다. 이 digest는 당시 이미지 관측값이며
workload의 기존 tag 정책을 바꾸지 않는다. optional `--expected-image-digest`는 tag가 바뀌면 검증을 중단한다.

| 증거 | 내용 |
|---|---|
| `evidence.json` | 실제 이미지 digest/version, 환경, 보존·로그·종료 결과, 대시보드 지표 존재 여부 |
| `observability.xml` | 현재 Helm 렌더 결과 그대로의 입력. SHA256은 evidence와 일치해야 한다 |
| `dashboard-metrics.prom` | 실제 `/metrics`에서 대시보드/recording rule 사용 native 지표만 추출한 샘플 |
| `server-log-samples.jsonl` | 실제 시작·SELECT/INSERT 오류·종료 로그. 시각/스레드/query ID를 제외하고 주소·UUID를 마스킹 |

서버 지표 2,008개 이름이 관측됐고 사용 중인 native 지표 9개가 모두 존재했다. 오류를 유발한 뒤
FailedQuery=2, FailedInsertQuery=1, 추가 INSERT 뒤 InsertedRows=2가 관측됐다. 비활성 merge/delay/connection은
실제 0 샘플로 나왔다. `TotalPartsOfMergeTreeTables`는 시스템 테이블을 포함한 전체 서버 값이다.
표본 수치 자체를 고정 기대값으로 삼지 않는다. 디스크·스토리지 종류와 서버 기능에 따라 없는 지표는 NoData다.
이 테스트는 일부러 빈 지표를 0으로 생성하지 않는다. 앱의 `pulsemetry_*` 및 kubelet PVC 지표는 다른 수집 대상이다.

server JSON 로그는 이 이미지에서 **stderr**에 기록됐다. entrypoint의 안내 문구 등은 평문일 수 있으며
JSON logger의 `message` 안에는 stacktrace가 포함된다. 저장된 샘플은 길이를 줄이기 위해 stacktrace 본문을 제외하고
`stackTracePresent`로 존재 여부를 남긴다. 사용자 데이터·비밀·실제 서비스 요청은 사용하지 않는다.

로컬 검증은 EKS CSI/EBS, Fluent Bit tail/CloudWatch 배송, MSK, 실제 부하 성능이나 장애 복구를 입증하지 않는다.
컨테이너는 정상 SIGTERM 종료를 검증했으며 OOM·SIGKILL·노드 소실을 유발하지 않았다.
