# PROJ-191·255·256 — dev Strimzi 관측 완료 근거

**현재 상태: observability revision 8·Tempo revision 2 적용, G8 API·실제 UI·30분 관찰·종료 후 자원 대조를 통과해 완료조건 검증 PASS. 실제 상태는 각 Jira에서 확인한다.**
이 문서는 dev Strimzi 경로의 관측 적용과 실제 확인 범위를 기록한다. 기존 실행 절차는
[관측 런북](dev-observability.md), 공급자 전환은 [Strimzi 런북](dev-strimzi-kafka.md)을 따른다.
[ADR-0039](../adr/0039-dev-loki-tempo-and-platform-trace-collector.md)와 backend ADR 0069의 `Proposed` 상태는 유지한다.
원본 증거는 실행 환경에 보존하고 공유 가능한 요약을 이 문서와 Jira에 연결한다.
실제 티켓 상태는 [PROJ-191](https://team376.atlassian.net/browse/PROJ-191)·[PROJ-255](https://team376.atlassian.net/browse/PROJ-255)·
[PROJ-256](https://team376.atlassian.net/browse/PROJ-256)에서 확인한다.
계정·Secret·내부 주소·고객 본문은 이 문서에 싣지 않는다.

## Source와 실제 적용

| 항목 | 확인된 값과 범위 |
|---|---|
| lag·보존 정정 | [infra #87](https://github.com/soma-376/infra/pull/87), source `0febb2fdd77b15c9b74802f1415841c3b382ae12`, [CI 성공](https://github.com/soma-376/infra/actions/runs/41006047855) |
| Grafana 표시 정정 | [infra #88](https://github.com/soma-376/infra/pull/88), source `6d8938c1995542b0c1f8de34e8f295bf25ec359c`, 병합 2026-10-30 05:20:40 UTC, [CI 성공](https://github.com/soma-376/infra/actions/runs/41007693469) |
| Pipeline 안내문 정정 | [infra #89](https://github.com/soma-376/infra/pull/89), source `8d230aa1ad77efdd2d6ae907ba1f5be7e1c13239`, 병합 2026-10-30 05:29:02 UTC, [CI 성공](https://github.com/soma-376/infra/actions/runs/41008406538) |
| docs 계약 상태 정정 | [docs #21](https://github.com/soma-376/docs/pull/21), merge `e23cd5b234f8a9b5b550a2ce303e84f80cad9121` |
| backend 관측 상태 정정 | [backend #55](https://github.com/soma-376/pulsemetry-backend/pull/55), merge `af0c3158d7bc1496b2c0010a188385aae983f1d2` |
| Loki·Collector | `loki` revision 1, `otel-platform` revision 1. revision 8까지 설정 digest·실행 imageID와 기존 release revision이 같았고 06:01:18 UTC 종료 대조에서도 유지됐다 |
| Tempo | revision 2 적용 2026-10-30 05:07:10 UTC. 실행 설정의 scheduler·worker 보존 값 모두 `48h0m0s` 확인 |
| 관측 차트 | revision 6 적용 2026-10-30 05:08:30 UTC, 05:25 UTC G8에서 revision 7 확인. revision 8은 05:29:19 UTC 적용되어 `deployed` 상태이며 05:32 UTC API의 source·안내문 대조를 통과했다 |

기존 고정 이미지와 입력을 재사용했다. backend 문서 병합은 이미지 게시 workflow를 실행하지만
Kubernetes workload를 자동 배포하지 않는다. 관찰 종료 후 실제 이미지·Pod·PVC 동일성은 아래 적용 전후 대조에서 확인했다.

### 코드·렌더링 검증

#87의 전체 회귀 범위는 46개 suite·1,301개 test다. 최초 실행에서 44개 suite·1,299개 test가 통과했고,
나머지 두 Helm schema 검사는 sandbox의 schema 다운로드 차단으로 실패했다. 네트워크를 허용한 동일 두 검사를
재실행해 모두 통과했으며 TypeScript build도 성공했다. 이 합산 결과를 한 번의 전체 실행 성공으로 해석하지 않는다.
고정 Helm 3.22.0·Promtool 3.9.1을 사용한 실제 렌더링과 rule 시험에서 정상 0,
미커밋만 존재, `1001 + 미커밋 4개`, 경계 1000, exporter 중단, 지표 누락,
group·cluster 분리와 `1000 초과·5분 지속` 경보를 확인했다. 빈 수집 결과는 정상 0으로 채우지 않는다.
#88·#89의 후속 표시 변경도 고정 도구를 사용한 두 suite·7개 test를 통과했고 각 PR의 CI가 성공했다.
격리 보존의 조기 삭제 방지 guard test 5개와 실제 실행의 구분은 보존 항목에 별도로 기록한다.

### 실제 고정 이미지

아래는 2026-10-30 05:09 UTC의 읽기 전용 Pod 캡처에서 추출한 digest다.
각 구성요소의 image 설정과 실행 imageID의 `sha256`가 일치했고 05:34:45 UTC revision 8 자원 대조와
06:01:18 UTC 최종 관찰 종료 대조에서도 그대로였다. registry·개인 ECR 계정·저장소 이름은 제외한다.

| 구성요소 | 설정 및 실행 imageID digest |
|---|---|
| Loki 3.7.8 | `sha256:1107dd5274e0ada47e42472b7a7e71f3b2a2fe878878108f3e2f9e51528f0193` |
| Tempo 3.1.0 | `sha256:3076b8dcdfb32fd6bc5ccef85e7b7313e6199b9cb84366257fc17ecb696db5fd` |
| Grafana 12.3.1 | `sha256:2175aaa91c96733d86d31cf270d5310b278654b03f5718c59de12a865380a31f` |
| Prometheus 3.9.1 | `sha256:1f0f50f06acaceb0f5670d2c8a658a599affe7b0d8e78b898c1035653849a702` |
| Collector 0.161.0 | `sha256:2fed8ff024bdb42473890724fa0833bd31e16197aa4790d8e0be3829f87f0de1` |
| Gateway | `sha256:9e9b2dbb9e9a70e9052241b92b311cf73e16bdbb1811e71eac2ae7e5c8124c48` |
| ingest | `sha256:98401de5ff8765da1f6ae306d5fd5f01eae267e8018e446214b2c6460265c55e` |

Loki·Tempo는 격리 보존 시험의 실제 실행 digest와도 같았다. 이 일치는 설정·실행 artifact의 동일성 근거이며 dev 전체 보존 기간의 재현 증거가 아니다.

## 재사용한 배포 증거

2026-10-29 [PROJ-285](https://team376.atlassian.net/browse/PROJ-285)에서 validation/main JWT 요청의
Gateway ACK→소유한 Kafka record→해당 record 이후 consumer commit→ClickHouse 논리 행을 확인했다.
main 30분 안정화 공개 요청 31회가 모두 HTTP 200·ClickHouse·commit 대조를 통과했고, sampled 요청에서는
producer/consumer 연결·ClickHouse child span 및 양 앱 Loki 로그를 확인했다.
이는 당시 소량 시험의 증거이며 아래 2026-10-30 배포 후 관찰과 다른 실행이다.

MSK와 전용 리소스의 철거는 [infra #85](https://github.com/soma-376/infra/pull/85) 및 PROJ-285에 기록됐다.
철거 후 요청 두 건은 unsampled이므로 해당 두 건의 trace 연결 성공을 주장하지 않는다.
2026-10-26 HTTP/k6·장애 격리·PVC 복구는 [PROJ-255](https://team376.atlassian.net/browse/PROJ-255)·
[PROJ-256](https://team376.atlassian.net/browse/PROJ-256)의 원래 범위에서 재사용한다.
원래 검증에는 Collector→Tempo 합성 3개 span, ingest·ClickHouse·관측 컨테이너의 실제 Loki 로그 유입,
동일 465개 로그의 CloudWatch/Loki 병행 배송, 한글·여러 줄 보존, Collector queue·동일 PVC 복구가 포함된다.
이는 과거 결과의 재사용이며 이번에 다시 시험한 결과나 전체 Kafka 경로 검증으로 확대하지 않는다.

## Kafka 지표와 Grafana 전수 점검

`pulsemetry:kafka_committed_lag:sum`은 exporter가 UP이고 offset·lag가 유효한 partition만 합산한다.
`pulsemetry:kafka_uncommitted_partitions:count`가 양수면 확인된 부분합이며 전체 backlog가 아니다.
미커밋 partition에는 아직 메시지를 받지 않은 partition도 포함된다. group 부재·수집 실패를 0으로 채우지 않는다.
2026-10-30 05:10 UTC 사전 조회는 main 6개 partition 중 미커밋 4개와 확인된 lag 0을 구분했다.

2026-10-30 05:25 UTC revision 7의 G8 조회는 query가 있는 패널 105개·target query 114개를
전체/서비스/Pod 선택과 15분/24시간의 6개 조합으로 대조한 684건이다.
DATA 573건, NO_DATA 111건이며 query error·pending·미확정은 모두 0이다.
NO_DATA는 미발생 21건, 미수집 22건(실행 미선택 18건·lazy counter 미생성 4건), 미지원 68건으로 구분했다.
미생성은 지원되는 event metric이 아직 노출되지 않은 상태이며 실측 0이 아니다.

모든 snapshot에서 target 60/60 UP이었고 lag Stat의 instant query와 과거 MSK 행의 현재 상태 표 제외를 확인했다.
현재 대시보드는 8개이며 텍스트 전용 MSK 이력 안내 1개를 별도 태그로 구분했다.
main의 확인된 lag는 조회 중 1에서 후속 조회 0으로 바뀌었고 미커밋 partition 4개는 별도 유지됐다.
이 변화는 실제 업무 진행의 일시 lag로 기록하며 고정 0을 완료 조건으로 두지 않는다.

revision 7 G8 API·분류 대조 후 발견한 Pipeline 안내문 한 곳의 구 CloudWatch 설명은 #89·revision 8에서 정정했다.
2026-10-30 05:32:43 UTC 최종 G8 API 대조는 PASS다. revision 7과 8의 query·변수·표시 계약 SHA256은
`a464b9dfdd85c0f59130bad71c8cc54215cdb8c693f471e9e6862315af0c9b84`로 같고,
render와 실제 Grafana API에서 변경이 Pipeline 안내문 한 곳뿐임을 확인해 위 684건 matrix를 재사용했다.
현재 대시보드 8개에 구 MSK·SumOffsetLag·STABLE/EMPTY 안내가 없고 MSK 이력 안내는 query 없는 별도 태그로 남는다.
이는 API·분류·표시 계약 검증이며 실제 브라우저 가독성 판정과 구분한다.
2026-10-30 05:33:20 UTC revision 8의 실제 UI도 PASS다. Pipeline의 Strimzi 안내문,
Overview/Pipeline/Kafka의 확인된 lag 0·미커밋 4 표시와 데이터 없는 과거 구간의 `미수집` 표시를 확인했다.
실제 업무로 생긴 일시 lag 1은 정상 0으로 덮지 않았다. k6 dropdown에는 기존 실행 두 개가 있었고
선택한 과거 실행 구간에서 RPS 0.217·p95 145ms를 화면으로 확인했다. 새 부하 실행 결과가 아니다.
선택한 과거 k6 실행의 RPS·p95 데이터는 조회됐지만 현재 15분/24시간 창 밖이다.
이 executor가 내지 않은 dropped-iterations counter는 실측 0으로 바꾸지 않는다.

## 실제 로그↔trace UI 왕복

2026-10-30 04:54:28 UTC에 PROJ-285의 main sampled 요청을 재사용했다.
Grafana Loki에서 Gateway·ingest 로그 2개 → Gateway derived field → Tempo의 2개 서비스·4개 span →
Gateway root span의 `Explore the logs` → 같은 trace의 Gateway accepted/200 로그로 돌아오는 UI 왕복을 통과했다.
새 트래픽을 생성하거나 API 응답만으로 UI 성공을 추정하지 않았다.
최종 revision 8 적용 뒤 2026-10-30 05:33:20 UTC에도 같은 요청을 사용해 실제 클릭 왕복을 다시 통과했다.
시작 로그 2개→Tempo 서비스 2개·span 4개→Gateway accepted/200 로그 1개로 돌아왔으며
공개 문서에는 trace ID·원문 로그·내부 Grafana 주소를 싣지 않는다.

## N5 허용·차단 대조

2026-10-30 04:45:56–04:47:36 UTC, N5만 실행했다. 허용 포트 5개는 OPEN,
Fluent Bit→Loki·Collector→Tempo·Gateway→Collector·ingest→Collector 기능 대조 4개는 OK였다.
비허용 경로 11개 중 8개는 NetworkPolicy 차단, 3개는 SG도 함께 차단하는 경로로 구분했다.
세 정책과 controller 데이터는 그대로였고 이 실행 소유 Job·Pod 잔존은 0이었다.
Collector failure 원천 query는 빈 vector였으므로 기능 대조 성공을 실패 counter 실측 0으로 표현하지 않는다.

## 보존 정책과 실제 삭제 검증

검증 범위는 **dev 설정·상태 확인 및 동일 버전 격리 환경의 자동 삭제 검증**이다.
실제 dev 실행 설정은 Loki 72h, Tempo scheduler·worker 48h다. Tempo worker의 누락된 보존 값은 #87에서 고쳤다.
정책 설정 검증과 삭제 동작 검증은 다음처럼 구분한다.

같은 고정 digest를 사용한 격리 filesystem 시험은 2026-10-30 04:55:52–05:04:30 UTC에 통과했다.
정책과 compaction 주기를 시험용으로 단축했고 보존 기간은 5분이었다. 현재 시각 fixture를 정상 경로로 넣어
274.157초까지 조회 가능·파일 존재·삭제 counter 0을 확인한 뒤 454.608초에 대상 chunk/block 파일 0개와
Loki·Tempo 삭제 counter 각각 1을 확인했다. 시계 변경·과거 시각 주입·delete API·판정 전 수동 파일 삭제는 사용하지 않았다.

파일 삭제 직후 Loki query는 cache 영향으로 PRESENT, Tempo는 ABSENT였다. 같은 저장소로 재시작한 뒤
Loki·Tempo 모두 세 번 연속 ABSENT였고 새 fixture는 조회됐다. 소유한 컨테이너·network는 정리됐다.
최종 조기 삭제 방지 guard는 이 실행 뒤 추가됐으며 저장된 43개 관찰 중 만료 전 27개를 재평가해 통과했다.
수정된 최종 runner를 다시 실행했다는 뜻은 아니다. 대응 guard 테스트 5개도 통과했다.

이 시험은 dev 특정 과거 파일의 물리 삭제, dev의 72h/48h 전체 기간 재현, secure erase,
모든 WAL byte의 포렌식 부재를 증명하지 않는다.

실제 dev의 최신 읽기 조회(2026-10-30 05:22:37 UTC)는 Loki·Tempo Ready 200,
Loki 72h·Tempo scheduler/worker 48h 및 tenant 보존 override 0개를 확인했다.
약 110.6–111.1시간 된 기존 fixture trace 4건은 모두 HTTP 200으로 각각 span 3개를 반환했다.
Tempo 기동 후 약 889초이며 retention job 주기 1시간·compacted block 유예 1시간·blocklist poll 5분이었다.
관측된 retention 작업·삭제·오류 counter는 당시 0이고 첫 주기 실행 전일 수 있다.
이 비동기 주기는 관측된 설정이며 특정 시각까지 물리 삭제를 보장하는 기한이 아니다.

Loki의 sweeper 성공 삭제 누계는 210이었지만 이 값으로 특정 fixture 삭제를 연결하지 않았다.
72시간을 넘은 기존 로그 fixture 두 건의 빈 조회에는 `max_query_lookback`이 적용되므로 물리 삭제 증거가 아니다.
조회된 Loki·Tempo 로그 범위 안에서 retention 오류는 없었으나 dev 과거 trace의 조회 부재나 특정 파일의 물리 삭제는
확인하지 못한 상태다. 새 데이터를 생성하거나 원문 trace 본문을 보존하지 않았으며,
이 상태를 격리 시험의 삭제 성공으로 덮지 않는다.

## 적용 전후 자원 대조

revision 6·Tempo 2 적용 전후 캡처에서 앱 자원 21개의 집합·UID·generation·spec은 같았다.
관측 자원 30개는 집합을 유지했고 Tempo StatefulSet 설정과 Tempo Pod 교체만 변경됐다.
PV 10개의 집합·UID·generation·spec은 같았다. 이 비교는 실제 rollback 실행 증거가 아니다.

2026-10-30 05:34:45 UTC revision 8 적용 후 자원 대조는 PASS다. source는
`8d230aa1ad77efdd2d6ae907ba1f5be7e1c13239`, release는 observability 8·Tempo 2·Loki 1·Collector 1로 확인했다.
Pod 26개·controller 15개·PVC 10개의 자원 집합을 유지했고 revision 6 이후 Pod UID·spec 추가 변경은 없었다.
모든 캡처 Pod는 Ready였으며 컨테이너 image 설정·실행 imageID와 Gateway/ingest sampling 0.1도 같았다.
Kafka PVC 3개를 포함한 PVC 10개의 UID·spec·PV 연결, PV 10개의 UID·spec·volume identity는 초기·revision 6과 같았다.

Loki·Tempo·Collector 수신 NetworkPolicy 3개의 UID·spec은 적용 전과 같았다. 현재 정책은 6개를 캡처했지만
직접 전후 비교에 사용할 기준선이 있는 정책은 이 3개다. deployment/runtime 입력과 Strimzi·`network-removed`
profile도 유지됐다. AWS SG 또는 MSK 물리 자원 전체를 새로 조사한 결과는 아니며 철거는 10/29 증거를 재사용한다.
revision 7→8의 dashboard 변경은 Pipeline 안내문 한 곳뿐이고 실제 내용은 검토한 candidate와 같았다.
Loki 실행 설정과 Tempo worker 보정 후 설정도 유지됐다. Helm hook은 종료됐고 최종 관찰 기준선에는 포함되지 않았다.
이 결과는 해당 시점의 적용 대조이며 아래 30분 관찰 결과와 별도로 기록한다.

최종 관찰이 끝난 뒤 2026-10-30 06:01:18 UTC 자원 대조도 PASS했다.
revision 8 시작 대비 자원 추가·제거·UID/spec 변경은 없었고 revision 6 이후에도 추가 변경은 없었다.
26개 Pod는 모두 Ready였으며 이미지 설정·실행 imageID, Gateway/ingest sampling 0.1을 유지했다.
PVC 10개·PV 10개는 UID·spec·volume identity와 연결을 보존했고 모두 Bound였다.
revision 8 시작 snapshot의 NetworkPolicy 6개 전체와 캡처한 ConfigMap 데이터도 같았다.
최초 N5 기준선과 비교할 수 있는 관측 정책은 3개였으며 이 6개 종료 비교와 혼동하지 않는다.
Loki·Tempo 실행 설정, 추적 deployment/runtime 입력과 네 release revision도 유지됐다.
현재 관측 Job은 없었다. AWS SG/MSK 전체 조사·Secret 읽기·workload 변경·새 트래픽은 수행하지 않았다.
배포 중 이력과 배포 후 안정화의 restart 기준선은 분리한다. 의도한 Tempo 재기동을 이후 무재시작 관찰에서 숨기지 않는다.

### 이번 변경의 복구 기준

표시 변경 복구는 `observability` revision 8에서 7로 되돌리는 범위다. Tempo는 worker 48h가 적용된 revision 2를 유지한다.
현재 Strimzi와 `network-removed` profile, 기존 PVC·이미지·Gateway/ingest tracing 설정을 보존한다.
옛 MSK retain 입력이나 Tempo revision 1로 되돌리지 않는다. 실제 rollback은 이번 검증에서 실행하지 않았다.

## 배포 후 30분 수동 트래픽 없는 관찰

**상태: PASS — revision 8 최종 실행은 2026-10-30 05:30:52.715–06:00:53.525 UTC, 1,800.808초·31표본이다.**
첫 표본은 05:30:53.713 UTC, 마지막 표본은 06:00:53.507 UTC였다.
10/29 공개 요청 31회와 다른 실행이다.
새 공개 트래픽을 만들지 않고 기존 업무 수집 증가를 확인하며 특정 요청 ID·Kafka record·ClickHouse 논리 행의
관통 정합성은 위 PROJ-285 증거를 재사용한다. 이번 counter 증가는 새 요청별 완전성 대조가 아니다.

이전 실행은 최종 결과와 합치지 않는다.

- revision 6 기준의 초기 관찰은 첫 표본 05:11:00 UTC부터 마지막 저장 표본 05:29:56 UTC까지 20개를 남기고 중단했다.
  후속 표시 배포를 포함하며 완료 result가 없으므로 30분 통과 증거가 아니다.
- revision 7 관찰은 05:21:32.932–05:29:33.800 UTC, 480.868초·통과 표본 8개 뒤 `pod/container identity changed`로 FAIL했다.
  실패 표본에는 revision 8 Helm의 `admission-create` hook 컨테이너 하나가 일시 추가됐고 기존 컨테이너 제거·restart 증가는 없었다.
  실제 업무 Pod 교체로 해석하지 않으며 이 FAIL을 삭제하거나 revision 8 최종 관찰 성공으로 바꾸지 않는다.
- hook 종료 후 새 기준선으로 revision 8 관찰을 시작했다. 앞선 실행 시간을 이어 붙이지 않고 최소 1,800초·31개 표본을 새로 요구한다.

| 항목 | 최종 실측값과 범위 |
|---|---|
| 시작·종료·duration·표본 수 | 2026-10-30 05:30:52.715–06:00:53.525 UTC / 1,800.808초 / 31표본 |
| source·Helm revision | `8d230aa1ad77efdd2d6ae907ba1f5be7e1c13239` / observability 8 / Tempo 2 / Loki 1 / Collector 1. 06:01:18 UTC 종료 상태 대조도 PASS |
| target·health·freshness | 모든 표본에서 60/60 target UP, health HTTP 200. 표본 시점 최대 scrape age 11.221초 |
| 업무 진행 | Gateway ACK +499 / ingest completed +499 / ClickHouse INSERT success +228. 서로 다른 counter 단위이며 요청별 행 정합성의 새 대조는 아님 |
| trace·로그 진행 | Collector sent spans +182 / Fluent Bit Loki 전용 sent +2,743. 전체 output sent +5,486과 구분 |
| 실패·drop·retry·restart | 관측된 Gateway failure·commit failure·retry exhausted·Fluent Bit error/retry/drop·Loki drop·restart 증가 모두 0. Collector failure·Tempo drop·ingest failure는 `null / not_emitted`. Pod UID/spec 변화 없음 |
| queue·PVC | Collector 최대·종료 queue 0/2,000, 최대 비율 0%. Fluent Bit output 최소 가용률 100%. PVC 10개 최소 가용률 80.4765% |
| lag 범위 | 확인된 lag 0–1, 종료 1. 전체 6 partition 중 미커밋 4개를 계속 별도 표시. 확인된 부분합이며 전체 backlog가 아님 |
| 최종 판정과 한계 | PASS, 실패 목록 없음. sampling 10%의 기존 저부하 업무를 관찰한 범위 |

실측 없는 lazy event counter는 `null / not_emitted`다. 이것을 정상 0 또는 실패 없음의 직접 측정으로 바꾸지 않는다.
낮은 기존 부하의 관찰은 최대 처리량·SLO, 무손실·exactly-once, 모든 요청의 sampling을 보장하지 않는다.
