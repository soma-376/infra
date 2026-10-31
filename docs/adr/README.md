# Architecture Decision Records

> 레포 전체 구조, 불변 규칙, 미해결 작업 목록은 루트의 [AGENTS.md](../../AGENTS.md)를 참고한다.
>
> 병행 브랜치에서 작성한 `0028`·`0029`·`0030`은 프론트엔드와 백엔드 CDK/EKS에 각각 존재한다.
> 기존 파일명과 링크를 보존하며 번호만으로 문서를 식별하지 않는다. 아래 표의 범위·제목·파일 링크를 함께 사용한다.

| 번호 | 제목 | Status |
|---|---|---|
| 0001 | [컴퓨트 런타임으로 ECS 채택](0001-adopt-ecs-as-compute-runtime.md) | Accepted; EKS 활성화 경로 부분 대체: [백엔드 ADR 0028](0028-dev-eks-auto-mode-transition.md); dev ECS 제거는 [ADR 0035](0035-dev-backend-eks-only.md)로 부분 대체 |
| 0002 | [분석 저장소를 Redshift에서 ClickHouse(도커)로 변경](0002-clickhouse-on-ecs-instead-of-redshift.md) | Accepted; EKS 활성화 경로 부분 대체: [백엔드 ADR 0028](0028-dev-eks-auto-mode-transition.md); dev ECS 제거는 [ADR 0035](0035-dev-backend-eks-only.md)로 부분 대체 |
| 0003 | [하이브리드 launch type - ClickHouse만 EC2, 앱 서비스는 Fargate](0003-hybrid-launch-type-ec2-clickhouse-fargate-apps.md) | Accepted; EKS 활성화 경로 부분 대체: [백엔드 ADR 0028](0028-dev-eks-auto-mode-transition.md); dev ECS 제거는 [ADR 0035](0035-dev-backend-eks-only.md)로 부분 대체 |
| 0004 | [서비스 묶음 - 태스크 단위 co-location](0004-task-level-colocation.md) | Accepted (dev 부분 대체: ADR 0026) |
| 0005 | [서비스 디스커버리 - Cloud Map 프라이빗 DNS](0005-cloud-map-private-dns-discovery.md) | Accepted (dev Collector 부분 대체: ADR 0026); EKS 활성화 경로 부분 대체: [백엔드 ADR 0028](0028-dev-eks-auto-mode-transition.md); dev ECS 제거는 [ADR 0035](0035-dev-backend-eks-only.md)로 부분 대체 |
| 0006 | [ClickHouse 데이터 내구성 - MVP에서는 로컬 EBS 수용](0006-accept-local-ebs-durability-for-mvp.md) | Accepted; EKS 활성화 경로 부분 대체: [백엔드 ADR 0028](0028-dev-eks-auto-mode-transition.md); dev ECS 제거는 [ADR 0035](0035-dev-backend-eks-only.md)로 부분 대체 |
| 0007 | [ECR 레포지토리는 CDK 관리 밖에서 선(先)생성](0007-precreate-ecr-outside-cdk.md) | Accepted (dev 이미지 목록 부분 대체: ADR 0026); dashboard 배포 범위 부분 대체: [백엔드 ADR 0029](0029-dev-dashboard-api-ecs-and-eks-deployment.md) |
| 0008 | [인증 이원화 - 대시보드는 ALB authenticate-cognito, OTLP는 ALB jwt-validation](0008-dual-auth-alb-cognito-and-otlp-token.md) | Superseded by 허브 ADR 0001 |
| 0009 | [CDK 스택 경계 - 인프라 레포 단일 관리 + 앱 레포는 이미지 배포만](0009-single-infra-repo-stack-boundary.md) | Accepted; 프론트엔드 도구·상태 분리는 [프론트엔드 0030](0030-isolate-frontend-terraform-network.md), EKS 활성화 경로는 [백엔드 0028](0028-dev-eks-auto-mode-transition.md)로 부분 대체; dev ECS 제거는 [ADR 0035](0035-dev-backend-eks-only.md)로 부분 대체 |
| 0010 | [고정 IP(EIP) 미채택](0010-no-static-eip.md) | Accepted |
| 0011 | [최소 AZ 구성 - 서브넷은 2 AZ, 이중화는 미적용](0011-single-az-topology.md) | Accepted (EKS 경로의 MSK 전용 3 AZ subnet은 ADR 0035) |
| 0012 | [컨트롤 플레인 DB 엔진으로 PostgreSQL 검토](0012-aurora-postgresql-for-control-plane.md) | Proposed |
| 0013 | [Raw Signal 보존 정책 - MVP에서는 최근 30일만 복구](0013-raw-signal-retention-for-mvp.md) | Proposed |
| 0014 | [MVP에서는 ClickHouse를 app subnet에 유지](0014-keep-clickhouse-in-app-subnet-for-mvp.md) | Proposed |
| 0015 | [Fargate 태스크를 ARM64로 통일](0015-arm64-fargate-for-cost-savings.md) | Accepted |
| 0016 | [운영자 접속은 SSM 기반으로 (EC2는 Session Manager, Fargate는 ECS Exec)](0016-ssm-based-operator-access.md) | Accepted; EKS 활성화 경로 부분 대체: [백엔드 ADR 0028](0028-dev-eks-auto-mode-transition.md); EKS API 릴레이 추가: ADR 0034; dev ECS 제거는 [ADR 0035](0035-dev-backend-eks-only.md)로 부분 대체 |
| 0017 | [Collector config를 env provider로 주입](0017-inject-collector-config-via-env-provider.md) | Accepted (dev 부분 대체: ADR 0026) |
| 0018 | [post-processor 런타임 계약을 앱 환경변수에 맞추고 PG DSN을 파생 시크릿으로 주입](0018-post-processor-runtime-contract-via-derived-dsn-secret.md) | Accepted (dev 부분 대체: ADR 0026) |
| 0019 | [ClickHouse 컨테이너 런타임 계약 - compose와 동일한 사용자 설정 + 이미지 태그 고정](0019-clickhouse-container-runtime-contract.md) | Accepted |
| 0020 | [프론트엔드 실행 로그는 환경별 기간 동안 CloudWatch에 보관한다](0020-frontend-log-retention-policy.md) | Accepted — frontend 한정, 기존 CDK 정책 검토는 계속 필요 |
| 0021 | [dev/prod 환경 분리 - 컨텍스트 스위치 단일 앱과 lib/{common,prod,dev} 경계](0021-dev-prod-environment-separation.md) | Accepted; EKS 활성화 경로 부분 대체: [백엔드 ADR 0028](0028-dev-eks-auto-mode-transition.md) |
| 0022 | [개발 인프라 토폴로지 - 퍼블릭 서브넷 전용, ECS on EC2, 혼합 네트워크 모드](0022-dev-infrastructure-topology.md) | Accepted (앱 토폴로지 부분 대체: ADR 0026); EKS 활성화 경로 부분 대체: [백엔드 ADR 0028](0028-dev-eks-auto-mode-transition.md); 선택적 dev HTTPS 부분 대체: ADR 0033; EKS 경로 MSK isolated subnet 부분 대체: ADR 0035; DB 공개 접근 관련 부분은 [ADR 0038](0038-dev-databases-private-access-via-ssm-relay.md)로 대체 |
| 0023 | [dev 인증 프록시 - ALB와 Collector 사이에 auth-proxy 태스크 삽입](0023-dev-auth-proxy-between-alb-and-collector.md) | Superseded by ADR 0026 |
| 0024 | [GitHub Actions 배포 - 레포×환경 4개 OIDC 역할과 ECS 물리 이름 고정](0024-github-actions-oidc-deploy-roles.md) | Accepted (dev 대상 부분 대체: ADR 0026); dashboard 배포 범위 부분 대체: [백엔드 ADR 0029](0029-dev-dashboard-api-ecs-and-eks-deployment.md); dev ECS 제거는 [ADR 0035](0035-dev-backend-eks-only.md)로 부분 대체 |
| 0025 | [개발 MVP의 비-ClickHouse ALB 타깃에 60초 deregistration delay 적용](0025-use-60-second-dev-deregistration-delay.md) | Accepted (dev 대상 부분 대체: ADR 0026) |
| 0026 | [dev 백엔드를 telemetry-ingest·enrollment-api·ClickHouse 세 서비스로 전환](0026-dev-backend-deployment-units-and-staged-migration.md) | Accepted (API 경로·health check는 허브 ADR 0016이 부분 대체); EKS 활성화 경로 부분 대체: [백엔드 ADR 0028](0028-dev-eks-auto-mode-transition.md), dashboard 배포 범위 부분 대체: [백엔드 ADR 0029](0029-dev-dashboard-api-ecs-and-eks-deployment.md); 선택적 dev HTTPS 부분 대체: ADR 0033; dev ECS 제거는 [ADR 0035](0035-dev-backend-eks-only.md)로 부분 대체 |
| 0027 | [dev ALB에 경로별 Count 예외를 가진 WAF를 적용](0027-dev-alb-waf-policy.md) | Accepted (PROJ-269 bootstrap 두 경로의 등록 rate 합산; 실제 적용 별도); CLI OIDC query 조건 부분 대체: [ADR 0044](0044-dev-waf-cli-oidc-loopback-query-exception.md); CLI token Body 조건 부분 대체: [ADR 0045](0045-dev-waf-cli-token-body-exception.md); dashboard 배포 범위 부분 대체: [백엔드 ADR 0029](0029-dev-dashboard-api-ecs-and-eks-deployment.md); DB 공개 접근 관련 부분은 [ADR 0038](0038-dev-databases-private-access-via-ssm-relay.md)로 대체 |
| 0028 (프론트엔드) | [프론트엔드 HTTPS와 단일 컨테이너 실행 환경을 Terraform으로 관리한다](0028-frontend-alb-and-container-runtime.md) | Accepted (DNS·ACM은 [프론트엔드 0029](0029-use-external-dns-and-existing-frontend-certificate.md), 이미지 릴리스는 허브 0022로 부분 대체) |
| 0028 (백엔드 CDK/EKS) | [dev에 EKS Auto Mode를 병행 추가하고 수동 Helm으로 단계 전환](0028-dev-eks-auto-mode-transition.md) | Accepted (구현·검증 기록은 PROJ-206~212; dashboard 범위 부분 대체: [백엔드 ADR 0029](0029-dev-dashboard-api-ecs-and-eks-deployment.md); JWT 참조 목록 부분 대체: [백엔드 ADR 0030](0030-dev-user-jwt-keys-from-secrets-manager.md); 선택적 dev HTTPS 부분 대체: ADR 0033; API 접근·operator IAM 부분 대체: ADR 0034; MSK·telemetry Gateway 추가: ADR 0035·0036; NodePool·로그 수집 범위 부분 대체: ADR 0037); DB 공개 접근 관련 부분은 [ADR 0038](0038-dev-databases-private-access-via-ssm-relay.md)로 대체 |
| 0029 (프론트엔드) | [프론트 DNS는 외부에서 관리하고 발급된 ACM 인증서를 참조한다](0029-use-external-dns-and-existing-frontend-certificate.md) | Accepted |
| 0029 (백엔드 CDK/EKS) | [dev dashboard-api는 공통 ARM64 이미지로 ECS와 EKS에 각각 배포](0029-dev-dashboard-api-ecs-and-eks-deployment.md) | Accepted (후속 구현·AWS 배포 증거 대기; JWT 공개키 공급 부분 대체: [백엔드 ADR 0030](0030-dev-user-jwt-keys-from-secrets-manager.md)); dev ECS 제거는 [ADR 0035](0035-dev-backend-eks-only.md)로 부분 대체 |
| 0030 (프론트엔드) | [프론트엔드 기반 인프라는 독립 Terraform 상태로 관리한다](0030-isolate-frontend-terraform-network.md) | Accepted |
| 0030 (백엔드 CDK/EKS) | [dev 사용자 JWT 키는 별도 Secrets Manager 원본에서 버전을 지정해 파일로 공급](0030-dev-user-jwt-keys-from-secrets-manager.md) | Accepted (키 준비·전달 구현·AWS 배포 증거 대기; 원본 생성·보존 소유 경계 부분 대체: ADR 0031; telemetry JWT 범위는 ADR 0036) |
| 0031 | [dev dashboard DB 자격 증명과 사용자 JWT Secret 원본은 CDK로 생성하고 보존](0031-manage-dev-dashboard-and-jwt-secrets-with-cdk.md) | Accepted (dev 원본 정의·운영 절차; AWS 배포·값 등록·DB 적용 증거 대기) |
| 0032 | [dev OIDC client secret은 CDK 원본의 고정 버전을 ECS와 EKS에 공급](0032-dev-oidc-client-secret-runtime-supply.md) | Accepted (선택적 localhost HTTP 허용 입력 포함; 로컬 구현·검증, AWS 배포·값 등록·Cognito 로그인 증거 별도); dev ECS 제거는 [ADR 0035](0035-dev-backend-eks-only.md)로 부분 대체 |
| 0033 | [dev ALB는 외부 ACM 인증서를 context로 참조해 선택적으로 HTTPS를 제공](0033-dev-alb-https-with-external-acm.md) | Accepted (로컬 구현·검증; AWS 배포·TLS·애플리케이션 E2E 증거 별도); dev ECS 제거는 [ADR 0035](0035-dev-backend-eks-only.md)로 부분 대체; DB 공개 접근 관련 부분은 [ADR 0038](0038-dev-databases-private-access-via-ssm-relay.md)로 대체 — ADR-0040이 공개 URL·추가 인증서 결정을 부분 대체 |
| 0034 | [dev EKS API는 SSM 릴레이 터널을 통해 private endpoint로 접근](0034-dev-eks-private-api-via-ssm-relay.md) | Accepted (로컬 구현·검증 대상; AWS 배포·SSM·Kubernetes 접속 증거 별도) |
| 0035 (MSK) | [dev EKS 경로의 MSK는 전용 3 AZ isolated subnet과 DevEksStack 하위 리소스로 둔다](0035-dev-msk-isolated-subnets-under-eks-stack.md) | Accepted (PROJ-246 로컬 구현·검증 대상; AWS 배포·MSK 접속 증거 별도); dev Kafka 부분 대체: [ADR 0049](0049-dev-strimzi-kafka-and-staged-msk-retirement.md) |
| 0036 (telemetry Gateway) | [telemetry Gateway는 Pod Identity와 workload별 MSK 전용 역할로 dev EKS에 배포하고 OTLP 대상은 context로 전환한다](0036-dev-telemetry-gateway-workload-and-msk-iam.md) | Accepted (PROJ-246 로컬 구현·검증 대상; AWS 배포·MSK IAM·ALB 전환 증거 별도); dev Kafka 부분 대체: [ADR 0049](0049-dev-strimzi-kafka-and-staged-msk-retirement.md) |
| 0037 | [dev EKS 관측은 독립 노드의 Prometheus·Grafana와 CloudWatch 시스템 로그를 사용한다](0037-dev-observability-and-system-diagnostics.md) | Accepted (PROJ-191 로컬 구현; 0028의 NodePool·로그 수집 범위 부분 대체; 실환경 검증 별도; Loki·Tempo·tracing 제외는 0039(Proposed)가 개정 제안); dev Kafka 부분 대체: [ADR 0049](0049-dev-strimzi-kafka-and-staged-msk-retirement.md) |
| 0035 (dev EKS 전용) | [dev 백엔드의 ECS를 제거하고 기존 EKS를 단독 실행 환경으로 사용](0035-dev-backend-eks-only.md) | Accepted (PROJ-248 코드·문서·로컬 검증; 실제 철거·Snapshot·기능 검증 별도); DB 공개 접근 관련 부분은 [ADR 0038](0038-dev-databases-private-access-via-ssm-relay.md)로 대체 |
| 0036 (JVM 차단 목록) | [dev JVM의 임시 인증서 차단 목록을 Helm ConfigMap으로 공급한다](0036-dev-jvm-blocked-certs-configmap.md) | Accepted (PROJ-253 임시 대응; Gateway 포함 네 앱, 실제 배포 별도, 패치 이미지 검증 후 제거) |
| 0038 | [dev 데이터베이스는 공개 접근을 차단하고 별도 SSM 릴레이로 접속한다](0038-dev-databases-private-access-via-ssm-relay.md) | Accepted (PROJ-254 로컬 구현·검증; 실제 배포·접속 확인 별도) |
| 0039 | [dev EKS 관측에 Loki·Tempo·플랫폼 trace Collector를 독립 release로 더하고 CloudWatch 로그와 병행한다](0039-dev-loki-tempo-and-platform-trace-collector.md) | Proposed (PROJ-256; 채택 시 0037의 Loki·Tempo·분산 tracing 제외를 대체) |
| 0040 | [dev 공개 origin과 추가 인증서를 배포 입력으로 보존한다](0040-dev-public-origin-and-additional-certificates.md) | Accepted (추적 profile·runtime·DB TLS 연결) |
| 0041 | [dev dashboard 조회 권한 복구는 검증된 명시 허용목록으로 분리한다](0041-dev-dashboard-read-grants-repair.md) | Accepted (PROJ-262 수동 복구 준비·로컬 검증; dev 적용 별도 승인) |
| 0042 | [프론트 관측 스택을 전용 EC2와 영구 EBS에 배포한다](0042-frontend-observability-ec2.md) | Accepted (대시보드 독립 배포 개정; 전환 적용 대기) |
| 0043 | [dev 초대 메일은 SES와 EKS 전용 암호화 키 원본으로 보낸다](0043-dev-invitation-mail-via-ses-and-csi.md) | Accepted — SES identity 권한은 [ADR 0047](0047-dev-ses-fixed-sender-identity-authorization.md)로 대체; 원본·공급·고정 발신 주소 유지 |
| 0044 | [정상 CLI OIDC loopback 요청에만 두 query 탐지의 후속 차단 예외를 둔다](0044-dev-waf-cli-oidc-loopback-query-exception.md) | Accepted (ADR 0027의 두 query label 조건 부분 대체; 실제 배포 검증 별도) |
| 0045 | [정상 CLI 토큰 교환 본문에만 두 탐지의 후속 차단 예외를 둔다](0045-dev-waf-cli-token-body-exception.md) | Accepted (ADR 0027의 두 Body label 조건 부분 대체; 실제 배포 검증 별도) |
| 0046 | [dev SES 수신 identity 권한은 승인 태그와 고정 발신 주소로 제한한다](0046-dev-ses-tagged-recipient-authorization.md) | Superseded by [ADR 0047](0047-dev-ses-fixed-sender-identity-authorization.md) |
| 0047 | [dev SES identity 권한은 실행 계정·리전과 고정 발신 주소로 제한한다](0047-dev-ses-fixed-sender-identity-authorization.md) | Accepted (ADR 0046 대체; 실제 정상 초대 수신·설치 검증 별도) |
| 0048 | [dev CloudFormation은 고정한 합성 결과를 승인한 뒤 GitHub Actions로 배포한다](0048-dev-cloudformation-cicd.md) | Accepted (PROJ-259·270·271·272; develop 수동 재계획 포함; 로컬 구현·검증, 관리자 설정·실제 배포 별도) |
| 0049 | [dev Kafka는 Strimzi로 관리하고 MSK는 검증 후 단계적으로 제거한다](0049-dev-strimzi-kafka-and-staged-msk-retirement.md) | Accepted (Operator 통신·main 전환 S3 임시 중첩·Group ACL 의미 포함; 배포 검증 별도) |

| 0050 | [격리 perf 환경의 공급자별 Kafka와 고정 Strimzi 용량](0050-perf-strimzi-provider-and-isolated-capacity.md) | Accepted (로컬 구현; 배포 NOT_RUN) |
| 0051 | [perf 내부 Service와 공개 HTTPS는 같은 Gateway를 사용한다](0051-perf-https-edge-to-shared-gateway.md) | Accepted (로컬 구현; 실제 HTTPS 검증 NOT_RUN) |

| 0052 | [perf 예산과 독립 정리 보호](0052-perf-budget-and-independent-cleanup.md) | Accepted (로컬 구현; 실제 정리 검증 별도) |

| 0053 | [dev 프론트 두 앱을 인증 동시성 검증에 앞서 배치한다](0053-frontend-dev-two-apps-before-auth-validation.md) | Accepted (PROJ-243; 배포 검증 별도) |
| 0055 | [프론트 공유 Valkey 기반을 독립 Terraform 상태로 관리한다](0055-shared-frontend-valkey-foundation.md) | Proposed (로컬 구성; 배포 별도) |

병행 작업에서 사용한 `0035`·`0036`은 각각 파일명·제목·링크를 보존한다. 번호만으로 대상을 식별하지 않는다.

새 ADR을 작성할 때는 다음 미사용 번호(`0056-...`; 0054는 로컬 OIDC callback PR에서 사용)를 사용하고 [`0000-adr-template.md`](0000-adr-template.md)의 구조를 따른다. `0020`은 프론트엔드 로그 정책에 사용했다. 기존 CDK 로그 정책은 별도 후속 ADR의 미결 사항이며 `AGENTS.md` 섹션 5 (F)를 따른다.

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
