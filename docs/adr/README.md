# Architecture Decision Records

> 레포 전체 구조, 불변 규칙, 미해결 작업 목록은 루트의 [AGENTS.md](../../AGENTS.md)를 참고한다.

| 번호 | 제목 | Status |
|---|---|---|
| 0001 | [컴퓨트 런타임으로 ECS 채택](0001-adopt-ecs-as-compute-runtime.md) | Accepted; EKS 활성화 경로 부분 대체: ADR 0028 |
| 0002 | [분석 저장소를 Redshift에서 ClickHouse(도커)로 변경](0002-clickhouse-on-ecs-instead-of-redshift.md) | Accepted; EKS 활성화 경로 부분 대체: ADR 0028 |
| 0003 | [하이브리드 launch type - ClickHouse만 EC2, 앱 서비스는 Fargate](0003-hybrid-launch-type-ec2-clickhouse-fargate-apps.md) | Accepted; EKS 활성화 경로 부분 대체: ADR 0028 |
| 0004 | [서비스 묶음 - 태스크 단위 co-location](0004-task-level-colocation.md) | Accepted (dev 부분 대체: ADR 0026) |
| 0005 | [서비스 디스커버리 - Cloud Map 프라이빗 DNS](0005-cloud-map-private-dns-discovery.md) | Accepted (dev Collector 부분 대체: ADR 0026); EKS 활성화 경로 부분 대체: ADR 0028 |
| 0006 | [ClickHouse 데이터 내구성 - MVP에서는 로컬 EBS 수용](0006-accept-local-ebs-durability-for-mvp.md) | Accepted; EKS 활성화 경로 부분 대체: ADR 0028 |
| 0007 | [ECR 레포지토리는 CDK 관리 밖에서 선(先)생성](0007-precreate-ecr-outside-cdk.md) | Accepted (dev 이미지 목록 부분 대체: ADR 0026); dashboard 배포 범위 부분 대체: ADR 0029 |
| 0008 | [인증 이원화 - 대시보드는 ALB authenticate-cognito, OTLP는 ALB jwt-validation](0008-dual-auth-alb-cognito-and-otlp-token.md) | Superseded by 허브 ADR 0001 |
| 0009 | [CDK 스택 경계 - 인프라 레포 단일 관리 + 앱 레포는 이미지 배포만](0009-single-infra-repo-stack-boundary.md) | Accepted; EKS 활성화 경로 부분 대체: ADR 0028 |
| 0010 | [고정 IP(EIP) 미채택](0010-no-static-eip.md) | Accepted |
| 0011 | [최소 AZ 구성 - 서브넷은 2 AZ, 이중화는 미적용](0011-single-az-topology.md) | Accepted |
| 0012 | [컨트롤 플레인 DB 엔진으로 PostgreSQL 검토](0012-aurora-postgresql-for-control-plane.md) | Proposed |
| 0013 | [Raw Signal 보존 정책 - MVP에서는 최근 30일만 복구](0013-raw-signal-retention-for-mvp.md) | Proposed |
| 0014 | [MVP에서는 ClickHouse를 app subnet에 유지](0014-keep-clickhouse-in-app-subnet-for-mvp.md) | Proposed |
| 0015 | [Fargate 태스크를 ARM64로 통일](0015-arm64-fargate-for-cost-savings.md) | Accepted |
| 0016 | [운영자 접속은 SSM 기반으로 (EC2는 Session Manager, Fargate는 ECS Exec)](0016-ssm-based-operator-access.md) | Accepted; EKS 활성화 경로 부분 대체: ADR 0028 |
| 0017 | [Collector config를 env provider로 주입](0017-inject-collector-config-via-env-provider.md) | Accepted (dev 부분 대체: ADR 0026) |
| 0018 | [post-processor 런타임 계약을 앱 환경변수에 맞추고 PG DSN을 파생 시크릿으로 주입](0018-post-processor-runtime-contract-via-derived-dsn-secret.md) | Accepted (dev 부분 대체: ADR 0026) |
| 0019 | [ClickHouse 컨테이너 런타임 계약 - compose와 동일한 사용자 설정 + 이미지 태그 고정](0019-clickhouse-container-runtime-contract.md) | Accepted |
| 0021 | [dev/prod 환경 분리 - 컨텍스트 스위치 단일 앱과 lib/{common,prod,dev} 경계](0021-dev-prod-environment-separation.md) | Accepted; EKS 활성화 경로 부분 대체: ADR 0028 |
| 0022 | [개발 인프라 토폴로지 - 퍼블릭 서브넷 전용, ECS on EC2, 혼합 네트워크 모드](0022-dev-infrastructure-topology.md) | Accepted (앱 토폴로지 부분 대체: ADR 0026); EKS 활성화 경로 부분 대체: ADR 0028 |
| 0023 | [dev 인증 프록시 - ALB와 Collector 사이에 auth-proxy 태스크 삽입](0023-dev-auth-proxy-between-alb-and-collector.md) | Superseded by ADR 0026 |
| 0024 | [GitHub Actions 배포 - 레포×환경 4개 OIDC 역할과 ECS 물리 이름 고정](0024-github-actions-oidc-deploy-roles.md) | Accepted (dev 대상 부분 대체: ADR 0026); dashboard 배포 범위 부분 대체: ADR 0029 |
| 0025 | [개발 MVP의 비-ClickHouse ALB 타깃에 60초 deregistration delay 적용](0025-use-60-second-dev-deregistration-delay.md) | Accepted (dev 대상 부분 대체: ADR 0026) |
| 0026 | [dev 백엔드를 telemetry-ingest·enrollment-api·ClickHouse 세 서비스로 전환](0026-dev-backend-deployment-units-and-staged-migration.md) | Accepted (API 경로·health check는 허브 ADR 0016이 부분 대체); EKS 활성화 경로 부분 대체: ADR 0028, dashboard 배포 범위 부분 대체: ADR 0029 |
| 0027 | [dev ALB에 경로별 Count 예외를 가진 WAF를 적용](0027-dev-alb-waf-policy.md) | Accepted (배포 증거 대기); dashboard 배포 범위 부분 대체: ADR 0029 |

| 0028 | [dev에 EKS Auto Mode를 병행 추가하고 수동 Helm으로 단계 전환](0028-dev-eks-auto-mode-transition.md) | Accepted (구현·검증 기록은 PROJ-206~212; dashboard 범위 부분 대체: ADR 0029; JWT 참조 목록 부분 대체: ADR 0030) |
| 0029 | [dev dashboard-api는 공통 ARM64 이미지로 ECS와 EKS에 각각 배포](0029-dev-dashboard-api-ecs-and-eks-deployment.md) | Accepted (후속 구현·AWS 배포 증거 대기; JWT 공개키 공급 부분 대체: ADR 0030) |
| 0030 | [dev 사용자 JWT 키는 별도 Secrets Manager 원본에서 버전을 지정해 파일로 공급](0030-dev-user-jwt-keys-from-secrets-manager.md) | Accepted (키 준비·전달 구현·AWS 배포 증거 대기; 원본 생성·보존 소유 경계 부분 대체: ADR 0031) |
| 0031 | [dev dashboard DB 자격 증명과 사용자 JWT Secret 원본은 CDK로 생성하고 보존](0031-manage-dev-dashboard-and-jwt-secrets-with-cdk.md) | Accepted (dev 원본 정의·운영 절차; AWS 배포·값 등록·DB 적용 증거 대기) |

새 ADR을 작성할 때는 다음 미사용 번호(`0032-...`)를 사용하고 [`0000-adr-template.md`](0000-adr-template.md)의 구조를 따른다. `0020`은 로그 그룹 정책 ADR용으로 예약되어 있다(`AGENTS.md` 섹션 5 (F)).

섹션 순서는 다음과 같다. 괄호로 표시한 것은 내용이 있을 때만 둔다.

```
# NNNN. 제목

## Status
## Context
## Decision
## Constraints            (선택)
## Alternatives Considered
## Consequences/Tradeoffs
### Positive
### Negative
## Follow-up              (선택 - 재검토 조건과 미결 질문)
## Acceptance Criteria    (선택)
## References             (선택)
```

작성일은 문서에 적지 않는다. `git log --follow <파일>`로 확인한다.
