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
- KafkaTopic만 토픽 설정을 관리한다. stage별 mTLS/ACL 사용자와 별도 수동 offset Job을 사용한다.
  broker는 9093 내부 listener만 노출하고 AWS MSK IAM 대신 Kafka ACL로 권한을 분리한다.
  ingest와 offset-admin의 Group ACL은 모두 `Read, Describe`다. Kafka 4.2.2의 Group은 `Alter`를 지원하지 않으며,
  `Admin.alterConsumerGroupOffsets`도 일반 commit과 같은 OffsetCommit 요청(Group Read + Topic Read)을 사용한다.
  별도 offset-admin Secret과 수동 Job은 자격증명·운영 절차를 분리한다. ingest의 정상 commit에 필요한 Read를
  유지하면서 같은 group의 offset reset만 ACL로 금지한다고 보장하지 않는다. MSK IAM `AlterGroup`과는 다르다.
- CDK context `devKafkaProvider=msk|strimzi`(생략 msk)와 `devMskRetirementStage=retain|cluster-removed|network-removed`
  (생략 retain)를 도입한다. msk 공급자에서 제거 단계는 거부한다. 전환 중에는 Strimzi와 기존 MSK 리소스를 병존시킨다.
  cluster-removed는 MSK cluster/configuration/log·전용 IAM을 제거하고 subnet/SG를 남긴다.
  실제 MSK 삭제·ENI 해제 확인 뒤 network-removed를 NetworkStack에 적용한다. 최초 삭제 deploy --all은 금지한다.
- KafkaProvider/KafkaStage/KafkaTopicName/KafkaConsumerGroupName, EksKafkaNodeSecurityGroupId/EksKafkaAvailabilityZone을 출력한다.
  Strimzi values 생성에는 MSK ARN/bootstrap/list-nodes가 필요 없다. 기존 MSK 입력 검증은 호환 경로에만 남긴다.
  profile의 공급자와 archive prefix가 배포 output과 다르면 앱·Kafka 준비 values 생성을 모두 거부한다.
- Secret UID/resourceVersion 해시만 tlsRevision으로 배포 annotation에 공급한다. PKCS12 파일과 password-file을 읽으며
  인증서 원문·비밀번호는 generated YAML에 넣지 않는다. 365일/30일 갱신과 앱 명시적 재배포를 런북에 둔다.
- 기존 MSK CloudWatch 지표는 Strimzi/JMX/Kafka exporter/Pod/PVC 기반 관측으로 교체한다. 앱 로그 기반 경보는 유지한다.
- 기존 HTTP 보존 → validation E2E → main 전환 → 30분 안정화 → MSK 삭제 순서다.
  기존 MSK 미확인 데이터 폐기는 사용자가 승인했으며 migration·offset 이관은 하지 않는다.
- main 전환의 CDK 선행 배포가 아직 validation prefix를 사용하는 HTTP ingest의 쓰기를 끊지 않도록,
  `devKafkaProvider=strimzi` + `devEksArchivePrefix=eks` + `devMskRetirementStage=retain`에서만
  ingest의 S3 `PutObject`를 정확히 `eks/*`와 `eks_validation/*` 두 경로에 허용한다.
  기존 TLS 조건을 유지하고 Get/List/Delete·버킷 전체·임의 prefix는 추가하지 않는다. MSK 공급자와 prod는 확장하지 않는다.
  두 경로 허용을 먼저 배포·확인한 뒤 validation 입력 중지 및 backlog drain, main dual ingest/Gateway 배포,
  내부 main 검증, ALB 전환을 순서대로 수행한다. `cluster-removed`부터 임시 validation 권한을 회수하며
  `network-removed`에서도 `eks/*`만 남긴다. 제거 전 validation writer가 없는지 확인한다.

## Alternatives Considered

SCP 조정 대기는 제공자 확인으로 제외했다. 무인증 Kafka·단일 broker는 기존 신뢰·복제 계약을 만족하지 않는다.
MSK 네트워크를 먼저 삭제하면 ENI 종속성으로 실패하므로 제거 단계를 나눈다.

## Consequences/Tradeoffs

### Positive

관리형 MSK 권한 없이 기존 수집 계약을 운영하며 Kafka 리소스를 선언적으로 관리한다.

### Negative

Kafka·인증서·PVC의 운영 책임을 맡고 단일 AZ 위험을 감수한다. replica 1/Recreate 앱의 인증서 재배포는 짧은 중단을 낼 수 있다.
MSK와 임시 병존하는 동안 비용이 중복되며 삭제 후 MSK로 복구하지 않는다.
main 전환부터 MSK 제거까지 ingest 역할이 두 archive prefix에 쓸 수 있다. 이는 HTTP 연속성을 위한 제한된 중첩이며
`retain`에 머무르면 권한도 남으므로 MSK 제거 체크리스트에서 회수 완료를 확인한다.

## Acceptance Criteria

prod/cicd 불변, 기존 Data·JWT·HTTP 보존, 단계별 CloudFormation 참조 안전성, Helm/schema,
실제 mTLS/ACL·ACK/consume/commit/ClickHouse·인증서 갱신·노드 장애·PVC/offset 보존을 검증한다.
S3 두 경로 권한의 정확한 공급자·prefix·제거 단계 조건과 TLS/PutObject 제한, 기존 Secret·Pod Identity 보존을 합성 테스트로 고정한다.

## References

- [Kafka 4.2.2 Group 지원 권한](https://github.com/apache/kafka/blob/4.2.2/server/src/main/java/org/apache/kafka/security/authorizer/AclEntry.java)
- [Kafka 4.2.2 offset 변경 요청](https://github.com/apache/kafka/blob/4.2.2/clients/src/main/java/org/apache/kafka/clients/admin/internals/AlterConsumerGroupOffsetsHandler.java)
- [Kafka 4.2 ACL 프로토콜 표](https://kafka.apache.org/42/security/authorization-and-acls/)
