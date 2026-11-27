# 0067. dev ingest만 replica 2로 수평 확장하고 apps 노드는 t4g.large를 유지한다

## Status

Accepted (PROJ-346; 2026-11-27 팀 동의. 코드·로컬 검증과 dev 반영·확인은 별도다.)

[ADR 0063](0063-dev-pipeline-resource-sizing.md)의 다음 결정을 ingest에 한해 부분 대체한다.

- "replica 1과 앱 `Recreate`를 유지한다" — ingest만 replica 2·RollingUpdate다.
- 제외 대안 "replica 증가·전용 앱 풀 추가" — ingest replica 증가를 채택한다. 전용 앱 풀은 계속 제외한다.
- apps CPU 예산 8 — 12로 올린다.

ADR 0063의 Gateway·ingest 자원(request 500m/2Gi, limit 2 CPU/4Gi), hostname 필수 anti-affinity,
apps 노드 타입 `t4g.large`, 다른 앱의 replica 1·`Recreate`는 그대로 유효하다.

## Context

[PROJ-343](https://team376.atlassian.net/browse/PROJ-343)은 ingest 배치 소비의 처리 상한을 올린다.
[PROJ-346](https://team376.atlassian.net/browse/PROJ-346)은 그중 ingest 확장 방식과 노드 유형을 정한다.

- **⑧ 부하 시험**(`pipeline-20261120-1530-pipe-batch600`, 2026-11-25, 200→600 RPS 계단): 600 RPS 유지 끝에서
  ingest 노드(`t4g.large`, 2 vCPU) busy 1.821/2(1분 최대 1.882), ingest 컨테이너 1.674 core, CPU throttling 0이었다.
  컨테이너 limit 2보다 노드가 먼저 찼다. 처리는 438.0건/초, 배치 소비 상한은 약 450건/초였다.
- 같은 시험의 레코드당 노드 CPU는 약 4.16 ms다. 노드 하나의 CPU 상한은 약 480건/초로 추정한다.
- **PROJ-344 JFR**(`pipeline-20261120-1530-jfr200`·`-jfr500`, 2026-11-27, hold 200·500 RPS):
  같은 노드의 다른 Pod·커널 몫은 0.113–0.125 core였다. 레코드당 JVM CPU는 녹화 밖에서 3.7–3.8 ms로 ⑧과 같다.
- 배치 소비 처리량은 `소비자 수 × 100건(max.poll.records) ÷ 배치 시간`이다. ⑧은 소비자 6(Pod 1 × 스레드 6)이 2 vCPU를 나눠 썼다.
  topic partition은 6이다.
- 지금 replica 1을 고정하는 곳은 spring-app chart schema(`replicaCount` 상수 1), Deployment의 `Recreate` 고정,
  `scripts/validate-helm-workloads.mjs`의 단언, ADR 0063 Decision이다.
- Gateway·ingest anti-affinity의 선택 대상에 ingest 자신이 들어간다. 그래서 ingest Pod끼리도 다른 노드에 놓인다.
  k6 Job도 Gateway·ingest 노드를 피한다. ingest가 2개면 부하 시험 때 apps 노드는 최소 4대(8 vCPU)다.
  지금 apps CPU 예산 8과 같아 노드 교체 여유가 없다.
- workloads AppProject(`pulsemetry-dev-workloads`) 허용 목록에 PodDisruptionBudget이 없다.
  관리 RBAC는 이미 `policy/poddisruptionbudgets` 쓰기(삭제 제외)를 갖는다. 관리 구성은 수동 release `argocd-management`다.
- backend는 바꾸지 않는다. 넘김 목록 key는 group·topic·partition별 offset 범위다.
  차단기·작업 캐시는 소비 스레드마다 있다(backend ADR 0083 Decision 6). consumer group 이름도 그대로다.

결정하지 않으면 ingest는 노드 하나의 2 vCPU에 묶인다. Pod 하나가 재배포되거나 장애가 나면 소비가 전부 멈춘다.

## Decision

1. **ingest만 수평 확장한다.** dev `telemetry-ingest`는 replica 2, Pod당 소비 스레드 3
   (`PULSEMETRY_TELEMETRY_KAFKA_CONSUMER_CONCURRENCY=3`)이다. 소비자 합 6이 partition 6과 같아 partition은 늘리지 않는다.
   다른 앱은 replica 1·`Recreate`이며 chart는 ingest 외 workload의 다른 값을 거부한다.
2. **ingest는 RollingUpdate `maxSurge 0`·`maxUnavailable 1`이다.** 옛 Pod 하나를 먼저 내리고 새 Pod를 올린다.
   교체에 새 노드가 필수는 아니다. 종료 중 Pod가 anti-affinity 계산에 남아 Auto Mode가 잠깐 노드를 띄울 수 있고,
   빈 노드는 `WhenEmpty` 5분 뒤 정리된다. chart가 받는 strategy는 `Recreate`와 이 조합 둘뿐이다.
3. **PDB `minAvailable 1`을 둔다.** replica가 2 이상일 때만 렌더한다.
   `unhealthyPodEvictionPolicy: AlwaysAllow`로 Ready가 아닌 Pod는 예산과 관계없이 축출한다.
   workloads AppProject 허용 목록에 `policy/PodDisruptionBudget`을 더한다.
4. **anti-affinity는 그대로 둔다.** ingest끼리도 다른 노드에 놓는 기존 hostname 필수 규칙이 Pod마다 노드 하나의 CPU를 주는
   격리 장치다. 완화하지 않는다.
5. **노드는 `t4g.large`를 유지하고 apps CPU 예산을 12로 올린다.** 부하 시험 때 정상 4대(Gateway·ingest 2·k6, 8 vCPU)에
   교체 여유 2대(4 vCPU)다. 기존 "정상 2대 + 여유 2대"와 같은 여유다.
   PROJ-344에서 다른 Pod·커널 몫이 0.2 core 미만이었다. 전용 노드로 격리해 얻는 CPU가 노드당 약 0.1 core라 노드 유형을 바꾸지 않는다.
6. **처리 방식 전환 배포는 `Recreate`를 한 번 거친다.** 단건↔배치(`PULSEMETRY_TELEMETRY_KAFKA_CONSUMER_BATCH_ENABLED`)처럼
   소비 방식이 바뀌는 배포를 RollingUpdate로 하면 옛·새 Pod가 같은 group에서 함께 소비한다.
   값 변경과 `strategy: {type: Recreate}`(블록 전체 교체)를 한 커밋에 넣는다. 그 rollout은 옛 Pod가 모두 끝난 뒤 새 Pod를 띄운다.
   다음 커밋에서 RollingUpdate로 되돌린다. strategy는 Pod template 밖이라 rollout이 없다. 두 커밋은 따로 게시한다.
   Argo 자동 sync 중지와 `kubectl scale`은 쓰지 않는다. 다른 이유로 소비를 멈출 때만 Argo 유지보수 경로를 쓴다.
   절차는 [workloads 안내](../../helm/dev/workloads/README.md#ingest-수평-확장과-처리-방식-전환-proj-346)를 따른다.

## Alternatives Considered

### A. ingest 전용 비버스트 풀(`m7g.large`)

- 장점: CPU credit이 없어 지속 부하에서 CPU가 일정하다. 다른 Pod와 노드를 나누지 않는다.
- 단점: 격리로 얻는 CPU가 노드당 0.113–0.125 core(PROJ-344)뿐이다.
  NodeClass·NodePool 추가, 풀별 SG 선택, perf 전용 `placement` 규칙의 dev 허용, taint, 검증 스크립트까지 바뀐다.
  ingest 노드 2대가 약 $164/월이다. apps 노드가 줄어드는지는 남은 requests 배치에 달려 있어 순증은 약 $96~164/월이다.
- 탈락 이유: 이득에 비해 변경 범위와 비용이 크다.

### B. `c7g.large`

- 탈락 이유: 메모리 4Gi가 ingest limit 4Gi와 같다. ADR 0063에서 이미 제외했다.

### C. replica 3 × 스레드 2

- 장점: ingest가 6 vCPU를 쓴다.
- 단점: 부하 시험 때 apps 노드가 최소 5대다. RDS 연결이 최대 30이고 재할당 참여자도 는다.
- 탈락 이유: replica 2의 효과를 재기 전이다. 측정 뒤 다시 판단한다.

### D. partition 증가

- 단점: Kafka partition은 줄일 수 없다. key 분포와 topic 초기화 대조값(6)이 바뀐다.
- 탈락 이유: 되돌릴 수 없다. 소비자 6으로 partition 6을 이미 다 쓴다.

### E. replica 2에 `Recreate` 유지

- 단점: 배포마다 두 Pod가 함께 내려가 소비가 멈춘다.
- 탈락 이유: Pod 하나의 재배포·장애에도 소비를 잇는다는 목표와 맞지 않는다.

### F. 그대로 둔다(replica 1 × 스레드 6)

- 탈락 이유: 노드 하나의 CPU(약 480건/초 추정)와 단일 Pod 중단에 묶인다.

## Consequences/Tradeoffs

### Positive

- ingest가 노드 두 대의 CPU(2 × 2 vCPU)를 쓴다. 노드 CPU 기준 상한 추정이 약 2배가 된다.
  실제 상한은 배치 시간의 S3 대기([PROJ-347](https://team376.atlassian.net/browse/PROJ-347))와
  RDB 대기([PROJ-345](https://team376.atlassian.net/browse/PROJ-345))에도 달려 있다. hold 500으로 확인한다.
- Pod당 스레드가 6에서 3으로 줄어, 한 노드의 2 vCPU를 나눠 쓰는 스레드가 반이 된다.
- Pod 하나가 빠져도 남은 Pod가 6개 partition을 받아 소비를 잇는다.
- 다른 앱, 노드 유형, NodePool·SG는 바뀌지 않는다.

### Negative

- **EAGER 재할당.** 배포·장애·Pod 복귀 때 group 전체 소비가 잠깐 멈춘다. Pod 하나를 바꿀 때마다 나감·들어옴으로 두 번이다.
  그 사이에는 Pod 하나가 6개 partition을 맡아 처리량이 반이 된다. 협력적 재할당·static membership은 범위 밖이다.
- **중복 처리.** 재할당 때 옛 주인이 확정하지 못한 배치는 새 주인이 다시 처리한다. 중복 행은 backend ADR 0083 Decision 7·8
  (배치 끝에서만 확정, 재할당 뒤 옛 ack 건너뜀)과 ClickHouse `ReplacingMergeTree`·조회 `FINAL`이 정리한다.
- **RDS 연결.** Pod 수만큼 는다(Hikari 최대 10 × 2). dev RDS(`db.t4g.micro`)의 `DatabaseConnections`를 반영 전후로 본다.
  부족하면 ingest Hikari 최대 연결을 낮추는 env를 검토한다.
- **PDB 정리.** Argo는 `prune=false`이고 관리 RBAC에 삭제 권한이 없다. replica 1로 되돌리면 Git에 없는 PDB가 남는다.
  ingest Application이 OutOfSync로 남아 root의 다음 wave(Gateway 70·dashboard 80)가 기다리고(Argo 일반 동작에서 추론),
  Pod 하나의 drain도 막힌다. 되돌림 sync 직후 운영자가 바로 지운다. 순서는 workloads 되돌림 → PDB 삭제 →
  (필요하면) 관리 구성의 PDB 허용 제거다([Argo 운영 런북 §3.1](../runbooks/dev-argocd-operations.md#31-관리-구성-변경)).
- **PDB와 노드 교체.** 한 Pod가 Ready가 아니면 Ready인 다른 Pod는 축출되지 않아 그 노드의 drain(Auto Mode 교체 포함)이 막힌다.
  Ready가 아닌 Pod는 `AlwaysAllow`로 축출되므로 그 Pod의 노드는 drain된다. 두 Pod가 모두 Ready가 아니어도 두 노드 모두 drain된다.
- **관리 구성 선적용.** `argocd-management`는 수동 release다. 운영자가 workloads 변경보다 먼저 갱신해야 한다.
  빠뜨리면 ingest sync가 PDB에서 실패한다.
- **처리 방식 전환.** 단건↔배치 전환이 커밋 두 개(Recreate 전환·RollingUpdate 되돌림)로 나뉘고, 전환 rollout 동안 소비가 멈춘다.
  두 커밋을 한 게시에 묶으면 최종 선언이 RollingUpdate라 방식이 섞인다.
- **비용.** 상시 apps 노드가 1대 늘어 약 +$68/월이다(ADR 0063의 서울 On-Demand + Auto Mode 730시간 추정,
  `t4g.large` 1대 약 $68, `m7g.large` 1대 약 $82). 부하 시험 때는 k6를 포함해 4대다.
  두 ingest 노드가 baseline(노드당 0.6 vCPU)을 넘으면 unlimited 초과 credit이 과금된다.

## Follow-up

- dev 반영 뒤 hold 500 RPS 8분을 돌린다. 노드별 CPU, Pod별 JVM CPU, 포화 소비율, lag 기울기를 PROJ-344 `jfr500`과 비교한다.
- Pod 1개 삭제 시험을 한다. 남은 Pod가 6개 partition을 받는지, 새 Pod Ready 뒤 3·3으로 다시 나뉘는지,
  lag이 회복되는지, 레코드 유실이 없는지(smoke 구간 `FINAL` 대조)를 본다.
- RDS `DatabaseConnections`가 한도 안인지 본다.
- 2026-11-30 전에 dev 확인을 못 하면 미확인으로 기록한다.
- t4g unlimited 초과 credit 단가는 이 ADR에서 다시 확인하지 않았다. 지속 부하 비용을 판단할 때 확인한다.
- 재할당 멈춤이 문제가 되면 협력적 재할당(CooperativeSticky)·static membership을 후속으로 다룬다.

## Acceptance Criteria

- 렌더: ingest는 replica 2·RollingUpdate(`maxSurge 0`·`maxUnavailable 1`)·PDB `minAvailable 1`·`unhealthyPodEvictionPolicy: AlwaysAllow`이다.
  다른 앱은 replica 1·`Recreate`·PDB 없음이다. 다른 앱의 replica 2와 허용 밖 strategy는 거부한다.
- platform base의 apps `cpuLimit`이 `"12"`이고, workloads AppProject 허용 목록에 `policy/PodDisruptionBudget`이 있다.
- dev: ingest Pod 2개가 서로 다른 노드에 있다. `kubectl -n pulsemetry-dev get pdb`의 `ALLOWED DISRUPTIONS`가 1이다.
  Pod마다 로그의 `partitions assigned` 합이 3(스레드당 1, 기본 RangeAssignor)이다.

## References

- [ADR 0063](0063-dev-pipeline-resource-sizing.md), [ADR 0064](0064-dev-pipeline-loadtest.md),
  [ADR 0066](0066-dev-clickhouse-xlarge-memory.md), [ADR 0056](0056-dev-argocd-gitops-operations.md)
- [backend ADR 0083](https://github.com/soma-376/pulsemetry-backend/blob/develop/docs/adr/)(Kafka 배치 소비)
- [부하 시험 런북](../runbooks/dev-pipeline-loadtest.md),
  [Argo 운영 런북 §3.1](../runbooks/dev-argocd-operations.md#31-관리-구성-변경),
  [workloads 안내](../../helm/dev/workloads/README.md)
- [Kubernetes Deployment RollingUpdate](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/#rolling-update-deployment),
  [Recreate](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/#recreate-deployment),
  [rollout 조건(Pod template 변경만)](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/#updating-a-deployment),
  [PodDisruptionBudget](https://kubernetes.io/docs/tasks/run-application/configure-pdb/),
  [unhealthyPodEvictionPolicy](https://kubernetes.io/docs/tasks/run-application/configure-pdb/#unhealthy-pod-eviction-policy)
