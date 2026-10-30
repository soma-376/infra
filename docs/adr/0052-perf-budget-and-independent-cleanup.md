# 0052. perf 시험 예산을 고정하고 독립 정리 보호를 먼저 생성한다

## Status

Accepted — PROJ-294 로컬 구현 대상이다. 실제 비용·배포·강제 정리 성공은 별도 증거로 확인한다.

## Context

사용자는 한 번의 시험 전체에 100,000원과 생성부터 삭제 완료까지 24시간을 허용했다. 이전 evidence 90일 보존과 Kafka Retain만으로는 이 조건을 만족하지 않는다. 세션 단절 후에도 정리가 시작되어야 하며, 기존 dev·공유 ACM·공유 ECR를 삭제해서는 안 된다.

## Decision

- 현행 Strimzi profile에 승인된 실행 제한과 profile SHA를 묶은 budget policy를 적용한다. 예상 비용은 가정이며 실제 청구액 검증이 아니다. 다른 profile·NAT 수·상한 확대는 합성 단계에서 거부한다. MSK/v2 과거 호환 경로는 그대로 둔다.
- 총 요청 10,000, 최대 20RPS, 실행당 600초, 시험 추가 저장 1GiB로 제한한다. drain 900초와 최종 저장 검증 900초는 각각 별도다. ClickHouse/Kafka 가용 공간은 max(20GiB, 20%), 발생기는 max(10GiB, 20%)다. 실행 전 최신 관측·누적 요청 예산·추가 저장 예상량·정리 여유 시간을 확인하고 부족하면 시작하지 않는다.
- VPC 밖 PerfGuardrailStack을 먼저 만든다. EventBridge가 매분 Lambda를 호출하고 SSM Parameter에 정리 단계/오류를 기록한다. 수명 기준은 실제 스택 CreationTime과 이 환경에 새로 만든 ECR createdAt 중 가장 이른 시각이며 사용자 입력으로 연장하지 않는다. 22시간부터 강제 정리하고 24시간 내 삭제를 확인한다. 수동 정리 요청도 같은 드라이버를 사용한다.
- private EKS는 기존 relay에서 고정 SSM 문서를 실행해 정리한다. relay에 전용 perf EKS 접근만 추가하고, 임의 명령 매개변수는 제공하지 않는다. TGB/앱/Kafka/PVC를 클러스터가 살아 있을 때 제거한 뒤 Edge/EKS/Data/Network/Evidence 순서로 CloudFormation 삭제를 요청한다. 관측 시스템과 Strimzi operator는 자신이 관리하는 자원을 먼저 지운 뒤 제거한다. 모든 데이터 자원을 지운 뒤 전용 클러스터의 PDB를 제거하여 마지막 addon 노드 drain이 막히지 않게 한다.
- 드라이버는 고정 스택 허용목록·계정·리전·환경 소유 태그를 확인한다. 새 perf ECR 두 저장소는 CDK 밖에서 환경 태그로 만들며 이미지 포함 삭제한다. 이름만 같고 태그가 없거나 다른 자원은 채택하지 않는다. 소유 EBS 잔존·버전 있는 S3 객체/delete marker·multipart도 확인/정리한다. shared ACM·기존 ECR·dev는 허용목록 밖이다.
- 저장소의 `explicitStackTags=true`에 맞춰 `addStackTag()`로 CFN 스택 태그를 명시하고 `Tags.of()`로 자원 태그도 유지한다. 템플릿 자원 태그만 보고 스택 소유권을 추정하지 않는다. 직렬화한 assembly의 tags를 CFN API 형식으로 대조하고, 배포 뒤 실제 DescribeStacks 태그와 observe WAITING을 확인한다.
- 현행 Strimzi evidence도 환경 소유/Destroy로 전환한다. 증거는 정리 전에 로컬 보고서로 내려받는다. AWS 잔존 검사를 마친 뒤 GuardrailStack 자체도 삭제한다. Resource Groups Tagging API 조회만으로 모든 잔존 부재를 주장하지 않는다.
- 실패는 상태/CloudWatch 로그에 남기고 다음 호출에서 재시도한다. 세션의 운영자가 실패를 확인해 채팅에 보고한다. 외부 알림 또는 AWS 장애 중 정확히 24시간 삭제를 보장한다고 표현하지 않는다. 기한이 지나면 시험은 금지하고 삭제 재시도만 계속한다.

## Alternatives Considered

로컬 타이머만 사용하면 세션 단절 후 정리가 시작되지 않는다. Lambda를 workload VPC에 두면 Network 삭제와 ENI 의존성이 생긴다. EKS부터 지우면 TGB finalizer와 Kafka/PVC/EBS가 남을 수 있다. 계정 전체 이름 prefix 삭제는 기존 자원과 소유권을 구분하지 못한다.

## Consequences/Tradeoffs

### Positive

승인 예산과 제한을 기계적으로 대조하고, workload와 독립적인 정리 경로가 실패 후 재시도한다. 보존 정책을 실제 24시간 요구에 맞추고 공유 자원은 제외한다.

### Negative

정리 Lambda·SSM 문서·제한된 삭제 권한과 소량의 실행/로그 비용이 추가된다. Kubernetes finalizer 또는 AWS 장애는 수동 개입이 필요할 수 있다. 독립 정리가 증거 업로드를 중단할 수 있으므로 로컬 증거 수집을 시험 절차에 포함한다.

## Acceptance Criteria

잘못된 소유권/계정/리전, 갱신으로 TTL 연장, 초과 요청/시간/저장/디스크 부족을 거부한다. 정리 단계 재진입·페이지네이션·ECR 이미지 포함 삭제·S3 버전/multipart·스택 오류 재시도를 모의 API로 검사한다. Guardrail은 VPC 참조가 없고 dev/MSK 기본 합성은 유지한다. 실제 환경에서는 생성 시각·정리 상태·AWS/Kubernetes 잔존 조회 원본을 별도로 보관한다.

## References

- [허브 결정](https://github.com/soma-376/docs/blob/main/adr/0029-perf-strimzi-readiness-and-path-comparison.md)
- [perf 기반](0050-perf-strimzi-provider-and-isolated-capacity.md)
- [AWS CloudFormation 권한](https://docs.aws.amazon.com/service-authorization/latest/reference/list_cloudformation.html)
- [Amazon ECR 권한](https://docs.aws.amazon.com/service-authorization/latest/reference/list_ecr.html)
- [SSM 명령 상태](https://docs.aws.amazon.com/systems-manager/latest/userguide/monitor-commands.html)

## 2026-10-30 Auto Mode controller 소유 자원 정리 보완

NodeClass 생성만으로도 전용 NodeRole에 연결된 instance profile이 만들어진다. NodePool·node·NodeClaim 소멸 후 동일 환경 태그와 실제 NodeRole을 확인한 NodeClass를 삭제하고 finalizer의 자연 완료를 기다린다. EKS/NodeRole 스택을 지우기 전 IAM ListInstanceProfilesForRole의 모든 페이지가 비고 소유 launch template도 없는지 확인한다. Guardrail은 이를 조회하는 최소 권한만 더하며 profile/launch template 직접 삭제나 finalizer 강제 제거 권한을 추가하지 않는다. CFN 밖 profile/LT도 최종 inventory와 서비스별 부재 증거에 포함한다.

## 2026-10-31 관리형 자원 가시성 보완

AWS는 2026-04-22부터 새 Auto Mode EC2/EBS/launch template/ENI를 기본 목록에서 숨긴다.
실제 perf 노드 9개가 존재하는데 기본 소유 태그 EC2 조회는 relay 1개만 반환했다.
정리 드라이버는 EC2 인스턴스·볼륨·launch template 조회에 `IncludeManagedResources=True`를 명시한다.
계정 전체 가시성 설정은 바꾸지 않고 기존 소유 태그·계정·리전·고정 이름 검증을 유지한다.
SDK의 세 operation 입력에 boolean 옵션이 없으면 정리 전에 오류를 기록하며, 옵션 없는 재시도는 금지한다.
정확한 환경의 `sdk_capabilities` 진단 이벤트는 SDK 버전·지원 여부만 반환하고 상태나 자원을 쓰지 않는다.
실제 Lambda SDK 지원·숨겨진 자원 포함 조회·최종 서비스별 부재는 배포 후 별도로 확인한다.

- [EKS 관리형 자원 가시성](https://docs.aws.amazon.com/eks/latest/userguide/automode-learn-instances.html)
- [Lambda Python SDK 버전](https://docs.aws.amazon.com/lambda/latest/dg/lambda-python.html#python-sdk-included)
