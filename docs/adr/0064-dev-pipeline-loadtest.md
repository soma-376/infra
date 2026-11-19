# 0064. dev 파이프라인에 직접 계단식 부하를 걸고 k6 지표는 sidecar에서 pull한다

## Status

Proposed (PROJ-192; 코드·로컬 검증 범위. 팀 동의·dev 실행 시간대 공지 전이며 실제 dev 부하 실행은 별도다.)

부하 발생 도구(시드·payload·k6 시나리오)는 backend ADR 0082가 정한다. 이 ADR은 환경·배포·관측만 정한다.

결정 3의 "remote write를 쓰지 않는다"와 탈락 대안 C는 [ADR 0065](0065-dev-loadtest-k6-prometheus-remote-write.md)(Proposed)가 개정을 제안한다. sidecar pull 경로는 그대로다.

## Context

[PROJ-192](https://team376.atlassian.net/browse/PROJ-192)는 Gateway → Kafka → ingest → ClickHouse의 한계를 두 층으로 찾는다.
① Gateway 수용(HTTP를 받아 Kafka에 넣는 속도), ② 파이프라인 지속 처리(consumer lag이 쌓이지 않는 최대 속도)다.
대상 사양은 [ADR 0063](0063-dev-pipeline-resource-sizing.md)의 Gateway·ingest 각 1 replica, apps `t4g.large`, ClickHouse `m7g.large`다.

- 격리 perf 환경은 [ADR 0052](0052-perf-budget-and-independent-cleanup.md)에 따라 최대 20 RPS·실행당 600초·총 10,000요청이다. 한계를 찾을 수 없다.
- dev 파이프라인을 복제하려면 Pod Identity 연결, Strimzi가 감시하는 namespace, 관측 ServiceMonitor 선택자, Argo CD 카탈로그의
  Application·namespace 목록을 함께 늘려야 한다. CDK(`lib/`)와 GitOps 선언을 시험 하나 때문에 바꾸게 된다.
- 관측 차트에는 k6 지표 경로가 없다. 고정 collector 이미지(`otel/opentelemetry-collector-k8s`)에는 prometheus exporter가 없다.
- apps 노드 SG는 이미 관측 SG의 9404를 받는다(`network-stack.ts`, Gateway·ingest 지표용). 관측 인그레스 경계는 [ADR 0039](0039-dev-loki-tempo-and-platform-trace-collector.md)가 정한다.

결정하지 않으면 한계를 perf 상한 아래에서만 보거나, 시험마다 환경 복제로 CDK·GitOps 변경이 생긴다.

## Decision

1. **대상은 dev `pulsemetry-dev` 파이프라인 그 자체다.** 복제 namespace·새 Kafka·새 ClickHouse를 만들지 않는다.
   부하 데이터는 캠페인마다 전용 tenant로 나눈다(backend ADR 0082). 격리 perf 환경의 코드와 상한은 그대로 둔다.
2. **k6 Job은 Argo 밖에서 수동 helm으로 설치한다.** 차트는 `helm/dev/loadtest`, namespace는 `pulsemetry-loadtest`(PSA restricted)다.
   - apps NodePool(`pulsemetry-dev-apps`)에 두고, Gateway·ingest가 있는 노드에는 놓지 않는다(필수 Pod anti-affinity, hostname).
   - `karpenter.sh/do-not-disrupt`로 실행 중 노드 교체를 막는다. `backoffLimit: 0`, 계획 시간 + 600초의 `activeDeadlineSeconds`다.
   - 요청은 클러스터 안 Service로 보낸다(Gateway `:8082`, 토큰 교환 enrollment-api `:8080`). ALB·WAF는 거치지 않는다.
   - 코드는 backend 커밋마다 ConfigMap, 시드 비밀·identities는 캠페인마다 Secret이다.
3. **k6 지표는 sidecar collector → `:9404` → Prometheus pull이다.**
   - 같은 Pod의 native sidecar에서 core 배포판 `otel/opentelemetry-collector`(prometheus exporter 포함)를 돌린다. k6는 OTLP HTTP `127.0.0.1:4318`로 보낸다.
   - 관측 차트에 `pulsemetry-loadtest`를 고르는 PodMonitor(포트 `metrics`, 10s)를 dev values에서만 켠다. remote write·push gateway는 쓰지 않는다.
   - SG·NetworkPolicy·공개 Ingress를 더하지 않는다. 기존 apps SG의 9404 허용과 ADR 0039의 경계를 그대로 쓴다.
4. **대시보드 `Pulsemetry · 부하 시험` 하나를 관측 차트에 더한다.** k6·Gateway·Kafka·ingest·ClickHouse·JVM·자원을 `testid`로 한 화면에 둔다.
5. **판정과 정리.** 결과 추출 스크립트가 hold 구간별 Prometheus 질의로 두 층을 판정한다. 배수(lag 0) 뒤 캠페인 설치를 폐기하고 Job·ConfigMap·Secret을 지운다.
   ClickHouse 데이터 삭제 여부는 팀이 정한다(retention-worker로 지우면 그 tenant는 재사용할 수 없다).

## Alternatives Considered

### A. dev 파이프라인 복제 namespace
- 장점: 기존 dev 수집과 섞이지 않는다.
- 단점: Pod Identity·Strimzi 감시 namespace·ServiceMonitor·Argo 카탈로그를 바꿔야 한다. 복제본의 노드·저장소 배치가 원본과 다르면 측정값이 원본 한계가 아니다.
- 탈락 이유: 시험을 위해 CDK·GitOps를 바꾸고, 측정 대상도 dev 그 자체가 아니게 된다.

### B. 격리 perf 환경의 상한을 올린다
- 장점: dev 수집에 영향이 없다.
- 단점: 예산·정리 계약(ADR 0050·0052)을 다시 정해야 하고 환경 생성·삭제 비용이 시험마다 든다.
- 탈락 이유: 이번 목적은 현재 dev 사양의 한계다.

### C. k6가 Prometheus remote write로 보낸다
- 장점: sidecar가 없다.
- 단점: Prometheus에 remote write 수신을 켜야 하고 관측 인그레스가 넓어진다.
- 탈락 이유: 기존 pull 경로와 SG로 충분하다.

## Consequences/Tradeoffs

### Positive
- 현재 dev 사양 그대로의 두 층 한계를 같은 대시보드·같은 판정 식으로 얻는다.
- CDK·SG·Argo 카탈로그를 바꾸지 않는다. Job은 설치·삭제가 자유롭다.

### Negative
- 시험 중 dev 수집이 늦어지거나 멈출 수 있다. 다른 사용자의 dev 데이터 지연을 감수한다.
  - 시간대를 공지하고, 배수 예산(제안 1시간)으로 최대 RPS를 정한다. k6 안전 정지와 사람의 정지 조건을 함께 둔다.
- apps `t4g.large`는 CPU credit이 있는 버스트형이다. credit이 0이 됐을 때 standard 모드면 CPU가 기준선에 묶이고, unlimited 모드면 묶이지 않는 대신 초과분이 과금된다. dev apps 노드는 unlimited다(2026-11-19 확인). 모드와 과금은 CloudWatch로 따로 본다(런북 §11).
- ② 위의 부하는 backlog를 남긴다. 배수가 끝날 때까지 다음 실행을 시작할 수 없다.
- 부하 tenant 데이터가 dev ClickHouse 저장 공간을 쓴다. 실행 전 PVC 여유를 확인한다.

## Follow-up

- 팀 동의(backend ADR 0082와 함께), dev 사용 시간대 공지, 배수 예산 상한, 판정 임계값, 데이터 정리 방식.
- 측정 결과로 scaling·JVM·사양을 바꿀 때는 별도 ADR(0063 개정 등)로 한다.

## Acceptance Criteria

- `helm/dev/loadtest` 렌더가 namespace·digest·계획 시간·anti-affinity 조건을 강제하고 kubeconform strict를 통과한다.
- dev values 렌더에만 k6 PodMonitor가 있고, 대시보드 검증기가 k6 지표 이름을 로컬 E2E fixture와 대조한다.
- 실제 dev 실행·결과는 런북(`docs/runbooks/dev-pipeline-loadtest.md`)의 기록으로 남기며 이 ADR의 완료 조건이 아니다.

## References

- [ADR 0039](0039-dev-loki-tempo-and-platform-trace-collector.md), [ADR 0052](0052-perf-budget-and-independent-cleanup.md), [ADR 0063](0063-dev-pipeline-resource-sizing.md)
- backend ADR 0082(부하 시험 도구와 부하 tenant), backend ADR 0065(telemetry JWT), backend `tools/loadtest/README.md`
- `lib/dev/network-stack.ts`의 apps SG 9404 규칙
