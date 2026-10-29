# 0049. dev Kafka는 Strimzi로 관리하고 MSK는 검증 후 단계적으로 제거한다

## Status

Accepted — PROJ-282 사용자 승인에 따른 구현 결정. 실제 배포 성공은 PROJ-285의 증거로 별도 판정한다.
ADR-0035(MSK isolated subnet)의 공급자 결정, ADR-0036의 MSK IAM·topic-init,
ADR-0037의 MSK 관측 부분을 대체한다. 기존 HTTP 복구·JWT·Data·prod 경계는 유지한다.
크로스레포 계약은 허브 ADR 0026과 `contracts/telemetry-kafka.md`가 소유한다.

## Context

샌드박스 제공 측에서 MSK 사용 불가를 확인했다. 동일한 복제·보존·크기 계약을
기존 dev EKS의 Kafka로 옮기고 사용자가 선택한 단일 AZ 운영을 적용한다.

## Decision

- Strimzi 1.3.0/Kafka 4.2.2를 고정하고 broker/controller 겸용 3 Pod를 서로 다른 m7g.large ARM64 On-Demand 노드에 둔다.
  ClickHouse와 동일한 AZ의 기존 노드 subnet을 사용한다. 전용 NodeClass/NodePool·SG·taint,
  CPU 상한 8, Pod CPU 1/memory request 4Gi·limit 6Gi/heap 2Gi, PDB maxUnavailable 1을 둔다.
- Kafka 전용 encrypted gp3 100Gi/PVC, WaitForFirstConsumer, Retain, 확장 허용, deleteClaim=false를 사용한다.
  기존 앱·ClickHouse·관측 풀과 PVC는 수정하지 않는다. 단일 AZ 장애 내성은 제공하지 않는다.
- Operator는 strimzi-system에서 pulsemetry-dev만 감시한다. Kafka/NodePool/Topic/User/앱은 pulsemetry-dev에 둔다.
  기존 CSI 원칙의 예외는 Strimzi가 생성·관리하는 CA/사용자 Kubernetes Secret의 앱 직접 mount뿐이다.
- apps 노드의 Operator가 Kafka 노드로 사용하는 TCP 9090(controller Admin/quorum 확인)·8443(KafkaAgent 복구 상태 조회)을
  NetworkStack의 apps SG → Kafka SG 규칙으로 허용한다. 기존 9091(내부 broker)·9093(앱 mTLS)은 유지한다.
  Strimzi 1.3.0의 `KafkaRoller.adminClient()`는 controller에 `CONTROLPLANE_PORT`로 연결하고,
  `KafkaQuorumCheck`는 `describeMetadataQuorum()`으로 안전한 재시작 여부를 검사한다.
  `KafkaRoller`는 준비되지 않은 broker의 복구 상태를 `KafkaAgentClient`로 조회하므로 `KAFKA_AGENT_PORT`도 필요하다.
  두 포트는 노드 SG와 Strimzi가 생성하는 Operator 전용 NetworkPolicy 양쪽에서 허용되어야 한다.
  기존 NetworkPolicy 생성 및 앱 listener의 peer 제한은 유지하고 외부 CIDR·9092 listener는 추가하지 않는다.
- KafkaTopic만 토픽 설정을 관리한다. stage별 mTLS/ACL 사용자와 별도 수동 offset Job을 사용한다.
  broker는 9093 내부 listener만 노출하고 AWS MSK IAM 대신 Kafka ACL로 권한을 분리한다.
- CDK context `devKafkaProvider=msk|strimzi`(생략 msk)와 `devMskRetirementStage=retain|cluster-removed|network-removed`
  (생략 retain)를 도입한다. msk 공급자에서 제거 단계는 거부한다. 전환 중에는 Strimzi와 기존 MSK 리소스를 병존시킨다.
  cluster-removed는 MSK cluster/configuration/log·전용 IAM을 제거하고 subnet/SG를 남긴다.
  실제 MSK 삭제·ENI 해제 확인 뒤 network-removed를 NetworkStack에 적용한다. 최초 삭제 deploy --all은 금지한다.
- KafkaProvider/KafkaStage/KafkaTopicName/KafkaConsumerGroupName, EksKafkaNodeSecurityGroupId/EksKafkaAvailabilityZone을 출력한다.
  Strimzi values 생성에는 MSK ARN/bootstrap/list-nodes가 필요 없다. 기존 MSK 입력 검증은 호환 경로에만 남긴다.
- Secret UID/resourceVersion 해시만 tlsRevision으로 배포 annotation에 공급한다. PKCS12 파일과 password-file을 읽으며
  인증서 원문·비밀번호는 generated YAML에 넣지 않는다. 365일/30일 갱신과 앱 명시적 재배포를 런북에 둔다.
- 기존 MSK CloudWatch 지표는 Strimzi/JMX/Kafka exporter/Pod/PVC 기반 관측으로 교체한다. 앱 로그 기반 경보는 유지한다.
- 기존 HTTP 보존 → validation E2E → main 전환 → 30분 안정화 → MSK 삭제 순서다.
  기존 MSK 미확인 데이터 폐기는 사용자가 승인했으며 migration·offset 이관은 하지 않는다.

## Alternatives Considered

SCP 조정 대기는 제공자 확인으로 제외했다. 무인증 Kafka·단일 broker는 기존 신뢰·복제 계약을 만족하지 않는다.
MSK 네트워크를 먼저 삭제하면 ENI 종속성으로 실패하므로 제거 단계를 나눈다.

## Consequences/Tradeoffs

### Positive

관리형 MSK 권한 없이 기존 수집 계약을 운영하며 Kafka 리소스를 선언적으로 관리한다.

### Negative

Kafka·인증서·PVC의 운영 책임을 맡고 단일 AZ 위험을 감수한다. replica 1/Recreate 앱의 인증서 재배포는 짧은 중단을 낼 수 있다.
MSK와 임시 병존하는 동안 비용이 중복되며 삭제 후 MSK로 복구하지 않는다.

## Acceptance Criteria

prod/cicd 불변, 기존 Data·JWT·HTTP 보존, 단계별 CloudFormation 참조 안전성, Helm/schema,
실제 mTLS/ACL·ACK/consume/commit/ClickHouse·인증서 갱신·노드 장애·PVC/offset 보존을 검증한다.
Operator → 각 Kafka Pod의 9090·8443 경로와 quorum 조회·순차 재시작을 확인한다. broker Ready만으로 이 경로의 정상 동작을 판정하지 않는다.

## References

- [Strimzi 1.3.0 KafkaRoller: controller Admin 연결 및 KafkaAgent 복구 상태 조회](https://github.com/strimzi/strimzi-kafka-operator/blob/1.3.0/cluster-operator/src/main/java/io/strimzi/operator/cluster/operator/resource/KafkaRoller.java)
- [Strimzi 1.3.0 KafkaQuorumCheck: metadata quorum 확인](https://github.com/strimzi/strimzi-kafka-operator/blob/1.3.0/cluster-operator/src/main/java/io/strimzi/operator/cluster/operator/resource/KafkaQuorumCheck.java)
- [Strimzi 1.3.0 KafkaCluster: CONTROLPLANE_PORT·KAFKA_AGENT_PORT 및 generateNetworkPolicy](https://github.com/strimzi/strimzi-kafka-operator/blob/1.3.0/cluster-operator/src/main/java/io/strimzi/operator/cluster/model/KafkaCluster.java)
