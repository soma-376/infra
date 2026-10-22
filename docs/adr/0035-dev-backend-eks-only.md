# 0035. dev 백엔드의 ECS를 제거하고 기존 EKS를 단독 실행 환경으로 사용한다

## Status

Accepted (PROJ-248의 코드·문서·로컬 검증 결정. 실제 AWS 철거·Snapshot·기능 검증은 별도 실행이다.)

백엔드 ADR 0028의 ECS 병행 유지·Canary 후 제거 결정을 dev 백엔드에 한해 대체한다.
ADR 0001·0002·0003·0005·0006·0009·0016·0021·0022·0024·0026·0029·0030·0032·0033의
dev ECS 실행·스택·설정·배포 권한 가정도 해당 범위만 대체한다. prod와 frontend Terraform의 ECS,
공유 데이터 원본, WAF 정책, EKS 리소스와 Helm 소유권, ADR 0034의 private API·SSM 접근은 유효하다.

## Context

[PROJ-247](https://team376.atlassian.net/browse/PROJ-247)은 DB 연결 한도 문제로 완전한 전환 검증을
기다리지 않고 ECS를 조기 제거하기로 했다. 이 사유는 연결 누수 진단이나 EKS 기능 검증 완료를 뜻하지 않는다.
PROJ-248은 infra 구현만 담당한다. backend workflow의 ECS 사전 검사·재배포 제거는 PROJ-249이며,
허브 dashboard 계약 §5·ADR 0021의 dev 배포 계약 정합화도 해당 작업에 인계한다.
이 문서는 그 크로스레포 계약을 단독 개정하지 않고 인프라의 제거 경계와 적용 순서를 결정한다.

## Decision

1. dev는 Network·Data·Edge·EKS 네 스택을 생성한다. DevApplicationStack과 ECS cluster·네 서비스·
   task definition·두 ASG·capacity provider·Cloud Map·전용 IAM·로그·JWT writer 구현을 제거한다.
2. Edge의 ECS ALB·TG·listener·association과 Network의 ECS SG 세 개·관련 규칙을 제거한다.
   EKS에서 구 ECS ClickHouse로 접근하던 규칙도 제거한다. 최종 ALB 1개·TG 4개·WAF association 1개·
   사용자 정의 SG 6개다. WAF의 정책·로그와 기존 EKS construct 경로·논리 ID·TG 이름·Validation* output을 보존한다.
3. Data의 RDS·S3·Secret 원본과 EKS cluster·Pod Identity·SSM relay·로그, Helm workload·PVC는 유지한다.
   EKS 인증서 입력·NodePort·경로·generated YAML·archive prefix도 바꾸지 않는다.
4. devEksEnabled는 생략 또는 true만 허용한다. devAppAsgMaxCapacity·devImageTag·devCertificateArn·
   devDashboardRuntimeFile은 제거하며 남아 있으면 합성을 거부한다.
5. devOidcClientKeys를 필수 배열 입력으로 받는다. CLI에서는 JSON 배열 문자열을 쓰고 원본이 없으면 []를
   명시한다. key는 기존 영숫자·underscore·hyphen 1~64자, 최대 32개, 중복 금지·대소문자 보존 규칙이다.
   정렬한 key 목록만 Data에 전달한다. 기존 oidc.clients의 key 집합을 그대로 옮겨 원본의 논리 ID·이름·
   Retain·ARN output·EKS 권한을 보존한다. JWT 버전·OIDC callback·앱 설정은 EKS runtime YAML만 소비한다.
6. backend-dev 역할은 세 앱의 ECR 공급 권한만 유지한다. ECS 권한을 회수하되 역할 네 개·OIDC trust·
   ARN output·prod 권한과 pipeline-dev의 권한 0개 상태는 보존한다. EKS 자동 배포 권한은 추가하지 않는다.
7. 실제 철거는 PROJ-249와 허브 계약 정합화 완료 후 수행한다. ECS 앱·ClickHouse 쓰기를 중지하고
   운영자가 데이터 EBS Snapshot을 수동 생성해 completed를 확인한다. EKS로 데이터 이관은 하지 않는다.
   DevApplicationStack 명시적 삭제 완료 → ECS task·ASG·ENI 부재 확인 → Edge 단독 업데이트 →
   Network 단독 업데이트 → cicd 권한 회수 순서다. 최초 철거에 deploy --all을 사용하지 않는다.

## Constraints

- 실제 AWS 변경, backend·허브·frontend 소스 변경은 PROJ-248 범위가 아니다. Secret 원문은 읽지 않는다.
- EKS만 생성하는 코드로 바꿔도 이미 배포된 Application 스택이 자동 삭제되지는 않는다.
- weak cross-stack reference는 물리 ALB/ENI/SG 종속성을 없애지 않는다. 기존 스택 ID로 명시적 삭제한다.
- 기존 ECS 로그는 현재 DESTROY 정책으로 제거된다. 수동 Snapshot은 자동 삭제 정책을 추가하지 않고 보존한다.
- ECR 저장소는 기존 외부 소유를 유지한다. 이 작업은 ECR 이미지·저장소를 삭제하지 않는다.

## Alternatives Considered

- Canary 완료까지 ECS 유지: 기존 설계지만 연결 한도 문제 때문에 이번 조기 전환에서는 채택하지 않는다.
- ECS desiredCount만 0으로 유지: DB 연결은 줄일 수 있지만 불필요한 리소스와 재기동 경로가 남는다.
- 기존 ECS runtime JSON 유지: EKS CDK에 불필요한 writer image·앱 설정이 계속 필요하므로 OIDC 원본 목록을 분리한다.
- EKS 리소스 이름 일괄 변경: 제거와 무관한 교체 위험 때문에 Validation 명칭도 호환용으로 유지한다.

## Consequences/Tradeoffs

### Positive

dev 중복 실행과 ECS 전용 설정·권한을 제거하고 기존 EKS 리소스와 데이터 원본을 재사용한다.

### Negative

완전한 기능·부하·복구 검증 전에 ECS 복귀 경로를 제거한다. 이후 복구는 이전 인프라 재생성과
Snapshot 복원이 필요하고 코드 revert·Helm rollback만으로 데이터를 복구할 수 없다.
수동 Snapshot은 복원 시험과 별도이며, EKS 운영 안정성이나 DB 연결 문제 해결을 보증하지 않는다.

## Acceptance Criteria

build·전체 Jest·Helm 3.22.0/kubeconform 0.8.0·generator·configtree·OIDC fixture를 통과한다.
기존 EKS 활성 합성과 비교해 보존 리소스 ID·속성 및 prod A/B 템플릿을 확인한다. ECS·ASG·Cloud Map 부재,
최종 리소스 수, OIDC 입력 검증과 원본 보존, dev ECR-only 권한을 검사한다.
런북은 적용 전제·Snapshot·단독 삭제 순서·실패 시 중단·복구 한계를 포함한다.

## References

- [수동 철거 런북](../runbooks/dev-ecs-retirement.md)
- [PROJ-248 로컬 검증 결과](../runbooks/proj248-local-validation.md)
- [백엔드 ADR 0028](0028-dev-eks-auto-mode-transition.md), [EKS 수동 런북](../runbooks/dev-eks-manual-deployment.md)
- [AWS EBS Snapshot](https://docs.aws.amazon.com/ebs/latest/userguide/ebs-creating-snapshot.html)
- [CloudFormation delete-stack](https://docs.aws.amazon.com/cli/latest/reference/cloudformation/delete-stack.html)
