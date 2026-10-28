# PROJ-260 bootstrap 상태 점검과 선행 적용 순서

## 점검 결과 (2026-10-28)

실제 apply·state 갱신·import·원격 상태 이전은 하지 않았다. 원본 state를 임시 디렉터리에 복사한 뒤
최신 develop `6a045b2`의 bootstrap 코드로 `terraform plan -lock=false`를 실행했다.

- 로컬 `terraform.tfstate`: serial 79, managed 리소스 인스턴스 63개 + data source 1개.
- 백업: 같은 lineage의 serial 76. 확인된 로컬 두 파일 중 serial 79가 최신이다.
- 예상 bootstrap S3 버킷은 현재 객체·과거 버전·delete marker가 모두 없다. S3 이전 완료 상태가 아니다.
- refresh 과정에서 기존 관리 리소스의 삭제/재생성 계획은 없었다. dev IAM 역할 3개의 inline policy 조회 값은 저장된 state와 달랐다.
- 최신 develop 자체의 전체 계획은 **1 create / 5 update / 0 destroy**다. 아래 prod 변경은 이번 PR 이전부터 존재한다.
- 이번 관측 권한을 추가한 전체 계획은 **8 create / 5 update / 0 destroy**다. 차이는 신규 관측 IAM 리소스 7개다.
- 원본 state의 SHA-256이 점검 전후 동일함을 확인했다. state·binary plan·AWS 상세 조회 원문은 Git/PR에 게시하지 않는다.

따라서 이 state는 기존 리소스를 정상 추적하는 **확인 가능한 최신 로컬 원본**이지만 AWS 실제 값과
완전히 동기화된 snapshot이라고 할 수 없다. 다른 운영자의 별도 state 보유 여부까지 증명한 것은 아니다.
이 결과만으로 전체 bootstrap apply를 승인한 것으로 간주하지 않는다.

## 이번 관측 코드 이전부터 남아 있는 prod 변경

| Terraform 주소 | 계획 |
| --- | --- |
| `aws_ecr_repository.frontend["prod"]` | deploy 태그 mutable 예외 반영 |
| `aws_iam_policy.runtime_write["prod"]` | 기존 prod runtime 권한 변경 |
| `aws_iam_policy.security_groups["prod"]` | 기존 prod SG 권한 변경 |
| `aws_iam_role_policy.frontend_image_deploy["prod"]` | prod 이미지 배포 정책 생성 |
| `aws_iam_role_policy.runtime_read["prod-apply"]` | 조회 권한 갱신 |
| `aws_iam_role_policy.runtime_read["prod-plan"]` | 조회 권한 갱신 |

prod 이미지 배포 inline policy가 AWS에 없음을 별도 조회로 확인했다. 단순히 state에서 빠진 기존 정책을
중복 생성하는 상황은 아니다. dev IAM drift는 중복으로 보이는 role의 inline-policy 조회 속성에도 나타나므로,
실제 관리 주체인 `aws_iam_role_policy` 계획을 함께 읽어야 한다.

## PR 분리와 적용 순서

1. **bootstrap PR**: 관측 SSM 전용 역할·profile, SSM managed policy 연결, dev plan/apply profile 읽기,
   dev apply의 제한된 PassRole/EBS 권한을 추가한다. EC2/SG/디스크는 만들지 않는다.
2. 이 PR의 검증과 리뷰 후 머지한다. 기존 환경 workflow는 돌 수 있으나 bootstrap 디렉터리는 자동 apply하지 않는다.
3. 관리자가 최신 원본 state와 기존 tfvars를 보존하고, 머지 커밋으로 **새 전체 plan**을 만든다.
   예상 신규 IAM 7개 외에 위 prod 선행 변경도 포함되는지 검토한다. 다른 기존 리소스 생성/삭제/교체가 보이면 원인을 확인한다.
4. 승인된 관리자 작업에서만 저장된 plan을 적용한다. 이 점검 작업에서는 적용하지 않았다.
5. bootstrap 원격 상태 이전은 별도의 승인된 관리 작업으로 처리한다. 현재 원격 버킷이 비어 있으므로
   로컬 원본 없이 빈 S3 backend로 재초기화하거나 오래된 state로 덮어쓰지 않는다. 이전 시 기존 README의
   `init -migrate-state` 절차와 state list/lineage/serial 검증을 따른다.
6. **관측 EC2 PR**: bootstrap 적용 이후 AWS dev plan을 다시 확인한다. 전용 profile이 없으면 이 PR의 dev plan은 실패한다.
7. 관측 PR 머지 후 보호된 dev apply가 EC2·EBS·SG를 생성하고 첫 부팅에서 관측 스택을 시작한다.
   아직 앱 연결·prod 네트워크 연결은 하지 않는다.

운영 계획은 실행 시점에 다시 만들어야 한다. 이 문서의 숫자나 로컬의 과거 plan 파일을 그대로 신뢰해 적용하지 않는다.
