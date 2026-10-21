# 0035. dev EKS 경로의 MSK는 전용 3 AZ isolated subnet과 DevEksStack 하위 리소스로 둔다

## Status

Accepted (PROJ-246; 로컬 구현·검증 대상, AWS 배포·MSK 접속·장애 검증 증거 별도)

[ADR-0022](0022-dev-infrastructure-topology.md)의 "퍼블릭 서브넷 전용" 구성을 EKS 활성화 경로에서 부분 대체한다.
`devEksEnabled=true`일 때만 MSK 전용 isolated subnet 3개를 추가하며 기존 VPC construct·`maxAzs: 2`·
NAT 0·public subnet은 그대로다. [ADR-0028](0028-dev-eks-auto-mode-transition.md)의 DevEksStack 범위에
MSK와 telemetry 관측 리소스를 더한다. 기존 ECS·prod·cicd 결정은 유지한다.

## Context

PROJ-205는 telemetry 수집을 `ALB → Gateway → MSK → ingest Consumer`로 바꾼다. 공통 계약(PLAN §3.3)은
MSK Provisioned Standard, 서로 다른 3 AZ의 broker 1대씩, `kafka.m7g.large`·100 GiB, RF 3·minISR 2·
partition 6·72시간 보존, 12 MiB record다. MSK는 broker 수만큼 서로 다른 AZ의 client subnet을 요구한다.

dev VPC는 `maxAzs: 2`의 public subnet 두 개뿐이다(AGENTS.md 3장 불변식). `maxAzs`를 3으로 바꾸면 VPC가
subnet 집합을 다시 계산한다. ALB·RDS subnet group·EKS control plane·NodeClass·ClickHouse 고정 AZ·SSM 릴레이가
`publicSubnets`를 참조하므로 기존 배치가 함께 바뀔 수 있다.

CloudFormation `AWS::MSK::Cluster`는 bootstrap 주소를 attribute로 제공하지 않는다. 이를 CDK 안에서 얻으려면
`AwsCustomResource`(Lambda)가 필요하다. 이 레포는 EKS 스택에 Lambda와 kubectl provider를 두지 않는다
(DevEksStack 헤더 주석, ADR-0028).

결정하지 않으면 기존 subnet을 바꾸는 VPC 수정이나 public subnet의 broker 배치로 이어진다.

## Decision

### 1. 네트워크

- `DevNetworkStack`은 EKS 활성화 시에만 `ec2.PrivateSubnet` 3개를 만든다.
  `10.1.32.0/24`(`ap-northeast-2a`), `10.1.33.0/24`(`2b`), `10.1.34.0/24`(`2c`)이며 route table에는 VPC local route만 있다.
  IGW·NAT·S3 endpoint route를 연결하지 않는다.
- 이 subnet은 VPC의 subnet 선택(`publicSubnets`)에 들어가지 않는다. EKS·ALB·RDS·NodeClass·릴레이의 기존 선택은 바뀌지 않는다.
- `DevMskSg`(`disableInlineRules`, 아웃바운드 없음)를 Network에 둔다. 인바운드는 `DevEksAppNodeSg`의 TCP 9098(SASL/IAM over TLS)뿐이다.
  Gateway·Consumer·관리 Job은 모두 앱 NodePool에서 실행된다. 기존 SG의 description·logical ID는 바꾸지 않는다.
- 두 ALB SG에서 `DevEksAppNodeSg`로 Gateway NodePort 30082를 허용한다(`DEV_EKS_NODE_PORTS.gateway`). 세부 workload는 [ADR-0036](0036-dev-telemetry-gateway-workload-and-msk-iam.md)을 따른다.

### 2. MSK

- `DevEksStack` 하위 construct `DevEksMsk`가 `CfnConfiguration`과 `CfnCluster`를 소유한다. 이름은 둘 다 `soma-376-dev-telemetry`다.
- cluster: Kafka `3.9.x.kraft`, broker 3대 `kafka.m7g.large`, EBS 100 GiB, 세 MSK subnet과 `DevMskSg`.
  SASL/IAM만 켜고 unauthenticated·SCRAM은 끈다. client-broker TLS와 in-cluster 암호화를 쓰며
  저장 암호화는 AWS 관리 키(KMS 미지정)다. public access는 `DISABLED`다.
  broker 로그는 `/aws/vendedlogs/msk/soma-376-dev-telemetry`(14일, DESTROY)에 보내며 enhanced monitoring은 `DEFAULT`다.
- configuration: `auto.create.topics.enable=false`, `default.replication.factor=3`, `min.insync.replicas=2`, `num.partitions=6`,
  `unclean.leader.election.enable=false`(MSK 기본값 `true`를 덮는다), `message.max.bytes`와 `replica.fetch.max.bytes`는 13 MiB(`13631488`),
  `log.retention.hours=72`다. producer의 12 MiB `max.request.size`에 batch 여유를 둔 값이다.
- topic·group은 stage마다 하나다. stage는 기존 `devEksArchivePrefix`에서 정한다. `eks_validation`은 `validation`, `eks`는 `main`이다.
  topic은 `pulsemetry-dev-telemetry-ingress-<stage>`, group은 `pulsemetry-dev-telemetry-ingest-<stage>`다.
  S3 prefix와 topic/group·IAM 범위를 같은 입력으로 바꿔 서로 다른 저장 대상이 같은 group을 공유하지 않게 한다.
- CDK는 topic을 만들지 않는다. Helm 관리 Job이 `--if-not-exists`로 만들고 partition·RF·minISR·보존·크기·unclean 설정을 대조한다.
  다르면 실패하며 자동 재생성하지 않는다.
- 출력은 `MskClusterArn`, `MskClusterName`, `MskStage`, `MskTopicName`, `MskConsumerGroupName`과 역할·세션 이름이다.

### 3. bootstrap 입력

- Lambda·`AwsCustomResource`를 만들지 않는다. 운영자가 `aws kafka get-bootstrap-brokers --cluster-arn <MskClusterArn>`의 JSON을
  values 생성기 `--msk-bootstrap`에 전달한다.
- 생성기는 `BootstrapBrokerStringSaslIam` 키 하나만 허용한다. broker 3개(`b-1`~`b-3`), 포트 9098, `MskClusterName`·리전과 같은 호스트 형식을 검사한다.
  public·평문·TLS 전용 키가 있으면 거부한다.

### 4. 수명과 비용

- MSK는 DevEksStack에 속한다. `devEksEnabled=false`나 EKS 스택 삭제는 MSK와 72시간 backlog를 함께 삭제한다.
  배포 설정에서 `devEksEnabled=true`를 유지하는 기존 규칙(AGENTS.md EKS 병행 전환 규칙)을 그대로 적용한다.
- MSK 생성은 수십 분이 걸리며 실패하면 EKS 스택 업데이트 전체가 롤백된다. 운영자는 별도 변경 없이 MSK 추가만 담은 배포를 먼저 수행한다.
- broker 3대·스토리지·로그는 상시 비용이다. 비용 수치는 배포 전 계정 요금표로 확인한다.

### 5. 관측

- MSK 경보: `KafkaDataLogsDiskUsed`(broker 최대), `UnderMinIsrPartitionCount`, `OfflinePartitionsCount`,
  stage group·topic의 `EstimatedMaxTimeLag`·`SumOffsetLag`.
- `/eks/dev/application`의 평문 `event=<code>` term으로 metric filter와 경보를 만든다. Fluent Bit은 원문 한 줄을 그대로 보낸다.
- SNS가 없으므로 경보는 상태만 남는다. Pod 재시작·OOM 경보는 Container Insights 없이는 지표가 없어 이번 범위에서 제외한다.

## Constraints

- MSK Provisioned는 broker 수와 client subnet 수가 같아야 하고 subnet은 서로 다른 AZ여야 한다.
- `ap-northeast-2a/b/c`에서 `kafka.m7g.large`와 `3.9.x.kraft` 지원 여부는 배포 전 `aws kafka list-kafka-versions`와 콘솔로 확인한다.
- MSK IAM 클라이언트 포트는 VPC 내부 9098이다.

## Alternatives Considered

### A. VPC `maxAzs`를 3으로 바꾸거나 subnet 구성을 추가
- 장점: CDK의 기본 subnet 선택을 쓸 수 있다.
- 단점: 기존 subnet 계산과 logical ID, AZ 선택이 바뀐다. ALB·RDS·EKS·ClickHouse 배치까지 영향을 준다.
- 탈락 이유: `maxAzs: 2` 불변식과 기존 리소스 보존 조건을 깨뜨린다.

### B. MSK를 별도 스택에 둔다
- 장점: EKS 스택과 수명을 분리한다.
- 단점: 스택 하나와 cross-stack 참조가 늘고, Pod Identity 역할의 topic ARN 조립이 다른 스택에 의존한다.
- 탈락 이유: MSK는 EKS 경로에서만 쓰이며, EKS 비활성화는 경로 전체 제거와 같다. 수명 분리의 이득이 작다.

### C. MSK Serverless
- 장점: broker 크기 관리가 없다.
- 단점: 최대 메시지 크기가 공통 계약의 12 MiB record보다 작고 broker 설정 제어가 제한된다.
- 탈락 이유: 공통 계약(Provisioned 3 broker)과 맞지 않는다.

### D. bootstrap을 `AwsCustomResource`로 조회
- 장점: output 하나로 생성기가 끝난다.
- 단점: Lambda·IAM이 EKS 스택에 추가된다. 조회 실패가 스택 실패가 된다.
- 탈락 이유: 운영자 조회 JSON과 생성기 검증으로 충분하다.

## Consequences/Tradeoffs

### Positive
- 기존 VPC·subnet·SG·배치를 바꾸지 않고 3 AZ broker를 둔다. broker는 인터넷 경로가 없는 subnet에 있다.
- stage별 topic/group과 S3 prefix가 같은 입력에서 정해져 검증과 본 수집 데이터가 섞이지 않는다.

### Negative
- EKS 스택 배포 시간과 실패 범위가 커진다. EKS 비활성화 시 backlog를 잃는다.
- bootstrap 조회가 수동 단계다. 운영자가 잘못된 cluster의 JSON을 쓰면 생성기 검증이 막지만 조회 자체는 자동화되지 않는다.
- Gateway·Consumer·RDS의 AZ 이중화가 아니다. MSK의 broker/AZ 장애 대응 범위만 다룬다.
- 경보 알림 경로(SNS)와 Pod 재시작·OOM 경보가 없다.

## Follow-up

- 허브 ADR 0001(인증)·0005·0006(수집 경로·영속화 전 마스킹)의 부분 대체가 필요하다. 이번 범위는 infra·backend 레포뿐이므로 허브 개정은 별도 작업이다.
  요지: HTTP 200은 Kafka 접수를 뜻하고, Kafka에는 서버 마스킹 전 원문이 72시간 저장되며, telemetry 인증은 JWT(Gateway)와 RDB(Consumer)로 나뉜다.
- Pod 재시작·OOM 경보(Container Insights 또는 kube-state-metrics 수집 경로 결정 후).
- 경보 알림(SNS·Chatbot) 연결.
- `3.9.x.kraft` 버전 문자열과 서울 리전 3 AZ의 `kafka.m7g.large` 가용성은 배포 전 확인한다. 4.x 업그레이드는 backend client 호환을 확인한 뒤 결정한다.

## Acceptance Criteria

- EKS 비활성 합성에는 MSK·subnet·SG가 없고 EKS 활성 합성에는 subnet 3개·SG 10개·MSK cluster/configuration 각 1개가 있다.
- 기존 Network 리소스의 logical ID·속성이 EKS 활성화 전후 같다. prod·cicd 템플릿은 기존과 같다(cicd는 ADR-0036의 ECR 권한만 추가).
- template assertion으로 broker 설정·인증·암호화·public access·로그와 configuration 속성을 고정한다.
- 실제 broker 생성, IAM 접속, AZ 장애 후 ISR 2 쓰기 재개는 AWS 적용 후 별도 수락 항목이다.

## References

- [PROJ-246](https://team376.atlassian.net/browse/PROJ-246), 상위 [PROJ-205](https://team376.atlassian.net/browse/PROJ-205)
- [MSK supported versions](https://docs.aws.amazon.com/msk/latest/developerguide/supported-kafka-versions.html)
- [MSK custom configuration properties](https://docs.aws.amazon.com/msk/latest/developerguide/msk-configuration-properties.html)
- [MSK IAM access control](https://docs.aws.amazon.com/msk/latest/developerguide/iam-access-control.html)
- [MSK consumer lag metrics](https://docs.aws.amazon.com/msk/latest/developerguide/consumer-lag.html)
- [CloudFormation AWS::MSK::Cluster](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-msk-cluster.html)
