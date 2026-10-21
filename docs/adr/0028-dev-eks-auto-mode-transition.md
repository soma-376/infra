# 0028. dev에 EKS Auto Mode를 병행 추가하고 수동 Helm으로 단계 전환한다

## Status

Accepted (구현·로컬 검증 대상, AWS 배포 증거 대기; JWT Secret 참조 목록은 [ADR-0030](0030-dev-user-jwt-keys-from-secrets-manager.md)이 부분 대체)

[ADR-0033](0033-dev-alb-https-with-external-acm.md)이 인증서 context가 있는 dev ALB의 HTTP 전용
listener를 HTTPS와 선택적 HTTP redirect로 부분 대체한다. 검증 ALB·TG 소유권과 라우팅은 유지한다.

ADR-0001·0002·0003·0005·0006·0009·0016·0021·0022·0026의 dev ECS 전용 실행·접속·스토리지·스택 수 가정을 **EKS 활성화 경로에 한해** 부분 대체한다. 기존 ECS와 prod 결정은 계속 유효하다. ADR-0019의 ClickHouse 이미지·사용자 설정, ADR-0024의 기존 CI 권한, ADR-0027의 WAF 정책은 유지한다. ADR-0020 예약 범위인 기존 ECS 로그 정책은 이 결정으로 대체하지 않는다.

[ADR-0029](0029-dev-dashboard-api-ecs-and-eks-deployment.md)이 dashboard 포함 네 workload와 전용 검증 TG·runtime·수동 Helm 배포를 추가한다. 아래 세 workload·두 앱 설정 목록은 PROJ-206~212 기준이며 추가 구현은 PROJ-221~224다. 기존 CDK/Helm 경계, ECS TG 재사용 금지와 데이터 전환 결정은 유효하다.

## Context

기존 dev는 `telemetry-ingest`, `enrollment-api`, `clickhouse`를 ECS EC2에서 실행한다. AWS 리소스는 infra가 소유하고 backend는 앱 코드·이미지·Flyway를 소유한다. 실행 장소를 EKS로 옮기더라도 앱 API와 환경 설정 계약, prod, 기존 GitHub Actions ECS 배포 workflow를 바꿀 필요는 없다. 따라서 이 결정은 infra 단일 레포에 둔다.

기존 ALB와 TG를 ECS와 Kubernetes가 동시에 관리하면 등록 해제 경쟁이 생긴다. 데이터 전환과 트래픽 전환을 동시에 실행하면 실패 원인과 복구 시점이 불명확해진다. 먼저 독립 검증 경로를 만들고 실제 이관을 후속 작업으로 분리한다. 형제 문서 허브에 남은 과거 auth-proxy·Collector 설명은 현재 배포 증거가 아니며, 기존 ADR-0026과 승인된 전환 계획을 되돌리는 근거로 사용하지 않는다.

## Decision

### 1. 소유권과 활성화

- `devEksEnabled=false`를 기본으로 기존 Network/Data/Application/Edge 4스택을 보존한다. `true`에서만 `DevEksStack`과 검증 Edge 리소스를 추가해 5스택을 만든다.
- CDK는 EKS 클러스터·IAM·AccessEntry·모든 사용자 정의 SG 및 cross-SG 규칙·ALB·TG·WAF·로그 그룹을 소유한다. SG와 규칙은 Network에 둔다. EKS 서비스가 자동 생성하는 cluster SG는 예외적 서비스 소유 리소스다.
- Helm은 NodeClass/NodePool, OSS LBC, CSI/ASCP, Fluent Bit, Namespace·ServiceAccount·Deployment·StatefulSet·Service·TGB·PVC 선언을 소유한다. 노드 생성·교체, 네트워킹·EBS 제공 기능은 Auto Mode가 관리한다.
- Kubernetes 1.36을 사용하고 private+public API endpoint, 필수 API CIDR, API 인증 모드와 명시적 AccessEntry를 구성한다. 자동 cluster creator admin은 끈다.
- EKS 운영자 role `soma-376-dev-eks-operator`는 CDK가 생성한다. 기존 운영자 role ARN이나 별도 principal ARN을 context로 받지 않는다. 같은 계정의 `AccountPrincipal`에 AssumeRole 권한을 위임하고, 실제 운영자는 계정 IAM에서 이 role에 대한 `sts:AssumeRole` 권한을 부여해 지정한다. 계정 root ARN은 root 사용자만 뜻하지 않으며 계정의 모든 주체에게 AssumeRole 권한을 자동 부여하지도 않는다.
- 운영자 role의 IAM policy는 해당 클러스터의 `eks:DescribeCluster`만 허용한다. Kubernetes 권한은 `STANDARD` AccessEntry와 cluster 범위 `AmazonEKSClusterAdminPolicy`로 부여하고, role ARN·이름은 `EksOperatorRoleArn`·`EksOperatorRoleName` output으로 제공한다. CloudFormation/IAM 배포 권한과 S3 조회·정리 권한은 원래 배포·운영 주체에서 관리한다.
- 기존 public subnet·NAT 0을 유지한다. 앱과 ClickHouse의 NodeClass/NodePool을 분리하고 ARM64·On-Demand·t4g.medium을 초기값으로 둔다. NodeClass는 public IPv4를 명시한다. ClickHouse는 전용 taint와 첫 번째 AZ에 고정한다. Auto Mode 기본 NodePool은 사용하지 않는다.
- 공통 node role에 EC2 AccessEntry와 AmazonEKSAutoNodePolicy를 연결한다. EKS는 Network/Data만 참조하며 ECS service·ALB listener에 의존하지 않는다. Helm 입력은 CDK output 참조를 values로 전달한다.
- 실제 배포 이후 `devEksEnabled=true`를 영속 설정으로 고정한다. false 합성 결과로 Network/Edge/EKS를 배포해 EKS 종속 리소스를 제거하는 일을 금지한다.

### 2. 외부 Edge와 워크로드

- OSS LBC chart/controller 3.6.0과 대응 CRD를 고정한다. Pod Identity와 `clusterName`·`region`·`vpcId`를 명시하고 TGB 등록·해제만 맡긴다. ALB/TG/listener·SG의 생성·변경 권한을 주지 않는다. Auto Mode 제공 구성요소는 중복 설치하지 않는다.
- namespace는 `pulsemetry-dev`, 앱 release는 ClickHouse·enrollment·ingest로 분리한다. 앱은 Deployment, ClickHouse는 StatefulSet이며 replica 1이다.
- ingest NodePort 30416/컨테이너 4316, enrollment NodePort 30080/컨테이너 8080을 사용한다. HTTP readiness `/api/v1/healthz`와 TCP liveness를 분리하고 ingest startup 240초를 허용한다. 메모리는 앱별 request 1Gi/limit 2Gi이며 실측 전 초기값이다. 앱 이미지는 immutable digest를 필수 입력으로 받는다.
- ClickHouse는 `24.8-alpine`, 기존 default user와 `CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1`, 50GiB gp3 PVC를 사용한다. StorageClass는 `ebs.csi.eks.amazonaws.com`, `WaitForFirstConsumer`, `Retain`이다. 기존 ECS EBS가 자동 승계된다고 가정하지 않는다.
- 별도 검증 ALB와 전용 TG 3개를 추가한다. 앱 TG는 instance+NodePort, ClickHouse TG는 ip:8123이다. 기존 listener 경로·default 404·접근 CIDR·health check·WAF를 유지하고 같은 Web ACL에 검증 ALB association을 추가한다. 검증 TG와 후속 Canary TG는 별도 ARN이며 ECS TG를 TGB에 전달하지 않는다.
  검증 ALB의 선택적 HTTPS는 ADR-0033의 `devEksCertificateArn`으로 켜며 기존 listener·규칙 ID를 유지한다.

### 3. 런타임 주입과 로그

- PROJ-206~212의 기존 구현은 Secret 3개의 ARN만 참조한다. Pod Identity·ASCP·CSI mount와 `SPRING_CONFIG_IMPORT=configtree:/mnt/secrets-store/`로 backend 수정 없이 주입한다. DB JSON username/password와 HMAC 전체 SecretString은 두 앱, 관리자 JSON token은 enrollment만 읽는다.
- 사용자 JWT 추가분은 [ADR-0030](0030-dev-user-jwt-keys-from-secrets-manager.md)에 따라 개인키·공개키 별도 ARN·VersionId를 참조하고 별도 키 파일 mount로 전달한다. enrollment는 두 원본, dashboard는 공개키 원본만 읽으며 ingest에는 JWT 권한을 추가하지 않는다. 기존 3개와 과거 검증 기록을 변경하지 않으며 JWT 역할·SPC·mount·파일 맵은 후속 구현이다.
- 기존 configtree 파일명은 PULSEMETRY 설정 이름이다. JWT PEM은 configtree 설정값이 아니라 별도 키 파일이며, 설정에는 파일 경로·명시적 `kid` 맵만 전달한다. Secret 환경변수 중복, Kubernetes Secret 복제, 자동 회전은 사용하지 않는다. UID 10001의 읽기 권한과 필수 파일 존재·읽기 가능·비어 있지 않음을 검사하는 initContainer를 구성한다. Secret 변경은 명시적 재시작으로 적용한다. JWT 교체는 일반 재시작 순서와 구별해 ADR-0030의 전체 verifier → signer → 330초 이상 대기 → 구 공개키 제거 절차를 따른다. 원문을 조회·합성·출력하지 않는다.
- 앱별 Secret 권한을 분리한다. ingest는 검증 단계에 `eks_validation/*`의 PutObject만 허용한다. `PULSEMETRY_ARCHIVE_PREFIX=eks_validation`이며 검증 완료 후 병행 운영에서 `eks`와 `eks/*`로 values와 IAM을 함께 변경한다. 기존 객체는 이동하지 않고 버킷의 7일 expiration과 ECS 권한을 유지한다. 조회·정리는 운영자 권한이다.
- prefix는 객체의 논리적 구분이다. 공유 RDS·ClickHouse 또는 양방향 보안 격리로 표현하지 않는다.
- 독립 Fluent Bit release로 앱 namespace의 stdout/stderr만 `/eks/dev/application`에 보내고 14일 보존한다. AWS 통합 CloudWatch observability 패키지는 메트릭/트레이싱 범위가 불필요하고, OTel Collector는 기존 앱 수집 파이프라인과 역할이 혼동되며, Vector는 별도 AWS 연동 운영 학습이 필요하다. 이번에는 로그 전달만 필요한 Fluent Bit을 선택한다. 로그 그룹은 CDK, 수집 설정은 Helm이 소유하며 자동 그룹 생성은 끈다.

### 4. 데이터·Canary·복구

1. 독립 검증: 전용 tenant/token과 별도 EKS ClickHouse를 사용한다. RDS·Secret은 공유하며 ECS와 호환되는 이미지·Flyway migration만 허용한다.
2. 후속 Canary: 양쪽 ingest가 기존 ClickHouse 한 곳에 쓴다. 이 단계의 EKS S3 prefix는 `eks`다.
3. 최종 이관: 쓰기 차단 → 처리 완료 확인 → ClickHouse 정지 → EBS snapshot → 동일 AZ 복원 → PVC 데이터 복사 → event ID 기반 정합성 확인 → 재개 순서다. snapshot/PV 보존과 복구 소요 시간을 리허설한다.

Canary 초기 가설은 비중 1→10→50→100%, 단계별 최소 30분·서비스별 성공 요청 100건, 100%에서 24시간 관찰이다. 예상 밖 인증 실패와 검증 event ID 유실은 0건, 5xx는 1% 이하이면서 ECS 대비 증가 0.5%p 이하, p95는 기준선 120% 이하로 둔다. 초과하면 승격을 중단하고 ECS 비중을 복구한다. **이 수치와 수락·저장 완료 데이터 기준 RPO 0·RTO 30분은 임의의 초기 설계 가설**이며 실측·AWS 권장값·검증된 SLO가 아니다. 실제 승격 전에 담당자가 기준선과 리허설 결과로 재검토한다.

Helm release 복구, ALB 트래픽 복구, DB/PVC 데이터 복구는 서로 다르다. Helm rollback으로 데이터가 복구되지 않는다.

## Constraints

- 앱 설정·DDL·인증 계약과 backend 소스/이미지를 바꾸지 않는다. enrollment 준비 확인 후 ingest를 배포한다.
- 수동 Helm 배포만 준비한다. GitHub Actions EKS 배포 자동화·ArgoCD는 포함하지 않는다.
- PROJ-206~212는 구현·문서·로컬 검증·커밋 범위다. AWS 배포, 데이터 이관, Canary, ECS 제거, HTTPS 전체 CLI E2E는 실행하지 않는다. 기존 HTTP ALB는 HTTPS endpoint 계약의 대체가 아니다.

## Alternatives Considered

- ECS 즉시 교체: 병행 비용은 줄지만 독립 검증과 빠른 트래픽 복구가 불가능해 채택하지 않는다.
- Auto Mode native TGB/Ingress: 외부 ALB/TG 소유권을 유지하고 Helm OSS LBC를 사용한다는 결정과 달라 채택하지 않는다.
- 처음부터 기존 ClickHouse 공유: 검증 데이터와 리허설 실패가 기존 저장소에 영향을 주므로 검증 분리 후 Canary에서만 공유한다.
- GitOps/ArgoCD: 초기 수동 배포·복구 경로를 먼저 검증하며 운영 구성요소 추가를 후속으로 미룬다.

## Consequences/Tradeoffs

### Positive

기존 경로와 prod를 보존한 채 검증할 수 있고, 코드 소유권과 배포 주체가 명시된다. Secret·S3 권한은 workload별로 축소된다.

### Negative

병행 기간에는 클러스터·노드·검증 ALB 비용이 추가된다. public 노드와 단일 AZ ClickHouse는 고가용성을 제공하지 않는다. Auto Mode 노드는 기존 EC2처럼 SSH/SSM 직접 접속하지 않는다. 공유 RDS migration, CSI 파일 권한, 노드 교체와 스토리지 정합성은 실환경 검증이 필요하다. LBC CRD와 chart/controller의 버전 갱신을 함께 관리해야 한다.

## Follow-up

- PROJ-213~215에서 병행 운영·데이터 리허설·Canary·ECS 제거를 실제 수행한다.
- 배포 전 EKS 버전·인스턴스·chart/CRD의 서울 리전 가용성, ARM64 이미지와 health 계약, API 접근과 Pod Identity를 확인한다.
- HTTPS listener·외부 인증서 참조는 ADR-0033이 담당한다. 실제 인증서·도메인·공개 URL·manifest 정합과
  TLS/CLI E2E 및 바이너리 공급은 별도 선행 과제다.

## Acceptance Criteria

TypeScript build·전체 Jest·prod A/B·dev 비활성/활성·cicd synth, 기존 리소스 보존과 의존 DAG, Helm lint/render/schema, configtree fixture, S3 prefix/PutObject 대응과 런북 shell 구문을 검사한다. 로컬 통과를 live 완료조건 충족으로 보고하지 않는다.

## References

- [EKS Auto Mode 클러스터](https://docs.aws.amazon.com/eks/latest/userguide/automode-get-started-cli.html)
- [NodeClass](https://docs.aws.amazon.com/eks/latest/userguide/create-node-class.html)
- [Auto Mode StorageClass](https://docs.aws.amazon.com/eks/latest/userguide/create-storage-class.html)
- [Spring configtree](https://docs.spring.io/spring-boot/reference/features/external-config.html)
- backend `application.yaml`, `SecurityConfig.HEALTH_PATH`, `HealthController`, `S3RawArchiveWriter`와 infra `synthDev()`·`DEV_OTLP_PATHS`·`DEV_ENROLLMENT_API_PATHS`
