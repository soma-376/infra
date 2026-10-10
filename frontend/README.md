# 프론트엔드 Terraform 기반 인프라

기존 `lib/`의 CDK 리소스와 별개로 관리한다. [PROJ-216](https://team376.atlassian.net/browse/PROJ-216)의
범위는 부트스트랩·네트워크·ALB·ACM·개발 EC2·운영 Fargate와 Terraform CI다.
근거는 [ADR 0027](../docs/adr/0027-isolate-frontend-terraform-network.md),
[ADR 0028](../docs/adr/0028-frontend-alb-and-container-runtime.md)이다.
**코드와 mock 검증이며 AWS에 적용한 결과가 아니다.**

## 네트워크

| 항목 | 개발 | 운영 |
|---|---|---|
| VPC | `10.2.0.0/16` | `10.3.0.0/16` |
| public (2a / 2c) | `10.2.0.0/24`, `10.2.1.0/24` | `10.3.0.0/24`, `10.3.1.0/24` |
| private (2a / 2c) | 없음 | `10.3.16.0/24`, `10.3.17.0/24` |
| public 기본 경로 | IGW | IGW |
| private 기본 경로 | 없음 | 2a의 NAT Gateway 하나 |

새 VPC 두 개이며 기존 CDK 개발/운영 VPC 두 개와 공유하지 않는다. 실제 연결망과 CIDR 충돌,
계정의 AZ 사용 가능 여부는 관리자 plan 전에 확인한다. 모든 서브넷의 public IP 자동 할당은 끈다.
개발 EC2에서만 public IP를 명시적으로 할당한다. public 여부는 IGW 라우팅으로 결정된다.
운영 NAT와 EIP는 적용하는 순간부터 비용이 발생하고, NAT AZ 장애 시 양쪽 private 서브넷의
외부 통신이 중단될 수 있다. 네트워크 분리는 서버 이중화를 의미하지 않는다.

## 디렉터리와 소유권

```text
frontend/
  bootstrap/           상태용 S3 3개, ECR·CI 역할·실행 역할·BFF secret 메타데이터
  modules/network/     환경별 네트워크 공통 코드
  modules/application/ ALB·ACM·DNS·SG·로그·ECS·개발 EC2
  environments/dev/    개발 root / 독립 backend
  environments/prod/   운영 root / 독립 backend
  scripts/check.sh     AWS 자격증명 없는 검증
```

S3 버킷은 bootstrap/dev/prod 각각 하나다. bootstrap 상태는 CI에 공개하지 않는다.
개발 역할은 개발 상태만, 운영 역할은 운영 상태만 접근한다. S3 native lock을 사용한다.
S3와 ECR은 `prevent_destroy`와 강제 삭제 금지로 보호한다. backend는 AWS 기본 자격증명
체인을 사용하고, provider와 backend 모두 입력한 계정 ID를 검증한다. 계정 ID와 자격증명은 파일에 커밋하지 않는다. 비밀이 아닌 runtime 릴리스 입력만 예외적으로 추적한다.

GitHub OIDC provider는 계정 전역 리소스이므로 기존 CDK provider를 조회만 한다. 없으면 관리자가
기존 CDK cicd 절차로 먼저 준비한다. 프론트 전용 역할은 기존 배포 역할을 변경하지 않는다.
apply 역할은 네트워크/SG의 소유권 태그와 환경별 리소스 이름/ARN으로 쓰기 대상을 제한한다.
EC2 실행 권한은 dev에만 주고, IAM 수정 권한은 주지 않는다. 고정 execution/instance 역할에 대한
서비스별 PassRole만 허용한다. plan은 메타데이터·자기 환경 상태 읽기와 잠금만 가능하다.
CI는 secret 값을 읽지 않는다. 실행 역할은 자기 환경 ECR·로그·BFF secret만 사용한다.
ACM 태그 포함 생성은 AddTags 권한도 요구하므로 소유권 태그가 없는 인증서에 초기 태그를
붙이는 권한이 있다. IAM은 이것이 방금 생성한 인증서인지 구분하지 못하므로, 같은 계정의 기존
인증서에도 소유권 태그를 유지하고 이 CI 역할을 검토된 workflow에서만 사용한다.
실제 IAM 평가는 SCP·permission boundary·서비스 조건에 영향을 받으므로 mock 결과와 구분한다.

## 로컬 및 PR 검증

Terraform **1.13.5**를 사용한다. provider 버전·플랫폼 체크섬은 각 root의 lock 파일에 고정한다.

```bash
bash frontend/scripts/check.sh
```

fmt, backend를 연결하지 않는 init, validate, `mock_provider "aws"` 기반 test만 실행한다.
테스트 안의 `command = apply`는 mock provider에만 적용하며 실제 AWS를 생성하지 않는다.
provider 설치에는 네트워크가 필요하지만 AWS 자격증명은 필요 없다.
업그레이드는 lock 파일 변경과 함께 PR로 검토한다. state, `.terraform/`, 관리자용 실제 tfvars,
backend 설정, binary plan은 커밋하지 않는다.

## 최초 부트스트랩 — 관리자 1회 작업

아래는 관리자가 리뷰·머지된 커밋에서 수행할 절차이며 이번 코드 작성 중 실행한 명령이 아니다.
AWS 로그인, 기존 OIDC provider, 실제 account ID, 저장소 OIDC subject prefix를 먼저 준비한다.
subject는 저장소 생성 시기/설정에 따라 immutable ID를 포함할 수 있다. 실제 `sub`의
`:environment:` 앞부분을 확인하고 입력한다. JWT 원문을 로그·PR에 게시하지 않는다.

```bash
cd frontend/bootstrap
cp terraform.tfvars.example terraform.tfvars
# terraform.tfvars에 실제 account ID와 github_subject_prefix를 입력한다.
terraform init
terraform plan -out=bootstrap.tfplan
# 계획 검토 후 실행한다.
terraform apply bootstrap.tfplan
terraform output
```

생성된 bootstrap 버킷으로 자신의 상태도 이전한다.

```bash
cp backend.tf.example backend.tf
terraform init -migrate-state \
  -backend-config='bucket=<output의 bootstrap 버킷>' \
  -backend-config='allowed_account_ids=["<실제 계정 ID>"]'
terraform state list
```

`backend.tf`는 Git에서 제외된다. 이후 관리자 checkout에서도 이 파일을 복원하고 동일 버킷으로
init해야 한다. 이전 후에는 로컬 상태로 bootstrap apply를 다시 실행하지 않는다.
S3 최신 상태와 버전 관리가 확인된 뒤 로컬 상태·백업·계획 파일은 안전하게 정리한다.
부트스트랩 변경도 PR→머지→관리자 계획 검토→적용 순서이며, 네트워크 CI 역할에 자기 IAM 수정권을 주지 않는다.

## GitHub 설정 — AWS 연동 활성화 전 필수

이 저장소의 GitHub Settings에서 설정한다. Terraform 코드가 GitHub 설정까지 자동 변경하지는 않는다.

| Environment | 허용 실행 | 변수 |
|---|---|---|
| `frontend-dev-plan` | 검토된 동일 저장소 PR 및 필요한 검증 실행 | `TF_STATE_BUCKET`, `TF_PLAN_ROLE_ARN` |
| `frontend-prod-plan` | 검토된 동일 저장소 PR 및 필요한 검증 실행 | `TF_STATE_BUCKET`, `TF_PLAN_ROLE_ARN` |
| `frontend-dev-apply` | `develop` 브랜치만 | `TF_STATE_BUCKET`, `TF_APPLY_ROLE_ARN` |
| `frontend-prod-apply` | `main` 브랜치만 | `TF_STATE_BUCKET`, `TF_APPLY_ROLE_ARN` |

- 네 Environment 모두 required reviewers와 자기 승인 금지를 설정한다. PR 코드도 상태를 읽을 수
  있으므로 plan 역할 승인은 코드·workflow 검토 후에만 한다. fork PR는 AWS plan을 실행하지 않는다.
- OIDC subject는 Environment 단위다. **apply Environment의 branch 제한이 실제 권한 경계**다.
  보호 규칙 없이 Environment만 생성하면 어느 브랜치든 그 역할을 요청할 수 있으므로 활성화하지 않는다.
- `develop`, `main`은 PR·리뷰·필수 검증을 요구하고 직접 push 및 보호 우회를 제한한다.
  workflow와 `frontend/` 변경도 인프라 담당자가 검토한다.
- 저장소 변수 `AWS_ACCOUNT_ID`에 계정 ID를 넣고, 각 Environment에는 bootstrap output의
  해당 버킷·역할 ARN을 넣는다. 최초 bootstrap과 환경 보호 설정을 완료한 뒤 workflow를 실행한다.
- 초기 준비용 실행 플래그는 제거했다. 동일 저장소 PR는 검증 성공 후 dev/prod plan을 실행하며,
  설정이나 권한이 누락되면 실패로 표시한다. AWS plan 결과도 필수 리뷰에 포함한다.
- apply는 `develop`/`main`의 변경과 해당 Environment의 보호 규칙을 따른다. 저장소에 남아 있는
  `FRONTEND_TERRAFORM_ENABLED` 변수는 더 이상 사용하지 않으므로 삭제해도 된다.
- 일반 개발자의 로컬 AWS 권한에서 인프라 쓰기를 제한하는 것은 계정 관리자 책임이다.
  workflow 추가만으로 기존 관리자 권한이 회수되지는 않는다.

## 일상 변경 흐름

```text
PR → fmt/validate/mock test → 보호된 Environment 승인 → dev/prod plan
develop 머지 → 검증 → frontend-dev-apply 승인 → 최종 plan → 같은 계획 apply
main 머지 → 검증 → frontend-prod-apply 승인 → 최종 plan → 같은 계획 apply
```

Environment 승인은 머지된 코드와 PR 계획을 기준으로 **job 시작 전**에 한다. 승인 후 최신 상태로
최종 plan을 만들고 같은 job에서 저장된 binary plan을 적용한다. 최종 plan 뒤 별도 승인 gate는 없다.
해당 단계에서 더 엄격한 승인이 필요하면 별도 접근 통제된 plan 저장·승인 흐름을 추가한다.
계획/상태 파일을 공개 저장소의 artifact에 올리지 않는다. 현재 구성은 secret ARN만 저장하며
비밀 값을 plan에 넣지 않는다. 이미지나 환경 변수에 자격증명을 추가하지 않는다.

apply는 환경별 직렬화, S3 잠금, 실행 직전 branch HEAD 검사를 사용한다. 이전 커밋의 재실행은
거부한다. `push` trigger 자체는 직접 push와 merge를 구분하지 않으므로 branch protection이 필요하다.
부트스트랩 뒤 최초 네트워크 배포는 해당 환경 브랜치의 다음 머지 또는 현재 HEAD workflow 재실행으로 한다.

## 실행 환경 활성화

초기 `runtime = null`은 네트워크만 생성한다. ALB·인증서·서버를 활성화하려면 다음을 순서대로 준비한다.

1. 실제 개발/운영 도메인과 같은 계정의 **public Route 53 zone**을 정한다. zone 자체와 도메인 구매/NS 위임은 이 코드가 관리하지 않는다. 개발과 운영 도메인은 달라야 한다.
2. bootstrap의 `frontend_dns`에 환경별 `domain_name`, `zone_id`를 입력하고 관리자 plan/apply로 해당 DNS 권한을 먼저 반영한다. 기존에 bootstrap을 적용했어도 새 execution/instance 역할과 빈 BFF secret을 반영해야 한다.
3. 계정에 `AWSServiceRoleForECS`, `AWSServiceRoleForElasticLoadBalancing`이 있는지 관리자가 확인한다. 기존 CDK/AWS 소유 공용 역할이며 이 코드에서 생성/import하지 않는다. 없으면 관리자가 서비스 연결 역할을 먼저 만든다. CI에는 IAM 생성 권한이 없다.
4. `bff_secret_arns` 출력의 각 환경 secret에 서로 다른 BFF 키를 **관리자 콘솔에서 값으로 저장**한다. 값은 프론트 `BFF_SESSION_KEYS` 형식(32-byte hex 키, 회전 시 쉼표로 최대 3개)이다. Terraform으로 secret version을 만들지 않는다. 빈 secret 상태로는 태스크가 시작되지 않는다.
5. 실제 Next.js **linux/arm64** 이미지를 환경별 ECR에 올리고 digest를 확인한다. 이미지 빌드·push와 앱 CI 역할은 후속 앱 작업이다. 컨테이너는 `0.0.0.0:3000`에서 Next.js 프로세스 하나를 실행하고 `/`에 HTTP 200을 응답해야 한다. 빌드 시 `NEXT_PUBLIC_ENROLLMENT_API_URL`에 해당 환경의 공개 HTTPS enrollment origin을 넣는다. 이 값은 이미지 빌드 후 런타임 환경 변수로 바뀌지 않는다.
6. 개발 AMI는 서울 리전 ECS optimized AL2023 ARM64 AMI의 실제 ID를 조회해 고정한다. 아래 명령은 조회만 한다.

```bash
aws ssm get-parameter --region ap-northeast-2 \
  --name /aws/service/ecs/optimized-ami/amazon-linux-2023/arm64/recommended/image_id \
  --query 'Parameter.Value' --output text
```

7. 각 환경의 `runtime.auto.tfvars.json.example`을 `runtime.auto.tfvars.json`으로 복사하고 실제 도메인·zone·digest·AMI·백엔드 HTTPS origin을 입력한다. **이 파일만 비밀 없는 릴리스 설정으로 Git에 커밋한다.** PR plan과 머지 후 apply가 같은 입력을 사용한다. bootstrap DNS 권한과 도메인/zone 값이 같아야 한다. example placeholder는 그대로 적용할 수 없다.
8. 백엔드가 실제 HTTPS로 응답하고 프론트 `https://<domain>/auth/callback`과 허용 origin이 등록됐는지 확인한다. 현재 백엔드가 HTTP만 지원한다면 이 선행 작업을 먼저 끝낸다. VPC peering은 없으며 BFF는 공개 HTTPS 백엔드로 연결한다.
9. runtime 설정 PR을 검토한 뒤 develop 또는 main에 머지하고 해당 Environment 승인 후 적용한다. image digest도 이후 이 파일의 PR로 변경한다.

ALB는 public subnet 두 개, 앱 ingress는 ALB SG의 TCP 3000만 허용한다. 개발 EC2는
ECS EC2/bridge 모드이며 public IP는 외부 통신에 사용한다. SSH는 열지 않고 SSM으로 관리한다.
운영은 private subnet Fargate, public IP 없음, NAT를 통한 HTTPS egress다.
로그는 [ADR 0020](../docs/adr/0020-frontend-log-retention-policy.md)에 따라 dev 14일/prod 30일 보존하고
실행 환경 삭제 시 로그 그룹을 남긴다. 다시 생성하려면 기존 로그 그룹을 해당 환경 상태로 import한다.
루트 URL의 ALB health check는 HTTP 서버 생존 확인이며 로그인·백엔드 연결 성공을 증명하지 않는다.

두 환경의 태스크 수는 **1개**, 배포 비율은 min 0% / max 100%다. 기존 태스크를 중지한 뒤 새 태스크를
실행하므로 배포 중 잠시 응답할 서버가 없다. 허브 ADR 0009의 단일 BFF 프로세스 제약 때문에
autoscaling·복제본·blue/green은 사용하지 않는다. 이 제약을 풀려면 BFF 설계 변경이 먼저다.
개발 EC2도 AMI/user data 변경 시 기존 인스턴스를 제거하고 교체한다.

상태 S3 key는 호환성을 위해 계속 `network/terraform.tfstate`다. **이름에 network가 있어도
ALB·인증서·실행 환경까지 같은 dev/prod 상태에 저장된다.** 새 key로 임의 변경하면 안 된다.

## 배포 확인과 롤백

- Terraform은 ECS steady state까지 기다린다. 실제 적용 후 ECS event, ALB target health, HTTPS 응답과 로그인 callback을 별도로 확인한다. mock test로 대체할 수 없다.
- ECS circuit breaker가 실패를 감지하고 이전 완료 배포가 있으면 롤백한다. **최초 배포에는 이전 정상 버전이 없다.** secret/이미지/네트워크를 수정한 뒤 재배포한다.
- 수동 롤백은 runtime 파일의 image digest를 이전 정상 digest로 되돌리는 PR을 머지한다. 설정/키도 이전 이미지와 호환되어야 한다. Terraform이 새 task definition으로 배포하고 안정화를 확인한다.
- 키 회전 후 태스크를 재시작해야 새 secret 값이 주입된다. 키 값만 바꾸면 실행 중인 프로세스는 자동 갱신되지 않는다.
- 활성화 후 runtime을 null로 지우면 ALB·인증서·실행 환경 삭제 계획이 나온다. 운영 ALB는 삭제 보호가 켜져 있어 해제 변경을 먼저 검토해야 한다. S3/ECR/secret은 bootstrap의 삭제 보호를 유지한다.
- 앱 CI의 이미지 빌드/push 역할과 workflow는 아직 추가하지 않았다. 현재 Terraform 역할에는 ECR push 권한이 없다.

## 참고

- [Terraform S3 backend](https://developer.hashicorp.com/terraform/language/backend/s3)
- [Terraform provider mocking](https://developer.hashicorp.com/terraform/language/tests/mocking)
- [GitHub OIDC와 AWS](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws)
- [EC2 IAM 지원 범위](https://docs.aws.amazon.com/service-authorization/latest/reference/list_ec2.html)
