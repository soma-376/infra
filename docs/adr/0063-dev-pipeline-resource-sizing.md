# 0063. dev 파이프라인 자원을 확대하고 Gateway와 ingest를 서로 다른 노드에 배치한다

## Status

Accepted (PROJ-304의 코드·로컬 검증 범위이며 실제 dev 배포·성능 시험은 별도다.)

ClickHouse의 노드 타입(`m7g.large`)·메모리(6Gi)·NodePool CPU 예산(4)은
[ADR 0066](0066-dev-clickhouse-xlarge-memory.md)(Proposed)이 부분 대체를 제안한다. 나머지 결정은 그대로 유효하다.

ingest의 replica 1·`Recreate`, 제외 대안 중 ingest replica 증가, apps CPU 예산 8은
[ADR 0067](0067-dev-ingest-horizontal-scale.md)(Accepted)이 부분 대체한다. ingest는 replica 2·RollingUpdate·PDB, apps CPU 예산은 12다.
Gateway·ingest 자원과 anti-affinity, apps `t4g.large`, 다른 앱의 replica 1·`Recreate`, 전용 앱 풀 제외는 그대로 유효하다.

[ADR 0028](0028-dev-eks-auto-mode-transition.md)의 apps·ClickHouse 초기 노드 타입과
Gateway·ingest 초기 Pod 자원만 부분 대체한다. CDK/Helm/Auto Mode 소유권과 ARM64,
On-Demand, 기존 NodeClass·SG·AZ·PVC 경계는 유지한다.

## Context

[PROJ-304](https://team376.atlassian.net/browse/PROJ-304)는 단일 파이프라인 성능 측정에 앞서
부족한 초기 자원을 확대한다. Gateway·ingest는 같은 apps 풀을 사용하며 기존에는 서로 다른
노드 배치를 강제하지 않았다. 사용자가 정정한 ingest 사양은 Gateway와 request·limit 모두 같다.
ClickHouse의 가용 자원 사용은 노드의 명목 2 vCPU·8Gi 전체를 예약하는 뜻이 아니라,
시스템·DaemonSet 여유를 남긴 첨부안의 1500m·6Gi 요청과 CPU 제한 해제를 뜻한다.

## Decision

| 대상 | CPU request | 메모리 request | CPU limit | 메모리 limit |
|---|---:|---:|---:|---:|
| telemetry-gateway | 500m | 2Gi | 2 | 4Gi |
| telemetry-ingest | 500m | 2Gi | 2 | 4Gi |
| ClickHouse | 1500m | 6Gi | 없음 | 6Gi |

- apps NodePool은 `t4g.large`, ClickHouse NodePool은 `m7g.large`만 허용한다.
  기존 NodePool·NodeClass 이름, SG, ARM64·On-Demand, ClickHouse AZ와 taint를 보존한다.
- **부분 대체됨(ADR 0067)** — apps CPU 예산은 12다. 기존 결정: apps의 CPU 예산 8, ClickHouse의 CPU 예산 4를 유지한다.
  정상 apps 2대·ClickHouse 1대는 예상치이며 고정 대수가 아니다. Auto Mode가 requests와 배치 제약에 따라 증설하고 교체한다.
- Gateway·ingest에만 같은 namespace의 두 workload 이름을 선택하는
  `requiredDuringSchedulingIgnoredDuringExecution` Pod anti-affinity를 적용한다.
  `kubernetes.io/hostname`으로 분리하며 AZ 분리나 다른 앱과의 독점 배치를 보장하지 않는다.
- **부분 대체됨(ADR 0067)** — ingest만 replica 2·RollingUpdate(`maxSurge 0`·`maxUnavailable 1`)·PDB다.
  기존 결정(다른 앱·ClickHouse는 유효): replica 1과 앱 `Recreate`를 유지한다. ClickHouse는 기존 단일 Pod StatefulSet의 기본
  순차 교체를 유지한다. OnDelete·RollingUpdate Deployment로 바꾸지 않는다.
- 앱별 정적 values에서 새 사양을 고정한다. ClickHouse는 공식 runtime 입력과 생성기로
  전달한다. `limits.cpu: null`로 Helm 기본 CPU 제한을 제거하고 최종 렌더에는 해당 키가 없어야 한다.
  기존 ClickHouse 허용 자원 조합은 호환용으로 유지하되 임의 자원 입력은 허용하지 않는다.
- Kafka·관측·다른 앱·perf·prod·frontend, 이미지·JVM 옵션·기존 PVC와 데이터 설정은 변경하지 않는다.

## Alternatives Considered

- **apps도 m7g.large:** CPU credit 변수가 없지만 사용자는 비용 우선으로 t4g.large를 선택했다.
  지속 부하에서 credit이 비용·결과 해석을 방해하면 별도 변경으로 재검토한다.
- **c7g.large:** 메모리 4Gi가 앱 limit과 같아 시스템·다른 Pod 여유가 없어 제외한다.
- **apps를 정확히 2대로 제한:** 교체·배치 여유를 없애므로 기존 최대 4대 예산을 보존한다.
- **부분 대체됨(ADR 0067)** — ingest replica 증가는 ADR 0067이 채택했다. 전용 앱 풀은 계속 제외한다.
  기존: **replica 증가·전용 앱 풀 추가:** 단일 파이프라인 측정 목적과 기존 풀 재사용 범위를 넘으므로 제외한다.

서울 Linux On-Demand 공개 단가와 EKS Auto Mode 요금을 합산한 730시간 추정에서,
apps t4g.large 2대는 약 $136.04, m7g.large 2대는 약 $164.02다. 선택한 apps 2대와
ClickHouse m7g.large 1대 합계는 약 $218.05다. EBS·IPv4·전송·control plane·기존 Kafka·관측과
CPU credit 추가 과금은 제외하며 실제 노드 수·가격 변동에 따라 달라진다.

## Consequences/Tradeoffs

### Positive

- Gateway·ingest가 한 노드 장애로 동시에 종료되는 배치를 피한다.
- 메모리 제한과 ClickHouse CPU 제한을 완화하면서 기존 배포·저장 계약을 유지한다.

### Negative

- 2 CPU limit은 전용 CPU 예약이 아니다. 다른 Pod·시스템 프로세스와 물리 CPU를 공유한다.
- 플랫폼과 DaemonSet을 포함한 apps 요청량의 2노드 분할 예시는 약 1620m/4720Mi와
  1570m/4656Mi다. 시스템 예약·추가 Pod·실제 allocatable을 제외한 계산이며 배치를 보장하지 않는다.
  같은 분할의 메모리 limit 합은 노드당 약 9.6Gi/9.7Gi로 명목 8Gi를 초과한다.
  모든 Pod의 동시 최대 사용을 보장하지 않으며 requests 기반 증설도 limit 접근만으로 보장되지 않는다.
- t4g.large의 baseline은 vCPU당 30%, 노드당 합계 0.6 vCPU다. CPU credit과 실제 credit mode,
  초과 과금이 지속 부하 측정에 영향을 준다. 단일 replica 재생성·노드 교체는 중단을 동반할 수 있다.

## Follow-up

- 배포 전후 실제 allocatable, 시스템·DaemonSet 요청량, Pending·메모리 압박과 CPU credit을 확인한다.
  2노드가 부족하면 실제 근거로 requests·풀 크기·노드 타입을 재검토하며 anti-affinity를 완화하지 않는다.
- 기존 GitOps 유지보수·게시 경로로 적용한다. 이미지·PVC·AZ 보존, ClickHouse 재연결과
  Gateway ACK → Kafka consume/commit → ClickHouse 저장을 별도로 검증한다.
- 코드·로컬 검증은 실제 게시·Argo Synced/Healthy·기능 성공·최대 처리량 증거가 아니다.

## Acceptance Criteria

- 공식 values와 Helm 렌더에서 표의 자원, 호스트 분리, replica·전략과 PVC 보존을 확인한다.
- 기존 ClickHouse 조합 허용·잘못된 조합 거부, perf·Kafka·다른 앱의 회귀를 검사한다.
- 고정 도구의 Helm 검증, Jest, TypeScript build와 fixture synth를 통과한다.

## References

- [AWS NodePool](https://docs.aws.amazon.com/eks/latest/userguide/create-node-pool.html)
- [AWS CPU credit baseline](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/burstable-credits-baseline-concepts.html)
- [AWS 서울 EC2 공개 단가](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/ap-northeast-2/index.csv)
- [AWS 서울 EKS Auto Mode 공개 단가](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEKS/current/ap-northeast-2/index.csv)
- [Kubernetes Pod anti-affinity](https://kubernetes.io/docs/concepts/scheduling-eviction/assign-pod-node/)
- [Helm 기본 키 제거](https://helm.sh/docs/chart_template_guide/values_files/)
