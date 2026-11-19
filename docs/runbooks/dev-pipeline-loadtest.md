# dev 파이프라인 부하 시험

PROJ-192. [ADR 0064](../adr/0064-dev-pipeline-loadtest.md)·backend ADR 0082를 따른다. dev `pulsemetry-dev` 파이프라인(Gateway → Kafka → ingest → ClickHouse)에
k6 계단식 부하를 걸어 ① Gateway 수용 한계와 ② 파이프라인 지속 처리 한계를 찾는다. 판정 기준은 §8에 있다.

**이 문서의 명령은 운영자가 직접 실행한다.** 시험 중 dev 수집이 늦어지거나 멈출 수 있다. 시간대를 공지하고 시작한다.
코드·렌더링 테스트 통과는 실제 실행·한계 측정의 증거가 아니다.

| 구성 | 위치 |
|---|---|
| 시드 SQL·payload·k6 시나리오·로컬 E2E | backend `tools/loadtest/`([안내](../../../pulsemetry-backend/tools/loadtest/README.md)) |
| k6 Job 차트 | `helm/dev/loadtest`([안내](../../helm/dev/loadtest/README.md)) — Argo 밖 수동 helm |
| PodMonitor·대시보드 `Pulsemetry · 부하 시험` | 관측 차트(Argo). PodMonitor는 dev values, 대시보드는 Strimzi 렌더에만 있다 |
| 결과 추출·판정·배수 계획 | `scripts/loadtest-results-export.mjs` |

공통 변수(레포 밖 작업 디렉터리를 쓴다):

```bash
: "${RUN_DIR:?레포 밖 작업 디렉터리}"
: "${KUBECONFIG:?EKS 터널용 별도 kubeconfig(dev-eks-manual-deployment.md 2-3)}"
: "${EKS_CLUSTER_NAME:?dev EKS 클러스터 이름}"
BE=../pulsemetry-backend                 # develop 의 backend 체크아웃
T=$HOME/.cache/proj192-tools             # helm 3.22.0 (시스템 helm v4 를 쓰지 않는다)
CAMPAIGN=pipeline-20261120               # ^[a-z0-9-]{3,40}$, 캠페인마다 새로
C="$RUN_DIR/loadtest/$CAMPAIGN"; mkdir -p "$C" && chmod 700 "$C"
```

## 1. 준비 확인

- PodMonitor·대시보드가 develop에 머지되고 Argo가 반영했다.

  ```bash
  kubectl -n argocd get application pulsemetry-dev-observability -o jsonpath='{.status.sync.status} {.status.health.status}{"\n"}'
  kubectl -n pulsemetry-observability get podmonitor pulsemetry-loadtest-k6
  ```

  Grafana(`kubectl -n pulsemetry-observability port-forward --address 127.0.0.1 service/pulsemetry-grafana 3000:80`)에서 `Pulsemetry · 부하 시험`이 보이는지 본다.
- 실제 사양이 [ADR 0063](../adr/0063-dev-pipeline-resource-sizing.md)과 같다. 다르면 결과에 그 사양을 적는다(결과 추출의 `config.json`이 남긴다).

  ```bash
  kubectl -n pulsemetry-dev get deploy telemetry-gateway telemetry-ingest \
    -o jsonpath='{range .items[*]}{.metadata.name} replicas={.spec.replicas} {.spec.template.spec.containers[0].resources}{"\n"}{end}'
  kubectl -n pulsemetry-dev get sts clickhouse -o jsonpath='{.spec.template.spec.containers[0].resources}{"\n"}'
  kubectl get nodes -L karpenter.sh/nodepool,node.kubernetes.io/instance-type
  ```

- apps 노드 여유: k6 Pod(요청 1.1 CPU·1.1Gi)는 Gateway·ingest가 없는 apps 노드에만 뜬다. 없으면 Karpenter가 노드를 더한다(apps CPU 예산 8).
  `kubectl describe nodes -l karpenter.sh/nodepool=pulsemetry-dev-apps | grep -A8 'Allocated resources'`
- ClickHouse PVC 여유가 충분하다(80% 미만 유지): `kubectl -n pulsemetry-dev exec statefulset/clickhouse -- df -h /var/lib/clickhouse`
- 시작 전 consumer lag이 0이다(대시보드 `확인된 commit 기준 lag`).
- dev 사용 시간대를 공지했다. 다른 사람의 dev 수집이 늦어질 수 있다.

## 2. 시드 비밀과 캠페인

```bash
(set -C; umask 077; openssl rand 32 > "$C/seed-secret")   # 정확히 32바이트 원시 값(-hex 아님). 이미 있으면 덮어쓰지 않고 실패한다
```

시드 비밀은 저장소·채팅·티켓에 넣지 않는다. 캠페인마다 새로 만든다. 잃으면 그 캠페인의 설치 토큰을 다시 만들 수 없다 — 새 캠페인으로 시드한다.

## 3. 시드 적용

PostgreSQL 터널은 [DB 접근 런북](dev-database-access.md) §2대로 연다(기본 `127.0.0.1:15432`). DB 계정은 기존 방식대로 클라이언트에서만 쓴다.

생성기가 성공했을 때만 psql 을 실행한다(`&&`). 파이프(`… | psql`)는 생성기 실패를 빈 입력의 psql 성공으로 가린다.
어느 줄이든 0이 아닌 종료 코드로 끝나면 다음 단계(§4)로 가지 않는다.

```bash
# TLS 검증을 끄지 않는다 — 원래 RDS hostname 과 CA 번들로 검증하고 접속만 터널로 보낸다(DB 접근 런북 §2).
PGURL="host=<원래 RDS hostname> hostaddr=127.0.0.1 port=15432 dbname=controlplane user=<계정> sslmode=verify-full sslrootcert=<RDS CA 번들>"
python3 "$BE/tools/loadtest/generator/seed_sql.py" --campaign "$CAMPAIGN" --installations 60 --partitions 6 \
  --secret-file "$C/seed-secret" --identities-out "$C/identities.json" > "$C/seed.sql" \
  && psql "$PGURL" -v ON_ERROR_STOP=1 -f "$C/seed.sql"            # 생성기 stderr: tenant ID, partition 분포 10×6
python3 "$BE/tools/loadtest/generator/seed_sql.py" --campaign "$CAMPAIGN" --installations 60 --partitions 6 \
  --secret-file "$C/seed-secret" --verify > "$C/verify.sql" \
  && psql "$PGURL" -v ON_ERROR_STOP=1 -At -f "$C/verify.sql"       # 8행 모두 t. 하나라도 f 면 오류로 끝난다(종료 코드 3)
```

같은 입력은 다시 적용해도 안전하다. 다음은 SQL이 롤백된다 — 설치 수 변경·폐기한 캠페인은 새 캠페인 ID를, 다른 비밀이면 처음 쓴 비밀 파일을 쓴다.
기존 캠페인과 설치 집합이 다르다(INSERT 전 검사), 설치별 자격증명 해시가 이 시드 비밀과 다르다(커밋 전 검사), 폐기한 캠페인이다.

## 4. namespace·Secret·ConfigMap

```bash
kubectl create namespace pulsemetry-loadtest
kubectl label namespace pulsemetry-loadtest pod-security.kubernetes.io/enforce=restricted \
  pod-security.kubernetes.io/audit=restricted pod-security.kubernetes.io/warn=restricted
kubectl -n pulsemetry-loadtest create secret generic "loadtest-seed-$CAMPAIGN" \
  --from-file=seed-secret="$C/seed-secret" --from-file=identities.json="$C/identities.json"
```

코드 ConfigMap은 backend 커밋마다 하나다. backend [안내](../../../pulsemetry-backend/tools/loadtest/README.md)의 `dev에 올릴 때` 명령으로
`loadtest-k6-<sha12>`를 만든다(크기 1MiB 미만 확인 포함). 같은 커밋이면 다시 만들지 않는다.

```bash
SHA=$(git -C "$BE" rev-parse --short=12 HEAD)    # 이후 helm 의 configMapName=loadtest-k6-$SHA
```

## 5. 실행

실행마다 새 `testid`(3~40자)를 쓴다. Job 이름은 `loadtest-<testid>`, release 이름도 같다. 같은 캠페인으로 Job 두 개를 동시에 돌리지 않는다
(setup의 토큰 교환이 서로의 토큰을 회전시킨다). 각 실행 뒤 §7 배수를 기다리고 §8로 결과를 뽑은 다음 다음 실행으로 간다.

```bash
run() {   # run <testid> [helm --set ...]
  local testid=$1; shift
  "$T/helm" install "loadtest-$testid" helm/dev/loadtest -n pulsemetry-loadtest \
    --set testid="$testid" --set configMapName="loadtest-k6-$SHA" --set seedSecretName="loadtest-seed-$CAMPAIGN" "$@"
  kubectl -n pulsemetry-loadtest get pods -l "pulsemetry.io/testid=$testid" -o wide    # NODE 가 Gateway·ingest 와 다른지 본다
}
```

| 순서 | 명령 | 목적·기간 |
|---|---|---|
| 1 | `run "$CAMPAIGN-smoke" --set scenario=smoke` | 경로·토큰·지표·저장 확인. 60초 |
| 2 | `run "$CAMPAIGN-pipe" --set scenario=stair` | ② 찾기. 5→60 RPS, +5, 상승 30s, 유지 5m, 약 67분 |
| 3 | §7 배수 대기, §8 결과 추출 → ② 값 확정 | |
| 4 | `node scripts/loadtest-results-export.mjs drain-plan --pipeline-limit <②> --start 20 --step 20 --max 300 --hold 2m --budget 3600` | 배수 예산(제안 1시간) 안의 최대 MAX |
| 5 | `run "$CAMPAIGN-gw" --set scenario=stair --set startRps=20 --set stepRps=20 --set maxRps=<4의 제안> --set stepHold=2m` | ① 찾기 |
| 6 | (선택) `run "$CAMPAIGN-hold" --set scenario=hold --set holdRps=<후보> --set holdDuration=20m` | 후보 한계 재확인 |

smoke 뒤에는 대시보드에서 실제 요청률·`200 응답의 기대 저장 건수`·ClickHouse 삽입 행이 함께 움직이는지 보고 넘어간다.
계획 시간이 10200초(telemetry JWT 3h − 600s)를 넘거나 RPS가 1000을 넘으면 helm이 렌더를 거부한다 — 실행을 나눈다.

## 6. 정지 조건과 정지 방법

k6가 스스로 멈추는 것: 오류율 ≥ 5%·p95 ≥ 4s·dropped ≥ 3000(1분 지연 평가), 401 즉시, 같은 VU의 non-2xx 50회 연속.

사람이 멈출 때(대시보드로 본다):
- lag이 배수 예산(§5-4)을 넘어 쌓인다.
- ingest 재시도 소진·실패 분류가 늘거나 ClickHouse 지연·실패 INSERT가 는다.
- Gateway·ingest·ClickHouse의 OOM·재시작(`kubectl -n pulsemetry-dev get pods`의 RESTARTS).
- ClickHouse PVC 80% 초과.

```bash
TESTID=<멈출 실행의 testid>
POD=$(kubectl -n pulsemetry-loadtest get pod -l "pulsemetry.io/testid=$TESTID" -o name)
# 정상 정지 — k6 가 진행 중 요청을 끝내고 summary 블록을 쓴 뒤 종료 코드 105 로 끝난다(Job 은 실패로 남지만 로그는 24시간 보존).
kubectl -n pulsemetry-loadtest exec "$POD" -c k6 -- kill -INT 1
# 응답이 없을 때만 — summary 가 남지 않는다.
kubectl -n pulsemetry-loadtest delete job loadtest-$TESTID
```

`k6 pause`는 쓰지 않는다. 도착률 실행기(constant/ramping-arrival-rate)는 시작 뒤 pause를 지원하지 않는다(k6 1.8.2 확인).
조기 정지한 실행을 추출하면 멈춘 단계와 실행하지 않은 단계가 `미완료`로 표시되고 한계 산정에서 빠진다. 한계 값은 그 앞에서 이어서 통과한 완료 단계라 그대로 유효하다.

## 7. 배수 대기

다음 실행 전과 결과 추출 전에 backlog가 빠지기를 기다린다. 기준은 둘 다다.

- `확인된 commit 기준 lag`이 0(미커밋 partition 수도 0).
- ingest `처리 시도 결과 / 초`가 0 근처로 떨어졌다.

## 8. 결과 추출(7일 안)

Prometheus 보존이 7일이다. 실행 직후 뽑는다.

```bash
kubectl -n pulsemetry-observability port-forward svc/pulsemetry-monitoring-prometheus 9090:9090    # 별도 터미널
TESTID="$CAMPAIGN-pipe"                                                                           # 뽑을 실행
R="$C/$TESTID"; mkdir -p "$R"
kubectl -n pulsemetry-loadtest logs job/loadtest-$TESTID -c k6 > "$R/k6.log"               # summary 블록 포함
kubectl -n pulsemetry-dev get deploy,sts,cm -o json > "$R/config-snapshot.json"            # 원본은 레포 밖에만 둔다
node scripts/loadtest-results-export.mjs --prometheus http://127.0.0.1:9090 --cluster "$EKS_CLUSTER_NAME" \
  --testid "$TESTID" --summary "$R/k6.log" --config-snapshot "$R/config-snapshot.json" --out "$R/result"
```

`result/`에 `REPORT.md`(단계별 표·①·② 한계·실패 사유), `judgement.json`, `queries/sNN.json`(대시보드와 같은 식의 원자료),
`summary.json`, `config.json`(replica·자원·`PULSEMETRY_*` env·이미지 digest·nodeSelector, 비밀로 보이는 값은 `<redacted>`)이 남는다.
판정 기본값은 ① p95 ≤ 1초·p99 ≤ 3초·오류율 ≤ 0.1%·dropped 0, ② 유지 구간 lag 증가 ≤ max(100, 목표 RPS × 10)·접수→완료 p95 ≤ 직전 통과 단계 × 2·영구 거부·재시도 소진·ClickHouse 지연/실패 INSERT 0이다(`scripts/lib/loadtest-judge.mjs`). 팀이 정한 값은 `--max-p95-seconds`·`--max-p99-seconds`·`--max-error-rate`·`--max-dropped`·
`--lag-min-growth`·`--lag-growth-per-rps`·`--completion-p95-factor`로 준다. Kafka 이름이 dev main 기본값과 다르면
`--kafka-cluster`·`--topic`·`--consumer-group`을 준다. 출력 디렉터리는 실행마다 새로 쓴다.

판정 입력과 미수집 규칙(`scripts/lib/loadtest-queries.mjs`):

- 단계별 dropped·k6 p95·p99·오류율은 k6 summary 값이다. dropped 는 예정 반복(목표 RPS × 유지 초) − 유지 구간 요청 수다 — Prometheus 의
  drop 카운터는 첫 drop 때 생겨 증가율로는 첫 drop 을 놓친다. summary 에 단계별 dropped 가 없으면(이전 스크립트) 미수집이다.
- 영구 거부·재시도 소진·ClickHouse 지연/실패 INSERT 는 창을 유지 구간 끝 + `--boundary-delay`(기본 20s)까지 늘린다. 끝 직전 이벤트가
  다음 scrape 에 찍히기 때문이다. 다음 단계 상승 초반이 섞이면 실패 쪽으로만 기운다.
- 그 창에서 ingest 재시작·Pod 교체·scrape 실패·표본 부족(창 ÷ `--scrape-interval` − 1 미만)이 있으면 그 값은 미수집이다.
- lag 증가는 두 경계의 표본 시각이 `--max-sample-age`(기본 30s)보다 오래됐거나 같은 표본이면 미수집이다.
- 중단·미실행 단계(k6 summary `completed: false`)는 두 층 모두 실패로 표시하고 한계 산정에서 뺀다. 유지 구간을 끝까지 실행하지 않은
  결과를 통과로 세지 않는다. 조기 정지한 실행의 한계는 그 앞에서 이어서 통과한 완료 단계다.
- ClickHouse 지연·실패 INSERT 는 창 안에서 ClickHouse 가 재시작했으면(`ClickHouseAsyncMetrics_Uptime` 감소) 미수집이다. 재시작 직전
  scrape 되지 않은 실패는 `increase()` 로 되살릴 수 없기 때문이다. ingest 는 시작 시각 변화·Pod 교체로 같은 판단을 한다.
- 미수집은 실패로 표시되고 사유가 REPORT 에 함께 남는다. 이때는 Grafana 로 그 구간을 직접 본다.
- 지연·처리율(서버 p95·p99, 실제 RPS)은 유지 구간 창 그대로다. 수집 지연(최대 10초)만큼 경계가 어긋나지만 2~5분 창에서는 무시할 수준이다.
- 마지막 유지 구간 끝 + 경계 지연 전에는 실행을 거부한다.

결과를 뽑은 뒤 그 release를 지운다: `"$T/helm" uninstall "loadtest-$TESTID" -n pulsemetry-loadtest`.

## 9. 정리

1. 마지막 실행의 배수(§7)가 끝났는지 확인한다. 그 전에 폐기하면 Kafka에 남은 record가 영구 실패(`installation_revoked`)가 된다.
2. 설치·자격 폐기:

   ```bash
   python3 "$BE/tools/loadtest/generator/seed_sql.py" --campaign "$CAMPAIGN" --revoke > "$C/revoke.sql" \
     && psql "$PGURL" -v ON_ERROR_STOP=1 -f "$C/revoke.sql"
   ```

3. (선택, 팀 결정) 데이터 삭제는 retention-worker로 한다. `--retention-months`는 1 이상이라 방금 넣은 데이터를 지우려면 `--as-of`를
   한 달 넘게 미래로 준다. 그 뒤 그 tenant는 재사용할 수 없다(ClickHouse fence가 이후 INSERT를 거부한다, backend ADR 0024).
   실행 설정(DB·ClickHouse 연결)은 backend 문서를 따른다.

   ```bash
   (cd "$BE" && ./gradlew :apps:retention-worker:bootRun --args="--tenant=<tenantId> --retention-months=1 --as-of=<지금 + 2개월, ISO-8601>")
   ```

4. 클러스터 자원과 로컬 비밀:

   ```bash
   "$T/helm" list -n pulsemetry-loadtest            # 남은 release 를 uninstall
   kubectl -n pulsemetry-loadtest delete configmap "loadtest-k6-$SHA"
   kubectl -n pulsemetry-loadtest delete secret "loadtest-seed-$CAMPAIGN"
   kubectl delete namespace pulsemetry-loadtest     # 더 실행하지 않을 때
   rm -f "$C/seed-secret"                           # 결과(result/)는 남긴다
   ```

## 10. 결과를 보고 바꿀 곳

| 증상 | 조정 대상 | 바꾸는 방법 |
|---|---|---|
| lag 기울기 > 0, ingest CPU 여유 | ingest concurrency, max.poll.records, replica, partition 수 | 설정 |
| CPU throttling | CPU limit | values (ADR 0063 영향) |
| Tomcat busy가 max에 닿음 | `threads.max` (16) | 설정 |
| producer buffer 고갈, 대기 시간 증가 | linger·batch·compression | **코드** |
| CH INSERT p95·parts 증가 | async_insert, 일괄 INSERT | **코드** |
| heap committed ≈ max, GC 최대 증가 | JVM 옵션, 메모리 limit | **차트** (현재 JVM env 주입을 막는다) |
| apps 노드 초과 credit 과금(`CPUSurplusCreditsCharged`) 증가 | 노드 타입 | 이번 범위 밖. 성능 제한이 아니라 비용 문제다(§11) |

사양을 바꾸는 변경은 별도 ADR(0063 개정 등)로 한다. 바꾼 뒤에는 같은 시나리오를 새 캠페인으로 다시 돌려 `config.json`과 함께 비교한다.

## 11. 대시보드 밖에서 볼 것

RDS CPU·연결 수와 apps 노드(t4g)의 CPU credit은 CloudWatch에서 같은 UTC 구간으로 본다. 같은 계정에 prod Aurora도 있으니 RDS 식별자는 dev 인스턴스로 지정한다.

```bash
aws cloudwatch get-metric-statistics --region ap-northeast-2 --namespace AWS/RDS --metric-name CPUUtilization \
  --dimensions Name=DBInstanceIdentifier,Value=<RDS 인스턴스> --start-time <시작Z> --end-time <끝Z> --period 60 --statistics Maximum
aws cloudwatch get-metric-statistics --region ap-northeast-2 --namespace AWS/RDS --metric-name DatabaseConnections \
  --dimensions Name=DBInstanceIdentifier,Value=<RDS 인스턴스> --start-time <시작Z> --end-time <끝Z> --period 60 --statistics Maximum
aws cloudwatch get-metric-statistics --region ap-northeast-2 --namespace AWS/EC2 --metric-name CPUCreditBalance \
  --dimensions Name=InstanceId,Value=<apps 노드 인스턴스> --start-time <시작Z> --end-time <끝Z> --period 300 --statistics Minimum
aws cloudwatch get-metric-statistics --region ap-northeast-2 --namespace AWS/EC2 --metric-name CPUSurplusCreditsCharged \
  --dimensions Name=InstanceId,Value=<apps 노드 인스턴스> --start-time <시작Z> --end-time <끝Z> --period 300 --statistics Sum
aws ec2 describe-instance-credit-specifications --region ap-northeast-2 --instance-ids <apps 노드 인스턴스>   # standard | unlimited
```

ingest는 레코드마다 PostgreSQL을 여러 번 조회한다. RDS(`db.t4g.micro`) CPU·연결이 ② 한계를 먼저 정할 수 있다.

apps 노드(`t4g.large`)는 버스트형이라 CPU credit이 있다. 기준선(vCPU당 30%)을 넘게 쓰면 credit을 소모한다. m·c 계열(ClickHouse·Kafka·관측 노드의 `m7g.large`)에는 credit이 없다.
credit이 0이 됐을 때의 동작은 모드에 따라 다르다. 시작 전에 위 `describe-instance-credit-specifications`로 확인한다.

- **unlimited**(2026-11-19 dev apps 노드 확인): CPU가 기준선으로 묶이지 않고 초과분이 과금된다. 결과는 credit에 묶이지 않으며, 비용은 `CPUSurplusCreditsCharged`로 본다.
- **standard**: credit이 0이 된 뒤의 단계는 CPU가 기준선에 묶인 값이다. 그 단계의 한계는 노드 credit 한계로 기록한다.
