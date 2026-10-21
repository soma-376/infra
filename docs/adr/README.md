# Architecture Decision Records

> 레포 전체 구조, 불변 규칙, 미해결 작업 목록은 루트의 [AGENTS.md](../../AGENTS.md)를 참고한다.
>
> 병행 브랜치에서 작성한 `0028`은 프론트엔드와 백엔드 CDK/EKS에 각각 존재한다.
> 기존 파일명과 링크를 보존하며 번호만으로 문서를 식별하지 않는다. 아래 표의 범위·제목·파일 링크를 함께 사용한다.

| 번호 | 제목 | Status |
|---|---|---|
| 0001 | [컴퓨트 런타임으로 ECS 채택](0001-adopt-ecs-as-compute-runtime.md) | Accepted; EKS 경로 부분 대체: [백엔드 ADR 0028](0028-dev-eks-auto-mode-transition.md) |
| 0002 | [분석 저장소를 Redshift에서 ClickHouse(도커)로 변경](0002-clickhouse-on-ecs-instead-of-redshift.md) | Accepted; EKS 경로 부분 대체: [백엔드 ADR 0028](0028-dev-eks-auto-mode-transition.md) |
| 0003 | [하이브리드 launch type - ClickHouse만 EC2, 앱 서비스는 Fargate](0003-hybrid-launch-type-ec2-clickhouse-fargate-apps.md) | Accepted; EKS 경로 부분 대체: [백엔드 ADR 0028](0028-dev-eks-auto-mode-transition.md) |
| 0004 | [서비스 묶음 - 태스크 단위 co-location](0004-task-level-colocation.md) | Accepted (dev 부분 대체: ADR 0026) |
| 0005 | [서비스 디스커버리 - Cloud Map 프라이빗 DNS](0005-cloud-map-private-dns-discovery.md) | Accepted (dev Collector 부분 대체: ADR 0026); EKS 경로 부분 대체: [백엔드 ADR 0028](0028-dev-eks-auto-mode-transition.md) |
| 0006 | [ClickHouse 데이터 내구성 - MVP에서는 로컬 EBS 수용](0006-accept-local-ebs-durability-for-mvp.md) | Accepted; EKS 경로 부분 대체: [백엔드 ADR 0028](0028-dev-eks-auto-mode-transition.md) |
| 0007 | [ECR 레포지토리는 CDK 관리 밖에서 선(先)생성](0007-precreate-ecr-outside-cdk.md) | Accepted (dev 이미지 목록 부분 대체: ADR 0026) |
| 0008 | [인증 이원화 - 대시보드는 ALB authenticate-cognito, OTLP는 ALB jwt-validation](0008-dual-auth-alb-cognito-and-otlp-token.md) | Superseded by 허브 ADR 0001 |
| 0009 | [CDK 스택 경계 - 인프라 레포 단일 관리 + 앱 레포는 이미지 배포만](0009-single-infra-repo-stack-boundary.md) | Accepted; EKS 경로 부분 대체: [백엔드 ADR 0028](0028-dev-eks-auto-mode-transition.md); 프론트엔드 도구·상태 분리는 [프론트엔드 0030](0030-isolate-frontend-terraform-network.md)로 부분 대체 |
| 0010 | [고정 IP(EIP) 미채택](0010-no-static-eip.md) | Accepted |
| 0011 | [최소 AZ 구성 - 서브넷은 2 AZ, 이중화는 미적용](0011-single-az-topology.md) | Accepted |
| 0012 | [컨트롤 플레인 DB 엔진으로 PostgreSQL 검토](0012-aurora-postgresql-for-control-plane.md) | Proposed |
| 0013 | [Raw Signal 보존 정책 - MVP에서는 최근 30일만 복구](0013-raw-signal-retention-for-mvp.md) | Proposed |
| 0014 | [MVP에서는 ClickHouse를 app subnet에 유지](0014-keep-clickhouse-in-app-subnet-for-mvp.md) | Proposed |
| 0015 | [Fargate 태스크를 ARM64로 통일](0015-arm64-fargate-for-cost-savings.md) | Accepted |
| 0016 | [운영자 접속은 SSM 기반으로 (EC2는 Session Manager, Fargate는 ECS Exec)](0016-ssm-based-operator-access.md) | Accepted; EKS 경로 부분 대체: [백엔드 ADR 0028](0028-dev-eks-auto-mode-transition.md) |
| 0017 | [Collector config를 env provider로 주입](0017-inject-collector-config-via-env-provider.md) | Accepted (dev 부분 대체: ADR 0026) |
| 0018 | [post-processor 런타임 계약을 앱 환경변수에 맞추고 PG DSN을 파생 시크릿으로 주입](0018-post-processor-runtime-contract-via-derived-dsn-secret.md) | Accepted (dev 부분 대체: ADR 0026) |
| 0019 | [ClickHouse 컨테이너 런타임 계약 - compose와 동일한 사용자 설정 + 이미지 태그 고정](0019-clickhouse-container-runtime-contract.md) | Accepted |
| 0020 | [프론트엔드 실행 로그는 환경별 기간 동안 CloudWatch에 보관한다](0020-frontend-log-retention-policy.md) | Accepted — frontend 한정, 기존 CDK 정책 검토는 계속 필요 |
| 0021 | [dev/prod 환경 분리 - 컨텍스트 스위치 단일 앱과 lib/{common,prod,dev} 경계](0021-dev-prod-environment-separation.md) | Accepted; EKS 경로 부분 대체: [백엔드 ADR 0028](0028-dev-eks-auto-mode-transition.md) |
| 0022 | [개발 인프라 토폴로지 - 퍼블릭 서브넷 전용, ECS on EC2, 혼합 네트워크 모드](0022-dev-infrastructure-topology.md) | Accepted (앱 토폴로지 부분 대체: ADR 0026); EKS 경로 부분 대체: [백엔드 ADR 0028](0028-dev-eks-auto-mode-transition.md) |
| 0023 | [dev 인증 프록시 - ALB와 Collector 사이에 auth-proxy 태스크 삽입](0023-dev-auth-proxy-between-alb-and-collector.md) | Superseded by ADR 0026 |
| 0024 | [GitHub Actions 배포 - 레포×환경 4개 OIDC 역할과 ECS 물리 이름 고정](0024-github-actions-oidc-deploy-roles.md) | Accepted (dev 대상 부분 대체: ADR 0026) |
| 0025 | [개발 MVP의 비-ClickHouse ALB 타깃에 60초 deregistration delay 적용](0025-use-60-second-dev-deregistration-delay.md) | Accepted (dev 대상 부분 대체: ADR 0026) |
| 0026 | [dev 백엔드를 telemetry-ingest·enrollment-api·ClickHouse 세 서비스로 전환](0026-dev-backend-deployment-units-and-staged-migration.md) | Accepted (API 경로·health check는 허브 ADR 0016이 부분 대체); EKS 경로 부분 대체: [백엔드 ADR 0028](0028-dev-eks-auto-mode-transition.md) |
| 0027 | [dev ALB에 경로별 Count 예외를 가진 WAF를 적용](0027-dev-alb-waf-policy.md) | Accepted (배포 증거 대기) |
| 0028 (프론트엔드) | [프론트엔드 HTTPS와 단일 컨테이너 실행 환경을 Terraform으로 관리한다](0028-frontend-alb-and-container-runtime.md) | Accepted (DNS·ACM은 [프론트엔드 0029](0029-use-external-dns-and-existing-frontend-certificate.md), 이미지 릴리스는 허브 0022로 부분 대체) |
| 0028 (백엔드 CDK/EKS) | [dev에 EKS Auto Mode를 병행 추가하고 수동 Helm으로 단계 전환](0028-dev-eks-auto-mode-transition.md) | Accepted (배포 증거 대기) |
| 0029 (프론트엔드) | [프론트 DNS는 외부에서 관리하고 발급된 ACM 인증서를 참조한다](0029-use-external-dns-and-existing-frontend-certificate.md) | Accepted |
| 0030 (프론트엔드) | [프론트엔드 기반 인프라는 독립 Terraform 상태로 관리한다](0030-isolate-frontend-terraform-network.md) | Accepted |

새 ADR을 작성할 때는 다음 미사용 번호(`0031-...`)를 사용하고 [`0000-adr-template.md`](0000-adr-template.md)의 구조를 따른다. `0020`은 프론트엔드 로그 정책에 사용했다. 기존 CDK 로그 정책은 별도 후속 ADR의 미결 사항이며 `AGENTS.md` 섹션 5 (F)를 따른다.

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
