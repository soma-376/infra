# 0037. dev EKS 관측은 독립 노드의 Prometheus·Grafana와 CloudWatch 시스템 로그를 사용한다

## Status

부분 대체: dev Strimzi 공급자·mTLS·토픽 소유·관측 및 단계적 MSK 제거는 [ADR-0049](0049-dev-strimzi-kafka-and-staged-msk-retirement.md)를 따른다. 기존 HTTP·JWT·Data·prod 경계는 유지한다.

Accepted (PROJ-191; 사용자 승인 설계의 로컬 구현. AWS 배포·실부하·장애 검증은 별도).
ADR-0035의 관측 범위를 확장한다. MSK DEFAULT CloudWatch 경보와 broker 설정은 유지한다.
Loki·Tempo·분산 tracing 제외 결정은 [ADR-0039](0039-dev-loki-tempo-and-platform-trace-collector.md)(Proposed)가 개정을 제안한다. 채택 전까지는 이 문서가 기준이다.

[ADR-0028](0028-dev-eks-auto-mode-transition.md)의 두 결정을 부분 대체한다. 앱·ClickHouse 두 NodePool 구성에
관측 전용 NodePool을 더한다. 앱 namespace stdout/stderr 원문만 `/eks/dev/application`에 보내던 Fluent Bit은
원문과 Kubernetes metadata를 함께 보내고 관측·로그 namespace를 `/eks/dev/observability`로 보낸다.
로그 그룹은 CDK, 수집 설정은 Helm이 소유한다는 경계와 나머지 0028 결정은 유효하다.

## Context

Gateway의 Kafka 접수와 ingest의 ClickHouse 적재를 구분하여 부하 병목을 확인해야 한다.
장애 시 서버 로그, Kubernetes Events, 종료 사유를 같은 시간대로 조회해야 한다.
현재 Fluent Bit은 원문만 보내며 ClickHouse의 파일 로그와 Kubernetes Events는 수집하지 않는다.

## Decision

- 기존 dev EKS에 `pulsemetry-observability` namespace·ARM64 m7g.large 전용 NodePool을 추가한다.
  `workload=observability:NoSchedule`과 명시적 nodeSelector로 측정 대상과 자원을 분리한다.
- Prometheus는 내부 management 9404, ClickHouse 9363, kubelet/cAdvisor, kube-state-metrics와
  MSK Open Monitoring JMX 11001·node 11002를 수집한다. MSK IAM 9098 권한을 수집기에 주지 않는다.
- MSK 전체 broker는 운영자가 조회한 `list-nodes` JSON에서 확인한다. 부분 목록인 bootstrap 주소로
  전체 broker를 추정하지 않는다. 생성기는 endpoint·broker ID·cluster 주소를 대조한다.
- SG와 cross-SG 규칙은 NetworkStack만 소유한다. Grafana·Prometheus·metrics Service는 ClusterIP다.
  운영자는 기존 private API SSM 터널과 localhost port-forward를 사용한다.
- Grafana 암호는 EKS 하위 CDK Secret에서 서버 측 생성하고 Retain한다. 전용 Pod Identity와 CSI가
  파일로 공급한다. Grafana는 CloudWatch 지표·지정 로그 그룹만 읽고 데이터 경로의 Secret을 읽지 않는다.
- CloudWatch 앱 로그는 원문 `log`와 Kubernetes metadata를 함께 보존한다. 관측 스택 로그·Events는
  별도 14일 그룹에 둔다. 기존 telemetry 실패 event 문구와 metric filter는 유지한다.
- ClickHouse는 information 수준 JSON console 로그를 사용한다. 같은 로그를 파일에 중복 저장하지 않는다.
  Fluent Bit은 tail DB와 크기 제한 filesystem buffer를 사용한다. 노드 손실 시 미전송 로그까지 보장하지 않는다.
- Events는 단일 collector와 PVC로 수집한다. OOM/SIGKILL는 로그가 없을 수 있어 종료 사유 지표와 함께 본다.
- 노드 진단은 NodeDiagnostic과 private S3 bundle(14일 수명)이다. node role의 S3 권한은 늘리지 않는다.
  운영자만 짧은 presigned PUT을 만들며 완전히 소실된 노드의 로컬 로그 복구는 보장하지 않는다.
- Helm 설정·대시보드는 환경 입력으로 재사용한다. 별도 k6 인프라·Loki·Tempo·분산 tracing은 만들지 않는다.

## Alternatives Considered

- 앱 NodePool에 동거: 저렴하지만 부하 결과를 관측 스택 자원 경합으로 오염시킨다.
- Loki·Tempo 추가: 현재 요구는 시스템 장애 로그이며 기존 CloudWatch 재사용으로 충족한다.
- MSK CloudWatch만 조회: 1분 지표를 보존하되 짧은 부하 변화는 10초 Prometheus scrape로 보완한다.

## Consequences/Tradeoffs

### Positive

접수·소비·적재 병목과 서버 종료 증거를 한 Grafana에서 확인하며 ECS·prod 경로를 유지한다.

### Negative

관측 노드·EBS·CloudWatch 조회 비용이 추가된다. 단일 Prometheus는 클러스터 전체 장애에 독립적이지 않다.
기존 CloudWatch 경보를 보존하며 로그 배송은 best effort다. Retain Secret·PVC의 정리는 별도 운영 책임이다.

## Acceptance Criteria

EKS 비활성 템플릿은 유지하고 metrics 포트에 public ingress를 만들지 않는다. broker 3대 전체와 앱별 target을
확인한다. ClickHouse console 로그, collector 재시작·buffer 재전송, Events, Grafana Logs 조회를 배포 후 검증한다.

## References

- [MSK Prometheus](https://docs.aws.amazon.com/msk/latest/developerguide/prometheus-metrics.html)
- [Fluent Bit Events](https://docs.fluentbit.io/manual/data-pipeline/inputs/kubernetes-events)
- [EKS NodeDiagnostic](https://docs.aws.amazon.com/eks/latest/userguide/auto-get-logs.html)
