# 0029. dev dashboard-api는 공통 ARM64 이미지로 ECS와 EKS에 각각 배포한다

## Status

Accepted (배포 결정 채택, 서비스 구현·AWS 배포·기능 검증은 후속 티켓; JWT 공개키 공급은 [ADR-0030](0030-dev-user-jwt-keys-from-secrets-manager.md)이 부분 대체)

[ADR-0007](0007-precreate-ecr-outside-cdk.md)·[ADR-0024](0024-github-actions-oidc-deploy-roles.md)의 dev 이미지 소비·ECS 배포 대상,
[ADR-0026](0026-dev-backend-deployment-units-and-staged-migration.md)의 서비스 수·앱 배치·라우팅,
[ADR-0027](0027-dev-alb-waf-policy.md)의 앱 내용 검사 범위,
[ADR-0028](0028-dev-eks-auto-mode-transition.md)의 workload·검증 TG·런타임 주입 목록을 부분 대체한다.
과거 migration 기록, 기존 enrollment·ingest·ClickHouse 계약, prod, OIDC trust, ECR 선생성 원칙과 CDK/Helm 소유 경계는 유지한다.
ADR-0020의 로그 정책 예약은 유지한다.

## Context

backend의 `apps/dashboard-api`는 이미 구현되어 있고 backend ADR-0022·0023을 채택한다.
앱 소재·저장소·DDL·사용자 인증·설정 식별자와 endpoint 소유권은
[허브 ADR-0021](../../../docs/adr/0021-dashboard-runtime-and-deployment-contract.md)과
[dashboard 공통 계약](../../../docs/contracts/dashboard-api.md)이 소유한다.
이 ADR은 그 계약을 dev ECS/EKS에 배치하고 전달하는 infra의 책임만 정한다.

PROJ-226 기준 코드는 `ECR_REPOS.dashboardApi`와 backend-dev의 ECR 공급 권한을 준비했지만,
dashboard ECS Service·TaskDefinition·TG·재배포 권한과 EKS workload를 만들지 않는다.
EKS 구현은 PROJ-207~211의 누적 브랜치, 기존 운영 문서는 PROJ-212에 있다.
이 문서 브랜치로 가져온 EKS 문서는 해당 코드의 존재나 현재 AWS 배포 상태를 증명하지 않는다.

## Decision

### 1. 이미지와 배포 소유권

`soma-376/dashboard-api`는 CDK 밖에서 선생성하고 `Repository.fromRepositoryName`으로 참조한다.
backend Dockerfile의 dashboard-api target으로 `linux/arm64` 이미지를 한 번 빌드한다.
같은 릴리스의 commit 태그·`dev` 태그와 manifest digest를 대조하고 ECS/EKS가 같은 artifact를 소비한다.
EKS 입력은 immutable digest이며 ECS 태그를 검증하는 동안 다른 workflow가 태그를 바꾸지 않았는지도 확인한다.
최초 `dev` 이미지 공급은 아직 없는 ECS 서비스의 ACTIVE 검사나 전체 CD 성공을 기다리지 않는다.

CDK는 AWS 리소스, ECS TaskDefinition·Service, IAM, 모든 사용자 정의 SG와 cross-SG 규칙,
ALB·TG·listener·WAF·로그 그룹을 소유한다. SG와 규칙은 Network에 둔다.
Helm은 Kubernetes Deployment·Service·ServiceAccount·SecretProviderClass·TGB를 소유한다.
LBC는 전용 TG의 대상 등록·해제만 맡는다. ECS TG를 EKS TGB에 전달하지 않는다.

### 2. ECS 배치와 초기 서비스 생성

`soma-376-dev`에 독립 서비스 `dashboard-api`를 추가한다. 컨테이너 포트는 8081,
bridge와 동적 host port, 기존 앱 ASG/capacity provider, 1024 MiB 소프트 예약,
`desiredCount: 1`, `minHealthyPercent: 0`, `maxHealthyPercent: 100`을 사용한다.
ECS 전용 instance TG는 `/api/v1/healthz`의 200을 검사하고 새 앱 기준인 60초 deregistration delay를 적용한다.
`/ecs/dev/dashboard-api` 로그는 기존 14일 보존·DESTROY 정책을 따른다. 정책 자체의 재결정은 ADR-0020이다.

기존 두 앱을 합쳐 세 Spring 컨테이너의 소프트 예약은 3072 MiB다.
t4g.medium 한 대에서의 산술 합계는 배치 가능성·메모리 안정성의 증거가 아니다.
PROJ-221에서 실제 placement·host 여유·메모리·OOM·교체 배포를 확인한 뒤 수락한다.
이번 문서 작업으로 ASG 크기나 기존 앱 사양을 변경하지 않는다.

ECS 서비스 이름의 단일 출처는 `lib/common/deploy-targets.ts`다.
backend-dev의 재배포 대상에 dashboard-api를 추가하는 구현은 PROJ-221이 맡는다.
`iam:PassRole`·`ecs:RegisterTaskDefinition`을 허용하지 않고 prod·pipeline 역할과 OIDC trust를 보존한다.

### 3. EKS 배치와 설정 전달

`pulsemetry-dev`의 기존 apps NodePool에 별도 dashboard release를 배치한다.
기존 Spring 앱의 ARM64, replica 1, Recreate, UID 10001, requests 250m/1Gi·limits 1 CPU/2Gi,
HTTP readiness와 TCP liveness 운영 방식을 따른다. 자원 값은 실측 전 초기값이며 실제 스케줄링·메모리는 별도 검증한다.
dashboard 컨테이너 포트는 8081이고 검증 ALB에 전용 instance TG와 TGB를 추가한다.

**dashboard NodePort 숫자는 미정이다.** PROJ-223 구현에서 기존 할당과 실제 대상 환경을 확인해 확정한다.
PROJ-224의 TG 포트, Network SG, CDK output과 Helm Service·TGB가 같은 값을 사용하는 것이 배포 전 필수 조건이다.
기존 ingest 30416·enrollment 30080을 근거로 다음 숫자를 자동 할당하지 않는다.
현재 spring-app schema/helpers와 output→values 생성기는 두 앱만 지원하므로 values 한 파일만 추가해 실행하지 않는다.

공통 계약의 RDS/ClickHouse source·cache 네 연결은 PROJ-222가 계정·권한·설정 참조로 준비한다.
원천 migration은 enrollment-api가 먼저 적용하고, 캐시 DB·스키마·사용자·권한은 기동 전에 준비한다.
dashboard 앱은 자기 캐시 테이블·뷰 DDL을 기동 시 적용하며 실패하면 기동에 실패한다.
RDS cache 연결에서 원천 retention boundary를, ClickHouse cache 연결에서 원천 분석 테이블을 읽는 조건도 충족해야 한다.
구체적인 설정명·최소 SELECT 대상·DDL 권한 표는 허브 계약을 참조하며 여기 복제하지 않는다.

ECS는 일반 운영값을 전달하고 기존 비밀 자격증명은 ECS secrets 참조로 주입한다.
**대체됨(ADR-0030)**: 공개키를 앱 이미지에 포함하거나 임의 mount로 전달하는 선택은 사용하지 않는다.
공개키 전용 Secrets Manager ARN·VersionId에서 일회성 writer가 task 공유 volume에 파일을 공급하며,
앱은 writer의 SUCCESS 이후 읽기 전용 mount를 사용한다. 실제 kid 맵·issuer·audience·허용 origin을 enrollment와 맞춘다.
EKS는 dashboard 전용 ServiceAccount·Pod Identity·SecretProviderClass와 기존 ASCP/CSI/configtree를 사용한다.
JWT 공개키는 버전 지정 JSON 키링에서 개별 PEM 파일로 추출해 별도 mount하고 configtree에는 경로·kid 맵만 전달한다.
UID 10001의 필수 파일 접근과 실제 Spring 바인딩을 확인한다. 원문 조회·출력·Kubernetes Secret 복제를 하지 않는다.
dashboard에 HMAC·관리자 토큰·개인 서명키·raw S3 권한을 전달하지 않는다.

### 4. 경로·메서드·CORS와 WAF

기존 ECS ALB와 EKS 검증 ALB는 허브 계약의 endpoint별 path와 HTTP method만 해당 앱 TG로 전달한다.
동일 URI의 dashboard GET과 enrollment 쓰기 method를 분리한다.
`/api/v1/auth/me`, 조직 onboarding·invitations GET, 기존 enrollment 명령·bootstrap은 enrollment 소유를 유지한다.
조직 전체 wildcard나 GET 전체 전달 규칙으로 대체하지 않는다.

공유 URI의 OPTIONS는 path·OPTIONS method·`Access-Control-Request-Method`를 함께 검사한다.
dashboard GET preflight와 enrollment 쓰기 preflight를 나누고 enrollment GET 예외의 preflight도 보존한다.
누락·미지원 요청 method의 preflight가 다른 앱으로 포괄 전달되지 않도록 명시 규칙과 default 404로 검증한다.
인증·CORS 응답은 각 앱이 담당한다. `/api/v1/healthz`는 TG/probe 내부 용도이고 public rule은 만들지 않는다.
ALB condition 평가 한도에 맞춰 규칙을 나누며 모든 listener의 `open: false`를 유지한다.

dashboard의 명시한 URI는 WAF 앱 본문/query 검사에 포함한다.
WAF 앱 검사 범위와 ALB의 method별 전달 범위는 구분하며 등록 rate 범위를 넓히지 않는다.
정확한 OTLP 세 경로는 10,000건/300초 Count, 기존 등록 세 조건은 300건/300초 Block,
dashboard를 포함한 나머지는 1,000건/300초 Block을 유지한다.
국가·악성 IP·URI·헤더 차단과 로그 redaction·data protection·sampling 비활성화도 유지한다.

### 5. 단계별 완료 증거와 복구

| 순서 | 담당 | 다음 단계 전 확인할 증거 |
|---|---|---|
| 공통 저장소·인증 참조 준비 | PROJ-222 | 네 연결의 권한 경계, 원천 migration·캐시 사전 준비, 공개키·kid·세션 조회 조건 |
| 최초 ARM64 이미지 공급 | PROJ-226 | ARM64 manifest, commit/`dev` tag와 digest, 런타임 pull 접근 |
| 수동 CDK 서비스 생성 | PROJ-221 | build/test/synth/diff, 실제 ECS stable·target health·로그, 인증·조회·snapshot 및 기존 서비스 회귀 |
| 이후 ECS CD | PROJ-219 | 세 ECR·서비스 preflight 후 enrollment → ingest → dashboard 승격·배포·stable; 실패 즉시 후속 중단 |
| 수동 EKS Helm | PROJ-222~225 | chart/runtime/검증 TG 준비, ECS와 같은 digest, Pod Ready·target health, 인증·조회·snapshot·CORS·회귀 |

로컬 검증, 설치·target healthy, 인증·기능 성공을 각각 기록한다.
릴리스별 infra/backend commit, 이미지 태그·digest, ECS task와 Pod imageID, Helm revision,
설정 참조의 버전, 검사 기대값·실제 결과·실패 원인과 복구 결과를 남긴다. JWT는 개인키·공개키 VersionId·active-kid·파일 맵을 묶어 기록하고 ADR-0030의 교체·롤백 절차를 따른다.
비밀 원문은 기록하지 않으며 저장소 문서·예시·공개 증거의 계정 ID는 placeholder로 표시한다. 실제 full ARN은 승인된 접근 제한 배포 입력·기록에서 관리한다.
ECS는 마지막 검증 이미지로 `dev` 태그를 복구하고 기존 task definition으로 재배포한다.
EKS는 호환되는 마지막 검증 Helm revision으로 해당 release를 복구한다.
TG/listener·설정·권한은 해당 변경의 복구 절차를 적용하며 Helm rollback이 DB/PVC 데이터를 복구한다고 보지 않는다.

## Constraints

이번 PROJ-227·228·220은 문서 변경과 로컬 커밋만 수행한다. 실제 코드·이미지·DB 권한·AWS/Kubernetes 리소스를 변경하지 않는다.
retention-worker, prod 변경, EKS CD 자동화, 전체 ECS→EKS 전환은 범위 밖이다.
HTTP ALB는 HTTPS 전체 CLI E2E 계약의 대체가 아니다. 상세 실행 절차는 기존
[EKS 수동 런북](../runbooks/dev-eks-manual-deployment.md)을 확장하며 공통 API·설정 표를 별도 infra 문서로 만들지 않는다.

## Alternatives Considered

- ECS/EKS별 이미지 재빌드: 같은 릴리스 비교에서 artifact 차이를 만들므로 기각한다.
- ECS TG를 EKS에 재사용: 대상 등록·해제 소유권이 충돌하므로 기각한다.
- 조직 URI·GET 전체 전달: enrollment GET과 미정의 endpoint가 가려지므로 기각한다.
- master 자격증명과 기존 앱 Secret 공유: source/cache 최소 권한과 dashboard 인증 경계를 무너뜨리므로 기각한다.

## Consequences/Tradeoffs

### Positive

같은 이미지·공통 계약을 두 런타임에서 검증하고 서비스·라우팅·DDL·인증의 담당이 명확해진다.
초기 서비스 생성과 이후 CD의 순환 의존을 분리한다.

### Negative

세 번째 앱이 기존 호스트와 NodePool 자원을 사용하고 method·preflight별 ALB 규칙을 추가한다.
별도 TG·설정 전달 경로와 네 연결 계정의 운영 비용이 늘어난다.
문서 채택만으로 앱 준비·AWS 설정·실제 기능 성공을 보장할 수 없다.

## Acceptance Criteria

문서·ADR 인덱스·활성 링크 정합, 코드와 설정·endpoint 소유권 대조, 런북 명령 구문,
부모 PROJ-226 대비 문서 외 변경 없음과 Git ancestry를 확인한다.
실제 배포 수락은 위 표의 담당 티켓이 성공 증거를 별도로 남긴 뒤 판단한다.

## References

- [dashboard 공통 계약](../../../docs/contracts/dashboard-api.md), [허브 ADR-0021](../../../docs/adr/0021-dashboard-runtime-and-deployment-contract.md)
- [backend 운영 명세](../../../pulsemetry-backend/docs/dashboard-server-spec.md), backend `CacheSchemaInitializer`·`SecurityConfig.dashboardAuthenticator`·`UserAccessVerifier.verify`
- [ALB rule conditions](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/rule-condition-types.html)
- [EKS 수동 런북](../runbooks/dev-eks-manual-deployment.md), [기존 로컬 검증 기록](../runbooks/dev-eks-local-validation.md)
