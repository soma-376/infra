# 0059. dev API 앱도 관리 포트 scrape와 플랫폼 trace 송신자에 포함한다

## Status

Proposed ([PROJ-324](https://team376.atlassian.net/browse/PROJ-324)) — backend ADR 0079(Proposed)와 짝이다.
채택되면 다음 두 문장의 대상을 enrollment-api·dashboard-api까지 넓힌다.

- [ADR-0037](0037-dev-observability-and-system-diagnostics.md): 내부 management 9404 scrape 대상
- [ADR-0039](0039-dev-loki-tempo-and-platform-trace-collector.md)(Proposed): "대상은 Gateway·ingest뿐이다", "Collector는 4318을 Gateway·ingest에게"

두 ADR의 나머지(관측 NodePool, 고정 Collector 주소, 속성·예외 정리, 수신 NetworkPolicy 방식, 보존)는 그대로 적용한다.
채택 전까지는 0037·0039가 기준이다.

## Context

- enrollment-api·dashboard-api의 로그는 이미 Fluent Bit이 CloudWatch와 Loki로 보낸다(`service_name=<workload>`).
- 지표와 trace는 없다. spring-app chart가 두 앱의 `metrics.enabled`·`tracing.enabled`를 렌더 단계에서 거부한다.
  ServiceMonitor 목록, Collector 수신 정책, 검증기의 허용 표, NetworkPolicy probe도 Gateway·ingest만 안다.
- backend ADR 0079가 두 앱에 관리 포트 9404(`GET /actuator/prometheus`만)와 기본 꺼진 플랫폼 trace를 Gateway·ingest와 같은 규칙으로 더한다.
  설정 키·서비스 이름(`enrollment-api`·`dashboard-api`)·고정 Collector 주소는 backend ADR 0069의 계약 그대로다.
- apps 노드 SG는 관측 SG로 9404 scrape와 4318 전송을 이미 연다(`lib/dev/network-stack.ts`). 송신자 제한은 SG가 아니라 수신 NetworkPolicy가 맡는다.
- 2026-11-06 dev 개요 1년 조회(5~7초)를 실측할 때 서버 내부 구간을 지표나 trace로 나눌 수 없었다.

## Decision

### 지표

- spring-app chart의 metrics 허용 목록을 네 앱으로 넓힌다. 생성기가 enrollment·dashboard에 `metrics.enabled`와
  `PULSEMETRY_OBSERVABILITY_ENVIRONMENT=dev`를 공급한다.
- 관측 chart의 앱 ServiceMonitor에 두 앱을 더한다. 경로·10초 간격·relabel·ID label 삭제는 Gateway·ingest와 같다.
- 수집 상태 기록 규칙(`pulsemetry:collection_*`)에 두 앱을 더하고 상세 화면은 새 `Pulsemetry · API`다.
  지표 부재 경보(`EnrollmentApiMetricsUnavailable`·`DashboardApiMetricsUnavailable`)를 더한다.
  5xx·지연 경보는 dev 기준선을 본 뒤 정한다.

### trace

- spring-app chart의 tracing 허용 목록과 생성기 공급 대상을 네 앱으로 넓힌다. sampling은 같은 runtime 값(dev 0.1)을 쓴다.
- otel-platform `ingressPolicy`의 4318 송신자에 `pulsemetry-dev`의 `app.kubernetes.io/name=enrollment-api`·`dashboard-api`를 더한다.
  0039의 절차대로 검증기의 허용 표와 probe의 기능 대조를 함께 고친다.
- 두 앱의 Pod label은 spring-app chart의 workload 값에서 유도한다. 2026-10-25 dev 조회 label fixture는 그때의 기록으로 두고 고치지 않는다.
  live label은 NetworkPolicy probe(N5)로 확인한다.

### Grafana

- 새 대시보드 `pulsemetry-api`: route별 요청률·5xx 비율·p95·2.5초 초과 비율, Hikari 풀, JVM·Tomcat·GC.
  로그 패널은 두지 않는다. 지표 화면의 10초 갱신을 유지하고, 패널 링크로 진단 로그와 trace 화면에 간다.
- 진단·수집 건강·trace 화면의 서비스 변수와 Overview·Health의 target 목록에 두 앱을 더한다. 수집 경로 화면(Gateway·Pipeline·Kafka·ClickHouse)은 그대로다.

### 범위

- dev만이다. perf는 enrollment에 metrics를 켜지 않는다. dashboard-api는 perf에 없다. prod ECS는 바꾸지 않는다.

## Alternatives Considered

### A. ADR-0039 본문을 직접 고친다
- 장점: 송신자 목록이 문서 하나에 모인다.
- 단점: 0039는 PROJ-256의 결정 기록이고 Proposed다. 다른 티켓의 범위 확장이 섞여 추적이 어렵다.
- 탈락 이유: 확장을 별도 ADR로 두고 0039·인덱스에서 링크한다.

### B. API 앱 로그를 새 대시보드에 Loki 패널로 둔다
- 장점: 한 화면에서 지표와 로그를 본다.
- 단점: 검증기 규칙상 로그 패널이 있으면 갱신이 1분·15분 범위로 바뀐다. 지표 화면의 10초 갱신과 맞지 않는다.
- 탈락 이유: 진단 화면 링크로 같은 시간·서비스·Pod의 로그를 연다.

### C. dev label fixture에 두 앱 label을 더한다
- 장점: 네 앱이 같은 출처로 대조된다.
- 단점: fixture는 특정 시각의 live 조회 기록이다. 조회하지 않은 값을 섞으면 기록의 의미가 바뀐다.
- 탈락 이유: Gateway처럼 workload 값에서 유도하고 live는 probe로 본다.

## Consequences/Tradeoffs

### Positive

- 네 앱의 HTTP·JVM·커넥션 풀 지표와 trace를 같은 Grafana에서 본다.
- Overview 수집 상태 표에 두 API가 나타나고, 지표가 끊기면 경보가 난다.
- dashboard 요청의 ClickHouse 구간과 나머지 구간을 trace로 나눠 본다.

### Negative

- Prometheus series와 Tempo span이 는다(route × status × 버킷, sampled 요청).
- 두 앱의 Pod template이 env·포트 변경으로 한 번 재생성된다(replica 1·`Recreate`라 짧은 중단이 있다).
- backend 이미지가 관리 포트를 열기 전에 이 chart를 적용하면 target이 down이고 경보가 난다. backend 이미지 → Collector 정책 → 앱 release → 관측 release 순서로 적용한다.
- 송신자가 넷이 되어 probe의 Collector 4318 판정은 네 앱 모두 실제 trace가 있어야 OK다.

## Follow-up

- dev 기준선(요청률·p95·5xx)을 본 뒤 경보 임계값을 정한다.
- 허브 계약 이관은 0039·backend 0069의 후속과 함께 한다.

## Acceptance Criteria

- Prometheus에서 `enrollment-api`·`dashboard-api` target이 UP이고 `Pulsemetry · API`가 실제 요청으로 채워진다.
- 두 앱의 sampled 요청이 Tempo에 있고, Grafana에서 로그↔trace를 왕복한다. span에 조직 ID·URL·SQL이 없다.
- 기존 Gateway·ingest target·trace·대시보드와 NetworkPolicy 허용·차단 판정에 회귀가 없다.

## References

- backend ADR 0068·0069·0079 (`soma-376/pulsemetry-backend` `docs/adr/`)
- [관측 런북](../runbooks/dev-observability.md)
