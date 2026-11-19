# 0065. dev 부하 시험 k6는 Prometheus remote write로도 지표를 보낸다

## Status

Proposed ([PROJ-337](https://team376.atlassian.net/browse/PROJ-337), PROJ-192 하위). 채택되면 다음 문장을 바꾼다.

- [ADR 0064](0064-dev-pipeline-loadtest.md)(Proposed) 결정 3의 "remote write·push gateway는 쓰지 않는다",
  "SG·NetworkPolicy·공개 Ingress를 더하지 않는다"와 탈락 대안 C
- [ADR 0039](0039-dev-loki-tempo-and-platform-trace-collector.md)(Proposed) 통신 절의 "다음 두 규칙만 더한다",
  "세 release가 각자 `Ingress` 정책 하나를 둔다"

0064의 sidecar collector → `:9404` → PodMonitor pull 경로와 0039의 나머지(수신 정책 방식, 검증·live 시험 절차)는 그대로다.
채택 전까지는 0039·0064가 기준이다.

## Context

- PROJ-192의 k6 지표는 OTel 출력 → sidecar collector → Prometheus pull이다. prometheus exporter가 단위 접미사를 붙여
  이름이 `k6_http_req_duration_milliseconds_bucket` 꼴이다.
- grafana.com의 k6 커뮤니티 대시보드는 k6 Prometheus 출력의 이름을 전제로 한다. 2026-11-19 대조에서
  18030(Native Histograms)은 지표 14개 중 3개, 19665는 18개 중 3개만 맞았다.
- k6의 Prometheus 출력은 push(remote write)뿐이다. scrape 엔드포인트가 없다.
- dev Prometheus 3.9.1은 remote write 수신(`enableRemoteWriteReceiver`)과 native histogram을 이미 켜 두었다.
  운영자 port-forward와 perf runner가 쓰는 경로이고, k6 1.8.2 native histogram 호환은 로컬 증거가 있다(`helm/observability/tests/remote-write/`).
- k6 Pod는 apps 노드에 뜬다. apps 노드 SG → 관측 SG는 3100·4318만 열려 있어 Pod에서 Prometheus 9090에 닿지 않는다.
- SG는 노드 단위이고 remote write 수신에는 인증이 없다(ADR 0039). SG만 열면 apps 노드의 모든 Pod가 Prometheus를 조회하고 임의 시계열을 쓸 수 있다.

## Decision

1. **k6 Job에 `experimental-prometheus-rw` 출력을 더한다.** OTel 출력과 함께 쓴다.
   - 주소 `http://pulsemetry-monitoring-prometheus.pulsemetry-observability.svc:9090/api/v1/write`, native histogram,
     5초 push, stale marker다. 관측 차트 README의 운영자 경로와 같은 설정이다.
   - 차트 값 `prometheusRemoteWrite.enabled`(기본 켬)로 끈다. 꺼도 sidecar 경로는 그대로다.
   - 판정·결과 추출·`Pulsemetry · 부하 시험` 대시보드·기록 규칙은 기존 sidecar 이름을 그대로 쓴다. 단계별 p95·오류율·drop은 k6 summary다.
2. **apps 노드 SG → 관측 SG TCP 9090 규칙 하나를 더한다**(NetworkStack).
3. **Prometheus에 수신 NetworkPolicy `pulsemetry-prometheus-ingress`를 둔다.** 관측 차트의 dev values에서만 켠다. 기본·perf 렌더는 바뀌지 않는다.
   - 9090은 Grafana(`pulsemetry-observability`)와 k6 Pod(`pulsemetry-loadtest`, `app.kubernetes.io/name=pulsemetry-loadtest-k6`)에게만 연다.
   - Prometheus 자신은 모든 포트에 닿는다(자기 scrape·config-reloader).
   - 송신 정책은 두지 않는다. 운영자 port-forward와 `kubectl exec` 조회는 정책 대상이 아니다.
   - 검증기의 허용 표와 N5 probe 대상에 Prometheus 9090을 더한다.
4. **커뮤니티 대시보드는 사람이 Grafana에서 import한다.** 관측 차트에 넣지 않는다.

## Alternatives Considered

### A. remote write로 교체한다(sidecar·PodMonitor 제거)
- 장점: k6 지표 경로가 하나다.
- 단점: 결과 추출·기록 규칙·대시보드·검증기·fixture와 backend 로컬 E2E의 지표 이름을 전부 바꿔야 한다.
- 탈락 이유: 대시보드 하나를 위해 검증한 판정 경로를 다시 만들지 않는다.

### B. 커뮤니티 대시보드를 import한 뒤 쿼리를 고친다
- 장점: SG·정책 변경이 없다.
- 단점: 원본이 바뀔 때마다 다시 고쳐야 하고, 고친 쿼리를 검증할 곳이 없다.
- 탈락 이유: 원본 대시보드를 그대로 쓰기로 했다.

### C. SG만 열고 NetworkPolicy는 두지 않는다
- 장점: 변경이 가장 작다.
- 단점: 인증 없는 remote write와 조회가 apps 노드의 모든 Pod에 열린다.
- 탈락 이유: ADR 0039의 송신자 제한 원칙을 어긴다.

## Consequences/Tradeoffs

### Positive
- 커뮤니티 k6 대시보드(18030)를 수정 없이 쓴다.
- Prometheus 9090의 송신자가 처음으로 명시된다. 지금은 관측 노드의 모든 Pod가 닿는다.

### Negative
- 같은 k6 지표가 두 이름 체계로 저장된다. 시계열 수와 k6 CPU가 조금 는다.
- 허용 송신자인 k6 Pod는 Prometheus에 임의 시계열을 쓸 수 있다. 같은 namespace·label의 Pod도 마찬가지다.
- 정책이 틀리면 Grafana 조회가 멈춘다. 배포 뒤 N5와 Grafana 화면으로 확인한다.
- remote write가 실패해도 k6는 시험을 계속하고 로그만 남긴다. 커뮤니티 대시보드가 비면 SG·정책부터 본다(런북).
- 다른 namespace에서 Prometheus를 부르는 구성을 더하려면 정책에 송신자를 함께 더해야 한다.

## Follow-up

- dev 반영 뒤 관측 런북의 N5로 Prometheus 9090 허용·차단을 확인하고, smoke 1회로 18030 화면을 확인한다.
- 0039·0064와 함께 팀 동의.

## Acceptance Criteria

- dev Network 합성에 apps → 관측 9090 규칙이 하나 있고, 9090을 CIDR에 열지 않는다.
- 관측 차트는 dev 렌더에만 `pulsemetry-prometheus-ingress`가 있고, 검증기가 송신자를 실제 Pod label과 대조한다.
- loadtest 차트 렌더에 두 출력과 remote write 환경 변수가 있고, 끄면 OTel 출력만 남는다.
- 로컬에서 k6 1.8.2 → Prometheus 3.9.1 remote write로 대시보드 18030의 지표가 생긴다. `k6_checks_rate`는 시나리오가 check를 쓰지 않아 없다.

## References

- [ADR 0039](0039-dev-loki-tempo-and-platform-trace-collector.md), [ADR 0064](0064-dev-pipeline-loadtest.md)
- `helm/observability/README.md`의 k6 연결 절, `scripts/observability-networkpolicy-probe.mjs`
- grafana.com 대시보드 18030 "k6 Prometheus (Native Histograms)", k6 Prometheus remote write 문서
