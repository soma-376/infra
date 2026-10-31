# 공유 BFF Valkey 기반

dev/prod가 하나의 ElastiCache Serverless for Valkey를 공유하는 **배포 전 구성**이다.
근거: [ADR 0055](../../../docs/adr/0055-shared-frontend-valkey-foundation.md).
기존 프론트 BFF는 아직 이 저장소를 사용하지 않는다. develop 머지 후 bootstrap → dev → shared plan/apply 순서로 실행한다. 실제 배포 성공은 Actions와 AWS 리소스로 확인한다.

## 리소스와 소유권

- 서울 `10.4.0.0/24` 전용 VPC, 2a/2c 격리 서브넷. IGW/NAT/EC2 없음.
- dev `10.2.0.0/16`, prod `10.3.0.0/16`과 피어링. secondary CIDR가 있거나 기존 CIDR가 다르면 plan을 거부한다.
- 공유 root가 피어링, 양쪽 추가 경로, BFF→cache SG 6379 송신/수신 규칙을 소유한다.
  기존 root에서 같은 경로·규칙을 중복 선언하지 않는다. reader 포트 6380은 열지 않는다.
- Valkey 8 Serverless 하나, IAM 사용자/태스크 역할 두 개. AWS 관리형 저장 암호화와 서비스의 TLS를 사용한다.
- `dev:*` / `prod:*` ACL. 허용된 문자열·TTL·Lua 명령만 사용한다. 키 검색·관리·전체 삭제 명령은 허용하지 않는다.
- 태스크 역할은 실행 역할과 다르다. **현재 ECS task definition에는 연결하지 않는다.**
- 캐시·VPC `prevent_destroy`는 Terraform 구성 삭제나 콘솔 삭제까지 막는 보호가 아니다.
- IAM 역할은 이 root가 소유하며, bootstrap은 이후 task 역할에 대한 제한된 PassRole만 소유한다.

## 입력과 상태 준비

`terraform.tfvars.example`에 기존 dev/prod output의 VPC ID, application SG ID, route table ID를 넣는다.
dev는 BFF EC2의 public route table, prod는 BFF가 배치되는 두 private route table 모두 필요하다.
`network.public_route_table_id`, `network.private_route_table_ids`를 출력에 추가했다.
입력한 SG/route table이 해당 VPC 소유인지 plan에서 검사한다. 실제 BFF가 그 SG와 경로를 사용하는지는 배포 전 확인한다.
두 환경이 동일 계정·리전에 있고 VPC DNS가 켜져 있어야 한다. NACL·조직 정책·기존 다른 VPC와의 CIDR 충돌도 실제 plan에서 확인한다.

기존 bootstrap S3 버킷의 `shared-valkey/terraform.tfstate` key를 사용한다. 버킷의 버전 관리·공개 차단·TLS 강제·암호화·삭제 보호를 재사용한다.
bootstrap이 `soma-376-frontend-shared-plan/apply` 역할을 생성한다. shared 역할은 자기 state key와 잠금 파일만 읽으며 bootstrap/dev/prod state 본문에 접근하지 않는다.
shared plan은 조회와 잠금만, apply는 shared 캐시·네트워크 및 명시된 기존 frontend peer 자원에만 쓰기를 허용한다. 기존 route table 권한은 목적지별 IAM 제한이 아니므로 승인된 Terraform 계획과 peer 누락 방어도 함께 사용한다.

`.github/workflows/frontend-terraform-shared.yml`은 이미 설정된 `frontend-bootstrap-plan/apply` GitHub Environment의 계정 ID·상태 버킷·승인 조건을 사용한다.
새 GitHub Variables를 수동 등록하지 않는다. OIDC subject는 bootstrap과 같은 승인 경계이며 역할 이름과 AWS 권한은 별도다. 이를 별도 조직/관리자 보안 경계라고 해석하지 않는다.
기존 bootstrap이 새 역할·정책을 만든 후 shared 단계가 실행된다. 최초 PR에서는 역할이 없으면 AWS shared plan만 명시적으로 보류하며, 머지 후 실행에서는 역할 부재를 오류로 처리한다.

`shared-peers.py`가 기존 frontend 소유 태그와 정확한 이름으로 VPC·BFF SG·route table을 조회해 임시 입력을 생성한다. dev는 필수다.
prod VPC 또는 BFF SG가 아직 없으면 dev만 연결하며, prod 준비 후 develop의 `Frontend Terraform Apply`를 workflow_dispatch로 다시 실행한다.
이미 state에 기록된 peer가 조회에서 누락되면 자동 제거하지 않고 실패한다. 중복 VPC/SG, 불완전한 경로도 실패한다. 처음부터 두 환경이 준비되어 있으면 둘 다 연결한다.
main 배포에서 오래된 공유 코드를 적용하지 않도록 shared 자동 apply는 develop에만 연결한다.

plan과 apply는 같은 SHA의 별도 job이며, 승인 후 실제 입력을 다시 조회하고 전체 계획 해시를 비교한다. 변경되었거나 develop 최신 SHA가 아니면 중단한다.
shared workflow는 전용 concurrency와 S3 state lock을 사용한다. 계획·state·임시 입력을 artifact로 업로드하지 않는다.
GitHub 환경 승인이 설정되어 있으면 머지만으로 즉시 생성되는 것은 아니며 승인 후 apply까지 성공해야 한다.

로컬 검증 (AWS 자격증명 불필요):

```bash
terraform init -backend=false -input=false -lockfile=readonly
terraform validate
terraform test
```

리뷰용 실제 plan은 위 workflow에서 실행한다. 수동 검토 시 `backend.hcl.example`의 bucket에는 기존 bootstrap 상태 버킷을 사용한다.
backend key는 `shared-valkey/terraform.tfstate`이며 dev/prod의 `network/terraform.tfstate`와 다르다.
실제 ID, account ID, tfvars, plan, state는 커밋하지 않는다.

## 비용과 감시

기본 최대값은 저장 **1GB**, 처리량 **1,000 ECPU/s**다. 최소값을 지정하지 않아 서비스 기본 최소 과금을 유지한다.
상한은 월 요금 제한이 아니다. 저장량이 늘거나 요청이 많으면 요금이 오른다.
최소 저장 비용 외에 ECPU, 네트워크 경로에 따른 전송, CloudWatch alarm 등의 비용과 세금이 추가될 수 있다.
피어링을 위해 NAT Gateway/EC2를 추가하지 않는다. 신규 CMK와 Secrets Manager secret도 만들지 않는다.

용량·처리량 75%, 요청 제한, 데이터 축출 CloudWatch alarm을 생성한다.
`alarm_topic_arn=null` 기본값은 상태만 표시하며 **사용자에게 알림을 발송하지 않는다**.
수신처와 SNS 구독이 확인된 뒤 ARN을 설정한다. 월 예산 알림은 별도 AWS Budgets 설정이며 금액·수신처는 미정이다.

상한 도달 시 TTL 데이터가 축출되거나 요청이 제한될 수 있다. 잠금 키도 TTL을 사용하므로
애플리케이션이 락 획득만으로 정확히 한 번 갱신된다고 가정하면 안 된다. 버전 검사·결과 공유·실패 동작을 검증한 뒤 사용한다.
서버리스의 eviction 정책을 이 코드에서 noeviction으로 설정했다고 간주하지 않는다.
스냅샷은 자동 복구로 폐기한 인증 정보를 되살리지 않도록 만들지 않는다. 유실 시 재로그인 처리는 BFF 구현이 필요하다.

## BFF 적용 전 남은 작업

1. 허브 ADR 0009·웹 인증 계약에서 공유 세션 전환을 정의한다. 현재 암호화 토큰 쿠키 계약은 그대로다.
2. `cache.users`의 환경별 task 역할을 ECS `task_role_arn`에 연결하고 bootstrap PassRole을 정확한 ARN에 한정한다.
3. TLS·cluster-aware client·IAM 인증을 구현한다. IAM 인증 토큰은 15분 유효하고 연결은 12시간 제한이므로 새 연결·재연결 때 새 토큰을 생성한다.
4. 사용자 ACL은 AUTH를 위한 IAM 인증을 사용하며 문자열 GET/SET 기반 세션 저장을 전제로 한다. 실제 클라이언트 초기화 명령과 Lua 스크립트를 검증하고 필요 명령만 추가한다.
5. 멀티 키 Lua는 동일 hash slot의 키만 사용한다. 예: `dev:{<session-id>}:session`, `dev:{<session-id>}:lock`. 세션 ID에 `{}` 삽입을 허용하지 않는다.
6. 토큰 암호화 키·TTL·로그아웃·재사용 방어·실패 시 동작과 두 BFF 동시 갱신을 검증한다. 백엔드 API/refresh 정책은 이 구성에서 변경하지 않는다.
7. dev 사용자로 prod 키/사용자 접근, KEYS/SCAN/FLUSHALL/FLUSHDB, 비인가 SG 접근이 거부되는지 실제 환경에서 확인한다.

mock test는 리소스 구조와 잘못된 입력 방어만 검증한다. AWS 정책 평가·TLS·IAM 인증·서버 ACL·실제 트래픽 증거가 아니다.
