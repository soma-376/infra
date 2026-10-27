# 프론트엔드 Terraform 기반 인프라

기존 `lib/`의 CDK 리소스와 별개로 관리한다. [PROJ-216](https://team376.atlassian.net/browse/PROJ-216)의
범위는 부트스트랩·네트워크·ALB·기존 ACM 인증서 연결·개발 EC2·운영 Fargate와 Terraform CI다.
근거는 [ADR 0030](../docs/adr/0030-isolate-frontend-terraform-network.md),
[ADR 0028](../docs/adr/0028-frontend-alb-and-container-runtime.md),
[ADR 0029](../docs/adr/0029-use-external-dns-and-existing-frontend-certificate.md)이다.
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
  modules/application/ ALB·기존 인증서 연결·SG·로그·ECS·개발 EC2
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
`DescribeTaskDefinition`은 리소스 단위 권한을 지원하지 않아 서울 리전 조회로 제한한다.
태스크 정의는 `skip_destroy = true`로 이전 revision을 보관한다. `DeregisterTaskDefinition`도
ARN 제한을 지원하지 않으므로 CI에 부여하지 않으며, 미사용 revision 정리는 관리자 작업이다.
DNS와 ACM 인증서 발급·검증은 외부에서 관리한다. CI 역할에 Route 53 및 ACM 조회·변경
권한을 주지 않으며, ALB 리스너에 이미 발급된 인증서 ARN만 연결한다.
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

초기 `runtime = null`은 네트워크만 생성한다. ALB·서버를 활성화하려면 다음을 순서대로 준비한다.

1. 서로 다른 실제 개발/운영 도메인을 정하고, 같은 AWS 계정의 **서울 리전 ACM**에서 도메인을 포함하는 public 인증서를 발급한다. 외부 도메인 관리 화면에 ACM 검증용 CNAME을 등록하고 **발급됨(ISSUED)** 및 도메인 일치를 확인한다. 검증 CNAME은 자동 갱신을 위해 유지한다. Route 53 hosted zone이나 NS 변경은 필요 없다.
2. bootstrap 관리자 plan/apply로 execution/instance 역할과 빈 BFF secret을 준비한다. CI는 DNS·인증서를 관리하지 않는다. 이전 버전에서 생성한 인증서·DNS가 있다면 아래 기존 배포 전환 절차를 먼저 따른다.
3. 계정에 `AWSServiceRoleForECS`, `AWSServiceRoleForElasticLoadBalancing`이 있는지 관리자가 확인한다. 기존 CDK/AWS 소유 공용 역할이며 이 코드에서 생성/import하지 않는다. 없으면 관리자가 서비스 연결 역할을 먼저 만든다. CI에는 IAM 생성 권한이 없다.
4. `bff_secret_arns` 출력의 각 환경 secret에 서로 다른 BFF 키를 **관리자 콘솔에서 값으로 저장**한다. 값은 프론트 `BFF_SESSION_KEYS` 형식(32-byte hex 키, 회전 시 쉼표로 최대 3개)이다. Terraform으로 secret version을 만들지 않는다. 빈 secret 상태로는 태스크가 시작되지 않는다.
5. 실제 Next.js **linux/arm64** 이미지를 환경별 ECR에 올리고 digest를 확인한다. 이미지 빌드·push는 프론트 앱 저장소의 workflow와 bootstrap의 환경별 image-push 역할로 수행한다. 컨테이너는 `0.0.0.0:3000`에서 Next.js 프로세스 하나를 실행하고 `/login`에 HTTP 200을 응답해야 한다. 빌드 시 `NEXT_PUBLIC_ENROLLMENT_API_URL`에 해당 환경의 공개 HTTPS enrollment origin을 넣는다. 이 값은 이미지 빌드 후 런타임 환경 변수로 바뀌지 않는다.
6. 개발 AMI는 서울 리전 ECS optimized AL2023 ARM64 AMI의 실제 ID를 조회해 고정한다. 아래 명령은 조회만 한다.

```bash
aws ssm get-parameter --region ap-northeast-2 \
  --name /aws/service/ecs/optimized-ami/amazon-linux-2023/arm64/recommended/image_id \
  --query 'Parameter.Value' --output text
```

7. 각 환경의 `runtime.auto.tfvars.json.example`을 `runtime.auto.tfvars.json`으로 복사하고 실제 도메인·인증서 ARN·digest·AMI·백엔드 HTTPS origin을 입력한다. **이 파일만 비밀 없는 릴리스 설정으로 Git에 커밋한다.** PR plan과 머지 후 apply가 같은 입력을 사용한다. `certificate_arn`에는 같은 계정·서울 리전의 프론트 도메인 인증서를 입력한다. ARN 형식 검증만으로 발급 상태나 도메인 일치는 보장하지 않는다. example placeholder는 그대로 적용할 수 없다.
8. 백엔드가 실제 HTTPS로 응답하고 프론트 `https://<domain>/auth/callback`과 허용 origin이 등록됐는지 확인한다. 현재 백엔드가 HTTP만 지원한다면 이 선행 작업을 먼저 끝낸다. VPC peering은 없으며 BFF는 공개 HTTPS 백엔드로 연결한다.
9. runtime 설정 PR을 검토한 뒤 develop 또는 main에 머지하고 해당 Environment 승인 후 적용한다. 자동 배포 활성화 전까지 image digest도 이 파일의 PR로 변경한다. 자동 배포 전환은 아래 절차를 따른다.
10. 해당 환경의 `terraform output -json application`에서 `alb_dns_name`을 확인하고, 외부 DNS에 **프론트 도메인 → ALB DNS 이름** CNAME을 등록한다. 대상에는 `https://`나 경로를 넣지 않는다. 앞의 ACM 검증 CNAME과 별개이며 두 레코드를 유지한다. DNS가 반영되면 실제 HTTPS 접속과 로그인을 확인한다.

ALB는 public subnet 두 개를 사용한다. 앱 ingress는 ALB SG에서만 받으며, prod는 TCP 3000,
dev는 기존 TCP 3000과 자동 호스트 포트 범위 TCP 32768–65535를 허용한다.
dev는 내부 포트 3000을 유지하고 hostPort=0으로 자동 배정하며 ECS가 ALB 대상 포트를 등록한다.
배치 정책은 dev에만 AZ → instanceId 순서의 spread를 적용한다. 태스크 수와 메모리는 기존대로 유지한다. 개발 EC2는
ECS EC2/bridge 모드이며 public IP는 외부 통신에 사용한다. SSH는 열지 않고 SSM으로 관리한다.
운영은 private subnet Fargate, public IP 없음, NAT를 통한 HTTPS egress다.
로그는 [ADR 0020](../docs/adr/0020-frontend-log-retention-policy.md)에 따라 dev 14일/prod 30일 보존하고
실행 환경 삭제 시 로그 그룹을 남긴다. 다시 생성하려면 기존 로그 그룹을 해당 환경 상태로 import한다.
ALB health check는 `/login`의 200 응답으로 HTTP 서버 생존을 확인하며 로그인·백엔드 연결 성공을 증명하지 않는다. 루트(`/`)는 미인증 사용자를 307로 리다이렉트하므로 검사 경로로 사용하지 않는다.

두 환경의 태스크 수는 **1개**, 배포 비율은 min 0% / max 100%다. 기존 태스크를 중지한 뒤 새 태스크를
실행하므로 배포 중 잠시 응답할 서버가 없다. 허브 ADR 0009의 단일 BFF 프로세스 제약 때문에
autoscaling·복제본·blue/green은 사용하지 않는다. 이 제약을 풀려면 BFF 설계 변경이 먼저다.
개발 EC2도 AMI/user data 변경 시 기존 인스턴스를 제거하고 교체한다.

상태 S3 key는 호환성을 위해 계속 `network/terraform.tfstate`다. **이름에 network가 있어도
ALB·실행 환경까지 같은 dev/prod 상태에 저장된다. 인증서 자체와 DNS는 외부 관리다.** 새 key로 임의 변경하면 안 된다.

## 기존 Route 53·ACM 배포 전환

이전 버전을 이미 적용했다면 `route53_zone_id` 대신 **기존 인증서의 ARN**을 `certificate_arn`에
입력하고 runtime은 활성 상태로 유지한다. `external-dns-migration.tf`의 `removed` 블록은 기존
인증서·검증 대기 리소스·DNS 레코드를 `destroy = false`로 관리 대상에서만 제외한다.
계획에서 해당 항목이 삭제 없이 관리 제외로 표시되는지 검토한 뒤 환경에 적용한다. 전환 도중
runtime을 null로 바꾸거나 모듈을 통째로 삭제하지 않는다. 이후 bootstrap에서 불필요해진
DNS·ACM 권한을 제거한다. 관리자 tfvars에 이전 `frontend_dns`가 남아 있다면 그 입력도 제거한다.

기존 DNS·인증서가 AWS에서 삭제되는 것은 아니며, 이후 갱신과 레코드 유지는 관리자가 담당한다.
기존 상태가 없는 첫 배포에는 이 관리 제외 절차가 필요 없다. 실제 AWS state의 존재 여부와
전환 계획은 배포 전에 확인한다.

## 배포 확인과 롤백

- Terraform은 ECS steady state까지 기다린다. 실제 적용 후 ECS event, ALB target health, HTTPS 응답과 로그인 callback을 별도로 확인한다. mock test로 대체할 수 없다.
- ECS circuit breaker가 실패를 감지하고 이전 완료 배포가 있으면 롤백한다. **최초 배포에는 이전 정상 버전이 없다.** secret/이미지/네트워크를 수정한 뒤 재배포한다.
- digest 고정 모드의 수동 롤백은 runtime 파일의 image digest를 이전 정상 digest로 되돌리는 PR을 머지한다. 자동 배포 모드는 아래 복구 절차를 따른다. 설정/키도 이전 이미지와 호환되어야 한다. Terraform이 새 task definition으로 배포하고 안정화를 확인한다.
- 키 회전 후 태스크를 재시작해야 새 secret 값이 주입된다. 키 값만 바꾸면 실행 중인 프로세스는 자동 갱신되지 않는다.
- 활성화 후 runtime을 null로 지우면 ALB·실행 환경 삭제 계획이 나온다. 운영 ALB는 삭제 보호가 켜져 있어 해제 변경을 먼저 검토해야 한다. S3/ECR/secret은 bootstrap의 삭제 보호를 유지한다.
- 앱 CI의 이미지 빌드/push 역할은 bootstrap에 정의한다. Terraform plan/apply 역할에는 ECR push 권한이 없다.

## 참고

- [Terraform S3 backend](https://developer.hashicorp.com/terraform/language/backend/s3)
- [Terraform provider mocking](https://developer.hashicorp.com/terraform/language/tests/mocking)
- [GitHub OIDC와 AWS](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws)
- [EC2 IAM 지원 범위](https://docs.aws.amazon.com/service-authorization/latest/reference/list_ec2.html)

## 프론트 앱 ECR push 역할

bootstrap의 `frontend_github_subject_prefix`에 **프론트 저장소**의 실제 OIDC subject prefix를
입력하면 `soma-376-frontend-dev-image-push`, `soma-376-frontend-prod-image-push` 역할을 만든다.
기존 `github_subject_prefix`는 infra 저장소용이므로 재사용하지 않는다. 기본값 null은 역할을
생성하지 않는다. 활성화 후 null로 되돌리면 역할 삭제 계획이 나오므로 유지한다.

각 역할은 `dev` / `prod` GitHub Environment만 신뢰하고,
자기 환경 ECR의 이미지 업로드·manifest·digest 조회와 registry 로그인, 자기 ECS 서비스의
강제 재배포·상태 조회를 허용한다. Terraform state, secret 값, IAM 변경, task definition 등록, PassRole 권한은 없다. GitHub Environment의
배포 브랜치 제한을 dev=`develop`, prod=`main`으로 설정하고 prod에는 승인자를 지정한다.
Environment subject는 브랜치를 포함하지 않으므로 이 제한을 GitHub에서 적용해야 한다.

관리자가 기존 bootstrap state/backend와 실제 tfvars를 사용해 plan을 검토하고 적용한 뒤
`terraform output frontend_image_push_roles`의 해당 환경 ARN을 프론트 GitHub Environment의
`AWS_ECR_PUSH_ROLE_ARN` 변수에 등록한다. 코드 추가만으로 AWS 역할이 생성되지는 않는다.


## 머지 후 ECS 자동 배포 전환 (PROJ-242)

[허브 ADR 0022](https://github.com/soma-376/docs/blob/main/adr/0022-frontend-ecs-image-delivery.md)를 따른다.
프론트 develop→dev EC2, main→prod Fargate다. 리소스·task definition은 Terraform이 관리하고
앱 CI는 `deploy` 태그 승격과 `update-service --force-new-deployment`만 수행한다.
커밋 태그는 immutable이고 정확히 `deploy` 한 태그만 mutable이다.

1. 해당 GitHub Environment의 `ECS_DEPLOY_ENABLED`를 비활성화하고 진행 중 앱 배포가 끝날 때까지 기다린다.
2. 관리자가 기존 bootstrap state와 tfvars로 plan을 검토하여 ECR 예외 태그 및 `frontend-image-deploy` 정책을 적용한다.
   기존 image-push 역할 ARN을 유지하므로 GitHub 역할 변수는 변경하지 않는다. dev/prod 권한은 각각 자기 서비스·클러스터로 제한된다.
3. 현재 정상 실행 이미지 digest를 확인하고 그 manifest에 `deploy` 태그를 붙인다. 첫 생성이면 정상 ARM64 이미지를 먼저 게시하고 검증한다.
   아래 명령에서 환경·digest를 실제 조회값으로 지정한다. secret 값은 필요하지 않다.

```bash
release_env=dev
release_digest='<현재 정상 실행 sha256 digest>'
release_repo="soma-376/pulsemetry-frontend-$release_env"
release_manifest=$(mktemp)
aws ecr batch-get-image --region ap-northeast-2 --repository-name "$release_repo" \
  --image-ids "imageDigest=$release_digest" --query 'images[0].imageManifest' --output text > "$release_manifest"
aws ecr put-image --region ap-northeast-2 --repository-name "$release_repo" \
  --image-tag deploy --image-manifest "file://$release_manifest" \
  --query 'image.imageId' --output json
rm "$release_manifest"
```

4. runtime의 `automatic_image_deployment=true`를 검토·머지하여 해당 환경 Terraform apply를 수행한다.
   `image_digest`는 비상 고정 모드로 돌아갈 때 쓰는 값으로 유지하고 매 앱 배포마다 바꾸지 않는다.
   dev EC2의 `ECS_IMAGE_PULL_BEHAVIOR=always` 추가는 user data 변경이므로 인스턴스를 교체한다.
   사전 plan에서 이 교체를 확인하고 짧은 중단을 허용하는 시간에 전환한다. prod는 이 EC2 교체와 무관하다.
5. ECS COMPLETED, 실제 실행 digest, ALB healthy, HTTPS 및 로그인 동작을 확인한다.
6. 프론트 CI가 PROJ-242 버전인지 확인하고 해당 Environment에 `ECS_DEPLOY_ENABLED=true`를 설정한다.
   이후 해당 브랜치 push가 검사→ECR 게시→ECS 재배포→실행 digest 검증까지 수행한다.

prod runtime이 없으면 운영 배포를 켜지 않는다. 도메인·인증서·백엔드 URL·secret·이미지 준비와
최초 Terraform 배포를 먼저 완료한다. prod example 파일은 실제 입력이 아니며 자동으로 로드되지 않는다.

앱 CD와 infra apply의 GitHub concurrency는 저장소 간 공유되지 않는다. 인프라 유지보수 때는
CD 비활성화→진행 중 실행 종료→Terraform apply→정상 확인→CD 재활성화 순서를 지킨다.

실패한 앱 배포는 CI가 이전 실행 digest로 `deploy` 태그를 복구한다. 이것만으로 서비스 롤백 완료를 뜻하지 않는다.
ECS circuit breaker/events와 실제 task digest를 확인한다. runner 소실 또는 수동 변경으로 태그와 실행 이미지가
어긋나면 자동 배포는 다음 실행도 중단한다. CD를 끈 상태에서 위 명령으로 정상 manifest를 복원하고
`aws ecs update-service --cluster soma-376-frontend-<env> --service soma-376-frontend-<env> --force-new-deployment`로
배포 후 정상 상태를 검증한다. 평상시 코드 롤백은 프론트 revert PR을 해당 브랜치에 머지한다.
고정 digest로 돌아가려면 CD 비활성 상태에서 `automatic_image_deployment=false`와 정상 `image_digest`를 PR로 적용한다.
