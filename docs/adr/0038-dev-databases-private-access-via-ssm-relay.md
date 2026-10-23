# 0038. dev 데이터베이스는 공개 접근을 차단하고 별도 SSM 릴레이로 접속한다

## Status

Accepted (PROJ-254; 로컬 구현·검증, AWS 배포와 실제 접속 검증은 별도)

[ADR 0022](0022-dev-infrastructure-topology.md)의 공개 RDS와 CIDR 기반 DB 직접 접근,
[백엔드 ADR 0028](0028-dev-eks-auto-mode-transition.md)의 ClickHouse 디버깅 ALB 경로를 부분 대체한다.
ADR 0027·0033의 공개 ClickHouse 경로 가정과 [dev EKS 전용 ADR 0035](0035-dev-backend-eks-only.md)의
DB 관련 TG·SG·output 보존 규칙도 이번 DB 접근 변경에 한해 대체한다. 앱 listener·WAF 정책, 기존 리소스의
논리 ID, 데이터 수명, prod·frontend와 [ADR 0034](0034-dev-eks-private-api-via-ssm-relay.md)의 EKS API
릴레이·운영자 역할은 유지한다.

## Context

dev RDS는 public subnet에서 `publiclyAccessible=true`이며, ClickHouse는 internet-facing ALB의
8123 listener와 Pod IP target group을 통해 접근한다. `devAllowedCidr` 기본값은 `0.0.0.0/0`이다.
PROJ-254는 비용 이상 징후 조사 중 외부에 노출된 두 DB를 먼저 숨기기로 했다. 이 변경으로 비용
이상 원인이 DB 접속이었다고 판정하거나 침해 사실을 단정하지 않는다.

기존 EKS API 릴레이는 Kubernetes API 전용이다. DB 중계를 별도 EC2 한 대로 모아 역할을 분리하고
추가 LB·NAT 비용은 들이지 않는다. ClickHouse Service는 ClusterIP이므로 EC2에서 Kubernetes DNS를
그대로 목적지로 사용할 수 없다. Pod IP는 VPC 내부 주소이며 Pod 교체 시 달라진다.

이 결정은 infra의 운영자 접속 경로만 바꾼다. 앱 API, DB 스키마·인증 방식과 앱의 내부 DB endpoint는
변경하지 않으므로 크로스레포 계약 변경은 없다.

## Decision

### 1. 공개 DB 경로를 제거한다

- RDS의 `PubliclyAccessible`을 false로 바꾸고 CIDR 기반 5432 ingress를 제거한다. 기존 subnet group,
  DB·Secret·SG 논리 ID와 데이터 수명 정책을 보존한다. RDS SG의 기존 description은 교체를 피하기 위한
  호환 문자열로 남긴다. subnet 이동·DB 재생성·계정 전환은 하지 않는다.
- 공개 ALB의 ClickHouse 8123 listener·TG·`ValidationClickhouseUrl`·`ValidationClickhouseTargetGroupArn`과
  외부→ALB:8123·ALB→ClickHouse:8123 규칙을 제거한다. ALB와 앱 TG 네 개·WAF는 유지한다.
- ClickHouse chart의 TGB와 `vpcId`·`targetGroupBindings` 입력을 제거하고 구 values는 schema에서 거부한다.
  generator는 구 CDK outputs의 ClickHouse 키를 무시할 수 있어야 한다. TGB를 먼저 정리한 후 TG를 삭제한다.
- 앱→RDS:5432, 앱→ClickHouse:8123/9000, 관측→ClickHouse:9363과 StatefulSet·Service·PVC는 유지한다.
  `devAllowedCidr`는 이제 앱 ALB 80/선택적 443에만 적용된다.

### 2. DB 전용 릴레이와 역할을 추가한다

- `DevDataStack` 하위에 릴레이 EC2 한 대를 추가한다. dev 네 스택을 유지하며 기존 EKS 릴레이를 이동하거나
  공통 construct로 재구성하지 않는다. AL2023 ARM64 t4g.micro, 첫 public subnet, public IPv4, IMDSv2,
  암호화된 8 GiB gp3 root volume과 삭제 시 volume 제거를 사용한다. 키페어·인바운드는 없다.
- Network가 신규 DB relay SG와 모든 cross-SG 규칙을 소유한다. 사용자 정의 SG는 9개다.
  릴레이 egress는 IPv4 HTTPS 443(SSM), RDS SG:5432, ClickHouse node SG:8123만 허용한다.
  RDS와 ClickHouse는 릴레이 SG에서 오는 해당 포트를 허용한다. 기존 NodeClass의 Pod ENI SG 구성을 유지한다.
- EC2 역할은 `AmazonSSMManagedInstanceCore`만 사용한다. EKS 권한·AccessEntry·Secret 읽기·DB IAM 인증·
  operator AssumeRole·애플리케이션 권한을 추가하지 않는다. EC2에는 kubectl·DB 클라이언트를 설치하지 않는다.
- 별도 `soma-376-dev-db-operator` 역할은 같은 계정 IAM의 AssumeRole 위임을 따른다. 계정 IAM에서 누가
  이 역할을 맡을지는 기존 관리 경계다. 기존 EKS operator의 trust·권한은 바꾸지 않는다.
- `ssm:StartSession`은 DB relay instance와 아래 두 문서로 제한한다. instance에는
  `BoolIfExists: ssm:SessionDocumentAccessCheck=true`를 적용하고 문서 ARN은 별도로 제한한다.
  `ssmmessages:OpenDataChannel`은 `${aws:userid}-*` session, Resume/Terminate는 호출자 session-id와
  DB relay target-id tag 조건으로 제한한다. 기본 셸·범용 remote-host 문서·SendCommand 권한은 주지 않는다.

### 3. 목적지를 제한한 Session 문서와 로컬 도구를 사용한다

- `soma-376-dev-db-postgres-tunnel`은 RDS endpoint:5432를 고정한다.
  `soma-376-dev-db-clickhouse-tunnel`은 원격 포트 8123을 고정하고 host는 유효한 `10.1.0.0/16` IPv4만 받는다.
  host 제한은 SG 목적지 제한과 함께 적용한다. localhost·IMDS·외부 IP·DNS hostname·임의 원격 포트는 받지 않는다.
- 두 문서는 schema 1.0·sessionType Port·NewVersion 갱신을 사용한다. `localPortNumber`는 1~65535이며
  기본값은 PostgreSQL 15432, ClickHouse 18123이다.
- Data output은 `DbRelayInstanceId`, `DbOperatorRoleArn`, `DbRelayPostgresSessionDocumentName`,
  `DbRelayClickHouseSessionDocumentName`이다.
- `scripts/dev-db-tunnel.mjs`는 사용자 PC에서 실행한다. `postgres|clickhouse`, `--outputs`, `--profile`,
  선택적 `--local-port`를 받는다. DB 역할로 설정한 프로필을 사용하고 다시 AssumeRole을 요청하지 않는다.
  출력 JSON은 기존 CDK outputs 또는 CloudFormation describe-stacks 형식을 사용한다.
- ClickHouse에는 `--kubeconfig`·`--eks-profile`을 명시한다. 이미 열린 EKS API 터널을 통해
  `pulsemetry-dev`의 clickhouse release Pod를 조회한다. 삭제 중이 아니고 Running·Ready이며 controller가
  StatefulSet/clickhouse인 후보가 정확히 하나여야 한다. IP가 유효한 dev VPC IPv4인지 검사한 뒤 SSM에 전달한다.
  조회 실패·0개·복수 후보·잘못된 IP는 StartSession 전에 실패한다. Pod 교체 시 자동 재연결하지 않고 다시 실행한다.
- 스크립트는 Secret·DB 인증 정보를 읽거나 파일로 만들지 않는다. 실제 DB 클라이언트는 로컬에서 실행한다.
  원격 포워딩을 지원하는 SSM Agent, 로컬 AWS CLI v2·Session Manager plugin·Node.js와 ClickHouse 조회용
  kubectl이 필요하다. SSM 포트 포워딩은 SQL 내용을 세션 로그로 남기지 않는다.

## Alternatives Considered

- **기존 EKS 릴레이 공유:** 비용은 적지만 티켓의 별도 인스턴스 요구와 API 전용 경계를 어긴다.
- **internal ALB/NLB:** 안정적인 DNS를 제공하지만 추가 상시 비용과 TG/TGB 관리가 생긴다.
- **EC2에서 kubectl 실행:** EC2에 Kubernetes 자격과 도구 관리가 필요하므로 로컬 운영자 조회를 선택한다.
- **공개 경로를 CIDR로만 제한:** IP 갱신이 계속 필요하며 DB 공개 설정 자체를 끄려는 목적을 충족하지 않는다.

## Consequences/Tradeoffs

### Positive

- 공개 DB 경로를 제거하고 DB 릴레이 권한과 EKS 관리 권한을 분리한다.
- 기존 앱 endpoint·데이터·PVC·EKS 릴레이를 유지하며 추가 LB·NAT 없이 두 DB를 한 EC2로 중계한다.

### Negative

- EC2·EBS·public IPv4 비용과 Agent 관리가 추가된다. 단일 릴레이 장애 시 운영자 DB 접근이 중단된다.
- ClickHouse IP 조회에는 기존 EKS 터널·운영자 권한이 필요하다. DB 전용 역할만으로 조회까지 할 수는 없다.
- Pod 교체 시 새 IP로 재접속해야 하며 조회와 연결 사이의 Pod 교체도 재실행으로 처리한다.
- Network를 먼저 갱신하면 DB 운영자 직접 접근이 즉시 끊긴다. Data 릴레이 준비까지 접속 공백을 감수한다.
- 로컬 검증은 실제 AWS 차단·SSM 인가·Pod ENI 접근·DB 연결·비용 원인 해결의 증거가 아니다.

## Follow-up

- DB IAM 인증, DB audit, Kafka 실행 위치와 백엔드 API 비공개화는 후속 작업이다.
- SSM Online·Agent 버전, 외부 직접 접속 실패, 두 터널 성공, 다른 대상/문서/세션 거부와 앱 DB 연결을 배포 후 확인한다.

## Acceptance Criteria

- 공개 DB CIDR ingress·ClickHouse listener/TG/TGB가 없고 RDS PubliclyAccessible=false다.
- SG 9개·앱 TG 4개·relay EC2 총 2개이며 기존 EKS relay와 prod/cicd 템플릿은 동일하다.
- helper 오류 조건·SSM 인자·종료 코드, CDK template assertion, 전체 Jest·build·환경별 synth·Helm/configtree를 검증한다.
- 운영 순서는 Network → Data 및 SSM 준비 → 새 values와 Helm --reset-values로 TGB 정리 → Edge다.
  실제 배포는 별도 수행한다. [접속·전환 런북](../runbooks/dev-database-access.md)을 따른다.

## References

- [PROJ-254](https://team376.atlassian.net/browse/PROJ-254)
- [RDS public access 변경](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_ModifyInstance.Settings.html)
- [SSM remote host 포트 포워딩](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-sessions-start.html)
- [EKS Auto Mode NodeClass 네트워크](https://docs.aws.amazon.com/eks/latest/userguide/create-node-class.html)
