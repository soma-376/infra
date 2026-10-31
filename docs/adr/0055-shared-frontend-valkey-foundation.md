# 0055. 프론트 공유 Valkey 기반을 독립 Terraform 상태로 관리한다

## Status
Proposed ([PROJ-243](https://team376.atlassian.net/browse/PROJ-243)의 기반 구성) — dev/prod 공유는 사용자 선택이며, 네트워크·IAM 세부안은 로컬 구성이다. 배포하지 않았다.

## Context
BFF 프로세스 간 갱신 조율에 사용할 공유 저장소가 필요하다. frontend dev/prod는 각각 별도 VPC와 Terraform 상태를 사용한다. 이번 범위는 infra의 기반 리소스다. 기존 허브 ADR 0009의 암호화 쿠키 계약과 frontend 실행 코드는 변경하지 않는다.

## Decision
- `frontend/environments/shared`가 전용 VPC·두 격리 서브넷·Valkey Serverless 하나·dev/prod 피어링과 왕복 경로·SG를 소유한다. IGW/NAT/EC2를 만들지 않는다.
- 캐시와 환경별 IAM 사용자·사용자 그룹을 함께 생성한다. ACL은 `dev:*`/`prod:*`로 나누고 명시한 명령만 허용한다. SCAN/KEYS/FLUSHALL/FLUSHDB와 관리 명령은 허용하지 않는다.
- 별도 ECS task 역할 두 개는 자기 사용자와 캐시에만 Connect를 허용한다. 기존 execution 역할에 앱 권한을 추가하지 않는다.
- 공유 상태는 dev/prod 상태와 다른 S3 key/bucket을 사용한다. 기존 배포 workflow에 자동 편입하지 않는다. 캐시에는 prevent_destroy를 설정한다. 이는 Terraform 설정이 존재하는 동안의 보호이며 AWS 삭제 방지 기능은 아니다.
- 저장 최소값은 지정하지 않아 Valkey 기본 최소 과금을 유지한다. 초기 최대치는 저장 1GB·초당 1,000 ECPU다. 이 값은 월 예산 상한이 아니다.
- 세션 원본의 스냅샷 복구로 폐기한 로그인 정보를 되살리지 않도록 자동 스냅샷은 비활성화한다. 저장소 유실 시 재로그인을 요구하는 앱 동작은 후속 작업이다.

## Alternatives Considered
- 환경별 캐시: 장애·용량 격리에 유리하지만 최소 비용이 두 번 든다. 사용자가 공유를 선택했다.
- dev/prod VPC에 배치: VPC 추가는 줄지만 한 환경의 삭제·변경에 공유 리소스가 종속된다.
- 비밀번호 인증: 클라이언트는 단순하지만 비밀값 보관·회전이 필요하다. IAM 인증은 state에 비밀번호를 저장하지 않는다.

## Consequences/Tradeoffs
### Positive
- 앱 환경 삭제와 공유 저장소 수명을 분리하고 사용자·키 권한을 구분한다.
- 네트워크 라우팅과 권한을 코드로 검토한다.
### Negative
- 메모리·처리량·장애는 두 환경이 공유한다. dev 부하가 prod에 영향을 줄 수 있다.
- 두 VPC 피어링, 환경별 반환 경로와 교차 AZ 전송 비용이 발생할 수 있다.
- IAM 토큰 갱신·재연결 및 cluster-aware client가 필요하다.

## Follow-up
- 보호된 shared CI 역할/backend/승인 workflow 준비 후에만 apply한다. 기존 runtime 역할을 확대 재사용하지 않는다.
- BFF 변경 전 허브 ADR 0009 및 웹 인증 계약을 개정한다. 세션 ID·저장 형식·TTL·잠금·실패 정책·환경별 암호화 키를 별도로 확정한다.
- ECS task 역할 배선과 PassRole 허용은 기존 bootstrap 소유권을 따라 후속 반영한다.
- 실제 CIDR 충돌·경로 소유권·NACL·SG·엔진 가용성·ACL/네트워크 차단·재연결을 배포 전후 검증한다.

## Acceptance Criteria
Terraform fmt/validate/mock test 통과. 실제 AWS 연결 및 BFF 동시 갱신 검증은 별도다.

## References
- [IAM 인증](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/auth-iam.html)
- [RBAC](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/Clusters.RBAC.html)
