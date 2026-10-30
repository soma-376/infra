# AGENTS.md

> 현재 dev Kafka는 Strimzi·`network-removed` profile이며, 배포·검증 범위는 아래 PROJ-282·191·256 절과
> [Strimzi 관측 완료 근거](docs/runbooks/proj191-strimzi-completion.md)를 따른다. 과거 로컬 구현 절의 미검증 표기는 당시 범위에만 적용하며 현재 배포 전체의 상태로 해석하지 않는다.

이 레포에서 작업하는 코딩 에이전트를 위한 핸드오프 문서다. 코드를 수정하기 전에 **3장(불변 규칙)** 과 **5장(남은 작업)** 을 반드시 읽는다.

문서와 주석은 **한국어**로 작성한다. AWS/CDK 용어와 명령어는 영문 원문을 유지한다.

---

## 프론트엔드 Terraform 추가 범위 (ADR 0030·0028·0029)

`frontend/`는 기존 CDK와 독립된 프론트엔드 인프라다. 부트스트랩·개발/운영 네트워크와 ALB·기존 ACM 인증서 연결,
개발 EC2(ECS bridge)·운영 Fargate를 구현한다. runtime 입력이 없으면 네트워크만 생성한다. [운영 안내](frontend/README.md)와 [ADR 0030](docs/adr/0030-isolate-frontend-terraform-network.md), [ADR 0028](docs/adr/0028-frontend-alb-and-container-runtime.md), [ADR 0029](docs/adr/0029-use-external-dns-and-existing-frontend-certificate.md)을 따른다. DNS와 인증서 발급은 외부에서 관리한다.
BFF 단일 프로세스에 맞춰 서비스 desired=1/min=0/max=100이다. 앱 이미지 게시·자동 배포는 [허브 ADR 0022](https://github.com/soma-376/docs/blob/main/adr/0022-frontend-ecs-image-delivery.md)를 따른다. 자동 배포 활성 환경은 deploy 태그를 사용하며 task definition은 계속 Terraform이 소유한다.
기존 CDK 전용 테스트 규칙은 그대로 유지하고, 새 Terraform은 fmt·validate·mock test로 검증한다.
기존 CDK 리소스를 Terraform에 import하거나 같은 리소스를 두 도구가 수정하지 않는다.
실제 apply는 리뷰·머지 후 보호된 CI에서 수행한다. 최초 bootstrap CI 역할 준비는 관리자 작업이다. 이후 bootstrap 변경은 ADR-0050에 따라 develop에서 전용 plan/apply 역할과 Environment 승인을 거친다.
다음 미사용 ADR은 **0051**다.

[ADR-0044](docs/adr/0044-dev-waf-cli-oidc-loopback-query-exception.md)에 따라 정확한 CLI OIDC authorize GET과
검증된 loopback query에만 SSRF·RFI 두 label의 후속 Block을 제외한다.
[ADR-0045](docs/adr/0045-dev-waf-cli-token-body-exception.md)는 정확한 CLI token POST의 1KB 이하 원문 JSON
세 필드를 검증한 경우에만 두 Body label을 제외한다. 다른 탐지·rate·로그 보호는 유지한다.

## PROJ-282 dev Strimzi 전환

[ADR-0049](docs/adr/0049-dev-strimzi-kafka-and-staged-msk-retirement.md)와
[허브 Kafka 계약](https://github.com/soma-376/docs/blob/main/contracts/telemetry-kafka.md)을 따른다.
Strimzi 1.3.0/Kafka 4.2.2는 ClickHouse와 같은 AZ의 전용 ARM64 노드 3대에서 실행한다.
Kafka 인증서에 한해 Strimzi 소유 Kubernetes Secret을 읽기 전용 mount한다. 기존 AWS Secret의 CSI 원칙은 유지한다.
최종 추적 MSK 제거 단계는 `network-removed`다. 이 profile은 두 수동 삭제·MSK/ENI 부재·수집 보존을 실제로
확인한 뒤에만 머지·사용하며, 파일의 단계 값만으로 실제 제거 완료를 판정하지 않는다.
main Kafka 전용 profile은 `archivePrefix=eks`·ALB Gateway·ingest kafka를 유지한다. 공개 ALB의
main ACK/consume/commit·S3/ClickHouse 성공을 확인한 뒤 적용한다. HTTP 복구는 현재 main 입력으로 만든 dual
수신기/TGB의 직접 서비스·NodePort·Ready·등록을 먼저 확인하고 ALB ingest 연결 뒤 실제 healthy를 확인한다.
코드의 profile은 실제 배포·검증 완료 증거가 아니다. 병렬 준비의 `strimzi/eks/retain` 조합만 ingest의
S3 PutObject를 `eks/*`와 `eks_validation/*`에 허용한다. `cluster-removed`부터 validation 권한을 회수하며
최종 단계는 main `eks/*`와 TLS 조건만 남긴다. 회수 전에 validation writer가 없어야 한다.
ingest와 offset-admin의 Kafka Group Read는 commit/reset을 함께 허용한다. 별도 Secret·수동 Job은 운영 절차 분리다.
최초 철거는 고정 private profile의 `cluster-removed`로 EKS 단독 배포, MSK ENI 해제 확인 뒤 `network-removed`로 Network 단독 배포다.
추적 profile 갱신은 두 단계가 끝난 실제 baseline과 정합을 맞추는 후속 작업이며 최초 삭제에 쓰지 않는다. main dual/TGB를 먼저 복원하는 HTTP 복구 절차를 유지한다.

## PROJ-259 dev CloudFormation CI/CD

[ADR-0048](docs/adr/0048-dev-cloudformation-cicd.md)·[운영 런북](docs/runbooks/dev-cloudformation-cicd.md)은
PROJ-270 문서 → PROJ-271 IAM → PROJ-272 workflow 순서의 도입 계약이다. 문서·코드·로컬 검증과
실제 관리자 설정·AWS 배포는 구분한다. 기존 앱 역할 4개를 유지하고 infra diff/deploy 역할 2개를 더한다.
도입 후 `DeployStack`의 역할은 총 6개이며 `env=cicd`는 계속 관리자 수동 배포다.
PR과 CD plan은 AWS baseline을 읽은 뒤 local `cdk diff --template`을 실행한다. CD는 plan →
Environment 승인 → 같은 SHA·Assembly 배포 순서이고, 최신 SHA·baseline·artifact 해시가 다르면 중단한다.
경로 필터 밖 변경으로 계획이 오래되면 develop 전용 `workflow_dispatch`로 새 plan·승인을 진행한다.
기존 run 재실행은 원래 SHA를 유지하며, 수동 실행 활성화에는 default branch의 workflow 정의도 필요하다.
기존 bootstrap 관리자급 실행 권한을 재사용하므로 dev/prod IAM 격리를 제공한다고 표현하지 않는다.
dev 네 스택의 후속 업데이트만 대상으로 하며 최초 설치·ECS 철거·Helm·prod·frontend는 별도 절차다.
GitHub 보호 설정과 실제 OIDC·승인·배포 검증은 로컬 구현의 완료 증거에 포함하지 않는다.

## PROJ-267 dev SES 초대 메일

[ADR-0043](docs/adr/0043-dev-invitation-mail-via-ses-and-csi.md)에 따라 관리 응답·메일 키 원본 두 개를
Retain으로 추가하고 enrollment Pod만 고정 버전 CSI 파일로 읽는다. SES는 실행 계정·리전의 identity와
고정 발신 주소로 제한한 SendEmail 권한을 사용한다. 실제 발송은 지정한 수신함만 사용하고 DNS 인증·
sandbox 수신 제한·수신·설치 결과는 별도 검증한다. [ADR-0047](docs/adr/0047-dev-ses-fixed-sender-identity-authorization.md)에 따라
SES 권한은 단일 SendEmail statement와 정확한 FromAddress 조건으로 제한한다. 개인 수신 주소는 IAM·배포 원본에 넣지 않는다.

## PROJ-262 dashboard 조회 권한 복구

기존 source/cache DB 역할의 누락 권한은 [ADR-0041](docs/adr/0041-dev-dashboard-read-grants-repair.md)과
[권한 런북](docs/runbooks/dev-dashboard-read-grants.md)을 따른다. `scripts/dev-dashboard-read-grants.py`는
읽기 전용 catalog 검사와 명시 허용목록 SQL 생성만 한다. vendor 암호문 열·credential 테이블·원천 쓰기·
미래 테이블 default privileges를 부여하지 않는다. dev GRANT는 별도 사용자 확인 뒤 운영자가 적용한다.
기존 broad grant 발견 시 자동 REVOKE하지 않으며 일반 배포·앱 시작·ClickHouse 설정과 분리한다.

## PROJ-261 dev 도메인 영속화

후속 배포 원본은 추적된 `config/dev/deployment.json`·`runtime.yaml`이다. 공식 dev CDK 명령은
`devDeploymentProfile`, `values:dev`는 `--deployment-profile`로 같은 원본을 자동 선택한다.
실제 계정 ID·Secret 원문·이미지/조회 산출물·개인 경로는 원본에 넣지 않으며 인증서 ARN은 실행 계정으로 조립한다.
profile과 다른 CLI context·공개 URL·callback은 오류다. `postgresSslMode.enrollment/ingest=require`가
현재 DB TLS를 보존한다. 개인 reports 또는 수동 Helm override를 다음 배포의 원본으로 쓰지 않는다.

[ADR-0040](docs/adr/0040-dev-public-origin-and-additional-certificates.md)에 따라 `devEksPublicBaseUrl`을 기존 output/Helm에 전달하고 `devEksAdditionalCertificateArns`로 추가 SNI 인증서를 보존한다. 이미 CloudFormation이 관리하는 추가 인증서는 `devEksAdditionalCertificateLogicalIds`에 현재 ARN→logical ID를 넣어 연결 교체를 피한다. 기본 인증서·listener/라우팅 ID·JWT issuer는 유지한다. 새 URL은 HTTPS origin이며 기본 인증서 입력이 필요하다. 생략한 공개 URL은 기존 HTTP ALB fallback이다. [도메인 런북](docs/runbooks/dev-domain-migration.md)에 따라 현재 runtime/Helm override를 함께 보관하고 DB TLS·수집 모드·tracing을 보존한다.

## PROJ-254 dev DB 비공개 접근

[ADR 0038](docs/adr/0038-dev-databases-private-access-via-ssm-relay.md)은 RDS의 공개 flag·CIDR ingress와
ClickHouse 공개 ALB 8123·TG·TGB를 제거한다. `devAllowedCidr`는 앱 ALB에만 적용한다.
Data에 별도 DB SSM 릴레이 한 대와 `soma-376-dev-db-operator`를 추가하고 Network가 SG 총 9개를 소유한다.
기존 EKS API 릴레이·역할은 유지하며 DB relay EC2에는 Kubernetes·Secret 권한을 주지 않는다.
로컬 `scripts/dev-db-tunnel.mjs`는 PostgreSQL 15432→5432, ClickHouse 18123→현재 Pod IP:8123으로 연결한다.
ClickHouse IP 조회에는 기존 EKS 터널·kubeconfig·EKS 운영자 프로필이 필요하고 Pod 교체 시 다시 실행한다.
RDS SG description의 `publicly accessible`은 교체 방지용 기존 문자열이며 현재 공개 설정을 뜻하지 않는다.
TGB를 Helm에서 먼저 제거하고 삭제/finalizer 완료 후 Edge TG를 제거한다. 공개 경로를 되살리는 rollback은 하지 않는다.
[접속·전환 런북](docs/runbooks/dev-database-access.md)을 따른다. AWS 배포·외부 차단·실제 DB 연결은 미검증이다.

## PROJ-256 Loki·Tempo·플랫폼 trace (Proposed)

[ADR-0039](docs/adr/0039-dev-loki-tempo-and-platform-trace-collector.md)는 관측 namespace에 `loki`·`tempo`·`otel-platform`
독립 release와 Fluent Bit의 CloudWatch·Loki 병행 배송을 기술한다. ADR의 `Proposed` 상태는 유지하며,
실제 dev 적용·검증 기록과 ADR 채택 여부를 구분한다.
세 chart는 `helm/observability/{loki,tempo,otel-platform}` wrapper가 upstream chart를 감싸고, chart checksum·이미지 digest를 lock에 고정한다.
apps·ClickHouse SG → 관측 SG 3100, apps SG → 관측 SG 4318 두 규칙만 더한다. Gateway·ingest의 trace 설정은 backend ADR 0069 계약을 생성기가 공급한다.
SG는 노드 단위라 세 release가 수신 NetworkPolicy를 두고, platform chart가 `kube-system/amazon-vpc-cni` ConfigMap으로 controller를 켠다. NodeClass는 바꾸지 않는다(노드 교체).
2026-10-26의 HTTP trace·로그 왕복과 장애 격리 검증은 [PROJ-256](https://team376.atlassian.net/browse/PROJ-256)에,
2026-10-29의 Strimzi main Gateway→Kafka→ingest→ClickHouse trace·로그 연결은
[PROJ-285](https://team376.atlassian.net/browse/PROJ-285)에 기록됐다. 2026-10-30에는 최신 N5와 실제 Kafka 요청의
Grafana 로그↔trace UI 왕복, 같은 digest 격리 저장소의 보존 삭제·재시작 비복원·새 입력을 확인했다.
격리 시험은 5분 정책이며 dev의 72h/48h 전체 기간 또는 과거 특정 파일 삭제 검증으로 확대하지 않는다.
최종 revision·G8·30분 판정은 [Strimzi 관측 완료 근거](docs/runbooks/proj191-strimzi-completion.md)에 기록한다.
observability revision 8·Tempo revision 2에서 G8 API·실제 UI, 1,800.808초·31표본 관찰과 종료 후 자원 보존 대조를 통과했다.
완료조건 검증은 PASS이며 실제 상태는 각 Jira에서 확인한다.

## PROJ-191 관측 현행과 완료 검증

[ADR-0037](docs/adr/0037-dev-observability-and-system-diagnostics.md)은 전용 관측 NodePool·SG,
Prometheus/Grafana, 내부 9404·9363 metrics, CloudWatch 시스템 로그를 정의한다. dev Kafka 관측은
[ADR-0049](docs/adr/0049-dev-strimzi-kafka-and-staged-msk-retirement.md)에 따라 Strimzi JMX·Kafka exporter·Operator·Pod/PVC로 전환했다.
`scripts/eks-values.mjs`는 배포 profile/output의 `kafkaProvider=strimzi`와 Secret metadata 입력으로 values를 생성한다.
MSK ARN/bootstrap/`--msk-nodes`는 현행 dev 입력이 아니다. 전체 `list-nodes` 검증은 호환용 MSK 경로에만 남는다.
EKS 하위 Grafana Secret은 서버 측 생성·Retain이며
전용 Pod Identity·CSI 파일로 공급한다. 기존 데이터 Secret을 관측 스택에 공유하지 않는다.
Fluent Bit은 Kubernetes metadata(label 포함, annotation 제외)·원문과 node-local DB/buffer를 보존한다. 실패 event
metric filter는 실제 Fluent Bit envelope 샘플로 대조하며 배포 전 `observability-metric-filter-check.mjs --aws`가 관문이다.
단일 Events collector는 PVC를, 노드 진단은 private S3의 NodeDiagnostic bundle을 사용한다.
업무 지표 계측과 PROJ-256의 플랫폼 tracing은 별도 설정이며, tracing의 ADR-0039 상태는 `Proposed`로 유지한다.
생성기는 관측을 항상 켠다(opt-in 없음, 근거는 런북). runtime-values의 `jvmGcSafepointLog`만 Gateway·ingest의
GC/safepoint stderr를 켠다. 관측 이미지 8개와 Fluent Bit DaemonSet은 검증한 multi-arch digest로 고정한다.
[관측 런북](docs/runbooks/dev-observability.md)과 [차트 안내](helm/observability/README.md)를 따른다.
2026-10-29 [PROJ-285](https://team376.atlassian.net/browse/PROJ-285)는 Strimzi target 7개, main ACK→consume→commit→ClickHouse,
sampled trace·로그, 30분 안정화와 TLS 실패 경보 발생·해제를 기록한다. MSK active scrape·전용 경보 제거와 최종 profile은
[infra #85](https://github.com/soma-376/infra/pull/85)에 연결된다. 2026-10-30의 lag·Tempo 보존 정정은
[infra #87](https://github.com/soma-376/infra/pull/87), lag 표시·현재 수집 상태 정정은
[infra #88](https://github.com/soma-376/infra/pull/88)에 반영됐다.
[infra #89](https://github.com/soma-376/infra/pull/89)의 Pipeline 안내문 정정까지 source
`8d230aa1ad77efdd2d6ae907ba1f5be7e1c13239`로 적용했고 observability revision은 8이다.
현재 source/runtime·검증 범위·G8·배포 후 30분 판정은 [Strimzi 관측 완료 근거](docs/runbooks/proj191-strimzi-completion.md)가 소유한다.
2026-10-30 06:00:53 UTC까지의 최종 관찰과 06:01:18 UTC 자원 대조로 세 티켓의 완료조건 검증은 PASS다.
실제 상태는 [PROJ-191](https://team376.atlassian.net/browse/PROJ-191)·[PROJ-255](https://team376.atlassian.net/browse/PROJ-255)·
[PROJ-256](https://team376.atlassian.net/browse/PROJ-256)에서 확인한다. 저부하 관찰을 최대 처리량이나 SLO 검증으로 확대하지 않는다.


---

## PROJ-246 telemetry Gateway·MSK 로컬 구현 이력

아래는 Strimzi 전환 전의 기록이다. 현재 dev Kafka 연결·관측·철거 상태는 위 PROJ-282·191 절과 ADR-0049를 따른다.

[ADR-0035](docs/adr/0035-dev-msk-isolated-subnets-under-eks-stack.md)와 [ADR-0036](docs/adr/0036-dev-telemetry-gateway-workload-and-msk-iam.md)을 따른다.
Network가 MSK 전용 isolated subnet 3개(`10.1.32~34.0/24`, 2a·2b·2c)와 `DevMskSg`를 만든다. VPC construct·`maxAzs: 2`·NAT 0은 그대로다.
DevEksStack 하위 `DevEksMsk`가 Kafka `3.9.x.kraft` broker 3대·IAM 전용 MSK를 소유하며 스택 삭제는 MSK와 backlog를 지운다.
bootstrap은 Lambda 없이 운영자가 조회한 `get-bootstrap-brokers` JSON을 생성기 `--msk-bootstrap`으로 받는다.
앱은 enrollment·ingest·dashboard·**telemetry-gateway** 네 개다. Gateway는 8082/NodePort 30082·전용 TG를 쓰며 DB·HMAC·사용자 JWT·S3가 없다.
ingest는 `http|dual|kafka` 모드이고 kafka 모드만 ClusterIP·TGB 없음이다. "모든 앱 NodePort"는 더 이상 참이 아니다.
MSK 데이터 권한은 workload별 MSK 전용 역할(대응 Pod 역할만 고정 세션 이름으로 assume, `sts:TagSession` 포함)에 있다.
`DevDataStack`은 값 없는 telemetry JWT 원본 2개를 RETAIN으로 더해 기본 Secret 정의 11개다. 개인키는 enrollment만, 공개키는 enrollment·Gateway·ingest가 읽는다.
runtime SPC는 기존 5개에 `<app>-telemetry-jwt` 3개를 더한 8개다. 검증 ALB의 OTLP 대상은 `devEksOtlpTarget=ingest|gateway`(기본 ingest)다.
backend-dev 배포 역할은 Gateway를 포함한 네 ECR push만 받고 ECS 권한은 없다. 경보는 SNS 없이 상태만 남고 Pod 재시작·OOM 경보는 후속이다.
설치·전환·복구·offset 재처리와 backend 인계표는 [telemetry Kafka 런북](docs/runbooks/dev-telemetry-kafka.md)을 따른다. AWS 적용·MSK 접속은 미검증이다.


---

## PROJ-248 dev 백엔드 EKS 전용 기준

[ADR-0035](docs/adr/0035-dev-backend-eks-only.md)는 DB 연결 한도 문제로 dev 백엔드 ECS를 조기 제거한다.
이 절은 PROJ-248 당시의 코드·로컬 검증 기준이다. 당시 AWS 철거·Snapshot·EKS 기능 검증 미완료 표기를 현재 배포 상태로 사용하지 않는다.
prod와 별도 frontend Terraform의 ECS는 유지한다. backend workflow의 ECS 검사·재배포 제거와 허브 배포
계약 정합화는 PROJ-249가 담당한다. **실제 철거는 PROJ-249 완료 후** [철거 런북](docs/runbooks/dev-ecs-retirement.md)을 따른다.

- dev는 Network·Data·Edge·EKS 네 스택이다. ECS·ASG·Cloud Map과 ECS JWT writer 구현은 없다.
- EKS ALB 1개·TG 4개·WAF association 1개·사용자 정의 SG 9개다. 기존 EKS construct 경로·논리 ID·
  TG 이름·앱 `Validation*` output을 보존한다. PROJ-254는 ClickHouse TG와 두 관련 output을 제거한다. 이름의 validation은 호환 표기다.
- RDS·S3·기본 Secret 11개와 OIDC 원본·EKS·Pod Identity·SSM relay·Helm workload/PVC는 유지한다.
- CDK의 필수 `devOidcClientKeys`는 전체 OIDC 원본 key 목록이며, 없으면 `[]`를 명시한다.
  기존 `oidc.clients[].key` 집합을 그대로 옮긴다. JWT/VersionId/callback/dashboard 설정은 EKS runtime YAML이 소유한다.
- `devEksEnabled`는 생략/true만 허용하고 false는 거부한다. `devDashboardRuntimeFile`·`devImageTag`·
  `devAppAsgMaxCapacity`·`devCertificateArn`·`devEksApiAllowedCidrs`는 폐기됐으며 남아 있으면 합성 오류다.
- 기존 EKS 인증서·CIDR·archive prefix·NodePort·앱 생성 YAML을 유지한다. ClickHouse 생성 YAML의
  공개 TG 입력 제거는 ADR-0038에 따른다. HTTPS의 공개 URL·manifest·
  Cognito·CLI E2E 정합은 별도 기능 검증이며 HTTP output을 HTTPS 완료 증거로 쓰지 않는다.
- 실제 삭제는 ECS 앱/ClickHouse 정상 종료 → 운영자 수동 EBS Snapshot completed → Application 스택 삭제 →
  task/ASG/ENI 부재 확인 → Edge 단독 갱신 → Network 단독 갱신 → cicd 권한 회수다. 최초 `deploy --all` 금지.
  Snapshot은 수동 보존하며 EKS 데이터 이관은 하지 않는다. 기존 ECS 로그는 현재 삭제 정책대로 제거된다.
- EKS API는 ADR-0034의 private 전용·SSM relay 접근이다. 릴레이 역할은 SSM 전용이고 operator 역할이
  Kubernetes 관리를 수행한다. 원래 hostname·CA 검증과 별도 kubeconfig를 유지한다.

기존 ECS 구현·검증 수치는 [PROJ-206~212](docs/runbooks/dev-eks-local-validation.md)와
[dashboard 구현 기록](docs/runbooks/proj218-local-implementation-validation.md)에 역사적 기록으로 남긴다.
해당 기록의 ECS 명령이나 과거 스택/서비스 수를 현재 배포 기준으로 사용하지 않는다.

---

## 0. 중앙 허브와 공통 규칙

Pulsemetry는 Claude Code·Codex 등 개발 AI 도구의 사용량과 비용을 조직 → 팀 → 구성원 축으로 모아 보여주는
사내 통합·가시화 플랫폼이다. 이 레포는 그 AWS 인프라를 담당한다.

- 제품·아키텍처·**레포 간 계약**의 단일 출처는 `soma-376/docs`다. 형제 체크아웃 `../docs`를 우선 참조한다.
- 기능 작업 전에는 `spec` 스킬, 설계 관련 작업 전에는 `adr` 스킬을 쓴다.
- git 작업은 `CONVENTION.md`를 따른다 (`conventions` 스킬).
- 스킬이 보이지 않으면 형제 `../agent-skills` 클론 여부를 확인하고, 없으면 사용자에게 클론을 안내한다.
- **사용자의 명시 요청 없이 `git push` 하지 않는다.**

**이 장은 1장 이하의 규칙을 대체하지 않는다.** 코드를 만지기 전에 3장(불변 규칙)과 5장(남은 작업)을 읽는 것은 그대로다.

**ADR 우선 원칙은 이 레포의 기존 규칙과 같다** — 1장의 "코드와 ADR이 어긋나면 ADR이 기준이다"가
전 레포 공통 규칙이며, 크로스레포 결정만 `../docs/adr/`가 소유한다. 스코프 판정은 `adr-new` 스킬이 안내한다.
단일 레포 구현 ADR은 지금처럼 `docs/adr/`에 남는다. 새 ADR은 `0050`부터이고 `0020`은 프론트엔드 로그 정책에 사용했다(5장 (F)).
기존 병행 브랜치의 ADR `0028`·`0029`·`0030`은 번호가 겹치므로 파일명과 링크를 보존한다.
프론트엔드 Terraform 절은 프론트엔드 ADR을, dashboard·EKS·기존 CDK 절은 해당 백엔드 ADR을 가리킨다.
인용할 때는 번호와 함께 범위·제목 또는 파일 링크를 사용하며, 전체 목록은 [ADR 인덱스](docs/adr/README.md)를 따른다.

**ADR 본문에서 타 레포 소스를 인용할 때는 행 번호 대신 함수·상수 이름으로 앵커한다**
(예: `sink_clickhouse.py` 의 `execute()`). 행 번호 정합은 검증할 방법이 없어 반드시 낡는다 —
ADR-0018·0019가 같은 이유로 두 번 낡았다. 기존 문서의 일괄 치환은 하지 않고, 손대는 문서부터 적용한다.

**이 레포가 소유한 계약 지점**: `config/otel-collector.yaml`은 **prod** ECS가 기동하는 collector 설정이다.
dev는 제품 수집용 OTel Collector를 배포하지 않고 `pulsemetry-backend/apps/telemetry-ingest`가 수집부터 적재까지 맡는다. ADR-0039(Proposed)의 `otel-platform`은 플랫폼 자체 trace만 받는 관측용 Collector이며 이 계약과 별개다.

---

### EKS 운영 규칙 (ADR-0028·0034·0035)

- CDK는 AWS 리소스, Helm은 Kubernetes 선언, Auto Mode는 노드 생성·교체를 소유한다.
- EKS 운영자 role은 CDK가 생성하며 계정 IAM이 운영자에게 대상 role의 `sts:AssumeRole`을 부여한다.
  role은 `eks:DescribeCluster`·전용 SSM 터널·AccessEntry 기반 Kubernetes 관리를 담당한다. 릴레이 EC2에는 EKS 권한이 없다.
- Secret 원문·Kubernetes Secret 복제 없이 ASCP/CSI/configtree를 사용한다. 고정 JWT/OIDC 버전과 명시적 재배포를 유지한다.
- archive prefix를 바꿀 때 S3 PutObject IAM과 generated workload 값을 함께 바꾼다. PROJ-248은 기존 prefix를 바꾸지 않는다.
- 설치·검증·복구는 [EKS 런북](docs/runbooks/dev-eks-manual-deployment.md)을 따른다. 과거 Canary 수치는 검증된 SLO가 아니다.

## 1. 이 레포는 무엇인가

AWS CDK v2 (TypeScript) 로 작성된 **단일 인프라 레포**다. MVP 관측성(observability) 플랫폼의 AWS 리소스를 정의한다.

```
dev:  AI Tool → ALB → telemetry-gateway → Strimzi Kafka → telemetry-ingest → S3 / ClickHouse
      사용자  → ALB → enrollment-api  → RDS PostgreSQL
prod: AI Tool → ALB → OTel Collector + post-processor → ClickHouse
      브라우저 → ALB → api-server + batch-processor → Aurora PostgreSQL
```

- ADR-0009에 따라 **인프라는 이 레포에서만 관리한다.** backend dev CI는 PROJ-249에서 이미지 build/push만 남긴다. prod CI의 기존
  `ecs update-service --force-new-deployment`는 유지하며 앱 CI가 `cdk deploy`를 유발하지 않는다.
  `lib/cicd/`의 배포 역할은 4개를 유지하지만 cleanup 뒤 `ai-telemetry-pipeline` dev 역할은 trust와 ARN
  output만 남고 permission은 0개다(ADR-0024·0026).
- 태스크 정의를 바꾸려면 **반드시 이 레포를 경유**해야 한다.
- 대상 region은 **`ap-northeast-2`**다. account는 `CDK_DEFAULT_ACCOUNT`에서만 주입하며 코드와 문서에 기록하지 않는다.
- **환경은 셋이다** — 운영(`lib/prod/`)과 개발(`lib/dev/`)이 **같은 계정·같은 리전**에 공존하고, 여기에 배포 역할만 담는 `lib/cicd/`가 더해진다. 진입점 `bin/infra.ts`는 `-c env=dev|prod|cicd` 컨텍스트 하나만 읽고 `synthProd()` / `synthDev()` / `synthCicd()`로 조립을 위임한다. **기본값은 `prod`**이므로 무인자 `cdk deploy`는 여전히 운영을 대상으로 한다. (ADR-0021, ADR-0022, ADR-0024)
- 설계 근거는 전부 `docs/adr/`에 있다. 코드와 ADR이 어긋나면 ADR이 기준이다.

---

## 2. 스택 구조와 의존 방향

앱 환경(prod/dev)마다 스택이 4개고, `cicd`는 1개다. 코드의 props 전달은
`lib/prod/app.ts`의 `synthProd()`, `lib/dev/app.ts`의 `synthDev()`, `lib/cicd/app.ts`의
`synthCicd()`에서 construct 참조를 넘기는 방식으로만 표현한다. 수동 `Fn::ImportValue`나 SSM 우회
참조를 새로 도입하지 않는다. **construct 생성·props 전달 순서와 합성 manifest의 실제 배포 의존은
같은 개념이 아니다.**

```
lib/
├── common/   환경 무관 계약 상수 + 순수 헬퍼 (config.ts, clickhouse-user-data.ts, deploy-targets.ts)
├── prod/     운영 4스택 + app.ts(synthProd) + config.ts
├── dev/      dev 4스택 + app.ts(synthDev) + config.ts
└── cicd/     DeployStack 1개 + app.ts(synthCicd) + config.ts
test/
├── prod/     운영 합성·계약 검증
├── dev/      EKS·Data·Edge·Network 및 입력 검증
├── cicd/     배포 역할·OIDC 검증
└── helpers.ts   buildApp() / buildDevApp() / buildCicdApp() / MODE_A_EDGE / TEST_ENV
```

폴더 간 의존 방향은 **`prod → common`, `dev → common`, `cicd → common` 단방향**이다 (ADR-0021 2번,
ADR-0024 1번). `cicd`도 `prod`·`dev` 어느 쪽도 import 하지 않는다.

prod의 일반 props 흐름은 아래와 같다.

```
NetworkStack ──> DataStack ──┐
     │                       ├──> ApplicationStack ──> EdgeStack
     └───────────────────────┘
```

dev는 Network → Data, Network/Data → Edge와 EKS의 방향이다. Application 스택은 생성하지 않는다.
기존 ECS 철거 때는 과거 Application의 물리 의존이 남으므로 [철거 런북](docs/runbooks/dev-ecs-retirement.md)의
Application 삭제 → Edge → Network 순서가 우선한다. weak 참조는 ENI/ALB/SG 의존을 없애지 않는다.

### 운영 스택 (prod)

| 스택 | 파일 | 주요 리소스 |
|---|---|---|
| `NetworkStack` | `lib/prod/network-stack.ts` | VPC (2 AZ × 3 티어 = 6 서브넷, NAT 1개), S3 Gateway Endpoint, **SG 5개 전부 + 모든 cross-SG 룰** |
| `DataStack` | `lib/prod/data-stack.ts` | Aurora Serverless v2 PostgreSQL 16.13 (`controlplane` DB, 0.5~2 ACU), Raw Signal S3 버킷 (30일 만료) |
| `ApplicationStack` | `lib/prod/application-stack.ts` | ECS 클러스터, Cloud Map `obs.local`, Fargate 서비스 2개, ClickHouse EC2 (t4g.small + ASG 캐패시티 프로바이더) |
| `EdgeStack` | `lib/prod/edge-stack.ts` | ALB (모드 A/B 분기), Cognito User Pool, CloudFront + 프론트엔드 S3 |

**서비스 구성** (ADR-0004: 태스크 단위 co-location)

| 태스크 | 컨테이너 | 비고 |
|---|---|---|
| `CollectorTask` (Fargate **ARM64**, 512/1024) | `otel-collector` (public image, :4318), `post-processor` (ECR) | |
| `DashboardTask` (Fargate **ARM64**, 512/2048) | `api-server` (ECR, :8080), `batch-processor` (ECR) | Spring Boot 고려. Fargate는 CPU/메모리 조합이 고정이라 512 CPU에는 1024/2048/3072/4096만 쓸 수 있다 (1536은 생성 실패) |
| `ClickhouseTask` (EC2, awsvpc) | `clickhouse` (public image **`:24.8-alpine` 고정**, :8123/:9000) | 호스트 볼륨 `/data/clickhouse` |

### dev 스택

스택 ID의 `Dev` 접두사는 prod와의 충돌 방지 경계다. 기존 스택 이름을 바꾸지 않는다.
현재 dev는 추적된 `config/dev/deployment.json`·`runtime.yaml`의 Strimzi·`network-removed` profile을 사용한다.
MSK 전용 subnet·SG를 현행으로 되살리지 않으며 SG 범위와 단계별 제거는 [Strimzi 런북](docs/runbooks/dev-strimzi-kafka.md)과 ADR-0049를 따른다.

| 스택 | 주요 리소스 |
|---|---|
| `DevNetworkStack` | VPC `10.1.0.0/16`, public 2 AZ·NAT 0·S3 endpoint, 현재 profile의 RDS·EKS·Strimzi·관측 관련 SG 및 cross-SG 규칙. `network-removed`는 MSK 전용 subnet·SG를 제외 |
| `DevDataStack` | 비공개 RDS PostgreSQL 16.13 `db.t4g.micro`·gp3 20GB, DB SSM relay·operator, Raw Signal S3 7일, 기본 Secret 11개 + OIDC key 수 |
| `DevEdgeStack` | 기존 EKS ALB·현재 profile의 TG·명시 path/method/OPTIONS·default 404·REGIONAL WAF/로그. 수집 경로의 ALB target은 Gateway |
| `DevEksStack` | Auto Mode cluster·node/operator/Pod Identity·SSM relay·로그·runtime output |

| workload | 실행 | 포트 / target |
|---|---|---|
| enrollment-api | Helm Deployment | 8080 / NodePort 30080 instance TG |
| telemetry-gateway | Helm Deployment | 8082 / NodePort 30082 instance TG. 공개 수집 요청을 받아 Strimzi Kafka로 전송 |
| telemetry-ingest | Helm Deployment | 4316 / 내부 ClusterIP, `kafka` 모드·TGB 없음. Strimzi Kafka를 소비해 S3/ClickHouse에 적재 |
| dashboard-api | Helm Deployment | 8081 / NodePort 30081 instance TG |
| clickhouse | Helm StatefulSet·독립 PVC | 8123 / 내부 ClusterIP·DB 릴레이에서 현재 Pod IP |

EKS API는 private 전용이다. SSM relay의 public IPv4는 NAT 없는 subnet의 SSM egress용이며
노드 직접 접속용이 아니다. Helm은 기존 generated YAML 순서를 유지하고 CDK는 OIDC 원본 key만 선언한다.

dev WAF는 ALB 전체에 적용한다. 국가·악성 IP·URI·헤더 Block, 정확한 OTLP 본문/rate Count·query Block,
등록 API 세 조건과 정확한 `/unix`·`/windows`의 공유 rate, 429/Retry-After, 로그 마스킹·sampling 비활성화와 14일 보존을 유지한다.
남는 앱 `Validation*` output은 EKS 주소/ARN이며 이름을 바꾸지 않는다. ClickHouse 공개 output은 ADR-0038로 제거한다. 인증서가 없으면 HTTP이고,
선택적 HTTPS도 인증서 도메인·공개 URL·manifest의 정합과 실제 E2E를 별도로 확인해야 한다.

### CI/CD 스택 (cicd)

| 스택 | 파일 | 주요 리소스 |
|---|---|---|
| `DeployStack` | `lib/cicd/deploy-stack.ts` | GitHub OIDC 공급자 1개(**RETAIN**), 기존 앱 역할 4개. ADR-0048 도입 후 infra 역할 2개와 ARN output을 추가해 총 6개 |

앱 인프라를 전혀 참조하지 않으므로 **언제든 따로 배포할 수 있다.** `cdk deploy --all`(무인자 = prod)은 이 스택을 앱 트리에 담지 않으므로 건드리지 않고, `-c env=cicd`로 `--all`을 돌려도 운영 4스택은 조립되지 않는다. IAM 변경과 앱 인프라 변경이 서로 다른 배포에 속하는 것이 이 분리의 목적이다 (ADR-0024 1번).

**prod ECS 클러스터/서비스의 물리 이름이 이 스택의 전제다.** 자동 생성 이름으로는 IAM 리소스 ARN을 좁힐 수도, 워크플로우가 `--cluster`/`--service`에 넣을 값을 알 수도 없다. 이름의 단일 출처는 `lib/common/deploy-targets.ts`다.

---

## 3. 반드시 지켜야 할 불변 규칙

아래는 "개선"처럼 보여서 되돌리기 쉽지만, 되돌리면 실제로 깨지는 것들이다. 바꾸려면 먼저 ADR을 쓴다.

| 규칙 | 왜 |
|---|---|
| **prod SG 5개와 dev SG 9개 및 모든 cross-SG 룰은 각 `NetworkStack`에만 정의한다** | SG 참조가 스택 내부 참조가 되어 스택 간 순환 의존을 원천 차단한다. 하류 스택은 props로 주입만 받는다. (`lib/prod/network-stack.ts`의 클래스 헤더 주석. `DevNetworkStack`이 같은 규칙을 그대로 계승한다 - ADR-0022 2번) |
| **ECR 레포를 CDK로 만들지 않는다** | `Repository.fromRepositoryName`으로 참조만 한다. CDK가 만들면 첫 배포에서 "이미지 없는 레포" → 태스크 기동 실패 → 롤백으로 레포까지 삭제되는 순환이 생긴다. (ADR-0007) |
| **ECR 레포 이름은 `soma-376/` 네임스페이스 아래에 둔다** | 네임스페이스는 `COMMON_TAGS.Org`와 같은 값이다. 비용 배분 태그 축과 레지스트리 경로를 같은 식별자로 정렬한다. ECR은 레포 이름 변경이 불가능해 사후 교정에 재생성 + 이미지 재push가 든다. (`lib/common/config.ts`의 `ECR_NAMESPACE`, ADR-0007) |
| **prod `batch-processor`는 `essential: false`** | 배치 실패가 같은 태스크의 api-server를 함께 내리면 안 된다. dev 최종 구성에는 두 컨테이너가 없다. (`lib/prod/application-stack.ts`, ADR-0004, ADR-0026) |
| **ClickHouse `Ec2Service`는 `minHealthyPercent: 0` / `maxHealthyPercent: 100`** | 인스턴스 1대 + awsvpc ENI 한도상 롤링 배포가 불가능하다. 강제 교체 배포만 가능하다. (`lib/prod/application-stack.ts`, dev ECS는 ADR-0035로 제거됨) |
| **`AsgCapacityProvider`의 `enableManagedTerminationProtection: false`** | 단일 인스턴스 교체 배포를 관리형 종료 보호가 막는다. (`lib/prod/application-stack.ts`; dev ASG는 ADR-0035로 제거됨) |
| **DB 시크릿은 참조만 노출한다** | `data.dbSecret`(`ISecret`)을 넘길 뿐, **합성 시점에 값을 평문으로 읽는 코드**는 절대 넣지 않는다. 컨테이너에는 `Secret.fromSecretsManager`로 주입한다. **prod의 예외는 `DataStack`의 `PostProcessorPgDsn` 파생 시크릿 하나뿐이며**, 거기서도 `unsafeUnwrap()`이 돌려주는 건 평문이 아니라 `{{resolve:secretsmanager:...}}` 동적 참조 토큰이다(합성 산출물은 `Fn::Join` + `Ref`뿐). 새 예외를 만들려면 ADR-0018을 먼저 갱신한다. dev는 파생 Secret 없이 마스터 Secret의 필드를 ASCP/CSI/configtree로 공급한다. (`lib/prod/data-stack.ts`, ADR-0018, ADR-0026) |
| **`post-processor`의 환경변수 이름은 앱 소스가 권위다** | 앱은 `ENRICHMENT_CH_URL` / `ENRICHMENT_CH_DB` / `ENRICHMENT_PG_DSN` **세 개만** 읽는다 (`ai-telemetry-pipeline`의 `apps/telemetry-processor/enrichment/sink_clickhouse.py`, `apps/telemetry-processor/enrichment/providers/org.py`의 `OrgProvider`). 이름이 틀리면 CH 두 개는 예외 없이 compose 전용 기본값으로 **조용히 폴백**하고(ECS에서는 DNS가 안 풀려 모든 insert가 `BackendUnavailable` → HTTP 503), `ENRICHMENT_PG_DSN`은 기본값이 빈 문자열이라 **조회 시점의 즉시 연결 실패**다(장애 증상이 다르다 — ADR-0018). **synth도 테스트도 배포도 전부 통과한다** — 인프라 테스트는 "앱이 그 이름을 읽는가"를 원리적으로 검증할 수 없다. 죽은 계약(`CLICKHOUSE_HOST`·`DB_CREDS`·`DB_NAME`)을 다시 넣지 않는다. **이 계약은 prod에만 남는다.** dev는 telemetry-ingest의 `PULSEMETRY_*` 계약을 쓴다. (`lib/common/config.ts`의 `ENRICHMENT_ENV`, ADR-0018, ADR-0026) |
| **dev `enrollment-api`와 `telemetry-ingest`는 각 앱의 `PULSEMETRY_*` 계약을 따른다** | RDS 마스터 Secret의 `username`/`password`와 공유 token hash는 두 앱에 각각 `PULSEMETRY_DB_USERNAME` / `PULSEMETRY_DB_PASSWORD` / `PULSEMETRY_TOKEN_HASH_SECRET`으로 넣는다. 관리자 Secret의 JSON `token`은 enrollment-api에만 `PULSEMETRY_ADMIN_API_TOKEN`으로 넣고 telemetry-ingest에는 주입하지 않는다. dev는 ASCP/CSI/configtree를 사용하며 `DB_CREDS`/`DB_NAME`을 되살리거나 토큰 값을 `environment`/`CfnOutput`에 넣지 않는다. (backend `application.yaml`, ADR-0026) |
| **ClickHouse 컨테이너의 `CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT: '1'`과 고정 태그를 지우지 않는다** | 이미지 entrypoint는 `CLICKHOUSE_USER`/`CLICKHOUSE_PASSWORD`/`CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT`가 전부 비면 `default` 유저를 루프백 전용으로 잠근다. 그러면 prod `post-processor`와 dev `telemetry-ingest`의 적재가 인증 실패한다. 비밀번호 없는 default user의 접근 통제는 `clickhouseSecurityGroup`이 담당하며 이미지 태그 `:24.8-alpine`을 고정한다. (`lib/common/config.ts`, ADR-0019) |
| **Aurora 자동 생성 비밀번호의 `ExcludeCharacters`와 따옴표 없는 libpq DSN은 한 몸이다** | `buildLibpqDsn()`은 값을 따옴표로 감싸지 않는다 — 합성 시점에 user/password는 토큰이라 감쌀 방법이 없다. aws-rds의 `DEFAULT_PASSWORD_EXCLUDE_CHARS`가 공백·`'`·`"`·`\` 넷을 전부 빼주기 때문에만 성립하는 **우연한 커플링**이다. 깨지면 배포는 성공하고 `post-processor`만 런타임에 죽는다. 그 상수는 공개 export가 아니므로 `test/prod/data-stack.test.ts`가 **합성 템플릿의 `ExcludeCharacters`** 로 고정한다. dev 앱은 파생 libpq DSN을 만들지 않지만 DatabaseInstance의 생성 비밀번호 제한은 합성 테스트로 별도 고정한다. (ADR-0018, ADR-0022 7번) |
| **prod `batch-processor` 계약과 `post-processor`의 `RAW_BUCKET`은 건드리지 않는다** | 두 컨테이너는 prod에 남는다. `batch-processor` 대응 모듈은 없어 계약을 추정하지 않고, `RAW_BUCKET`은 ADR-0017의 `awss3` exporter 전환용 권한과 함께 유지한다. dev cleanup을 이유로 prod 상수나 권한을 삭제하지 않는다. (ADR-0018, ADR-0026) |
| **prod Fargate 태스크와 dev 앱 이미지는 ARM64로 고정한다** | `runtimePlatform`을 빼면 CDK 기본값(미지정)으로 돌아가 x86_64가 된다. 앱 레포도 반드시 `linux/arm64` 이미지를 push해야 하며, amd64를 올리면 synth와 테스트는 통과하지만 런타임에 이미지 pull이 실패한다. ClickHouse EC2(t4g)와 아키텍처를 맞추고 x86 대비 약 20% 저렴하다. dev EKS NodePool도 ARM64이므로 `linux/arm64` 요구를 유지한다. (`lib/prod/application-stack.ts`의 `FARGATE_RUNTIME_PLATFORM`, ADR-0015) |
| **prod Collector 설정은 `config/otel-collector.yaml`에만 둔다** | synth 시점에 파일을 읽어 `OTEL_CONFIG` 환경변수로 주입하고 `--config=env:OTEL_CONFIG`로 기동한다. 파일 경로·환경변수 이름·`command` 세 가지는 한 몸이라 함께 바꿔야 한다. **이 값은 CFN 템플릿과 ECS 콘솔에 평문으로 남으므로 시크릿을 넣으면 안 된다.** dev 최종 구성은 Collector를 실행하지 않지만 prod 파일은 삭제하지 않는다. (`lib/prod/application-stack.ts`의 `COLLECTOR_CONFIG_PATH`, ADR-0017, ADR-0026) |
| **prod `otel-collector` 컨테이너는 root(`user: '0'`)로 돈다** | 이미지가 `User=10001:10001`인데 UID 10001이 쓸 수 있는 디렉터리가 하나도 없다(scratch 기반이라 `/tmp`도 없다). `file/*` exporter가 `/data`를 만들려면 root가 필요하다. 빼면 `mkdir /data: permission denied`로 기동 직후 exit 1이다. **file exporter와 `user: '0'`은 한 몸이라 함께 없애야 한다** — 이 커플링은 `test/prod/application-stack.test.ts`가 고정한다. `awss3` exporter로 옮기면 root가 필요 없어진다. (ADR-0017) |
| **prod Collector config는 배포 전 실제로 기동해 봐야 한다** | `cdk synth`·`npm test`는 config를 문자열로만 다루고, `otelcol-contrib validate`조차 컴포넌트를 **해석만** 하고 start하지 않아 파일시스템·권한 실패를 못 잡는다. 최초 배포가 정확히 이 틈으로 빠져나가 죽었다. 관문은 `docker run -d --user 0:0 -e OTEL_CONFIG="$(cat config/otel-collector.yaml)" ... --config=env:OTEL_CONFIG` 후 로그에 `Everything is ready`가 뜨는지 확인하는 것이다. **정리는 컨테이너 ID를 지목한다. `--filter ancestor=...`를 쓰면 같은 이미지를 쓰는 로컬 개발 컨테이너까지 지운다.** (ADR-0017) |
| **DB 이름은 PostgreSQL 키워드 표에 없는 단어여야 한다** | RDS는 `DatabaseName`에 엔진 예약어 검사를 걸고, 그 목록이 PostgreSQL의 reserved 키워드보다 넓다. 실제로 `control`은 non-reserved인데도 400으로 거부됐다. 되돌리면 배포가 통째로 실패한다. (`lib/common/config.ts`의 `CONTROL_DB_NAME` - dev RDS도 같은 상수를 쓴다, ADR-0012) |
| **`maxAzs: 2`는 이중화가 아니라 의도된 하한이다** | 진짜 단일 AZ는 Aurora `DatabaseCluster`(서브넷 ≥2 요구)와 internet-facing ALB(퍼블릭 서브넷 2개 요구)가 막는다. 컴퓨트/데이터는 여전히 사실상 단일 AZ다. (`lib/prod/network-stack.ts:35-36`. dev도 같은 이유로 `maxAzs: 2`다 - internet-facing ALB와 RDS DB subnet group이 각각 2 AZ를 요구한다) |
| **`RemovalPolicy.DESTROY` / `autoDeleteObjects`는 MVP 한정 의도다** | 실수가 아니다. 프로덕션 전환 시 일괄 재검토 대상이므로, 개별적으로 `RETAIN`으로 바꾸지 말고 ADR로 묶어서 처리한다. 신규 dashboard DB·JWT 원본 6개의 `RETAIN`은 ADR-0031이 정한 예외이며 기존 리소스 정책은 바꾸지 않는다. |
| **ECS 클러스터/서비스 이름의 단일 출처는 `lib/common/deploy-targets.ts`다** | 이 값은 앱 레포 워크플로와의 계약이자 `DeployStack`이 IAM 서비스 ARN을 조립하는 조각이다. **CloudFormation은 IAM 정책에 적힌 리소스 ARN의 실존을 검증하지 않으므로**, 한쪽만 고치면 네 스택이 전부 배포에 성공하고 GitHub Actions만 `AccessDenied`로 죽는다. `test/cicd/deploy-stack.test.ts`의 크로스 스택 어서션이 유일한 방어선이다. 이름 변경은 클러스터·서비스 **교체**를 유발하므로 6장 런북을 따른다. (ADR-0024 6번) |
| **신뢰 정책의 `sub`는 immutable ID와 지정 실행 경계까지 완전 일치시킨다** | 앱 역할은 기존 branch를, ADR-0048의 infra 역할은 지정 Environment를 완전 일치시킨다. Environment subject는 branch를 포함하지 않으므로 GitHub branch·reviewer 보호가 필수다. name-only 또는 `StringLike` + `*`로 넓히지 않는다. 기존 앱 역할의 `GITHUB_ORG`/`GITHUB_REPOS`와 `StringEquals` 조건은 유지한다. (`lib/cicd/config.ts`, ADR-0024·0048) |
| **배포 역할에 `iam:PassRole` / `ecs:RegisterTaskDefinition`을 주지 않는다** | `--force-new-deployment`는 기존 태스크 정의 리비전을 그대로 재사용하므로 둘 다 필요 없다. 주는 순간 CI가 태스크 정의를 갈아끼우고 임의 역할을 붙일 수 있어 계정 안에서 사실상 권한 상승 경로가 되고, ADR-0009(태스크 정의는 이 레포 경유)도 무너진다. (ADR-0024 5번) |
| **prod 파이프라인 역할에 dev 전용 또는 제거된 서비스를 넣지 않는다** | prod 역할은 현재 prod `collector`만 대상으로 한다. dev에서 제거된 auth-proxy 이름을 prod 계약에 추가하지 않는다. |
| **GitHub OIDC 공급자는 계정당 1개이고 `RETAIN`이다** | URL당 하나만 존재할 수 있어 이미 있는 계정에서 새로 만들면 `EntityAlreadyExists`로 스택이 통째로 롤백된다. 배포 전에 `aws iam list-open-id-connect-providers`로 확인하고, 있으면 `-c githubOidcProviderArn=<arn>`으로 참조 모드를 쓴다. `RETAIN`이므로 `DeployStack`을 destroy한 뒤 재배포할 때도 이 키가 필요하다. **`thumbprints`는 주지 않는다** — 지문을 박아 두면 GitHub 인증서 회전 시 인프라는 멀쩡한 채 Actions만 죽는다. (ADR-0024 3번) |
| **IAM `Description`은 영문으로 쓴다** | 이 레포는 주석과 문서를 한국어로 쓰지만 IAM의 `Description`은 Latin-1 밖의 문자를 거부한다. 한국어를 넣으면 `cdk synth`는 경고만 내고 통과한 뒤 `cdk deploy`가 실패한다. (`lib/cicd/deploy-stack.ts`) |

### dev 환경 전용 규칙

| 규칙 | 이유 |
|---|---|
| `lib/prod/`와 `lib/dev/` 상호 import 금지 | common 방향 의존만 유지 |
| Network가 사용자 정의 SG 9개와 모든 cross-SG 규칙 소유 | 순환 참조·하류의 자동 SG 변경 방지 |
| EKS 앱 ALB/TG·WAF·기존 relay·Data 논리 ID 보존 | ECS 제거에 무관한 리소스 교체 방지. PROJ-254의 RDS 공개 flag·DB 규칙·ClickHouse TG 삭제는 ADR-0038에 따름 |
| Data Secret 기본 11개·Grafana Secret 1개·OIDC key별 원본 수명 보존 | 기존 원본·Retain·고정 ARN과 실제 값은 런타임 수명과 별개 |
| OIDC client 전체 key 집합을 명시 | 입력 누락으로 원본 관리·output·IAM이 사라지는 것을 방지 |
| enrollment는 JWT 두 원본, dashboard는 공개키만, ingest는 JWT 권한 없음 | 최소 권한 유지 |
| JWT 키 일반 배포 시 재생성 금지 | verifier → signer → 마지막 구 발급 후 330초 → 구 공개키 제거 |
| enrollment·ingest는 기존 token hash 원본 공유 | 발급과 검증의 HMAC 일치 |
| `open:false`·명시 경로/method/OPTIONS·default 404 유지 | CIDR 우회 및 임의 public health 노출 방지 |
| dev WAF 내용 검사와 등록 rate 범위를 분리 | 등록 API 세 조건과 정확한 `/unix`·`/windows`만 300건 예산 공유; `/api/v1/*` 전체로 확대하지 않음 |
| CDK/Helm/Auto Mode 소유권 분리 | 기존 EKS TG만 TGB에 연결하고 AWS 리소스는 CDK가 소유 |
| 새 설정은 비밀 원문 없는 입력만 허용 | Secret 원문은 synth/output/values/context에 넣지 않음 |
| `bin/infra.ts`와 test helper는 synthDev로 조립 | CLI와 테스트의 배포 트리 불일치 방지 |
| dev JVM의 임시 `blocked.certs`는 앱 release별 ConfigMap과 단일 파일 mount로 공급 | ADR-0036. 앱 컨테이너에만 읽기 전용으로 마운트하고 내용 checksum으로 Pod를 재생성한다. 기존 Secret/JWT mount·init 검증을 유지하며 security 디렉터리 전체를 가리지 않는다. 패치 이미지 자체의 차단 목록을 검증한 뒤 임시 공급을 제거한다. |

## 4. 설정과 환경 분기

- 계정·리전은 `CDK_DEFAULT_ACCOUNT` / `CDK_DEFAULT_REGION`에서 주입한다. 계정별 `cdk.context.json`은 commit하지 않는다.
- 태그는 prod `Env=mvp`, dev `Env=dev`, cicd `Env=cicd`를 유지한다. 환경 선택 기본값은 prod다.
- 공통 상수는 common, 환경 고유값은 해당 환경 폴더에 둔다. prod ECS 이름과 CI 대상은 `lib/common/deploy-targets.ts`가 소유한다.

| 환경 | 키 | 기본값 / 의미 |
|---|---|---|
| prod | `edgeMode`, `certificateArn`, `customDomain` | 기존 모드 A/B와 외부 TLS 입력 유지 |
| dev | `devOidcClientKeys` | 필수 배열; CLI JSON 배열 문자열. 없으면 명시적 `[]` |
| dev | `devEksEnabled` | 생략/true만 허용. false 거부 |
| dev | `devAllowedCidr` | `0.0.0.0/0`; 앱 ALB 80/선택적 443 ingress. DB에는 적용하지 않음 |
| dev | `devEksCertificateArn` | 선택적 EKS ALB 외부 ACM ARN |
| dev | `devHttpRedirectEnabled` | true; 인증서가 있을 때 별도 HTTP 301 listener |
| dev | `devEksArchivePrefix` | `eks_validation`; `eks`도 지원. 기존 배포 값 유지 |
| cicd | `githubOidcProviderArn` | 기존 provider 참조; 미지정 시 생성하고 RETAIN |

폐기 입력 `devDashboardRuntimeFile`·`devImageTag`·`devAppAsgMaxCapacity`·`devCertificateArn`·
`devEksApiAllowedCidrs`는 모든 입력 출처에서 지운다. 존재하면 합성을 거부한다.

CDK는 OIDC Secret 원본 key 목록과 AWS ARN·endpoint·TG·NodePort를 소유한다. EKS 앱 설정은
`--runtime-values` YAML의 `userAuth`·`dashboard`·선택적 `oidc`를 generator에만 전달한다.
Helm 입력은 정적 workload YAML → generated 앱 YAML이며 runtime release에는 generated/runtime.yaml을 쓴다.
`writerImage`·ARN/endpoint override·Secret 원문은 runtime YAML에서 허용하지 않는다.

backend-dev IAM은 enrollment/ingest/dashboard ECR 공급만 허용한다. ECS 검사/업데이트 제거는 PROJ-249에
인계하며 실제 철거 전에 완료해야 한다. pipeline-dev 권한 0개, 기존 앱 역할 4개·trust·output과 prod 역할은 유지한다.
앱 CI에 CDK/Helm·task definition 등록·PassRole을 추가하지 않는다.

## 5. 지금 남은 작업

### (A) 도메인 / ACM 인증서 확보 — prod 모드 A와 dev TLS 실환경 적용 `미결`

`docs/adr/0008-dual-auth-alb-cognito-and-otlp-token.md`

- **ADR-0008 은 허브 ADR 0001 로 대체됐다(`Superseded by`, PROJ-79).** ALB 단 인증
  (`authenticate-cognito`·`jwt-validation`)은 양 경로 모두 채택하지 않는다 — ALB 는 TLS 종단만 담당하고,
  토큰 인증은 앱 계층이 한다(dev는 telemetry-ingest Spring Security, prod 전환은 별도 작업이며 Cognito와 무관).
  모드 A/모드 B 의 현행 정의는 **TLS 종단 유무**다(ADR-0008 의 "대체 후의 모드 정의" 블록).
- 남은 미결은 **도메인·ACM 인증서 확보(TLS 종단)** 하나다. 확보 시 순서:
  1. DNS를 Route 53에서 관리할지 외부 DNS 공급자를 유지할지 결정하고, ALB에 연결할 도메인을 확정한다.
  2. `ap-northeast-2`에서 ACM 인증서를 발급·검증하고, DNS에 ALB Alias/CNAME 레코드를 만든다.
  3. `certificateArn`, `domainName` context 값을 확정하고 모드 A로 배포해 HTTP→HTTPS 리다이렉트를
     확인한 뒤 배포 런북에 기록한다.
- dev 외부 ACM 연결 코드는 PROJ-238·ADR-0033으로 추가됐다. prod `certificateArn`과 dev의
  `devEksCertificateArn`이 현재 dev 입력이다. `devCertificateArn`은 ADR-0035로 제거됐다. dev 실제 인증서·DNS·공개 URL 준비와
  두 단계 적용·복구는 [dev HTTPS 런북](docs/runbooks/dev-alb-https.md)을 따른다.
- `lib/prod/edge-stack.ts` 의 Cognito 구축 코드(User Pool·`AuthenticateCognitoAction`·`authenticateJwt`)는
  **의도적 잔존**이다 — Spring Security 이관 시 함께 걷어낸다. 결함으로 오독하지 않는다.

### (B) ADR-0009 — 스택 경계 확정 — **완료 (`Accepted`)**

`docs/adr/0009-single-infra-repo-stack-boundary.md`

- PROJ-79에서 `Accepted`로 전환했다. prod의 단일 `ApplicationStack` 경계는 유지한다. dev는 ADR-0035에서 Application을 제거하고 EKS를 사용한다.
- Revisit Trigger 둘 — "앱 팀의 인프라 레포 수정 부담이 실제 병목이 되면 스택 분리",
  그리고 "backend로 수집 파이프라인을 이관하면 ADR-0017의 Collector config 소유권 재검토"다.
  허브 ADR 0004·0005가 Accepted가 되어 dev는 ADR-0026으로 Collector를 제거했다. prod의 ADR-0017 계약은 별도 전환 결정 전까지 유지한다.

### (C) ADR-0012 — 컨트롤 플레인 DB 엔진으로 PostgreSQL 검토 `Proposed`

`docs/adr/0012-aurora-postgresql-for-control-plane.md`

- 현재 유력 후보는 PostgreSQL이다. 엔진 수준의 멀티 테넌시 격리에 RLS를 활용할 가능성과 JSONB·전문 검색 등에 GIN을 활용할 가능성이 주요 근거다.
- 둘 다 실제 컨트롤 플레인 스키마와 쿼리로 검증되지 않았다. shared schema 여부, tenant context 전달 방식, GIN 대상 컬럼과 쿼리를 먼저 확정해야 한다.
- Aurora MySQL, RDS PostgreSQL, DynamoDB, ClickHouse 통합 대안과 비교해야 한다.
- 멘토의 MySQL 경험과 Microsoft SQL Server DBA 전문성은 서로 다른 후보에 활용할 수 있다. 팀원 중 한 명에게 PostgreSQL 프로젝트 경험이 없다는 점까지 포함해 학습 계획과 운영 책임자를 정해야 한다.
- 같은 Spring Data JPA 대표 워크플로를 PostgreSQL과 MySQL에서 비교하고 RLS connection pool 격리와 GIN 실행계획을 검증한 뒤 `Accepted` 전환 여부를 결정한다.
- 이 ADR은 DB 엔진 선택과 마이너 버전 고정만 다룬다. 버전은 16 계열의 최신 마이너(`VER_16_13`)로 고정하고 `autoMinorVersionUpgrade` 기본값 `true`를 유지하기로 ADR-0012 안에서 결정했다. Aurora Serverless v2, `0.5~2 ACU`, `RemovalPolicy.DESTROY`의 근거는 별도 결정으로 남아 있다.

### (D) DB 자격 증명 분리 설계

prod `post-processor`와 `api-server`, dev EKS `telemetry-ingest`와 `enrollment-api`에는 각 환경 PostgreSQL master secret이 공급된다. 이는 운영용 최종 설계가 아니며, master credential은 DB 초기화와 관리 작업에만 제한하는 것을 목표로 한다.

dashboard의 네 연결은 ADR-0031에 따라 별도 `username`·자동 생성 `password` Secret을 정의한다.
운영자가 그 값으로 DB 계정·권한을 수동 적용하며 이번 코드가 DB 사용자를 생성하거나 기존 앱 계정을 전환하지 않는다.
후속 연결·DDL 순서는 [공통 준비 런북](docs/runbooks/dev-dashboard-prerequisites.md)을 따른다.

**`enrollment` 스키마의 부트스트랩 주체는 backend Flyway로 확정됐다**(backend ADR 0009 —
주체는 더 이상 이 ADR의 결정 대상이 아니다). 현재 dev 구현에서는 enrollment-api가 시작할 때
Flyway를 실행하고 telemetry-ingest는 Flyway를 비활성화한다. EKS 수동 배포에서도 enrollment-api를 먼저
배포해 Ready와 migration 결과를 확인한 뒤 telemetry-ingest를 배포한다. PROJ-249는 이미지 공급 workflow만 정리한다.
앞으로 결정할 범위는 **prod에서 마이그레이션을 실행할 자리**와 DB 자격 증명 분리다.

구현을 변경하기 전에 다음 항목을 새 ADR로 결정해야 한다.

- prod 마이그레이션 실행 자리: one-off ECS task, 애플리케이션 시작 시 Flyway 등 (수동 `psql`은 제외 — 쓰지 않기로 확정)
- master, migration, runtime DB user의 권한과 수명주기
- runtime DB user를 서비스별로 분리할지 공유할지
- secret rotation과 ECS 재배포 및 마이그레이션 실행을 조정하는 방식

위 결정이 끝나기 전에는 현재 master secret 주입 방식을 운영 환경의 확정 구성으로 간주하지 않는다.

ADR-0018이 `post-processor`용 파생 DSN 시크릿을 도입했지만, **그 DSN 안에 든 것은 여전히 마스터 자격 증명이다.** 실질적인 권한 축소가 아니라 주입 형식의 정합화일 뿐이다. 또한 파생 시크릿은 `cdk deploy` 시점의 스냅샷이라 마스터 시크릿이 회전해도 자동 갱신되지 않는다(회전은 현재 설정하지 않았다). 따라서 이 항목의 ADR은 runtime DB user 분리와 함께 **파생 시크릿의 재생성·회전 방식까지** 결정해야 한다. 회전을 켜는 순간 파생 시크릿 방식은 "앱이 `DB_CREDS` JSON을 파싱"으로 교체해야 한다.

### (E) ADR-0014 — MVP ClickHouse 전용 subnet 분리 보류 `Proposed`

`docs/adr/0014-keep-clickhouse-in-app-subnet-for-mvp.md`

- 현재 ClickHouse ASG와 ECS 서비스는 primary AZ의 app subnet을 사용하고,
  전용 보안 그룹이 prod Collector/Dashboard와 dev app host의 8123/9000 접근만 허용한다.
- 같은 NAT Gateway와 기본 Network ACL을 사용하는 별도 private subnet은
  MVP에서 즉시 얻는 격리 효과가 제한적이므로 현재 구성을 유지하는 안이다.
- 팀 합의 후 `Accepted`로 전환한다. 전용 egress, Network ACL, VPC endpoint,
  IP 용량 또는 규제상 경계가 필요하면 전용 subnet을 다시 검토한다.
- subnet 이동은 ClickHouse EC2 교체와 로컬 EBS 데이터 유실 가능성이 있으므로,
  전환 시 최근 Raw Signal 재처리와 배포 절차를 함께 준비해야 한다.

### (F) 기존 CDK 로그 그룹 정책 기록 (후속 ADR 미정)

[프론트엔드 ADR 0020](docs/adr/0020-frontend-log-retention-policy.md)은 새 프론트엔드 Terraform 로그의
dev 14일/prod 30일 보존과 삭제 시 유지 정책을 결정했다. 아래 기존 CDK 정책은 별도의 후속 ADR 대상이며 번호는 아직 정하지 않았다.

현재 prod `ApplicationStack`은 컨테이너별 CloudWatch Logs 로그 그룹 5개를 만들고,
보존 기간을 14일, 삭제 정책을 `RemovalPolicy.DESTROY`로 설정한다. 이 구성은
구현되어 있지만 운영·비용·보안 관점의 결정 근거가 ADR에 없다.

**과거 `DevApplicationStack`은 ECS 로그에 같은 정책(14일, `RemovalPolicy.DESTROY`)을 썼다. ADR-0035 철거 시 해당 로그도 삭제된다.** ADR-0022 10번의 기존 ADR-0020 예약 참조는 이 미결 검토를 가리킨다.
현재 프론트엔드 ADR-0020이 기존 CDK 정책까지 확정한 것은 아니며, 아래 항목을 정할 때 **환경별 차등 여부**도 함께 결정한다.

이 로그 그룹 정책을 변경하기 전에 별도의 후속 ADR에서 다음 항목을 결정한다.

- 컨테이너별 로그 그룹을 유지할지 서비스 단위로 통합할지와 로그 그룹 명명 규칙
- 14일 보존 기간의 트래픽·장애 조사·비용 근거와 환경별 보존 기간 필요 여부
- MVP의 `RemovalPolicy.DESTROY`를 프로덕션에서도 유지할지와 전환 조건
- AWS 관리형 암호화 또는 customer managed KMS key 사용 여부와 로그 접근 권한
- 장기 보관·감사 요구가 생길 때 S3 등으로 내보내는 방식과 알람·운영 조회 책임
- 비용 또는 규제 요구가 바뀔 때 정책을 재검토할 조건

ADR이 확정되기 전에는 현재 로그 그룹 구성을 운영 환경의 최종 정책으로 간주하지 않는다.

### (G) 인프라 코드를 추가/수정할 때의 순서

1. 기존 ADR에 걸리는지 먼저 확인한다. 걸리면 **코드보다 ADR을 먼저** 처리한다.
2. 새 결정이면 ADR을 **먼저** 쓰고 `docs/adr/README.md` 인덱스 표에 추가한다. 번호는 다음 미사용 번호(**`0049`**)를 쓴다. `0018`·`0019`는 런타임 계약, `0021`은 dev/prod 환경 분리, `0022`는 dev 인프라 토폴로지, `0023`은 dev auth-proxy(ADR-0026으로 대체), `0024`는 배포 역할과 ECS 물리 이름, `0025`는 dev ALB deregistration delay, `0026`은 dev 백엔드 3서비스 전환, `0027`은 dev ALB WAF, `0028`은 EKS Auto Mode, `0029`는 dashboard ECS/EKS 배포, `0030`은 dev 사용자 JWT 키 공급, `0031`은 dashboard·JWT Secret 원본 CDK 소유, `0032`는 OIDC client secret ECS/EKS 공급, `0033`은 외부 ACM 기반 dev HTTPS, `0034`는 dev EKS SSM 릴레이 접근, `0035`는 MSK 배치와 dev EKS 전용 전환, `0036`은 telemetry Gateway·MSK IAM과 임시 blocked.certs 공급, `0037`은 관측 구성, `0038`은 dev DB 비공개 접근, `0039`는 Loki·Tempo·플랫폼 trace(Proposed), `0040`은 dev 공개 origin 영속화, `0041`은 dashboard 조회 권한 복구, `0042`는 프론트 관측 EC2, `0043`은 dev SES 초대 메일, `0044`는 정상 CLI OIDC loopback의 두 query label 예외, `0045`는 CLI token 교환의 두 Body label 예외, `0046`은 승인 태그 SES 수신 identity 권한, `0047`은 실제 진단 후 고정 발신 주소 SES identity 권한, `0048`은 dev CloudFormation CI/CD로 이미 쓰였다. `0020`은 프론트엔드 로그 정책이며, 프론트엔드 `0028`·`0029`·`0030`은 각각 Terraform 실행 환경·외부 DNS와 기존 인증서·독립 기반 상태를 다룬다. 중복 번호는 [ADR 인덱스](docs/adr/README.md)의 제목과 파일 링크로 구분하고, 기존 CDK 로그 정책 미결 사항은 위 (F)를 따른다.
   형식은 `docs/adr/0000-adr-template.md`를 따른다.
3. 상수는 **"이 값이 dev에서 달라야 할 이유가 있는가"**로 위치를 정한다 — 없으면 `lib/common/config.ts`, 운영 전용이면 `lib/prod/config.ts`, dev 전용이면 `lib/dev/config.ts`. 스택에서는 import만 한다 (4장).
4. `test/prod/*.test.ts` / `test/dev/*.test.ts` / `test/cicd/*.test.ts`에 template assertion을 추가한다. 픽스처는 `test/helpers.ts`의 `buildApp()` / `MODE_A_EDGE`(prod), `buildDevApp()`(dev), `buildCicdApp()`(cicd)를 재사용한다.
5. `npm test && npx cdk synth --all && npx cdk synth --all -c env=dev -c 'devOidcClientKeys=[]' && npx cdk synth --all -c env=cicd` 통과를 확인한다.

### (H) 알려진 잔여 이슈 (여유가 있으면)

- dev 배포 입력 PR CI는 fixture 계정으로 dev 테스트·values/Helm 전달·공식 synth를 검사한다. 전체 prod/cicd와
  관측 도구를 포함한 전체 테스트 CI는 별도다. DeployStack은 앱 레포 배포 권한이며 infra 검증 CI가 아니다.
- `.DS_Store`가 루트, `.github/`, `docs/`에 남아 있다.
- PROJ-254·ADR-0038은 DB 공개 경로를 제거한다. `devAllowedCidr=0.0.0.0/0`의 앱 ALB 공개 경고는 유지한다. 실제 AWS 차단·DB 릴레이 접속·앱 연결은 별도 검증한다.
- dev RDS와 prod Aurora 모두 `StorageEncrypted`를 명시하지 않는다. prod 전환 때 removal policy와 함께 검토한다.
- `/app/binaries`의 실제 설치 파일 공급은 이 레포 범위가 아니다. URL과 rule만 있어도 설치 E2E는 완료되지 않는다.
- PROJ-238은 dev HTTPS listener와 외부 ACM 참조를 로컬 구현한다. 실제 인증서·도메인·DNS·공개 URL·manifest 정합과 원격 OTLP E2E는 미완료이며 backend·telemetryctl·Schema 계약을 HTTP 허용으로 낮추지 않는다.

### (I) ADR-0026 dev 백엔드 전환의 역사적 기록

아래 수치·명령은 PROJ-144 당시 기록이며 현재 실행 절차가 아니다. 현행은 ADR-0035와 철거 런북을 따른다.

- 최종 문서 상태는 `telemetry-ingest`, `enrollment-api`, `clickhouse` 세 서비스와 앱 SG 4개, 실제 Secret 3개다. prod는 불변이다.
- PROJ-143 라우팅은 `6c11f19`에서 전체 279 tests, PROJ-144 detach는 `f08c207`에서 전체 280 tests로
  로컬 검증됐다. 두 단계 모두 AWS에는 배포하지 않았으며 live target health와 service event는 미확인이다.
- PROJ-144 delete는 `d45df19`에서 전체 254 tests, build와 prod mode A/B·dev·cicd fixture synth를
  통과했다. prod template/IAM과 기존 cluster·ALB·RDS·Raw Signal bucket·실제 Secret·ClickHouse
  properties는 기준선과 같고, ApplicationStack의 cross-stack reference 31개는 detach producer output과
  이름·값이 일치한다. 이 역시 로컬 합성 증거이며 AWS 배포 증거가 아니다.
- HTTP ALB에서는 인증 실패/성공, S3 PUT, ClickHouse insert, enrollment/bootstrap을 각각 검증한다. CLI enrollment → manifest → OTLP forward는 HTTPS 선행 과제 전에는 완료할 수 없다.
- PROJ-144는 먼저 구 세 서비스의 `AWS::ECS::Service.LoadBalancers: []`를 L1 override로 합성해 binding만 분리하고 구 target group을 유지한다. test가 정확한 빈 배열을 고정한다.
- 삭제 commit 배포 전에는 detach 배포 완료, 구 binding 부재, 새 target group·ALB DNS·DB 실제 Secret·S3 output 존재를 확인한다. `DevApplicationStack --exclusively`로 구 service/task를 먼저 제거하고 구 task/ENI/SG 미사용을 읽기 확인한 뒤 dev `--all`, 마지막 cicd 권한 회수 순서로 배포한다. weak reference는 물리 ECS/ENI/SG 종속성을 없애지 않는다.
- pipeline-dev 역할은 trust와 ARN output을 유지하며 ECR login을 포함한 permission statement가 0개다. 역할 삭제는 PROJ-106에서 결정한다.
- `config/otel-collector.yaml`, `ENRICHMENT_ENV`, prod ECR 상수와 prod 파생 DSN은 삭제하지 않는다.
- 로컬 구현은 `buildTelemetryIngestService()`·`buildEnrollmentApiService()`·`buildClickhouseService()`, dev SG construct 4개, 실제 Secret 3개와 Edge output 7개로 대조했다. 실제 배포가 끝나기 전에는 live 상태 증거로 쓰지 않는다.

### (J) ADR-0027 dev ALB WAF의 역사적 검증 기록

아래는 당시 검증 증거다. 정책은 유지하지만 ECS 스택/서비스 수를 현행으로 해석하지 않는다.

- PROJ-197은 정책·ADR·핸드오프, PROJ-198은 dev Web ACL·association·Block/Count·rate,
  PROJ-199는 로그·마스킹·로컬 회귀 검증을 맡는다. AWS 배포와 실트래픽 검증은 이번 완료 범위가 아니다.
- PROJ-200(PR #18)의 `/api/v1` 앱 경로 전체를 본문/query Block에 포함한다. OTLP 세 경로와
  bootstrap 경로는 유지하고 `/api/v1/healthz`는 public 앱 경로에 포함하지 않는다.
- IP별 300초 기준으로 정확한 OTLP 세 경로 10,000건 Count, 등록·토큰·초대 세 조건만 300건 Block,
  추가된 인증·manifest·조직 관리·문의·업데이트와 bootstrap·다운로드·SQL 디버깅 등 나머지 합계
  1,000건 Block이다. Block rate는 429와
  `Retry-After: 60`을 쓰며 정확한 차단 해제 시간을 보장하지 않는다. 값은 실측·AWS 권장값이 아닌
  dev 초기값이고 공유 NAT·동시 설치·재시도, 나머지 경로 합산 및 요청 건수 기준의 한계를 관측한다.
- 서울 리전의 선택 버전 가용성·실제 룰·label은 AWS 세션 만료로 미확인이다. 배포 전
  `ListAvailableManagedRuleGroupVersions`·버전을 지정한 `DescribeManagedRuleGroup`으로 확인한다.
  버전 만료·변경 때는 override·label·예외를 다시 검증하고 CDK·commit·배포 시각을 남긴다.
- 기존 WAF 분류는 `NONE`으로 URI 원문을 비교한다. PROJ-269의 `/unix`·`/windows` rate와 나머지 제외에만
  URL_DECODE를 한 번 적용하여 단일 인코딩 bootstrap도 같은 예산을 쓴다. ALB normalization 정합 증거는 canonical·trailing slash·prefix
  합성 조건에 한정한다. 배포 전 `curl --path-as-is`로 percent encoding·dot segment·중복 slash의
  ALB/WAF 분류를 확인하고 앱 라우팅이 디버깅 Count에 들어가면 정책을 보완한다.
- 인프라 배포 principal의 WAF logging configuration·CloudWatch Logs delivery/resource policy
  권한과 실제 로그 전달을 확인한다. 앱 GitHub 배포 역할에 이 권한을 추가하지 않는다.
- OTLP Count는 앱의 인증·압축 전후 크기 제한·압축 해제·JSON/protobuf 파싱·OTLP 구조 검증 확인이
  필요하다는 뜻이다. 이번 작업으로 앱 검사 구현 완료나 안전성을 주장하지 않는다.
- 정상 요청 오탐 차단 목표는 0건이며 관찰 기간·표본·담당자는 미정이다. template assertion과 synth는
  정책 조건만 증명하고 실제 signature 실행·차단·로그 마스킹·오탐 0건은 배포 후 별도로 검증한다.
- PROJ-198 배포에서 `OR_STATEMENT` nested statement 오류가 보고돼 나머지 rate 범위의
  `NOT(OR(OR3, OR3))`를 같은 의미의 `NOT(OR6)`로 평탄화했다. 일반적인 OR 중첩 금지나
  서비스 깊이 한도가 문서로 확인된 것은 아니다. 배포 전 합성 Rules를 `CheckCapacity`로 확인한다.
- PROJ-200 반영 전 OR 평탄화 수정은 전체 330 tests·build·prod A/B·dev·cicd fixture synth를
  통과했고, 당시 템플릿 변경은
  `RemainingRateBlock`의 OR 구조 한 곳에 한정됐다. AWS 세션 만료로 수정 전후 `CheckCapacity`
  대조는 수행하지 못했으며 실제 오류 해소는 서비스 검증·재배포로 확인해야 한다.
- PROJ-200(PR #18, `8836ef9`) 위로 PROJ-197 → 198을 누적한 구현은 전체 365 tests(14 suites,
  snapshot 없음), build와 prod A/B·dev·cicd fixture synth를 통과했다. PR #18 대비 기존 리소스와
  다른 환경 템플릿은 동일하고 dev Edge에 Web ACL·association 두 리소스만 추가된다. 새 앱
  내용 검사와 기존 등록 rate 세 조건을 구별하며 `RemainingRateBlock`의 여섯 leaf를 유지한다.
- PROJ-200 반영 전 PROJ-159 로컬 검증은 전체 334 tests(14 suites, snapshot 없음), build와
  prod A/B·dev·cicd fixture synth를 통과했다. 당시 develop 템플릿 대비 dev Edge의 Web ACL·association·로그 그룹·logging
  configuration 4개만 추가됐고 기존 dev 리소스 및 다른 12개 환경별 템플릿은 동일하다.
- PROJ-200 기준 PROJ-199까지의 누적 구현은 전체 369 tests(14 suites, snapshot 없음), build와
  prod A/B·dev·cicd fixture synth를 통과했다. PR #18 대비 13개 템플릿 중 12개는 전체 JSON이
  동일하고 dev Edge도 기존 리소스·output·기타 필드는 동일하며 WAF·로그 리소스 4개만 추가된다.
  PROJ-198 → 199의 Web ACL Rules는 동일하고 로그 리소스 2개와 `DataProtectionConfig`만 추가된다.
  prod·dev·cicd CLI synth도 고정 테스트 env/AZ context와 `--no-lookups`로 통과했다. sandbox의
  tsx IPC 제한은 `node --import tsx`로 회피했고 기존 CDK 경고는 남아 있다. 이 합성은 서울 리전
  입력 수용·실제 배포·차단·로그 전달을 확인한 증거가 아니다.

### (K) ADR-0030·0031 공통 Secret과 사용자 JWT 키 공급 `Accepted, 배포·runtime 연동 증거 대기`

- 허브 ADR-0022가 키 형식·초기화·버전 보존·교체를, infra ADR-0030이 EKS ASCP/CSI 파일 전달을 소유한다. ECS writer 부분은 ADR-0035로 대체됐다.
- **원본 정의 완료** — ADR-0031의 DB 계정 Secret 4개와 빈 JWT 원본 2개를 `DevDataStack`에 정의하고 `ISecret`·ARN getter로 노출한다. 실제 DB 사용자 생성·키 등록은 수동 절차다.
- JWT 원본은 CDK가 삭제·교체 시 보존하고 운영자는 활성·교체·롤백 버전 label을 유지한다. 보존된 원본의 재편입은 import로 처리하며 삭제·재생성으로 ARN을 바꾸지 않는다.
- EKS는 개별 objectVersion·키 파일 alias·명시적 kid 맵과 UID 10001의 실제 접근을 검증한다. 기존 configtree에는 경로만 전달한다.
- 키 누락·빈 파일·읽기 불가·PEM 오류·키쌍/kid 불일치·부분 등록 실패·신구 토큰 검증·교체·양방향 롤백을 수락 조건으로 남긴다.
- 이번 변경은 리소스 정의·수동 준비 문서·로컬 검증이다. 실제 DB 접속·계정/권한 적용·키 생성/등록·AWS 배포는 수행하지 않는다. 기존 3개 Secret·과거 검증 결과를 신규 공급 완료 증거로 재해석하지 않는다.

---

### (L) PROJ-253 dev JVM의 임시 blocked.certs 공급

[ADR-0036](docs/adr/0036-dev-jvm-blocked-certs-configmap.md)에 따라 dev Spring 앱 네 개(enrollment·ingest·dashboard·Gateway)의 각 Helm
release가 공식 Unix용 `blocked.certs` ConfigMap을 소유한다. 원본 provenance는
`helm/dev/workloads/spring-app/files/SOURCE.json`이며 앱 컨테이너의
`/opt/java/openjdk/lib/security/blocked.certs` 파일에만 읽기 전용으로 마운트한다.
파일 checksum은 runtime/JWT 활성 여부와 무관하게 Pod template에 들어간다.
Gateway도 같은 chart를 사용한다. 앱 전용 mount를 기존 initContainer의 Secret·사용자 JWT·telemetry JWT mount와
분리하고, telemetry JWT revision·Kafka 설정·9404 metrics를 유지한다. 배포 전 실제 네 이미지 digest를 검증한다.
파일 갱신은 각 앱 재배포와 재시작을 요구하며 기존 replica 1·`Recreate` 중단을 감수한다.

원본 확보·해시 검증 실패를 빈 파일·임의 목록으로 대체하지 않는다. 패치된 Temurin 이미지 자체의
차단 목록을 확인한 뒤 새 digest 배포와 임시 ConfigMap·mount·annotation 제거를 함께 진행한다.
취약한 이미지와 보호 없는 과거 chart revision을 조합해 rollback하지 않는다.
[적용·해제 런북 §12](docs/runbooks/dev-eks-manual-deployment.md#12-dev-jvm의-임시-blockedcerts-공급)를 따르며
로컬 검증은 실제 배포·TLS 기능·취약점 재현 검증의 증거가 아니다.

## 6. 명령어

```bash
npm run build
# 조건부 Helm suite를 건너뛰지 않도록 실제 Helm 3.22.0 / kubeconform 0.8.0 / promtool 3.9.1 경로를 사용한다.
# PROMTOOL_BIN이 없으면 관측 차트 suite(test/helm/observability-stack.test.ts)가 조용히 skip된다.
# 관측 suite는 chart archive를 직접 받지 않는다. 아래 준비 단계가 고정 archive를 받아 SHA-256을 검증해 둔다(없으면 suite가 실패한다).
node scripts/observability-prepare.mjs
HELM_BIN=/path/to/helm-3.22.0 KUBECONFORM_BIN=/path/to/kubeconform PROMTOOL_BIN=/path/to/promtool-3.9.1 npm test -- --runInBand
npm run synth       # prod 기본값
npm run synth:cicd
# 현재 dev profile을 자동 선택한다. 실행 계정과 기존 AWS 인증을 준비한다.
: "${CDK_DEFAULT_ACCOUNT:?대상 계정을 환경으로 지정한다}"
AWS_REGION=ap-northeast-2 npm run synth:dev
```

실제 신규 설치·후속 배포는 [EKS 런북](docs/runbooks/dev-eks-manual-deployment.md)을 따른다.
이미 ECS가 존재하는 환경에서는 먼저 [수동 철거](docs/runbooks/dev-ecs-retirement.md)를 완료한다.
Gateway를 포함한 네 앱 ARM64 이미지 공급·공유 DB/키 준비와 실제 기능 확인을 합성 성공으로 대신하지 않는다.
EKS Helm 배포 순서는 기반 구성 → ClickHouse → enrollment → Gateway → ingest → dashboard → 관측이다. 현재 dev Gateway·Kafka 연결은 [Strimzi 런북](docs/runbooks/dev-strimzi-kafka.md), 관측은 [관측 런북](docs/runbooks/dev-observability.md)을 함께 따른다. 기존 MSK 전환 절차는 [telemetry 런북](docs/runbooks/dev-telemetry-kafka.md)의 역사적·호환 경로다.

### 운영자 접속 (ADR-0016)

SSH 인그레스도 키페어도 없다. 접속은 전부 SSM 채널을 쓴다. **환경에 따라 수단이 갈린다.**

| 환경 / 대상 | 수단 | 필요한 운영자 IAM 권한 |
|---|---|---|
| prod `clickhouse` (EC2) | `aws ssm start-session` | `ssm:StartSession` |
| prod `post-processor`, `api-server` (Fargate) | `aws ecs execute-command` | `ecs:ExecuteCommand` |
| dev EKS | 전용 SSM relay 터널 → private API → kubectl | operator AssumeRole·전용 Session 문서·EKS AccessEntry |

dev EKS 접속은 [EKS 런북](docs/runbooks/dev-eks-manual-deployment.md)의 별도 kubeconfig·SSM 터널을 쓴다.
Auto Mode 노드에 직접 SSM/SSH 접속하지 않는다. 아래 EC2/ECS Exec 절은 prod 대상이다.

두 방식 모두 로컬에 **Session Manager plugin**이 설치되어 있어야 한다. 없으면 명령 자체가 실패한다.

#### ClickHouse EC2

```bash
# 인스턴스 ID 조회 — Org 태그는 dev 호스트에도 붙으므로 Env=mvp 로 운영만 좁힌다
aws ec2 describe-instances --region ap-northeast-2 \
  --filters "Name=tag:Org,Values=soma-376" "Name=tag:Env,Values=mvp" \
            "Name=instance-state-name,Values=running" \
  --query 'Reservations[].Instances[].InstanceId' --output text

# 접속
aws ssm start-session --target <instance-id> --region ap-northeast-2
```

주의할 점 두 가지.

- **접근 통제는 인스턴스가 아니라 운영자 IAM에 있다.** 인스턴스 역할의 `AmazonSSMManagedInstanceCore`는 "SSM에 관리될 수 있다"만 정한다. 실제로 누가 들어올 수 있는지는 `ssm:StartSession` 권한이 결정하며, 그 정책은 이 레포가 관리하지 않는다.
- **기본 세션 사용자 `ssm-user`는 passwordless sudo를 가진다.** 접속하면 사실상 root다.

인스턴스가 목록에 안 뜨면 SSM Agent가 없거나 죽은 것이다. 먼저 확인한다.

```bash
aws ssm describe-instance-information --region ap-northeast-2 \
  --query 'InstanceInformationList[].[InstanceId,PingStatus,AgentVersion]' --output table
```

#### Fargate 컨테이너 (ECS Exec)

`CollectorService`와 `DashboardService`에만 `enableExecuteCommand: true`가 켜져 있다. ClickHouse는 위의 EC2 접속으로 대신한다.

```bash
# 태스크 ID 조회
aws ecs list-tasks --cluster <cluster> --service-name <service> --region ap-northeast-2

# 접속
aws ecs execute-command --cluster <cluster> \
  --task <task-id> --container api-server \
  --interactive --command "/bin/sh" --region ap-northeast-2
```

**컨테이너 이미지에 셸이 없으면 실패한다.** distroless나 JRE-slim 기반이면 `/bin/sh`가 없어 권한과 무관하게 접속되지 않는다. 이건 인프라가 아니라 앱 레포의 Dockerfile이 결정하는 부분이다.

### 운영 스택 리팩터링 회귀 검증

운영 스택을 옮기거나 정리할 때는 **합성 템플릿이 바이트 단위로 같은지**를 게이트로 쓴다. ADR-0021의 `lib/prod/` 이동이 이 방식으로 검증됐고, 앞으로도 같은 종류의 작업에 그대로 쓸 수 있다.

```bash
git stash && npx cdk synth --all -q -o /tmp/before
git stash pop && npx cdk synth --all -q -o /tmp/after
diff /tmp/before/NetworkStack.template.json /tmp/after/NetworkStack.template.json  # 4개 모두
```

**`*.template.json`만 비교하면 된다.** `*.metadata.json`은 CDK construct의 스택 트레이스 문자열을 담고 있어 파일 경로가 바뀌면 필연적으로 달라진다 — 그 차이는 회귀가 아니다. 템플릿이 한 글자라도 다르면 "이동"이 아니라 변경이 섞인 것이다.

---

## 7. 테스트 작성 규칙

테스트는 `test/prod/`, `test/dev/`, `test/cicd/` 및 generator/Helm 검증으로 나뉘고, 픽스처 `helpers.ts`만 루트에 둔다.

- `aws-cdk-lib/assertions` 기반 **template assertion만** 쓴다. 스냅샷 테스트는 쓰지 않는다.
  - 예외: `lib/common/config.ts`의 **순수 함수**(예: `buildLibpqDsn`)와 `lib/dev/config.ts`의 `loadDevConfig`, `lib/cicd/config.ts`의 `loadCicdConfig` 파싱 로직은 CDK 리소스를 만들지 않으므로 `test/prod/config.test.ts` / `test/dev/config.test.ts` / `test/cicd/config.test.ts`에서 일반 단위 테스트로 검증한다. 이 파싱 테스트는 context 입력용 `new App()`을 직접 써도 되지만, 스택을 합성하는 테스트는 여전히 template assertion과 아래 팩토리만 쓴다.
- **`new App()`을 직접 쓰지 말고 `test/helpers.ts`의 `buildApp()`(prod) / `buildDevApp()`(dev) / `buildCicdApp()`(cicd)을 쓴다.**
  bare `App`은 `cdk.json`의 피처 플래그를 읽지 않아 CLI synth와 산출물이 달라진다 (예: ASG가 `LaunchTemplate` 대신 `LaunchConfiguration`을 생성). dev에도 피처 플래그를 동일하게 반영하며 ECS/ASG/Cloud Map 0개를 검사한다.
  세 팩토리 모두 진입점과 **같은 `synthProd` / `synthDev` / `synthCicd`를 거치므로** 픽스처 조립과 실제 배포 조립이 갈라질 수 없다 (ADR-0021 1번, ADR-0024 1번).
- 모드 A 테스트는 `MODE_A_EDGE`를, 모드 B는 인자 없이 기본값을 쓴다. dev context 키는 `buildDevApp({ devAllowedCidr: '203.0.113.10/32' })`처럼 객체로 주입한다 — CLI의 `-c key=value`와 같은 자리다.
- 고정 env는 `TEST_ENV = { account: '111111111111', region: 'ap-northeast-2' }`다.

**dev 테스트가 고정하는 핵심 계약**

- 네 스택, ECS/ASG/Cloud Map 0개, ALB 1개/TG 4개/WAF association 1개/SG 9개.
- Data/EKS·ALB/TG/WAF의 보존 리소스 논리 ID·속성 및 output 호환.
- OIDC 전체 key의 정규화·중복/누락/형식 검증, 기존 Secret/IAM 원본 유지.
- EKS 고정 버전의 JWT/OIDC 공급·권한·configtree·runtime/workload 경계.
- path/method/OPTIONS·default/public health 404·WAF Count/Block/rate·로그 보호.
- HTTPS/redirect 입력과 private API·SSM relay/운영자 권한.

**cicd 테스트가 고정하는 핵심 계약**

| 계약 | 왜 |
|---|---|
| trust `sub`가 immutable org/repo ID와 branch까지 `StringEquals` | wildcard나 name-only subject를 막는다 |
| backend-dev가 ECR 네 저장소만 대상으로 하고 ECS/EKS 권한 없음 | 물리 이름과 workflow 계약 drift를 잡는다 |
| pipeline-dev role의 permission statement 0개, trust/output 유지 | ECR login 포함 권한 회수를 보장한다 |
| prod 역할의 ECR/service policy가 기준선과 같음 | dev cleanup이 prod 권한을 바꾸지 않게 한다 |
| `iam:PassRole`, `ecs:RegisterTaskDefinition`, wildcard action 부재 | 권한 상승 경로를 막는다 |
| OIDC provider `Retain`, `ThumbprintList`/Lambda 없음 | provider 수명과 인증서 회전 계약을 지킨다 |

```ts
import { Template } from 'aws-cdk-lib/assertions';
import { buildApp, MODE_A_EDGE } from './helpers';

const { edge } = buildApp(MODE_A_EDGE);
Template.fromStack(edge).hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
  Protocol: 'HTTPS',
});
```

---

## 8. 커밋 / PR 규칙

- 브랜치명: `^(feat|feature|fix|docs|refactor|chore|test|style|perf|build|ci)/(PROJ-\d+)-.*$`
- 커밋 제목: `[<KEY>] <type>: <summary>` — 예) `[PROJ-22] docs: 핸드오프 문서 추가`
- PR 제목: `[<KEY>] <type>: <summary>` — 워크플로가 Jira 요약으로 자동으로 채운다. 직접 쓰지 않는다.
- PR 대상 브랜치는 `develop`이다. `.github/workflows/pull_request_auto_fill.yml`이 브랜치명에서 Jira 키를 파싱해 제목을 재작성하고 본문에 링크를 넣는다. (`feature`는 `feat`으로 정규화된다.)
- 브랜치명이 위 규칙에 맞지 않으면(타입 접두사 누락 등) `pull_request_auto_fill.yml`의 Jira 키 파싱이 실패해 제목이 재작성되지 않는다. PR을 올리기 전에 브랜치명을 규칙에 맞춘다. (브랜치가 origin보다 얼마나 앞서는지는 금방 낡으므로 여기 적지 않는다 — `git log --oneline origin/main..HEAD`로 확인한다.)
- 문서와 코드 주석은 한국어로 작성한다.


## perf 환경 (PROJ-292)

- 결정은 [ADR 0050](docs/adr/0050-perf-strimzi-provider-and-isolated-capacity.md), 입력·실제 상태 확인은 [perf 런북](docs/runbooks/perf-environment.md)을 따른다. 현재 배포·부하·정리는 NOT_RUN이다.
- `lib/perf → lib/common` 단방향. `-c env=perf -c perfEnvironmentId=perf-… -c perfProfile=profiles/perf/strimzi-fixed-v1.json`으로 명시한다. MSK fixed-v1은 과거 v2 호환용이다.
- canonical v2/v3 환경 계약은 load-tests 소유이며 shared export/SOURCE hash를 검사한다. v2 원본은 바꾸지 않는다. request/provisional/resolved/lock만 동일 버전을 강제한다.
- Kafka Secret 원문 입력 금지. CA/4 역할 사용자 metadata만 받고 PKCS12 참조와 revision을 기록한다. Kafka CR/ACL/PVC 실측이 부족하면 resolved ready를 만들지 않는다.
- 공유 dev workload/Kafka chart 기본 렌더는 유지한다. perf에만 namespace·고정 전용 pool·topic/group을 바꾼다. 스택 테스트는 `buildPerfApp()` 팩토리를 사용한다.
- 승인 상한은 100,000원·24시간 내 생성/seed/시험/삭제, 총 10,000요청·20RPS·실행당 600초·추가 저장 1GiB다. PROJ-294의 budget/cleanup gate 전 배포 금지; Retain은 정리 완료가 아니다.
- 후속 별도 PR: PROJ-293 공개 HTTPS/WAF, PROJ-294 실행 예산/24시간 정리, PROJ-295 합성 데이터, PROJ-296 발생기 관측, PROJ-297 Strimzi drain 증거, PROJ-298 외부 API/DB 기준선.
