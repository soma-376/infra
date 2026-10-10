# 0027. 프론트엔드 기반 인프라는 독립 Terraform 상태로 관리한다

## Status

Accepted — 사용자가 프론트엔드를 `frontend/`의 Terraform으로 분리하고, 머지 후 CI에서 적용하도록 요청했다. 기반 결정은 부트스트랩과 네트워크이며, 실행 환경은 [ADR 0028](0028-frontend-alb-and-container-runtime.md)이 추가한다.

## Context

기존 인프라는 CDK가 관리한다. 프론트엔드는 개발 EC2, 운영 Fargate를 사용할 계획이며
사용자가 VPC·ALB·인증서의 독립 관리를 선택했다. 단일 인프라 저장소 소유권은 유지한다.

## Decision

- `frontend/` 아래 Terraform만 새 프론트 리소스를 소유한다. 기존 CDK 리소스를 import하거나 수정하지 않는다.
- 이 결정은 ADR 0009의 CDK 단일 관리 범위에 프론트 Terraform 예외를 추가한다. 기존 앱·태스크 정의·CI 계약은 유지한다.
- 개발 `10.2.0.0/16`은 2 AZ의 public /24 두 개, 운영 `10.3.0.0/16`은 public /24 두 개와 private /24 두 개를 쓴다. 기존 CDK 대역을 재사용하지 않는다.
- 개발 NAT는 없고 운영은 primary AZ에 NAT 하나를 둔다. CIDR의 실제 계정·연결망 충돌 여부는 배포 전 확인한다.
- 부트스트랩은 환경별 S3 상태 버킷, ECR, PR plan 역할과 머지 후 apply 역할을 만든다. GitHub OIDC provider는 기존 계정 전역 공급자를 조회만 한다.
- 부트스트랩 자신은 별도 관리용 S3 버킷에 상태를 저장한다. 최초 관리자 실행은 머지된 코드를 대상으로 로컬 상태로 수행하고 이후 S3로 이전한다. 네트워크 배포 역할에는 부트스트랩 상태나 IAM 변경 권한을 주지 않는다.
- S3는 버전 관리·공개 차단·기본 암호화·TLS 강제, ECR은 immutable tag와 삭제 보호를 사용한다. Terraform은 S3 native lock을 쓴다.
- 자격증명 없는 검증은 모든 PR에서 수행한다. AWS plan은 동일 저장소 PR과 보호된 plan Environment에서만 실행한다. apply는 develop→dev, main→prod push에서만 실행하며 보호된 Environment의 승인 후 최종 plan을 적용한다.
- GitHub Environment reviewer/branch 규칙과 브랜치 보호는 관리자가 활성화 전에 설정한다. workflow 파일만으로 이 설정이 생기지는 않는다. OIDC subject는 실제 저장소 subject 형식에 맞게 입력받고 정확히 일치시킨다.
- 기반 단계 다음 ALB·인증서·보안 그룹·EC2·Fargate는 ADR 0028로 추가한다. 앱/API 계약 변경은 없다.

## Alternatives Considered

- 기존 VPC 공유: 사용자의 리소스 분리 결정과 맞지 않아 선택하지 않았다.
- 기존 CDK로 추가: 사용자가 frontend 폴더에 Terraform을 명시했다.
- Git에 상태 파일 저장: 민감 데이터와 동시 실행을 관리할 수 없어 제외한다.

## Consequences/Tradeoffs

### Positive

- frontend 상태·배포 권한과 기존 CDK 소유권이 분리된다.
- PR의 변경 계획과 머지된 코드의 실제 적용이 구분된다.

### Negative

- CDK와 Terraform 두 도구를 운영하며 상태 저장소와 최초 관리자 작업이 필요하다.
- 운영 NAT 하나는 외부 통신의 단일 AZ 장애 지점이고 별도 과금된다.
- mock test는 실제 AWS 권한·가용 AZ·조직 정책·CIDR 충돌을 검증하지 못한다.

## Follow-up

- ALB·ACM·앱 SG·실행 환경과 CI 권한은 ADR 0028을 따른다.
- 허브 ADR 0009의 단일 Next.js 프로세스 조건을 유지한다. 무중단/다중 태스크 배포는 별도 BFF 설계 변경이 필요하다.

## Acceptance Criteria

- fmt·validate·mock test로 환경별 서브넷/라우팅과 상태·IAM 경계를 검증한다.
- 기존 CDK 테스트·합성 결과가 유지된다. 실제 AWS 적용은 이 구현 작업에 포함하지 않는다.
