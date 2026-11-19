# dev 부하 시험 k6 Job

[ADR 0064](../../../docs/adr/0064-dev-pipeline-loadtest.md)의 k6 Job 차트다. dev `pulsemetry-dev` 파이프라인에 계단식 부하를 걸고,
같은 Pod의 collector sidecar가 k6 지표를 `:9404`(포트 이름 `metrics`)로 내놓는다. 관측 차트의 PodMonitor가 pull한다.
커뮤니티 k6 대시보드용으로 같은 지표를 Prometheus remote write로도 보낸다([ADR 0065](../../../docs/adr/0065-dev-loadtest-k6-prometheus-remote-write.md)).
Argo 밖에서 `pulsemetry-loadtest` namespace에만 수동 helm(3.22.0)으로 설치한다. 다른 namespace면 렌더가 실패한다.
실행·정지·결과 추출·정리 절차는 [런북](../../../docs/runbooks/dev-pipeline-loadtest.md)이다.

## 입력

| 값 | 내용 |
|---|---|
| `testid` | 필수. `^[a-z0-9-]{3,40}$`. Job 이름 `loadtest-<testid>`, 지표의 `testid` 라벨 |
| `configMapName` | 필수. backend 커밋마다 만든 코드 ConfigMap. 키는 아래 표 |
| `seedSecretName` | 캠페인 Secret(기본 `loadtest-seed`). 키 `seed-secret`·`identities.json` |
| `scenario`·`startRps`·`stepRps`·`maxRps`·`ramp`·`stepHold`·`cooldown`·`finalFlush`·`holdRps`·`holdDuration`·`mixSignal`·`mixProduct`·`gzip` | k6 env 와 1:1(backend `tools/loadtest/README.md`). `finalFlush`(기본 25s)는 끝난 뒤 마지막 지표가 수집되도록 기다리는 시간이다 |
| `images.k6`·`images.collector` | digest 고정 필수. [`tests/arm64-images.json`](tests/arm64-images.json) 증거와 같은 값 |
| `activeDeadlineSeconds` | 없으면 계획 시간 + 600초. 주면 그 이상이어야 한다 |
| `prometheusRemoteWrite.enabled`·`url`·`pushInterval` | 기본 켬·관측 Prometheus 내부 주소·5s. native histogram·stale marker를 쓴다. 끄면 OTel 출력만 남는다 |

렌더가 거부하는 것: 다른 namespace, testid·configMapName 없음, digest 없는 이미지, RPS 1000 초과,
계획 시간 10200초(telemetry JWT 3h − 600s) 초과, hold 의 holdRps 없음, 계획 시간 + 600 미만의 deadline,
`http://<host>[:port]/api/v1/write` 꼴이 아닌 remote write 주소, 초 단위가 아닌 push 간격.
계획 시간은 smoke 60초, stair `단계 수 × (ramp + stepHold) + cooldown`, hold `holdDuration`이다(k6 `lib/schedule.js`와 같은 계산).

| ConfigMap 키 | 마운트 경로 |
|---|---|
| `main.js` | `/scripts/main.js` |
| `lib.{config,schedule,payload,auth,summary}.js` | `/scripts/lib/<이름>.js` |
| `data.templates.json` | `/scripts/data/templates.json` |

## Pod

- apps NodePool(`pulsemetry-dev-apps`, arm64), Gateway·ingest Pod가 있는 노드는 필수 anti-affinity로 피한다. `karpenter.sh/do-not-disrupt`.
- `backoffLimit: 0`, `ttlSecondsAfterFinished: 86400` — 끝난 뒤 하루 안에 `kubectl logs … -c k6`로 summary 블록을 회수한다.
- collector는 native sidecar(`initContainers` + `restartPolicy: Always`)다. k6가 끝나면 함께 끝난다.
  OTLP는 루프백 `127.0.0.1:4318`만 받는다. kubelet 은 Pod IP 로 확인하므로 startup probe 는 4318 이 아니라 health_check 확장
  (`:13133`, HTTP)을 본다 — 모든 pipeline 이 뜬 뒤에만 200 이라 k6 의 첫 지표를 잃지 않는다. Service 는 없다.
- k6 REST API는 `127.0.0.1:6565`에만 연다(`k6 status`로 상태를 본다). 도착률 실행기는 시작 뒤 pause를 지원하지 않는다.
  멈출 때는 `kubectl exec <pod> -c k6 -- kill -INT 1` — summary 블록을 쓰고 종료 코드 105로 끝난다([런북 §6](../../../docs/runbooks/dev-pipeline-loadtest.md#6-정지-조건과-정지-방법)).
- restricted PSA: runAsNonRoot(k6 12345·collector 10001), seccomp RuntimeDefault, 권한 상승 금지, capability 전부 제거,
  읽기 전용 root filesystem, `/tmp`만 emptyDir. 시드 Secret은 0440 + fsGroup 12345.
- ServiceAccount 토큰을 마운트하지 않는다. Service·Ingress를 만들지 않는다.

## 실행 순서

1. 캠페인 시드(backend 생성기 → DB 터널 psql) → `pulsemetry-loadtest` namespace(PSA restricted)·캠페인 Secret·코드 ConfigMap.
2. `helm install loadtest-<testid> helm/dev/loadtest -n pulsemetry-loadtest --set testid=… --set configMapName=… --set seedSecretName=… [--set scenario=…]`
   — smoke → stair(②) → 배수 → `drain-plan`으로 MAX → stair(①) → (선택) hold. 실행마다 새 testid.
3. 배수 대기 → `kubectl logs job/loadtest-<testid> -c k6`로 summary 회수 → `scripts/loadtest-results-export.mjs` → release uninstall.

명령 전체와 정지·정리 기준은 [런북](../../../docs/runbooks/dev-pipeline-loadtest.md)이다.

## 검증

```bash
HELM_BIN=… KUBECONFORM_BIN=… PROMTOOL_BIN=… npx jest test/helm/loadtest-chart.test.ts --runInBand
```

렌더·kubeconform strict(1.36)·거부 사례·sidecar·anti-affinity·이미지 digest 대조를 본다. 클러스터 적용 결과의 증거가 아니다.
