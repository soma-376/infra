# Architecture Decision Records

> 레포 전체 구조, 불변 규칙, 미해결 작업 목록은 루트의 [AGENTS.md](../../AGENTS.md)를 참고한다.

| 번호 | 제목 | Status |
|---|---|---|
| 0001 | [컴퓨트 런타임으로 ECS 채택](0001-adopt-ecs-as-compute-runtime.md) | Accepted |
| 0002 | [분석 저장소를 Redshift에서 ClickHouse(도커)로 변경](0002-clickhouse-on-ecs-instead-of-redshift.md) | Accepted |
| 0003 | [하이브리드 launch type - ClickHouse만 EC2, 앱 서비스는 Fargate](0003-hybrid-launch-type-ec2-clickhouse-fargate-apps.md) | Accepted |
| 0004 | [서비스 묶음 - 태스크 단위 co-location](0004-task-level-colocation.md) | Accepted |
| 0005 | [서비스 디스커버리 - Cloud Map 프라이빗 DNS](0005-cloud-map-private-dns-discovery.md) | Accepted |
| 0006 | [ClickHouse 데이터 내구성 - MVP에서는 로컬 EBS 수용](0006-accept-local-ebs-durability-for-mvp.md) | Accepted |
| 0007 | [ECR 레포지토리는 CDK 관리 밖에서 선(先)생성](0007-precreate-ecr-outside-cdk.md) | Accepted |
| 0008 | [인증 이원화 - 대시보드는 ALB authenticate-cognito, OTLP는 ALB jwt-validation](0008-dual-auth-alb-cognito-and-otlp-token.md) | Proposed |
| 0009 | [CDK 스택 경계 - 인프라 레포 단일 관리 + 앱 레포는 이미지 배포만](0009-single-infra-repo-stack-boundary.md) | Proposed |
| 0010 | [고정 IP(EIP) 미채택](0010-no-static-eip.md) | Accepted |
| 0011 | [최소 AZ 구성 - 서브넷은 2 AZ, 이중화는 미적용](0011-single-az-topology.md) | Accepted |
| 0012 | [컨트롤 플레인 DB 엔진으로 PostgreSQL 검토](0012-aurora-postgresql-for-control-plane.md) | Proposed |
| 0013 | [Raw Signal 보존 정책 - MVP에서는 최근 30일만 복구](0013-raw-signal-retention-for-mvp.md) | Proposed |
| 0014 | [MVP에서는 ClickHouse를 app subnet에 유지](0014-keep-clickhouse-in-app-subnet-for-mvp.md) | Proposed |
| 0015 | [Fargate 태스크를 ARM64로 통일](0015-arm64-fargate-for-cost-savings.md) | Accepted |
| 0016 | [운영자 접속은 SSM 기반으로 (EC2는 Session Manager, Fargate는 ECS Exec)](0016-ssm-based-operator-access.md) | Accepted |
| 0017 | [Collector config를 env provider로 주입](0017-inject-collector-config-via-env-provider.md) | Accepted |
| 0018 | [post-processor 런타임 계약을 앱 환경변수에 맞추고 PG DSN을 파생 시크릿으로 주입](0018-post-processor-runtime-contract-via-derived-dsn-secret.md) | Accepted |

새 ADR을 작성할 때는 다음 미사용 번호(`0020-...`)를 사용하고 위 ADR들과 같은 템플릿(Status / Context / Decision / Alternatives Considered / Consequences)을 따른다. `0019`는 로그 그룹 정책 ADR용으로 예약되어 있다(`AGENTS.md` 섹션 5 (F)).
