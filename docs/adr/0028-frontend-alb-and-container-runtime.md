# 0028. 프론트엔드 HTTPS와 단일 컨테이너 실행 환경을 Terraform으로 관리한다

## Status

Accepted — [PROJ-216](https://team376.atlassian.net/browse/PROJ-216). ADR 0027의 기반 인프라에 실행 환경을 추가한다. 실제 AWS 적용은 별도 운영 단계다.

## Context

사용자가 독립 ALB·인증서·개발 EC2·운영 Fargate 구현과 코드 push를 요청했다.
허브 ADR 0009의 BFF refresh 조정은 프로세스 메모리에 있으므로 복제본을 동시에 실행할 수 없다.
프론트 앱은 Next.js 서버이며 정적 S3 호스팅만으로는 BFF를 실행할 수 없다.

## Decision

- 환경마다 public ALB, ACM 인증서, 앱 보안 그룹을 만든다. HTTP는 HTTPS로 전환하고 앱 포트 3000은 ALB 보안 그룹에서만 받는다.
- 관리자가 제공한 같은 계정의 public Route 53 zone에 인증서 검증 CNAME과 서비스 A alias만 관리한다. 기존 zone 자체를 소유하거나 다른 서비스 레코드를 변경하지 않는다. 도메인은 입력값으로 남긴다.
- 개발은 public subnet의 ARM64 EC2 한 대에서 ECS EC2 방식으로 컨테이너를 관리한다. bridge 모드와 고정 host port를 써서 EC2의 public IP로 외부에 연결한다. SSH 없이 SSM을 사용한다.
- 운영은 private subnet의 ARM64 Fargate 태스크 한 개다. 외부 HTTPS 통신과 이미지 pull은 기존 NAT를 통한다.
- 두 ECS 서비스 모두 desired=1, minimumHealthyPercent=0, maximumPercent=100이다. 이전 태스크를 중지한 뒤 다음 태스크를 실행하며 배포 중 중단을 허용한다. 자동 확장은 두지 않는다.
- 이미지 빌드·push는 앱 저장소의 후속 작업이다. 인프라는 환경별 ECR의 immutable digest를 입력받아 task definition을 소유한다. 앱 CI에 task definition 등록이나 PassRole 권한을 주지 않는다.
- IAM 실행/인스턴스 역할과 BFF 키용 Secrets Manager 빈 secret은 bootstrap이 소유한다. 실제 키 값은 관리자가 별도로 입력하며 Terraform state에 저장하지 않는다. CI는 비밀 값을 읽지 않고 고정된 실행 역할만 서비스에 전달한다.
- `runtime = null`인 초기 상태는 네트워크만 만든다. 도메인·DNS 권한·ARM64 이미지·키 값·백엔드 HTTPS 주소가 준비된 후 환경별 runtime 입력을 추가한다. 한번 활성화한 runtime을 null로 되돌리면 실행 환경을 삭제하는 계획이 되므로 명시적으로 검토한다.
- dev/prod state의 기존 `network/terraform.tfstate` key를 유지해 상태가 분리되거나 리소스가 중복 생성되는 것을 방지한다.
- AWS/API 계약은 변경하지 않는다. 기존 BFF 환경 변수, 단일 프로세스 제약과 백엔드 콜백 허용 목록을 따른다.

## Alternatives Considered

- EC2의 직접 Docker/systemd 배포: ECS로 개발·운영 task definition, secret 주입, 로그와 배포 정책을 함께 관리하는 방식을 선택했다.
- 복제본 두 개 또는 blue/green: 현재 BFF의 프로세스 간 refresh 조정이 없어 선택하지 않았다.
- 임시 nginx 이미지로 선배포: 실제 Next.js가 배포된 것처럼 오인할 수 있어 실제 이미지 준비를 선행 조건으로 둔다.

## Consequences/Tradeoffs

### Positive

- 기존 CDK와 소유권을 공유하지 않고 환경별 HTTPS, 실행 환경, 권한과 상태를 검토할 수 있다.
- 비밀 값을 Terraform 코드·state·user data에 넣지 않는다.

### Negative

- 단일 EC2/태스크이므로 서버 장애와 배포 시 중단을 감수한다. ALB의 두 AZ가 앱의 고가용성을 뜻하지 않는다.
- ALB 두 개, public IPv4, EC2/Fargate, NAT, 로그·secret 비용이 추가된다.
- 도메인/DNS 위임, 이미지, 키 입력과 백엔드 HTTPS/허용 callback 설정은 코드 작성만으로 완료되지 않는다.
- mock test는 실제 IAM/SCP, 인증서 발급, 컨테이너 시작이나 로그인 E2E를 증명하지 않는다.

## Acceptance Criteria

- mock 검증에서 HTTPS redirect, ALB 전용 앱 ingress, prod private networking, ARM64와 단일 태스크 배포 조건을 확인한다.
- CI plan 역할에는 리소스 쓰기와 secret 값 조회가 없고 apply 역할은 환경별 리소스와 고정 runtime 역할만 관리한다.
- AWS apply 없이 fmt·validate·mock test 및 workflow 검사를 수행한다.

## References

- [허브 BFF ADR 0009](https://github.com/soma-376/docs/blob/main/adr/0009-browser-auth-encrypted-cookie-bff.md)
- [ECS 서비스 배포 설정](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service_definition_parameters.html)
- [ECS ARM64 AMI](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ecs-optimized_AMI.html)
