# Loki·Tempo 격리 보존 검증

PROJ-256의 보존 확인은 dev의 설정·상태 조회와 새 로컬 저장소의 자동 삭제 실험을 함께 사용한다.
dev 계약은 Loki 72h, Tempo 48h다. `scripts/observability-retention-smoke.mjs`는 이 원본 값을 먼저
검사한 뒤, 렌더 결과의 복사본에만 5분 보존을 적용한다. dev 접속, dev PVC 조작, 수동 파일 삭제,
delete API, 시계 변경, 과거 시각 입력은 사용하지 않는다. 기존
`scripts/observability-loki-tempo-smoke.mjs`의 일반 smoke 동작은 그대로다.

## Tempo 3.1의 실제 보존 설정

Tempo 3.1의 retention job은 `backend_worker.compaction.block_retention`을 읽는다.
`backend_scheduler.provider.compaction.compaction.block_retention`만 48h로 설정하면
worker에는 기본 336h가 남을 수 있다. `tempo/values.yaml`은 양쪽에 같은
`tempo.retention` 값을 렌더하고, 플랫폼 trace 검증과 격리 smoke는 양쪽 48h 일치를 필수로 검사한다.
worker 누락 또는 336h는 검증 실패다.

근거는 [worker의 retention 실행](https://github.com/grafana/tempo/blob/v3.1.0/modules/backendworker/backendworker.go),
[worker 구성](https://github.com/grafana/tempo/blob/v3.1.0/modules/backendworker/config.go),
[보존 기본값](https://github.com/grafana/tempo/blob/v3.1.0/tempodb/config.go)이다.
실제 배포 검증에서는 chart 값뿐 아니라 `/status/config`의 worker 값을 함께 확인한다.

## 실행

Docker와 고정 Helm 바이너리, 설치된 저장소 Node 의존성이 필요하다. 이미지는 chart의 digest를
그대로 사용하며 runner는 digest가 없는 이미지를 거부한다. 새 Docker network와 세 컨테이너
(Loki, Tempo, Collector), 빈 임시 filesystem만 만들고 HTTP는 이 실행의 loopback 포트만 사용한다.

```sh
node --test test/scripts/observability-retention-smoke.test.mjs

HELM_BIN=/absolute/path/to/helm node scripts/observability-retention-smoke.mjs \
  --output-dir /absolute/private/retention/run-YYYYMMDD-HHMMSS
```

출력 디렉터리는 새 경로여야 한다. 증거는 private 권한으로 저장하며 Git에 포함하지 않는다.
컨테이너와 network는 실행 고유 label/ID를 확인한 뒤 정리한다. 성공한 임시 저장소는 최종 판정
후 제거한다. 실패 또는 미완료 저장소는 진단용으로 보존하며 `result.json`에 경로를 기록한다.

## 격리 설정

다음 값은 실험에만 적용한다. Loki 입력 허용 기간과 TSDB의 24h index period, filesystem 저장 방식,
이미지 digest는 유지한다. Loki의 짧은 전역 `retention_period`는
[공식 retention 문서](https://grafana.com/docs/loki/latest/operations/storage/retention/)가 지원하는 설정이다.
24h 최소값이 적용되는 stream별 retention rule은 사용하지 않는다.

| 구성 | 격리 값 |
| --- | --- |
| Loki 전역 retention / query lookback | 5m / 1h |
| Loki compaction / retention 적용 / 삭제 지연 | 10s / 20s / 30s |
| Loki chunk idle / 최대 age / flush 점검 / flush 후 보유 | 30s / 1m / 5s / 0s |
| Loki WAL checkpoint | 30s |
| Tempo scheduler·worker retention / compacted retention | 5m / 30s |
| Tempo retention job / blocklist poll | 10s / 10s |
| Tempo complete block timeout | 1m |

## 성공 판정과 증거

1. 원본 렌더의 Loki 72h와 Tempo scheduler·worker 48h를 검사한다. 격리 서버를 실제 기동하고
   effective config의 5m 보존 및 Ready를 확인한다.
2. 현재 시각의 합성 로그 1개와 span 1개를 넣고 둘 다 조회되는지 확인한다. 빈 저장소에서 시작했으므로
   해당 입력을 Loki chunk와 Tempo block에 대응시킨다. 파일 경로·크기·시각·SHA-256을 보존한다.
   Tempo는 backend metadata만 아니라 같은 block ID의 parquet/index와 live-store/WAL 파일까지 추적한다.
3. 입력 후 270초 이상 300초 미만에 두 입력이 조회되고 대응 파일이 있으며 삭제 counter가 0인
   표본을 요구한다. 최소 300초가 지난 뒤 대응 파일 전체 부재, 정상 Ready, 자동 삭제 counter 증가를
   함께 확인한다. 매 10초 관찰하며 입력 기준 30분 안에 이 조건을 충족하지 못하면 `INCOMPLETE`다.
4. 삭제 시점의 API 결과도 기록한다. 실행 중 Loki의 메모리 chunk cache는 이미 삭제된 파일 내용을
   반환할 수 있으므로 이 결과만으로 물리 삭제 여부를 판정하지 않는다. 같은 저장소로 Loki·Tempo를
   재시작한 뒤 원래 입력의 조회 부재를 5초 간격으로 3회 확인한다. 새 합성 입력도 다시 조회되어야 한다.

`observations.jsonl`, `before-expiry.json`, `persisted-storage.json`, `after-retention-storage.json`,
삭제 metrics와 컨테이너 로그, `same-storage-restart.json`, `result.json`을 함께 읽는다.
파일이 처음부터 없었거나, 5분 전에 사라졌거나, 만료 전 생존 표본이 없거나, 삭제 counter가 증가하지
않았거나, 재시작 후 원래 입력이 다시 조회되면 성공으로 판정하지 않는다. unit test는 이 거짓 성공
조건과 Loki의 분할 filesystem chunk key, metadata 삭제 후 남은 Tempo payload 추적을 검사한다.

이 실험은 같은 이미지의 격리 filesystem에서 자동 보존 삭제와 재시작 후 비복원, 새 입력의 정상 수신을
검증한다. dev의 특정 과거 파일 삭제, 실제 72h/48h 전체 경과, secure erase 또는 모든 WAL byte의
포렌식 부재를 재현했다는 뜻은 아니다. dev 설정·상태 증거와 격리 실험 증거를 구분해 기록한다.
