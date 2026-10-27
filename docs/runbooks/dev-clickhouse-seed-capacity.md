# dev 과거 시드의 ClickHouse 용량 검증과 적용

[허브 ADR-0023](https://github.com/soma-376/docs/blob/main/adr/0023-dev-historical-dashboard-dataset.md)의 실행 절차다.
풍부한 과거 사용량을 유지한 로컬 성공 결과와 아래 변경·복구 영향을 제시하고 사용자 확인을 받은 뒤 dev에 적용한다.
이 문서나 후보 파일이 있다는 사실은 dev 적용 승인을 뜻하지 않는다. PostgreSQL 조회 권한은
[PROJ-262 별도 런북](dev-dashboard-read-grants.md)을 따른다. 이미지 교체·새 마이그레이션·권한 변경을 이 절차에 묶지 않는다.

## 변경 범위와 공식 원본

후속 배포 입력은 `config/dev/deployment.json`·`config/dev/runtime.yaml`이다. 개인 report나 저장한 Helm values는 비교·복구 자료다.
생성기는 현재 앱 digest·배포 output·MSK API 결과와 공식 runtime으로 실행한다. 공식 현재 렌더가 live manifest와 같지 않으면
누락된 설정을 과거 override로 조용히 메우지 않고 원인을 먼저 해결한다. 생성된 다른 release는 배포하지 않는다.

| 항목 | 현재 기준 | 후보/보존 계약 |
|---|---|---|
| ClickHouse | 현재 검증한 24.8 ARM64 image, 1 replica, 1 CPU/2Gi, 50Gi PVC | 같은 실행 digest를 기존 tag와 함께 pin, 내용·자원·PVC 불변 |
| snapshot 복사 읽기량 | 100,000행 / 10MiB | 새 로컬 실측 최대 × 1.5, 행 10,000·바이트 MiB 올림 |
| 원천 반환 결과 | 100,000행 / 10MiB | 그대로 |
| snapshot 생성 | 60초 / 조직별 동시 1개 | 그대로, 서버 전체 동시 1개가 아님 |
| 내부 `metric_log` | 실제 테이블 override와 서버 engine 정의를 먼저 확인 | `max_compress_block_size=65536`, `merge_max_block_size=512` 두 개 |
| 기타 내부 로그 | 수집/flush 주기·buffer·보존/TTL·다른 table·전역 pool | 그대로 |

2026-10-27 새 로컬 검증의 602,733행/256,102,794바이트 최댓값으로 계산한 최종 후보는
910,000행 / 384,827,392바이트(367MiB)다. 이전 940,000행/385MiB 후보는 보존한 과거 시험값이다.
적용 시에는 승인받은 최신 측정과 후보가 일치해야 한다. 복사 읽기 바이트는 원천과 materialized view 처리의 누적 읽기량이고 RAM 상한이 아니다.
별도로 `read_rows/read_bytes`, 결과 크기, 쿼리 메모리, 컨테이너 working set·CPU·p95·전체 시간을 기록한다.
7/28/90일은 이전 기간 비교를 포함하고 180일은 단독 전체 범위를 사용한다.

새로운 metricLog 입력은 아래 두 정수만 허용한다. 자유 형식 engine·다른 숫자·추가 필드는 생성기와 Helm schema가 거부한다.
이 블록이 없으면 기존 manifest에 metric log 설정·mount·restart checksum이 추가되지 않는다.

```yaml
clickhouse:
  # 선택한 새 버전이 아니라 사전 확인한 실제 실행 imageID의 sha256:<64 hex>를 넣는다.
  # imageDigest: sha256:...
  metricLog:
    maxCompressBlockSize: 65536
    mergeMaxBlockSize: 512
```

`clickhouse.imageDigest`는 선택 입력이며 SHA-256 형식만 받는다. 생략 시 기존 tag 렌더를 유지한다.
이번 재시작 후보에는 현재 실행 digest를 넣어 `clickhouse/clickhouse-server:24.8-alpine@sha256:...`로 고정한다.
내용 변경이 없는지 baseline Pod imageID와 후보 digest를 반드시 대조한다. mutable tag와 `IfNotPresent`만으로는
새 노드에서 같은 이미지가 실행된다고 보장할 수 없다. 후보 digest가 다르면 새 버전을 선택하지 말고 중단한다.

이 입력은 `clickhouse-metric-log` ConfigMap과 단일 읽기 전용 파일
`/etc/clickhouse-server/config.d/metric-log.xml`, checksum annotation으로 이어진다. engine은 다음과 같다.

```sql
ENGINE = MergeTree
PARTITION BY toYYYYMM(event_date)
ORDER BY (event_date, event_time)
SETTINGS index_granularity = 8192,
         max_compress_block_size = 65536,
         merge_max_block_size = 512
```

기본 `partition_by`는 동일 engine에 포함하므로 XML의 별도 항목을 제거한다. `ttl` 제거는 현재 TTL이 없다는 사전 검증을 전제로 한다.
이미 TTL·다른 partition/order/engine 설정이 있는 서버에는 이 후보를 적용하지 않는다. 다른 설정을 덮어쓰는 범용 튜닝 경로가 아니다.

## 사전 검증과 승인 자료

1. 현재 이미지 digest, Helm revision/전체 values/manifest, Pod readiness, CPU·memory·PVC와 공식 입력을 저장한다.
   `SHOW CREATE TABLE system.metric_log` 또는 기존 metadata 파일, `system.tables`의 UUID·행 수와
   preprocessed XML의 `metric_log`를 저장한다. 두 table override의 **명시 여부**와 유효 기본값을 분리한다.
   비밀번호·Secret 본문은 출력/복사하지 않는다. count와 catalog 이외 대형 원천 scan은 하지 않는다.
2. 현재 계약은 `MergeTree`/월 partition/`(event_date,event_time)` order/index granularity 8192이며 TTL이 없다.
   이 구조나 기존 engine override가 다르면 중단한다. 이미 같은 두 값이 적용된 경우에도 서버 XML과 일치하는지 확인한다.
3. 같은 image·1 CPU/2Gi의 새 로컬 환경에서 풍부한 시드, 중단·재개·재실행, API·화면·SSO·기존 테넌트 보존을 검증한다.
   모의 OIDC 성공은 실제 Cognito 로그인 검증을 대신하지 않는다. 최종 복사 한도로 전체 조회를 다시 통과해야 한다.
4. **테이블 ALTER만으로 재시작 지속성을 보장하지 않는다.** 24.8은 서버 engine 정의와 다른 로그 테이블을
   다른 이름으로 보존하고 기본 active table을 새로 만들 수 있다. 새 작은 로컬 fixture에서
   기존 기본 table → ALTER → 동일 XML → restart와 그 역순을 검증한다.
   전환 전부터 동일 active UUID가 유지되고 기존 행 수/안정된 행 hash가 보존돼야 한다.
   단순히 새 XML에서 생성된 새 table의 두 번째 restart가 통과한 것만으로 이 관문을 대신하지 않는다.
5. 다른 조직의 진행 중 snapshot/유효 build lease, 최근 평가 상태, 활성 alert rule 수와 서버 전체 부하를 확인한다.
   조직별 동시성 1은 전체 서버 직렬화가 아니다. 평가 상태 테이블은 실행 이력이 아니므로 최근 갱신 수의 의미를 구분한다.
6. 후보 diff는 dashboard의 복사 제한 env 두 개, ClickHouse의 metric-log ConfigMap/mount/checksum,
   기존 실행 내용과 같은 digest를 pin하는 image 문자열 변경만 허용한다.
   root의 기존 source result 제한·timeout·동시성, 모든 이미지/Secret 참조, 다른 release가 같음을 확인한다.
   새 측정값·로그 보존/복구 실험·단일 replica 재시작 영향과 아래 한계를 제시한 뒤 사용자 확인을 받는다.

## 승인 후 적용 순서

단일 replica 재시작 동안 조회·수집이 일시적으로 실패할 수 있다. importer를 시작하지 않은 유지보수 구간을 사용하고
기존 조회/수집의 상태를 확인한다. 실제 지연·중단 길이는 측정값으로 기록하며 무중단이라고 설명하지 않는다.

1. 직전 snapshot과 live 이미지/revision/runtime/engine/UUID, 지표 신선도를 다시 대조한다. drift가 있으면 새 후보를 검토한다.
   `python3 scripts/dev-clickhouse-capacity-guard.py --before-dir <보호된 사전 증거 디렉터리> --expected-image-digest <후보 digest>`는
   기존 읽기 전용 접속 환경에서 metadata/XML hash·UUID·engine/TTL·Helm values/revision·Pod image/Ready를 검사한다.
   현재 실행 digest와 후보 pin도 대조한다. 이 도구는 ALTER나 배포를 하지 않으며 성공 자체가 승인이나 모니터 관문을 대신하지 않는다.
   원본 runtime patch를 검토·적용하고 공식 `npm run values:dev -- --outputs ... --msk-bootstrap ... --msk-nodes ...`
   입력으로 다시 생성한다. 현재 네 앱 digest 입력을 사용하되 이번 배포는 ClickHouse와 dashboard 두 release뿐이다.
2. 기존 `system.metric_log`가 저장한 UUID·engine이며 두 후보 override가 아직 없는 것을 확인한 뒤 다음 ALTER를 실행한다.

   ```sql
   ALTER TABLE system.metric_log MODIFY SETTING
     max_compress_block_size = 65536, merge_max_block_size = 512;
   ```

3. ALTER 결과를 확인한 직후 같은 engine XML을 포함한 공식 ClickHouse Helm values로 upgrade한다.
   예: `helm upgrade clickhouse helm/dev/workloads/clickhouse -n pulsemetry-dev --reset-values -f <공식 생성 clickhouse.yaml> --wait --timeout 10m`.
   checksum 변경으로 Pod가 재생성된다. 별도 불필요한 재시작은 하지 않는다.
   이 두 단계는 DB DDL과 Kubernetes 작업이므로 원자적이지 않다. 사이에 crash/restart가 발생하면
   로그 table이 rename됐는지 조사하고 시드를 보류한다. table을 삭제하거나 이름을 강제로 원복하지 않는다.
   **ClickHouse Helm 자동 rollback 옵션은 사용하지 않는다.** 테이블 ALTER와 함께 복구해야 하기 때문이다.
4. 새 Pod의 imageID·Ready·`/ping`, 엔진 XML/DDL의 일치, 원래 metric_log UUID와 기존 로그 보존,
   최근 MemoryLimit/Code241 및 전체 지표를 확인한다. UUID가 바뀌었으면 성공으로 처리하지 않는다.
5. dashboard는 이미지·모든 현재 값이 같은 공식 workload base+생성 values로 복사 한도만 upgrade한다.
   source result 100,000/10MiB, 60초와 조직별 동시성 1이 유지됨을 확인한다.
   동일 이미지 시작 과정의 기존 migration 상태를 확인한다. 새 schema 변경을 자동 추가하지 않는다.
6. 사전 조회·health·모니터 baseline이 정상이고 승인한 설정과 같을 때만 별도 시드 실행 절차를 시작한다.

## 적재와 조회 guard

배치 2,000행 또는 JSON 4MiB 중 먼저 도달한 한도, 동시 요청 1개, 동기 ACK 후 1초,
첫 5개 ACK 뒤 30초 관찰을 유지한다. working set 75% 이상, 기준 조회 지연 2배 이상, 오류/timeout,
지표 누락·노후화이면 **다음 작업 전에 중단**한다. 이미 실행 중인 요청을 취소하는 장치가 아니다.
모니터 결과는 원본별 sample 시각과 만료 시간을 보존하고 freshness는 실제 scrape interval에 맞춘
`2 × interval + 5초` 이상으로 산정한다. 성공 파일이 없거나 만료되면 진행하지 않는다.
실패 잠금과 journal을 보존하며 무조건 재시도하거나 허용 기준을 높이지 않는다.

## 복구

복구는 입력/설정 복원이며 적재된 soma 업무 데이터를 자동 삭제하지 않는다. 원래 copy 10MiB로 복구하면
이미 들어간 rich soma의 큰 기간 조회가 다시 실패할 수 있다. 운영자가 이 영향을 확인한 뒤 진행한다.
PROJ-262 권한 복구는 별도 SQL/관문이며 여기서 REVOKE하지 않는다.

1. importer·새 로컬/운영 시험을 중단하고 진행 중 요청 종료와 서버 상태를 확인한다. 저장한 before와 현재 table UUID를 대조한다.
2. 기존 override가 없었던 두 키는 아래처럼 **RESET**한다. 명시된 값이 있었다면 저장한 원래 정수로 MODIFY한다.
   두 키 외 engine 설정과 모든 데이터는 건드리지 않는다.

   ```sql
   ALTER TABLE system.metric_log RESET SETTING max_compress_block_size, merge_max_block_size;
   ```

3. 같은 유지보수 구간에서 원래 서버 XML을 복구하고 restart를 완료한다.
   공식 runtime에서 `clickhouse.metricLog`만 제거하고 현재 `clickhouse.imageDigest` pin은 유지한 복구 values로
   같은 chart의 Helm upgrade를 수행한다. 저장한 예전 revision은 비교 자료로 사용한다.
   mutable tag였던 예전 revision으로 직접 rollback하면 새 노드에서 이미지 내용이 달라질 수 있으므로 사용하지 않는다.
   table 복구가 실패했는데 XML만 먼저 되돌리면 engine 불일치로 rename될 수 있으므로 보류하고 원인을 확인한다.
4. 원래 UUID·engine·안정된 기존 행과 보존된 archive table들이 유지되는지, Ready/health/전체 부하를 확인한다.
   이미 rename된 로그도 증거로 보존한다. 테이블/PVC 삭제·truncate·로그 비활성화로 해결하지 않는다.
5. dashboard의 원래 복사 제한과 공식 runtime 입력을 복원하되, ClickHouse의 동일 내용 보장을 위한 imageDigest pin은 유지한다.
   설정 복구와 이미지 문자열 완전 원복을 구분하고, 정상화 의미와 soma 큰 범위 조회의 한계를 기록한다.

CH 버전 변경·새 PVC·시스템 로그 테이블 재생성 시 engine 정의/컬럼과 두 설정의 유효값·원래 구조를 재검증한다.
이번 후보가 다른 버전에서도 맞는다고 가정하지 않는다. 이 절차의 성공이 공유 dev의 모든 동시 부하를 보장하지 않는다.
