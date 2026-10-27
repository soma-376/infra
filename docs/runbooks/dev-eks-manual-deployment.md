# dev EKS 수동 설치·검증·복구 런북

> 새 dev 도메인의 공개 URL·추가 SNI 인증서와 재배포 입력은 [도메인 전환 런북](dev-domain-migration.md)을 따른다.

> **현재 기준은 ADR-0035·PROJ-248의 EKS 전용 구성이다.** 기존 ECS가 있는 환경은 먼저
> [수동 철거 런북](dev-ecs-retirement.md)을 완료한다. 이 문서의 전체 배포는 신규 환경 또는 철거 완료 후의 절차다.
> backend ECS 검사/재배포 종료와 허브 배포 계약 정합화는 PROJ-249 선행 작업이다.


> PROJ-206~212 구현 인터페이스를 반영한 런북이다. 이 문서의 AWS/Kubernetes 명령은 이번 작업에서
> 실행하지 않았다. 로컬 synth·렌더링·fixture 통과와 실제 배포 성공은 다르다.
> PROJ-206~212 기준은 [ADR-0028](../adr/0028-dev-eks-auto-mode-transition.md), dashboard 확장은
> [ADR-0029](../adr/0029-dev-dashboard-api-ecs-and-eks-deployment.md)와 §10을 따른다.
> 사용자 JWT 키 공급은 [허브 ADR-0022](../../../docs/adr/0022-user-jwt-key-provisioning.md)·
> [infra ADR-0030](../adr/0030-dev-user-jwt-keys-from-secrets-manager.md)와 §11의 별도 운영 절차다.
> PROJ-222의 공통 Secret 정의·수동 준비는 [준비 런북](dev-dashboard-prerequisites.md)과
> [ADR-0031](../adr/0031-manage-dev-dashboard-and-jwt-secrets-with-cdk.md)을 따른다.
> 기존 Secret 3개·configtree 검증 기록은 JWT writer·키 mount 구현·배포 증거를 포함하지 않는다.
> 기존 Cognito 연결·빈 client Secret·VersionId 준비는 [OIDC 런북](dev-oidc-prerequisites.md)과
> [ADR-0032](../adr/0032-dev-oidc-client-secret-runtime-supply.md)을 따른다. OIDC 비활성 bootstrap은
> 해당 런북의 `DevDataStack` 단독 배포를 먼저 수행하며, 이 문서의 전체 배포보다 앞선다.
> 외부 ACM 기반 HTTPS는 [dev ALB HTTPS 런북](dev-alb-https.md)을 따른다. 기존 HTTPS 배포에 아래 명령을
> 적용할 때는 `EKS_CONTEXT`에 기존 `devEksCertificateArn`과
> `devHttpRedirectEnabled`를 유지한다. 인증서 연결은 기존 endpoint output·Helm 생성값을 바꾸지 않는다.
> PROJ-244의 private API와 SSM 릴레이 접근은 [ADR-0034](../adr/0034-dev-eks-private-api-via-ssm-relay.md)와
> §2를 따른다. 문서의 터널·TLS·권한 검증 명령도 아직 실행한 증거가 아니다.
> PROJ-246의 MSK·telemetry Gateway·ingest Kafka 모드·Kafka 관리 Job은 [ADR-0035](../adr/0035-dev-msk-isolated-subnets-under-eks-stack.md)·
> [ADR-0036](../adr/0036-dev-telemetry-gateway-workload-and-msk-iam.md)과 [telemetry Kafka 런북](dev-telemetry-kafka.md)을 따른다.
> 이 문서의 공통 설치 순서와 생성기 입력은 그 런북의 키 등록·bootstrap 조회를 전제로 한다.
> PROJ-253의 dev JVM 임시 차단 목록 공급은 [ADR-0036](../adr/0036-dev-jvm-blocked-certs-configmap.md)과
> §12를 따른다. Gateway를 포함한 네 앱의 실제 배포 이미지로 사전 검증한다.

> PROJ-254의 기존 DB 공개 경로 전환은 [DB 릴레이 런북](dev-database-access.md)을 먼저 따른다.
> 전체 CDK 배포 전에 ClickHouse TGB를 Helm에서 제거해야 한다. 이후 ClickHouse 공개 ALB ping은 사용하지 않는다.

## 1. 실행 범위와 사전 조건

**실행 checkout 조건:** ADR-0035의 EKS 전용 코드와 기존 dashboard·JWT·OIDC·SSM relay 구현을 포함한다.
로컬 합성은 AWS 배포 증거가 아니다. 운영자가 별도 실행 범위를 확정한 뒤 아래 절차를 수행한다.
prod·frontend Terraform·기존 EKS/Data 식별자와 OIDC trust를 유지한다. 과거 ECS 병행·Canary·데이터 이관
계획은 ADR-0035로 대체됐으며 이 런북에서 실행하지 않는다.
생성기는 네 앱 digest와 `--runtime-values`, `--msk-bootstrap`, 전체 `--msk-nodes`를 필수로 받는다.
관측 설치·검증은 [관측 런북](dev-observability.md)을 함께 따른다.

- 원래 배포 주체에 infra 배포와 CloudFormation output 조회 권한이 있어야 한다. CDK가 생성하는
  `soma-376-dev-eks-operator` role은 해당 클러스터의 `eks:DescribeCluster`와 AccessEntry 기반
  Kubernetes 관리 권한, 전용 릴레이·Session 문서에 제한한 SSM 접속 권한을 가진다.
  CloudFormation/IAM 배포, SSM 상태 조회 및 S3 조회·정리는 원래 배포 주체로 실행한다.
- 생성한 role은 같은 계정에 AssumeRole 권한을 위임한다. 계정 IAM에서 실제 운영자에게
  output `EksOperatorRoleArn`에 대한 `sts:AssumeRole` 권한을 부여한다. 모든 계정 주체에게
  AssumeRole 권한이 자동 부여되는 것은 아니며 별도 role/principal ARN context 입력도 없다.
- AWS 계정은 환경 `CDK_DEFAULT_ACCOUNT`로만 전달한다. region은 `ap-northeast-2`다.
- Kubernetes 1.36과 ARM64 t4g.medium의 리전 가용성·할당량, 2개 public subnet의 여유 IP,
  public IPv4 egress를 확인한다. Auto Mode 노드는 SSH/SSM 직접 접속하지 않는다.
- 별도 AL2023 ARM64 `t4g.micro` 릴레이 한 대는 첫 번째 public subnet·public IPv4를 사용한다.
  인바운드 없이 TCP 443 아웃바운드만 허용하며, SSM 전용 EC2 역할에는 EKS AccessEntry가 없다.
  로컬 AWS CLI v2·Session Manager plugin과 릴레이 SSM Agent 3.1.1374.0 이상이 필요하다.
  [원격 호스트 터널 요구사항](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-sessions-start.html#sessions-remote-port-forwarding)을 따른다.
- backend와 호환되는 Flyway migration, immutable ARM64 앱 이미지 digest 4개(enrollment·ingest·dashboard·Gateway),
  `/api/v1/healthz`의 200 응답, init 검사용 `/bin/sh`·`head -c`, UID 10001 및 바이너리 공급을 확인한다.
- 별도 검증 tenant/token과 검증 event ID 집합을 준비한다. 공유 RDS의 현재 스키마와 호환되는
  DDL·이미지를 사용한다. archive prefix는 기존 배포의 `eks_validation` 또는 `eks`를 유지하며 기존 객체 7일 expiration도 유지한다.
- Secret ARN만 다룬다. Secret 원문 조회·출력, `kubectl get secret`으로 값 열람,
  CSI mount 내용 출력, shell `set -x`를 검증 절차에 넣지 않는다. 앱 인증 요청은 승인된 런타임
  credential 주입 경로를 사용하고 토큰을 명령 이력·로그·증거 파일에 남기지 않는다.
- HTTP ALB는 bootstrap/경계 검증용이다. HTTPS 전체 CLI enrollment→manifest→OTLP E2E는
  TLS 선행 과제 완료 전에는 통과로 기록할 수 없다.

### 버전과 release

| 구성 | 고정 버전 | namespace / release | 입력 |
|---|---|---|---|
| Kubernetes | 1.36 | CDK DevEksStack | context |
| 기반 chart | 0.1.0 | kube-system / pulsemetry-dev-platform | generated/base.yaml |
| OSS LBC | chart/controller 3.6.0 | kube-system / aws-load-balancer-controller | platform/lbc/values.yaml + generated/lbc.yaml |
| Secrets Store CSI | 1.6.1 | kube-system / secrets-store-csi-driver | runtime/csi-driver-values.yaml |
| ASCP | 3.1.4 | kube-system / secrets-provider-aws | runtime/ascp-values.yaml + generated/ascp.yaml |
| Fluent Bit | chart 0.58.3 / image 5.1.3 | pulsemetry-dev-logs / fluent-bit | runtime/fluent-bit-values.yaml + generated/fluent-bit.yaml |
| SecretProviderClass | runtime chart 0.1.0 | pulsemetry-dev / runtime-config | generated/runtime.yaml |
| ClickHouse | 24.8-alpine | pulsemetry-dev / clickhouse | generated/clickhouse.yaml |
| enrollment | immutable digest | pulsemetry-dev / enrollment-api | workloads/enrollment-api.yaml + generated/enrollment-api.yaml |
| ingest | immutable digest | pulsemetry-dev / telemetry-ingest | workloads/telemetry-ingest.yaml + generated/telemetry-ingest.yaml |
| dashboard | immutable digest | pulsemetry-dev / dashboard-api | workloads/dashboard-api.yaml + generated/dashboard-api.yaml |
| telemetry Gateway | immutable digest | pulsemetry-dev / telemetry-gateway | workloads/telemetry-gateway.yaml + generated/telemetry-gateway.yaml |
| Kafka 관리 Job | apache/kafka 3.9.2 digest·MSK IAM 2.3.9 | pulsemetry-dev / telemetry-kafka-admin | generated/telemetry-kafka-admin.yaml |

Helm 3.22.0·kubectl 1.36 계열을 사용한다. 로컬 schema 검증은 kubeconform 0.8.0이다.
LBC archive/CRD/checksum은 레포에 있으며 runtime upstream archive URL·checksum은
`helm/dev/runtime/versions.json`이 단일 출처다. 버전 갱신은 별도 검토한다.

## 2. EKS 활성화 설정과 CDK 배포

아래 변수는 운영자가 실제 값으로 설정한다. `RUN_DIR`는 증거·output 참조를 보관하는 로컬 경로이며
레포 바깥 또는 ignore된 `generated/`를 사용한다. 원문 Secret 값은 저장하지 않는다.

```bash
set -euo pipefail
: "${CDK_DEFAULT_ACCOUNT:?대상 계정을 환경으로 지정한다}"
export CDK_DEFAULT_REGION=ap-northeast-2
export AWS_REGION=ap-northeast-2
: "${DEPLOY_PROFILE:?기존 CloudFormation 배포용 AWS 프로필}"
export AWS_PROFILE="$DEPLOY_PROFILE"
: "${DEV_ALLOWED_CIDRS:?ALB와 RDS에 접근할 IPv4 CIDR 목록}"
: "${ENROLLMENT_IMAGE:?registry/repository@sha256:digest}"
: "${INGEST_IMAGE:?registry/repository@sha256:digest}"
: "${DASHBOARD_IMAGE:?registry/repository@sha256:digest}"
: "${GATEWAY_IMAGE:?telemetry-gateway registry/repository@sha256:digest}"
: "${DEV_EKS_OTLP_TARGET:?기존 ingest 또는 gateway 값, 신규는 ingest}"
: "${DEV_OIDC_CLIENT_KEYS:?기존 OIDC 원본 전체 key의 JSON 배열, 없으면 []}"
: "${DEV_EKS_ARCHIVE_PREFIX:?기존 eks_validation 또는 eks 값}"
: "${RUNTIME_VALUES:?비밀 없는 runtime 설정 YAML 절대 경로}"
: "${HELM_BIN:?Helm 3.22.0 실행 파일 경로}"
: "${KUBECONFORM_BIN:?kubeconform 0.8.0 실행 파일 경로}"
export HELM_BIN KUBECONFORM_BIN
: "${RUN_DIR:?실행 증거 디렉터리 절대 경로}"
mkdir -p "$RUN_DIR/generated" "$RUN_DIR/charts"
chmod 700 "$RUN_DIR"
EKS_CONTEXT=(-c env=dev -c devEksEnabled=true
  -c "devAllowedCidr=$DEV_ALLOWED_CIDRS"
  -c "devOidcClientKeys=$DEV_OIDC_CLIENT_KEYS"
  -c "devEksArchivePrefix=$DEV_EKS_ARCHIVE_PREFIX"
  -c "devEksOtlpTarget=$DEV_EKS_OTLP_TARGET")
if [[ -n "${DEV_EKS_CERTIFICATE_ARN:-}" ]]; then
  EKS_CONTEXT+=(-c "devEksCertificateArn=$DEV_EKS_CERTIFICATE_ARN")
fi
EKS_CONTEXT+=(-c "devHttpRedirectEnabled=${DEV_HTTP_REDIRECT_ENABLED:-true}")
printf '%s\n' "${EKS_CONTEXT[@]}" > "$RUN_DIR/cdk-context-args.txt"
git rev-parse HEAD > "$RUN_DIR/infra-commit.txt"
npm run build
npm test -- --runInBand
npx cdk synth --all "${EKS_CONTEXT[@]}" --output "$RUN_DIR/cdk.out"
npx cdk diff --all "${EKS_CONTEXT[@]}" > "$RUN_DIR/cdk-diff.txt"
```

`devEksApiAllowedCidrs`는 폐기됐으며 전달하면 오류다. CLI·`cdk.json`·`cdk.context.json` 등
모든 입력 출처에서 제거한다. 이전 CIDR은 아래 복구 증거에만 보존한다. `devAllowedCidr`는
ALB/RDS 접근 범위이므로 계속 유지하며 EKS API 접근 허용 목록으로 사용하지 않는다.

합성 템플릿에는 `EndpointPrivateAccess=true`, `EndpointPublicAccess=false`,
`PublicAccessCidrs=['0.0.0.0/0']`가 함께 있어야 한다. 마지막 속성은 기존 클러스터의 CloudFormation
업데이트 호환성을 위한 IPv4 기본값이며, public API는 비활성 상태다. 사용자 CIDR 입력을 되살리지 않는다.
이전 템플릿에 있던 `PublicAccessCidrs`를 새 템플릿에서 생략하면
`The new template must include all the properties specified in the previous template` 오류로 갱신이 실패한다.
이 오류가 났다면 CloudFormation rollback 완료를 확인하고, 세 속성을 포함하도록 수정된 코드로 다시
합성·diff한 뒤 §2-1 순서로 재배포한다. rollback이 실패 상태라면 먼저 해당 실패 이벤트를 해결한다.
[AWS 업데이트 제약](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-eks-cluster-resourcesvpcconfig.html)을 따른다.

diff에서 RDS·S3·실제 Secret·EKS ALB/TG·WAF 정책의 삭제/교체가 없고 prod/cicd가
포함되지 않았는지 확인한다. 사용자 정의 SG·규칙은 Network에 있고 EKS↔Edge 순환 의존은 없어야 한다.
EKS 전용 구성은 4스택이다. **첫 배포 후 이 context 전체를 운영 배포 설정에 보존한다.**
`devEksEnabled=false`는 오류이며 생략은 EKS 생성이다. `devOidcClientKeys` 누락도 오류다.
폐기된 ECS 입력을 모두 제거하고 OIDC 원본 목록은 빠짐없이 이전한다.
`--outputs-file`은 마지막 배포에 포함된 stack output만 담을 수 있으므로 조회 단계에서 필요한 세 스택을 합친다.
OIDC 원본 key는 CDK에 선언하고, 값 등록·VersionId 선택은 runtime YAML과 Helm 적용 전에 준비한다.

### 2-1. 기존 EKS의 API 접근 전환과 복구 준비

기존 EKS가 있다면 변경 직전 배포에 사용한 **완전한 CDK cloud assembly**와 context를 먼저 보관한다.
아래는 기존 EKS 전환에만 실행한다. 최초 EKS 설치는 이 절의 백업·복구 대신 §2-2의 전체 배포로 진행한다.
이전 assembly가 없거나 배포된 템플릿과 다르면 이전 commit·당시 context로 별도 checkout에서 다시 합성하고
live 템플릿과 일치 여부를 확인하기 전에는 전환하지 않는다. 새 코드로 이전 public 구성을 재합성할 수 없다.

```bash
: "${PREVIOUS_CDK_ASSEMBLY:?현재 배포와 일치하는 이전 cdk.out 절대 경로}"
: "${PREVIOUS_CDK_CONTEXT_FILE:?이전 배포 context 기록 파일}"
mkdir -p "$RUN_DIR/before-access-change"
test ! -e "$RUN_DIR/before-access-change/cdk.out"
cp -R "$PREVIOUS_CDK_ASSEMBLY" "$RUN_DIR/before-access-change/cdk.out"
cp "$PREVIOUS_CDK_CONTEXT_FILE" "$RUN_DIR/before-access-change/context.txt"
for stack in DevNetworkStack DevEksStack; do
  aws --profile "$DEPLOY_PROFILE" cloudformation get-template --stack-name "$stack" \
    --template-stage Original --region "$AWS_REGION" \
    > "$RUN_DIR/before-access-change/$stack-template.json"
  aws --profile "$DEPLOY_PROFILE" cloudformation describe-stacks --stack-name "$stack" \
    --region "$AWS_REGION" > "$RUN_DIR/before-access-change/$stack.json"
done
PREVIOUS_CLUSTER_NAME=$(jq -er '.Stacks[].Outputs[] | select(.OutputKey=="EksClusterName") | .OutputValue' \
  "$RUN_DIR/before-access-change/DevEksStack.json")
aws --profile "$DEPLOY_PROFILE" eks describe-cluster --name "$PREVIOUS_CLUSTER_NAME" \
  --region "$AWS_REGION" --query 'cluster.resourcesVpcConfig' \
  > "$RUN_DIR/before-access-change/eks-api-access.json"

# Network를 먼저 완료한다. 이 단계에는 아직 릴레이 EC2가 없다.
npx cdk deploy DevNetworkStack --exclusively "${EKS_CONTEXT[@]}"
# 이 갱신에서 릴레이와 private-only endpoint를 함께 적용한다.
npx cdk deploy DevEksStack --exclusively "${EKS_CONTEXT[@]}"
```

두 번째 배포에서 public API 직접 접근이 끊긴다. 릴레이 생성과 API 변경 순서는 CloudFormation이
결정하므로 **SSM 준비 확인 뒤에 public API를 닫는 무중단 전환으로 표현하지 않는다.** 유지보수 시간을
확보하고 원래 배포 프로필의 CloudFormation 접근을 유지한다. 배포 후 §2-2에서 SSM Online·Agent 버전을
확인하고 §2-3에서 터널·TLS·Kubernetes 권한을 검증한다. 확인 전에는 Helm 작업을 시작하지 않는다.

전환 실패 시 최초 CloudFormation 실패 이벤트와 endpoint/EC2/SSM 상태를 기록한다. 실패 상태에 따라
CloudFormation rollback을 먼저 완료한 후 저장한 assembly로 아래 순서대로 복구한다. Eks를 먼저 되돌려
릴레이 SG의 cross-stack 참조를 제거한 뒤 Network를 되돌린다. 이전 public endpoint와 CIDR을 복구하고
원래 허용 위치에서 접속을 확인한다. `devEksEnabled=false`나 `cdk destroy`로 복구하지 않는다.

```bash
npx cdk --app "$RUN_DIR/before-access-change/cdk.out" deploy DevEksStack \
  --exclusively --profile "$DEPLOY_PROFILE"
npx cdk --app "$RUN_DIR/before-access-change/cdk.out" deploy DevNetworkStack \
  --exclusively --profile "$DEPLOY_PROFILE"
```

### 2-2. 배포 output과 릴레이 상태 확인

기존 EKS는 §2-1 전환을 완료한 뒤 전체 배포를 진행한다. 신규 EKS는 아래 전체 배포가 클러스터·릴레이를
처음 생성한다. 어느 경우든 EKS API는 private 전용이며 SSM 접속 준비가 검증되기 전에는 접근을 보장하지 않는다.

```bash
npx cdk deploy --all "${EKS_CONTEXT[@]}" --outputs-file "$RUN_DIR/cdk-outputs.json"
for stack in DevEksStack DevEdgeStack DevDataStack; do
  aws cloudformation describe-stacks --stack-name "$stack" --region "$AWS_REGION" \
    > "$RUN_DIR/$stack.json"
done
jq -s '{Stacks: [.[].Stacks[]]}' "$RUN_DIR/DevEksStack.json" "$RUN_DIR/DevEdgeStack.json" "$RUN_DIR/DevDataStack.json" \
  > "$RUN_DIR/deployed-outputs.json"
# CFN에는 bootstrap attribute가 없다. 운영자가 조회한 JSON을 생성기가 9098·리전·같은 cluster 주소와 대조한다(ADR-0035).
MSK_CLUSTER_ARN=$(jq -er '.Stacks[].Outputs[] | select(.OutputKey=="MskClusterArn") | .OutputValue' \
  "$RUN_DIR/deployed-outputs.json")
aws kafka get-bootstrap-brokers --cluster-arn "$MSK_CLUSTER_ARN" --region "$AWS_REGION" --output json \
  > "$RUN_DIR/msk-bootstrap.json"
# CLI 기본 pagination을 유지한다. bootstrap 목록은 전체 broker를 보장하지 않는다.
aws kafka list-nodes --cluster-arn "$MSK_CLUSTER_ARN" --region "$AWS_REGION" --output json \
  > "$RUN_DIR/msk-nodes.json"
node scripts/eks-values.mjs --outputs "$RUN_DIR/deployed-outputs.json" \
  --output-dir "$RUN_DIR/generated" \
  --enrollment-image "$ENROLLMENT_IMAGE" --ingest-image "$INGEST_IMAGE" \
  --dashboard-image "$DASHBOARD_IMAGE" --gateway-image "$GATEWAY_IMAGE" \
  --runtime-values "$RUNTIME_VALUES" --msk-bootstrap "$RUN_DIR/msk-bootstrap.json" \
  --msk-nodes "$RUN_DIR/msk-nodes.json"
EKS_CLUSTER_NAME=$(jq -er '.Stacks[].Outputs[] | select(.OutputKey=="EksClusterName") | .OutputValue' \
  "$RUN_DIR/deployed-outputs.json")
EKS_OPERATOR_ROLE_ARN=$(jq -er '.Stacks[].Outputs[] | select(.OutputKey=="EksOperatorRoleArn") | .OutputValue' \
  "$RUN_DIR/deployed-outputs.json")
EKS_RELAY_INSTANCE_ID=$(jq -er '.Stacks[].Outputs[] | select(.OutputKey=="EksRelayInstanceId") | .OutputValue' \
  "$RUN_DIR/deployed-outputs.json")
EKS_RELAY_SESSION_DOCUMENT=$(jq -er '.Stacks[].Outputs[] | select(.OutputKey=="EksRelaySessionDocumentName") | .OutputValue' \
  "$RUN_DIR/deployed-outputs.json")
aws --profile "$DEPLOY_PROFILE" ssm describe-instance-information --region "$AWS_REGION" \
  --filters "Key=InstanceIds,Values=$EKS_RELAY_INSTANCE_ID" \
  --query 'InstanceInformationList[].{InstanceId:InstanceId,PingStatus:PingStatus,AgentVersion:AgentVersion}' \
  > "$RUN_DIR/relay-ssm-status.json"
jq -e 'length == 1 and .[0].PingStatus == "Online"' "$RUN_DIR/relay-ssm-status.json"
```

`relay-ssm-status.json`의 AgentVersion도 3.1.1374.0 이상인지 확인한다. Online이 아니면 인스턴스 역할,
SSM Agent 기동, public IPv4·Internet Gateway 경로, 443 아웃바운드를 점검한다. 이 조회는 operator 역할의
권한에 포함되지 않는다. 생성기는 리소스 참조만 읽고 AWS·Secrets Manager를 호출하지 않는다.

### 2-3. 로컬 operator 프로필·터널·kubeconfig

로컬에 전용 operator 역할 프로필을 준비한다. 다음 명령은 역할 ARN·프로필명·세션명만 저장하며
credential 원문을 출력하거나 복사하지 않는다. `OPERATOR_SOURCE_PROFILE`은 같은 계정에서 이 role을
AssumeRole할 권한이 있는 기존 프로필이다. 배포 프로필의 전역 `AWS_PROFILE`은 변경하지 않는다.
`OPERATOR_SESSION_NAME`은 사람마다 다른 식별자(영문·숫자·하이픈 권장)를 사용하고 공유하지 않는다.
같은 role의 같은 세션명을 공유하면 호출자 세션 구분이 약해진다.

```bash
: "${EKS_OPERATOR_PROFILE:?새 전용 operator 역할 프로필 이름}"
: "${OPERATOR_SOURCE_PROFILE:?operator role AssumeRole 권한이 있는 기존 프로필}"
: "${OPERATOR_SESSION_NAME:?운영자별 고유한 역할 세션 이름}"
aws configure set role_arn "$EKS_OPERATOR_ROLE_ARN" --profile "$EKS_OPERATOR_PROFILE"
aws configure set source_profile "$OPERATOR_SOURCE_PROFILE" --profile "$EKS_OPERATOR_PROFILE"
aws configure set role_session_name "$OPERATOR_SESSION_NAME" --profile "$EKS_OPERATOR_PROFILE"
aws configure set region "$AWS_REGION" --profile "$EKS_OPERATOR_PROFILE"
aws --profile "$EKS_OPERATOR_PROFILE" sts get-caller-identity --query Arn --output text
```

원래 소스 프로필의 로그인·MFA가 필요하면 기존 인증 절차를 먼저 완료한다. 프로필을 우회하는 임시
credential 환경변수는 두 터미널에서 사용하지 않는다. 반환 ARN이 해당 operator role 세션인지 확인한다.
터미널 1에서 아래 터널을 유지한다. 기본 로컬 포트는 8443이며 충돌하면 1024~65535의 빈 포트를 선택해
터미널 2에도 같은 값을 지정한다. 목적지 hostname과 443은 CDK 소유 문서에 고정되므로 `host`나
`portNumber`를 전달하지 않는다. 일반 shell·SSH·범용 port-forward 문서는 operator 권한에 포함하지 않는다.

```bash
# 터미널 1: §2-2의 output 값과 같은 operator 프로필·리전을 사용한다.
EKS_LOCAL_PORT=${EKS_LOCAL_PORT:-8443}
aws --profile "$EKS_OPERATOR_PROFILE" ssm start-session --region "$AWS_REGION" \
  --target "$EKS_RELAY_INSTANCE_ID" --document-name "$EKS_RELAY_SESSION_DOCUMENT" \
  --parameters "localPortNumber=$EKS_LOCAL_PORT"
```

`StartSession`이 `AccessDenied`이면 호출 principal·대상 인스턴스·문서 ARN과 배포된 operator 정책을
확인한다. 인스턴스 허용문의 `ssm:SessionDocumentAccessCheck`는 `BoolIfExists: true`여야 한다.
기존 `Bool: true`는 요청 평가에 조건 키가 없을 때도 불일치한다. `BoolIfExists`는 키 없음 또는
`true`일 때 일치하고 `false`이면 불일치한다. 실제 오류 원인이 키 누락인지는 실패 증거 없이 단정하지
않으며, 정책 수정 후에도 전용 문서 지정과 대상 제한을 유지한다.

터미널 2에는 `RUN_DIR`, `DEPLOY_PROFILE`, `AWS_REGION`, `EKS_CLUSTER_NAME`, `EKS_OPERATOR_PROFILE`, `EKS_LOCAL_PORT`를
같은 값으로 설정한다. 기존 `~/.kube/config`와 분리한 파일을 사용하고, kubeconfig의 AWS exec 인증에도
operator 프로필을 고정한다. 이미 이 역할로 인증하는 프로필이므로 `--assume-role-arn`·`--role-arn`을
덧붙여 자기 자신을 다시 AssumeRole하지 않는다.

```bash
# 터미널 2: AWS_PROFILE은 여전히 원래 배포 프로필이다.
export AWS_PROFILE="$DEPLOY_PROFILE"
EKS_LOCAL_PORT=${EKS_LOCAL_PORT:-8443}
export KUBECONFIG="$RUN_DIR/kubeconfig-ssm"
EKS_CONTEXT_NAME=pulsemetry-dev-ssm
EKS_USER_NAME=pulsemetry-dev-operator
aws --profile "$EKS_OPERATOR_PROFILE" eks update-kubeconfig --name "$EKS_CLUSTER_NAME" \
  --region "$AWS_REGION" --kubeconfig "$KUBECONFIG" \
  --alias "$EKS_CONTEXT_NAME" --user-alias "$EKS_USER_NAME"
chmod 600 "$KUBECONFIG"
EKS_KUBECONFIG_CLUSTER=$(kubectl config view --minify -o jsonpath='{.contexts[0].context.cluster}')
EKS_API_ENDPOINT=$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')
EKS_API_HOST=${EKS_API_ENDPOINT#https://}
kubectl config set-cluster "$EKS_KUBECONFIG_CLUSTER" \
  --server="https://127.0.0.1:$EKS_LOCAL_PORT" --tls-server-name="$EKS_API_HOST"
kubectl config set-credentials "$EKS_USER_NAME" --exec-env="AWS_PROFILE=$EKS_OPERATOR_PROFILE"
kubectl config current-context
kubectl --request-timeout=15s get --raw=/readyz
kubectl auth can-i '*' '*' --all-namespaces
kubectl auth can-i create nodepools.karpenter.sh
kubectl auth can-i create secretproviderclasses.secrets-store.csi.x-k8s.io --namespace pulsemetry-dev
helm list --all-namespaces
```

`set-cluster`는 기존 CA 정보를 유지하면서 접속 주소만 루프백으로 바꾸고 TLS 검증 이름은 원래 EKS
hostname으로 설정한다. `insecure-skip-tls-verify`를 사용하지 않는다. `update-kubeconfig`를 다시 실행하면
server가 원래 endpoint로 돌아오므로 위 루프백·TLS 설정도 다시 적용한다.
[AWS CLI kubeconfig](https://docs.aws.amazon.com/cli/latest/reference/eks/update-kubeconfig.html)와
[kubectl set-cluster](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_config/kubectl_config_set-cluster/)의 동작을 따른다.
context의 계정·리전과 cluster ARN을 확인한다. CRD 설치 전 `can-i`는 리소스 인식 경고가 날 수 있어
설치 후 다시 확인한다. 이후 이 터미널의 `kubectl`·Helm은 같은 `KUBECONFIG`를 사용한다.

터널 종료·로컬 포트 변경·AWS 세션 만료 시 작업을 멈추고 같은 프로필로 인증·터널을 다시 준비한다.
릴레이 재생성 후에는 output의 새 InstanceId를 다시 읽는다. CloudFormation 완료나 SSM Online만으로
TLS·Kubernetes 권한 성공을 기록하지 않는다. live 수락 기록에는 public endpoint 비활성, 터널을 통한
`readyz`·Helm 조회, 다른 대상·문서 생략·일반 shell·범용 포워딩 문서의 SSM 거부,
다른 운영자 세션의 종료·재개 거부를 포함한다.

### 주요 output 대응

| output | 소비자 |
|---|---|
| EksNodeRoleName, EksSubnetIds, EksAppNodeSecurityGroupId, EksClickhouseNodeSecurityGroupId, EksClickhouseAvailabilityZone | 기반 NodeClass/NodePool |
| EksClusterName, EksRegion, EksVpcId | LBC 및 앱 TGB |
| EksOperatorRoleArn, EksOperatorRoleName | 계정 IAM의 AssumeRole 권한 지정과 kubeconfig 인증 |
| EksRelayInstanceId, EksRelaySessionDocumentName | operator 프로필의 SSM 터널 대상과 전용 문서 (`soma-376-dev-eks-api-tunnel`) |
| DbRelayInstanceId, DbOperatorRoleArn, DbRelayPostgresSessionDocumentName, DbRelayClickHouseSessionDocumentName (`DevDataStack`) | 로컬 DB 터널 helper |
| DbEndpoint, DbSecretArn, TokenHashSecretArn, AdminApiTokenSecretArn, RawSignalBucketName, ArchivePrefix | runtime/앱 values |
| ValidationPublicBaseUrl, ValidationTelemetryIngestTargetGroupArn, ValidationEnrollmentApiTargetGroupArn, ValidationDashboardApiTargetGroupArn | 검증 앱/TGB |
| EksDashboardApiNodePort, DashboardRdsSourceSecretArn, DashboardRdsCacheSecretArn, DashboardClickHouseSourceSecretArn, DashboardClickHouseCacheSecretArn, UserJwtPrivateKeySecretArn, UserJwtPublicKeysSecretArn | dashboard 및 JWT runtime YAML |
| ApplicationLogGroupName | Fluent Bit |
| TelemetryJwtPrivateKeySecretArn, TelemetryJwtPublicKeysSecretArn (`DevDataStack`) | telemetry JWT runtime SPC 3개 |
| MskClusterArn, MskClusterName, MskStage, MskTopicName, MskConsumerGroupName | bootstrap 조회와 Gateway·ingest·관리 Job values |
| MskGatewayRoleArn, MskIngestRoleArn, MskTopicAdminRoleArn, MskOffsetAdminRoleArn, Msk*SessionName | `PULSEMETRY_KAFKA_IAM_*`와 관리 Job client.properties |
| EksTelemetryGatewayNodePort, ValidationTelemetryGatewayTargetGroupArn, ValidationOtlpTarget | Gateway Service/TGB와 ingest 모드 호환 검사 |
| MskBrokerLogGroupName | broker 로그 조회 |
| OidcClientSecretArns (`DevDataStack`) | key→ARN JSON 맵. EKS 입력에서 선택한 OIDC key의 ARN을 runtime/enrollment values에 주입 |
| EksLbcRoleArn, RuntimeEnrollmentRoleArn, RuntimeTelemetryIngestRoleArn, RuntimeDashboardRoleArn, RuntimeFluentBitRoleArn, RuntimeTelemetryGatewayRoleArn, RuntimeTelemetryKafkaAdminRoleArn, RuntimeTelemetryKafkaOffsetsRoleArn | CDK Pod Identity 검증 증거 |

NodeClass의 `role`에는 **role 이름**을 쓴다. ARN은 AccessEntry와 Pod Identity에 쓴다.

## 3. 기반·컨트롤러·런타임 설치

처음에는 노드가 0개여도 정상이다. 앱 NodePool에 배치할 controller Pod가 생기면 Auto Mode가
노드를 만든다. ClickHouse NodePool은 전용 taint와 첫 AZ 제약을 가진다.

```bash
helm upgrade --install pulsemetry-dev-platform helm/dev/platform/base \
  --namespace kube-system --values "$RUN_DIR/generated/base.yaml" --wait --timeout 10m
kubectl get nodeclasses.eks.amazonaws.com,nodepools.karpenter.sh
(cd helm/dev/platform/lbc && shasum -a 256 -c SHA256SUMS)
kubectl apply --server-side -f helm/dev/platform/lbc/crds/
helm upgrade --install aws-load-balancer-controller \
  helm/dev/platform/lbc/vendor/aws-load-balancer-controller-3.6.0.tgz \
  --namespace kube-system --skip-crds --values helm/dev/platform/lbc/values.yaml \
  --values "$RUN_DIR/generated/lbc.yaml" --wait --timeout 15m
kubectl -n kube-system rollout status deployment/aws-load-balancer-controller --timeout=5m
kubectl get nodes -L karpenter.sh/nodepool,kubernetes.io/arch,topology.kubernetes.io/zone
```

LBC가 `elbv2.k8s.aws/v1beta1` TGB만 처리하도록 설정한다. Auto Mode native TGB와 섞지 않는다.
`spec.networking`을 넣거나 CDK SG rule description에 LBC shared rule 표식을 넣지 않는다.
controller가 실패하면 clusterName/region/vpcId, Pod Identity, control-plane→node 9443 ingress를 확인한다.
IAM의 `RegisterTargets/DeregisterTargets`는 TG 이름 접두사와 `pulsemetry:eks-cluster` 태그를 모두 검사한다.

runtime archive는 공식 고정 URL에서 받고 SHA256이 맞지 않으면 설치를 중단한다.

```bash
python3 - "$RUN_DIR/charts" <<'PY'
import hashlib, json, pathlib, sys, urllib.parse, urllib.request
root = pathlib.Path(sys.argv[1])
for name, pin in json.load(open('helm/dev/runtime/versions.json')).items():
    if not isinstance(pin, dict):
        continue
    data = urllib.request.urlopen(pin['url'], timeout=60).read()
    if hashlib.sha256(data).hexdigest() != pin['sha256']:
        raise SystemExit(f'{name}: SHA256 불일치')
    (root / pathlib.PurePosixPath(urllib.parse.urlparse(pin['url']).path).name).write_bytes(data)
PY
helm upgrade --install secrets-store-csi-driver "$RUN_DIR/charts/secrets-store-csi-driver-1.6.1.tgz" \
  --namespace kube-system --values helm/dev/runtime/csi-driver-values.yaml --wait --timeout 15m
helm upgrade --install secrets-provider-aws "$RUN_DIR/charts/secrets-store-csi-driver-provider-aws-3.1.4.tgz" \
  --namespace kube-system --values helm/dev/runtime/ascp-values.yaml \
  --values "$RUN_DIR/generated/ascp.yaml" --wait --timeout 15m
helm upgrade --install fluent-bit "$RUN_DIR/charts/fluent-bit-0.58.3.tgz" \
  --namespace pulsemetry-dev-logs --create-namespace \
  --values helm/dev/runtime/fluent-bit-values.yaml \
  --values "$RUN_DIR/generated/fluent-bit.yaml" --wait --timeout 15m
helm upgrade --install runtime-config helm/dev/runtime/chart \
  --namespace pulsemetry-dev --values "$RUN_DIR/generated/runtime.yaml" --wait --timeout 5m
kubectl -n kube-system get daemonsets
kubectl -n pulsemetry-dev-logs get daemonsets
kubectl -n pulsemetry-dev get secretproviderclasses
aws eks list-pod-identity-associations --cluster-name "$EKS_CLUSTER_NAME" --region "$AWS_REGION"
```

Auto Mode 기본 DNS·네트워킹·Pod Identity agent·EBS CSI를 따로 설치하지 않는다.
Secrets Store CSI는 EBS CSI와 역할이 다르므로 위 별도 설치가 필요하다. upstream chart가 ASCP 의존
CSI를 다시 설치하지 않도록 `secrets-store-csi-driver.install=false`를 유지한다.
동기화 Kubernetes Secret과 자동 회전은 끈다. UID 10001의 initContainer가 필수 파일을 출력 없이
검사한다. 실제 mount 권한과 Pod Identity 성공은 이 단계와 앱 시작에서 확인하며 로컬 fixture로 대체하지 않는다.

## 4. 기존 ClickHouse → enrollment → ingest 순서

```bash
helm upgrade --install clickhouse helm/dev/workloads/clickhouse --namespace pulsemetry-dev --reset-values \
  --values "$RUN_DIR/generated/clickhouse.yaml" --wait --timeout 15m
kubectl -n pulsemetry-dev rollout status statefulset/clickhouse --timeout=10m
kubectl -n pulsemetry-dev get pvc,pods -o wide
kubectl get pv
helm upgrade --install enrollment-api helm/dev/workloads/spring-app --namespace pulsemetry-dev \
  --values helm/dev/workloads/enrollment-api.yaml \
  --values "$RUN_DIR/generated/enrollment-api.yaml" --wait --timeout 10m
kubectl -n pulsemetry-dev rollout status deployment/enrollment-api --timeout=5m
helm upgrade --install telemetry-ingest helm/dev/workloads/spring-app --namespace pulsemetry-dev \
  --values helm/dev/workloads/telemetry-ingest.yaml \
  --values "$RUN_DIR/generated/telemetry-ingest.yaml" --wait --timeout 10m
kubectl -n pulsemetry-dev rollout status deployment/telemetry-ingest --timeout=5m
kubectl -n pulsemetry-dev get pods,services,targetgroupbindings -o wide
```

ClickHouse PVC가 `pulsemetry-dev-gp3`·50Gi·Retain·첫 AZ를 쓰는지 확인한다.
각 Pod의 nodepool/architecture, 앱 1Gi request·2Gi limit, Recreate 배포와 실제 시작 시간을 기록한다.
앱의 필수 Secret 파일 검사가 실패하면 원문을 읽지 않고 association·권한·SPC alias·CSI 이벤트를 점검한다.
기존 DB·HMAC Secret 변경은 enrollment부터 명시적으로 재시작하고 ready를 확인한 다음 ingest를 재시작한다.
JWT 변경에는 이 순서를 적용하지 않고 §11의 모든 verifier → signer 전환을 따른다.
telemetry-ingest는 생성기의 `ingestMode`(기본 http)대로 설치된다. topic 초기화 Job·Gateway·dual/kafka 전환과
telemetry JWT 공개키 선배포는 [telemetry Kafka 런북](dev-telemetry-kafka.md)의 순서를 따른다.

## 5. 검증 ALB와 실제 데이터 확인

```bash
jq -r '.Stacks[].Outputs[] | select(.OutputKey | test("^Validation.*TargetGroupArn$")) | .OutputValue' \
  "$RUN_DIR/deployed-outputs.json" | while IFS= read -r tg; do
    aws elbv2 describe-target-health --target-group-arn "$tg" --region "$AWS_REGION"
  done
VALIDATION_URL=$(jq -r '.Stacks[].Outputs[] | select(.OutputKey=="ValidationPublicBaseUrl") | .OutputValue' \
  "$RUN_DIR/deployed-outputs.json")
curl --path-as-is -sS -o /dev/null -w '%{http_code}\n' "$VALIDATION_URL/not-a-route"
curl --path-as-is -sS -o /dev/null -w '%{http_code}\n' "$VALIDATION_URL/api/v1/healthz"
```

두 요청은 public routing상 404여야 한다. healthz는 TG health check 전용이며 public rule로 추가하지 않는다.
앱 TG는 해당 앱 NodePort의 instance target이다. ClickHouse 공개 listener/TG/TGB는 없으며
[DB 릴레이](dev-database-access.md) 연결 후 로컬 `http://127.0.0.1:18123/ping`으로 확인한다.
남는 앱 TG의 target 목록과 healthy 상태를 배포 전후 비교하고 앱 `Validation*` output과 TGB ARN을 보존한다.
같은 Web ACL을 공유하므로 검증 요청도 같은 rate rule 집계에 영향을 줄 수 있다. 이는 [AWS의
rule 인스턴스별 집계 설명](https://docs.aws.amazon.com/waf/latest/developerguide/waf-rule-statement-type-rate-based.html)에
따른 운영상 추론이며, 부하 검증 전 동일 출발지 IP를 공유하는 트래픽 영향을 확인한다.

아래는 실행 결과를 반드시 남길 검증이다. API별 실제 payload는 backend 계약과 검증 tenant를 기준으로 한다.

| 확인 | 성공 증거 | 실패 시 |
|---|---|---|
| enrollment·인증·bootstrap | 유효/무효 인증 구분, 응답 URL이 검증 ALB를 가리킴, 바이너리 실제 공급 | 앱 준비/이미지/계약 확인 |
| OTLP 세 경로 | 정상 시그널과 잘못된 payload·인증의 기대 상태 코드 | 인증·압축·크기·파싱 로그 확인 |
| S3 archive | 전용 event ID의 `eks_validation/...` 객체, 원본 로그에 토큰 없음 | prefix/PutObject/Pod Identity 확인 |
| ClickHouse | 같은 event ID의 적재·필드·중복/재시도 결과 | 앱 처리/스키마/스토리지 확인 |
| WAF | 기존 Web ACL association 2개, 정상/차단/Count 구분·로그 마스킹 | 임의 allow 예외 추가 금지, 정책 재검토 |
| CloudWatch | enrollment·ingest·ClickHouse 로그, `/eks/dev/application` 14일, 타 namespace 제외 | Fluent Bit/role/hostPath 확인 |
| 재시작/교체 | Pod 및 노드 교체 후 PV/AZ/target registration/로그 복구 | 손실·지연 증거 기록, 승격 중단 |

S3 object 개수는 batch 크기 때문에 이벤트 개수와 다르다. 검증 event ID 집합으로 S3와 CH를 대조한다.
S3 조회·정리는 운영자 권한이며 ingest role에 List/Get/Delete를 추가하지 않는다. 공유 RDS와 bucket prefix는
완전한 데이터 격리가 아니다. 실제 AWS 통신·파일 권한·WAF signature와 로그 보호·메모리 안정성은 별도 증거다.

## 6. 별도 작업으로 archive prefix 전환

PROJ-248은 prefix를 변경하지 않는다. 아래는 별도로 prefix 전환을 선택한 경우의 절차다.
기존 객체는 이동하지 않고 EKS가 새로 받는 데이터부터 `eks/`에 쓴다.
PutObject IAM과 Helm values가 한쪽만 바뀐 상태에서 ingest가 계속 수신하면 S3 쓰기가 실패하므로 다음 순서다.

1. 수신 트래픽을 멈추고 처리 완료를 확인한다.
2. EKS ingest를 0 replica로 내려 쓰기를 멈춘다. 직접 scale은 임시 운영 조치이고 Helm 선언은 replica 1을 유지한다.
3. 영속 CDK 설정의 `devEksArchivePrefix=eks`를 반영하고 EKS stack의 IAM을 배포한다. `devEksEnabled=true`를 유지한다.
4. 배포 output을 다시 조회해 generator를 실행한다. generated ingest prefix가 `eks`, IAM Resource가 `eks/*`인지 대조한다.
5. Helm upgrade로 replica 1을 복구하고 새 event ID가 `eks/`에 기록되는지 확인한다.

```bash
kubectl -n pulsemetry-dev scale deployment/telemetry-ingest --replicas=0
# EKS_CONTEXT의 기존 prefix 인자를 변경한다. 서로 다른 prefix 인자를 중복 전달하지 않는다.
for index in "${!EKS_CONTEXT[@]}"; do
  if [[ "${EKS_CONTEXT[$index]}" == devEksArchivePrefix=* ]]; then
    EKS_CONTEXT[$index]=devEksArchivePrefix=eks
  fi
done
printf '%s\n' "${EKS_CONTEXT[@]}" > "$RUN_DIR/cdk-context-args.txt"
npx cdk diff DevEksStack "${EKS_CONTEXT[@]}"
npx cdk deploy DevEksStack "${EKS_CONTEXT[@]}" --outputs-file "$RUN_DIR/cdk-outputs.json"
```

§2의 output 재조회·generator와 §4의 ingest Helm upgrade를 다시 실행한다. 검증 prefix로 돌아갈 때도
수신 중단 → IAM 변경 → output/values 재생성 → Helm 재개 순서다. `eks_validation/*`은 7일 expiration으로
정리하며 이동·복사하지 않는다. prefix 전환 자체가 Canary 승격은 아니다.

## 7. 과거 Canary·데이터 이관 계획의 대체

ADR-0028의 Canary와 ECS 데이터 PVC 이관은 ADR-0035의 조기 철거 결정으로 대체됐다.
기존 ECS의 데이터를 계속 쓰는 설정이나 구 TG를 이 런북에서 만들지 않는다. 실제 철거는 수동 Snapshot 후
Application → Edge → Network → cicd 순서이며 [철거 런북](dev-ecs-retirement.md)을 따른다.
과거 RPO/RTO·Canary 수치는 검증된 운영 SLO가 아니고 ECS 복귀를 현재 복구 수단으로 가정하지 않는다.

## 8. 장애 유형별 복구

| 실패 | 복구 | 복구하지 않는 것 |
|---|---|---|
| SSM 터널·private API 접근 | §2의 output·Online·Agent·프로필·TLS 확인, 전환 실패면 저장 assembly로 Eks → Network 복구 | EKS 비활성화·삭제, SG 인바운드 전면 개방, TLS 검증 우회 |
| Helm 앱 설정·이미지 | 기록된 마지막 검증 revision으로 해당 release rollback, rollout/health 확인 | DB migration·PVC 내용 |
| JWT 키 참조 | §11의 공개키 버전·맵 선행 적용 후 개인키 VersionId·active-kid 복구 | 이미지·Helm rollback만으로 키 버전·label 보존 복구 |
| LBC·CSI·ASCP | controller 로그/이벤트·association·버전을 확인하고 호환 release 복구 | CRD 자동 다운그레이드·CRD 삭제 |
| EKS 경로 장애 | 수신 중단, 마지막 정상 Helm 입력·TG/권한 상태 대조 | 삭제된 ECS로 자동 복귀 |
| 데이터 손상·이관 실패 | 쓰기 차단 후 검증한 snapshot/PV 복구 절차 | Helm rollback만으로 데이터 복구 |

```bash
: "${FAILED_RELEASE:?복구할 release}"
: "${LAST_GOOD_REVISION:?실제로 검증한 revision}"
helm history "$FAILED_RELEASE" --namespace pulsemetry-dev
helm rollback "$FAILED_RELEASE" "$LAST_GOOD_REVISION" --namespace pulsemetry-dev --wait --timeout 10m
kubectl -n pulsemetry-dev get pods,pvc,targetgroupbindings -o wide
```

rollback은 앱 release용 예시다. platform/controller의 namespace는 버전 표를 따른다. DB migration 호환성을
확인하지 못하면 앱 rollback보다 쓰기 차단·원인 진단을 먼저 한다. PROJ-253 적용 전의 chart revision은
임시 차단 목록을 제거할 수 있다. 복구 이미지에 패치가 없으면 §12의 보호를 유지한 chart와 해당 이미지
digest로 upgrade하여 복구한다. PVC·PV·namespace·CRD를 실패 정리
명목으로 삭제하지 않는다. `helm uninstall`은 스토리지/데이터 복구 전략이 아니다.

## 9. 로컬 검증과 실행 증거

```bash
npm run build
: "${HELM_BIN:?검증한 Helm 3.22.0 실행 파일}"
: "${KUBECONFORM_BIN:?검증한 kubeconform 0.8.0 실행 파일}"
export HELM_BIN KUBECONFORM_BIN
npm test -- --runInBand
node scripts/validate-helm-workloads.mjs
node scripts/eks-values-check-runtime.mjs --packages-dir "$RUN_DIR/charts"
python3 scripts/test-configtree.py --fetch-ref 4d6ccf2e2809344eac9feb1873f2d527eee2f212
```

configtree harness의 source·캐시 준비와 정확한 명령은 [PROJ-212 기준 runtime README](https://github.com/soma-376/infra/blob/f36ccc844431daed2c89096f0696db69efb8415f/helm/dev/runtime/README.md)를
따른다. 형제 checkout이 과거 버전이면 무조건 최신 계약 검증이라고 부르지 않는다. 검증 source SHA와
YAML·DTO hash를 기록한다. NodeClass/NodePool의 로컬 구조 검사와 Kubernetes API server 승인도 구별한다.
`--fetch-ref`는 지정한 backend commit의 소스 5개를 `gh`로 읽는다. 준비한 snapshot이 있으면
`--backend <snapshot 경로>`로 네트워크 없이 실행한다. runtime 검증은 §3에서 받은 고정 archive를
사용한다. schema를 미리 내려받은 환경은 workload 검사에 `KUBERNETES_SCHEMA_LOCATION`, runtime 검사에
`KUBERNETES_SCHEMA_DIR`를 지정할 수 있다. 기본값은 공개 Kubernetes 1.36 schema다.

PROJ-206~212 당시의 로컬 검증 결과와 미검증 경계는 [역사적 로컬 검증 기록](dev-eks-local-validation.md)에 남겼다.
그 기록의 앱 두 개·SPC 두 개·values 여덟 개 수치는 현재 dashboard/JWT 확장의 검증 수치가 아니다.
현재 checkout의 build·Jest·Helm/schema 결과는 실행한 commit과 함께 별도 기록한다.

각 실제 실행은 다음 표를 복사해 별도 증거 파일로 남긴다. 이번 로컬 작업은 아래 live 결과를 채우지 않는다.

| 항목 | 기록 |
|---|---|
| 실행자·승인·시각(KST) | |
| infra SHA·context·CDK diff | |
| backend SHA·ARM64 immutable digest 2개 | |
| cluster/NodeClass/NodePool 상태·AZ·노드 | |
| API private-only·릴레이 SSM Online/Agent·터널 TLS·Kubernetes 권한·SSM 거부 검증 | |
| Helm 버전·release/revision·values hash | |
| Pod Identity·CSI 파일 검사 결과(원문 제외) | |
| JWT 개인키·공개키 VersionId·active-kid·파일 맵, 제한된 배포 입력의 ARN 참조 | |
| JWT 전체 verifier 적용·마지막 구 발급 시각·330초 대기·제거/롤백 결과 | |
| 신규/기존 TG ARN·등록 대상·healthy | |
| event ID·S3 prefix·CH 정합성 | |
| WAF·로그 보호·로그 전달·관찰 메모리 | |
| 실패/중단/복구 시각·데이터 복구점 | |
| 미실행·다음 단계 진입 승인 | |

## 10. dashboard 추가 설치·기능·복구 검증

이 절은 기존 dashboard 구현을 EKS에서 운영하는 절차다. 공통 계정·설정·키 준비와
세 ARM64 이미지 공급 증거가 없으면 실행하지 않는다. 경로·method·OPTIONS와 전체 설정 식별자는
[허브 dashboard 계약](../../../docs/contracts/dashboard-api.md), backend 기동 조건은
[dashboard 운영 명세](../../../pulsemetry-backend/docs/dashboard-server-spec.md)를 따른다.

### 10-1. 최초 이미지와 공통 저장소 준비

1. `soma-376/dashboard-api`의 ARM64 manifest, commit 태그·`dev` 태그·digest와 pull 접근을 확인한다.
   최초 공급은 아직 없는 서비스의 ACTIVE 검사에 종속시키지 않는다.
2. RDS/ClickHouse source·cache 네 계정·권한, 캐시 DB·스키마와 원천 migration을 준비한다.
   Secret과 동일한 계정의 수동 생성·최소 권한 확인은 [공통 준비 런북](dev-dashboard-prerequisites.md)을 따른다.
   enrollment가 먼저 원천 Flyway를 적용하고 dashboard는 자기 캐시 DDL만 기동 시 적용한다.
   RDS cache와 source는 같은 논리 DB, ClickHouse cache와 source는 원천 분석 테이블을 함께 볼 수 있는 서버여야 한다.
3. §11의 별도 Secrets Manager 원본·VersionId·파일 공급·보존 label을 준비하고 공개키 파일·실제 kid 맵·issuer·audience·허용 origin, 현재 사용자·세션·tenant 조회 권한을 확인한다.
   dashboard에 HMAC·관리자 token·개인 서명키·raw S3 권한을 전달하지 않는다.
4. EKS 전용 TG·method/OPTIONS·Pod Identity와 runtime 설정을 확인한다.
5. enrollment의 원천 migration 준비 뒤 ingest·dashboard 순서로 Helm 배포하고 각 기동·기능을 검증한다.
   이미지 build/push는 PROJ-249 이후 ECS 서비스 상태에 의존하지 않는다.

### 10-2. EKS 입력과 설치

dashboard 전용 runtime 참조·ServiceAccount·Pod Identity·SecretProviderClass와 검증 TG output을 준비한다.
CDK는 AWS·SG·TG, Helm은 workload·Service·TGB를 소유한다. ECS TG를 TGB에 전달하지 않는다.
`workload: dashboard-api`, 컨테이너 8081, replica 1·Recreate·UID 10001과 필수 설정 파일 검사가
PROJ-223 구현의 schema/helpers/template에 실제로 지원되는지 먼저 lint/render로 확인한다.

**dashboard NodePort는 30081이다. 실제 가용성은 미검증이다.** PROJ-224의 TG 포트·Network SG·CDK output·Helm Service를
대조하고 실제 할당 충돌이 없음을 확인한 뒤 기록한다. 임의의 다음 번호를 빈 포트로 간주하지 않는다.
기존 앱의 requests 250m/1Gi·limits 1 CPU/2Gi 기준과 apps NodePool의 실제 배치·여유를 확인한다.

선택한 앱 릴리스의 `userAuth`·`dashboard`와 선택적 `oidc`를 runtime YAML에 작성한다.
`test/fixtures/eks-runtime.yaml`은 가짜 버전과 수치를 가진 검증 전용 예시다. writerImage는 EKS YAML에
넣지 않는다. ARN·endpoint·TG·NodePort는 CDK output만 소유하며 입력 YAML의 덮어쓰기·원문·중복key·
미지의 필드는 실패한다. managementEnabled/mailEnabled는 추가 Secret 공급이 없어 false만 허용한다.
생성기는 한 번 읽은 버전·kid/alias 맵으로 runtime과 앱 YAML을 함께 생성한다(PROJ-246부터 Gateway·관리 Job 포함).
OIDC는 `oidc.enabled`, HTTP/HTTPS callback 입력, `clients[].key/versionId`, `userAuth.allowedRedirectUris`로 설정한다.
key는 CDK `devOidcClientKeys`에 선언해 배포한 원본에서 선택한다. 생성기가 DataStack output의 ARN을 넣으므로
generated env만 수정하거나 runtime 입력에 ARN·원문을 추가하지 않는다. 자세한 입력 예시는 [OIDC 런북](dev-oidc-prerequisites.md)을 따른다.
HTTP 입력의 생성·렌더링은 허용하지만 backend의 외부 HTTP callback/복귀 거부와 Cognito의 HTTPS 정책은 유지된다.
따라서 실제 원격 로그인 수락은 HTTPS로 수행한다.

```text
CDK outputs JSON + 앱 digest(Gateway 포함 네 개) + runtime 설정 YAML + MSK bootstrap JSON
  -> scripts/eks-values.mjs
  -> generated/runtime.yaml + enrollment-api.yaml + telemetry-ingest.yaml + dashboard-api.yaml
     + telemetry-gateway.yaml + telemetry-kafka-admin.yaml
  -> Helm --values
```

runtime release는 `generated/runtime.yaml`을 사용한다. 입력 runtime YAML을 Helm에 직접 중첩하거나
`--set-json`으로 맵을 추가하지 않는다. 공개키 맵은 chart가 `SPRING_APPLICATION_JSON`으로 생성한다.
SPC는 VersionId를 고정하고 enrollment만 개인키를 mount한다. UID10001 initContainer가 configtree와
별도 JWT 디렉터리의 필수 파일을 출력 없이 읽는다. ingress·Kubernetes Secret 복제·자동 회전은 없다.

```bash
set -euo pipefail
: "${RUN_DIR:?기존 실행 증거 디렉터리}"
helm lint helm/dev/workloads/spring-app --strict --namespace pulsemetry-dev --kube-version 1.36.0 \
  --values helm/dev/workloads/dashboard-api.yaml --values "$RUN_DIR/generated/dashboard-api.yaml"
helm template dashboard-api helm/dev/workloads/spring-app --namespace pulsemetry-dev --kube-version 1.36.0 \
  --values helm/dev/workloads/dashboard-api.yaml --values "$RUN_DIR/generated/dashboard-api.yaml" \
  > "$RUN_DIR/dashboard-rendered.yaml"
```

출력에서 image·8081/30081·전용 TG·필수 파일·UID·배치를 확인한다. ARN과 VersionId는 참조이며
Secret 원문은 어느 values에도 들어가지 않는다. 기존 사용자 generated 디렉터리는 보존하고 새 RUN_DIR를 사용한다.

ClickHouse·enrollment·ingest의 이전 설치·준비 확인 뒤 dashboard를 설치한다. enrollment의 원천 migration이
준비되지 않았거나 앞 앱이 실패했으면 후속 설치를 멈춘다.

```bash
helm upgrade --install dashboard-api helm/dev/workloads/spring-app --namespace pulsemetry-dev \
  --values helm/dev/workloads/dashboard-api.yaml --values "$RUN_DIR/generated/dashboard-api.yaml" --wait --timeout 10m
kubectl -n pulsemetry-dev rollout status deployment/dashboard-api --timeout=5m
kubectl -n pulsemetry-dev get deployment/dashboard-api
kubectl -n pulsemetry-dev get service/dashboard-api
kubectl -n pulsemetry-dev get targetgroupbindings.elbv2.k8s.aws
kubectl -n pulsemetry-dev get pods -l app.kubernetes.io/instance=dashboard-api \
  -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.status.containerStatuses[*].imageID}{"\n"}{end}'
```

실제 Pod imageID를 같은 릴리스의 ECR ARM64 manifest digest에 대조한다.
multi-platform image index를 썼다면 index digest와 ARM64 하위 manifest digest의 관계까지 기록한다.
Pod Ready·전용 target healthy, 로그 전달·재시작·노드 배치·파일 접근은 설치 증거이며 아래 기능 검증과 구분한다.

### 10-3. 두 ALB의 method/CORS와 기능 검증표

아래 표를 EKS ALB에 적용한다. `{org}`·`{id}`는 전용 검증 데이터다.
요청에는 상관관계 ID를 사용하고 target/app 확인 근거를 남긴다. 401/403 응답만으로 올바른 앱에 전달됐다고 판단하지 않는다.
인증 요청의 토큰은 승인된 런타임 주입으로만 전달하고 명령 이력·응답 파일·로그에 원문을 남기지 않는다.

| 요청 또는 상태 | 기대값과 확인할 근거 |
|---|---|
| `GET /api/v1/organizations/{org}/teams`·`vendors` | dashboard 조회, 유효 사용자 응답·원천/캐시 조회 증거 |
| 동일 URI의 실제 `POST` 명령 | enrollment 명령으로 전달, dashboard로 가리지 않음 |
| `GET /api/v1/organizations/{org}/vendors/{id}`와 `PATCH`·`DELETE` | GET은 dashboard, 쓰기는 enrollment |
| `GET /api/v1/organizations/{org}/onboarding`·`invitations` | enrollment GET 예외 보존 |
| `GET /api/v1/auth/me`·manifest·check-updates와 bootstrap | 기존 enrollment 계약·응답 유지 |
| 공유 URI의 `OPTIONS` + `Access-Control-Request-Method: GET` | 해당 GET 소유 앱과 허용 origin·method·header의 응답 |
| 같은 URI의 `OPTIONS` + 실제 쓰기 request method | enrollment preflight, dashboard GET 응답과 구분 |
| onboarding·invitations의 `OPTIONS` + `GET` | enrollment preflight 보존 |
| OPTIONS의 누락·미지원 request method | 다른 앱의 포괄 GET/쓰기 규칙에 잡히지 않음; 공개 규칙 밖은 404 |
| 미정의 URI·미지원 method·외부 `/api/v1/healthz` | default 404; 내부 TG/probe에서는 health 200 |
| 유효 JWT·폐기/만료 session·비활성 member/tenant·변경된 role | 현재 DB 상태에 따른 수락/거부; JWT만 맞다고 통과하지 않음 |
| source/cache 권한 | 원천 SELECT·자기 캐시 DDL/RW는 성공; 원천 INSERT/DELETE·캐시 밖 쓰기는 거부 |
| 실제 조회·snapshot | 캐시 DDL 완료, 데이터가 있는 검증 tenant의 조회·snapshot·후속 페이지 응답과 만료 계약 |
| WAF | dashboard 앱 본문/query 검사, 등록 rate 세 조건 유지, OTLP/기존 경로와 로그 보호 회귀 |

CORS 응답만 확인하는 다음 예시는 토큰을 사용하지 않는다. 성공 판단에는 위 소유 앱과 실제 요청 검증을 함께 쓴다.

```bash
: "${PUBLIC_BASE_URL:?검증할 EKS ALB URL}"
: "${ALLOWED_ORIGIN:?앱에 설정한 검증 origin}"
: "${VERIFY_ORG_ID:?전용 검증 조직 ID}"
for requested_method in GET POST; do
  curl --silent --show-error --request OPTIONS \
    --header "Origin: $ALLOWED_ORIGIN" \
    --header "Access-Control-Request-Method: $requested_method" \
    --header 'Access-Control-Request-Headers: authorization,content-type,x-request-id' \
    --dump-header "$RUN_DIR/dashboard-preflight-$requested_method.headers" --output /dev/null \
    "$PUBLIC_BASE_URL/api/v1/organizations/$VERIFY_ORG_ID/teams"
done
```

### 10-4. 증거와 복구

기존 §9 증거 양식에 dashboard 릴리스의 backend/infra commit·ECR 태그/digest·Pod imageID,
실제 NodePort·전용 TG/설정 참조·Helm revision, 검사별 기대/실제 결과와 기존 앱 회귀를 추가한다.
계정 ID·비밀 원문·인증 헤더·전체 요청/응답 본문은 공개 증거에 남기지 않는다.

- Helm/이미지 실패: 호환되는 마지막 검증 dashboard revision으로 해당 release만 rollback하고 rollout·target·기능을 확인한다.
- 이미지 실패: 마지막 검증 digest와 함께 기록한 runtime/workload values로 dashboard를 재배포한다.
- 라우팅 실패: 새 dashboard method/OPTIONS 규칙을 해당 변경 절차로 복구하고 enrollment GET·쓰기·OTLP 회귀를 다시 확인한다.
- 설정·권한 실패: 준비된 참조와 최소 권한을 복구한 뒤 dashboard를 명시적으로 재시작한다. 기존 앱 Secret을 공유해 우회하지 않는다.
- DDL·데이터 실패: 앱/Helm rollback과 DB/PVC 복구를 구분한다. 호환성이 확인되지 않으면 후속 승격을 중단하고 원인부터 확인한다.

복구 성공도 설치 상태와 실제 인증·조회·snapshot·method/CORS 증거를 나눠 남긴다.
이번 문서 작업은 위 명령이나 live 검증을 실행하지 않았다.

## 11. 사용자 JWT 키 최초 공급·교체·복구

이 절은 [ADR-0030](../adr/0030-dev-user-jwt-keys-from-secrets-manager.md)의 **구현 이후 운영 수락 절차**다.
현재는 EKS JWT SPC/mount·YAML 생성 입력을 사용한다. ECS writer는 ADR-0035에서 제거했다.
키 초기화는 [공통 준비 런북](dev-dashboard-prerequisites.md)의 수동 절차이며 이 작업에서 실행하지 않았다.
EKS 입력은 [runtime README](../../helm/dev/runtime/README.md)를 따른다.
기존 Secret 3개 및 [과거 로컬 검증 기록](dev-eks-local-validation.md)은 이 절의 완료 증거가 아니다.

### 11-1. 최초 원본과 배포 참조 준비

1. [공통 준비 런북](dev-dashboard-prerequisites.md)에 따라 CDK 원본의 존재를 확인한 뒤,
   명시적인 초기화 작업에서 RSA 2048bit 이상 키쌍과 `kid`를 생성한다. 앱 시작·일반 재배포는 생성하지 않는다.
2. 개인키 PKCS8 PEM과 `kid → X.509 PEM` 공개키 JSON 키링을 별도 Secrets Manager 원본 두 개에 등록한다.
   암호화는 AWS 관리형 `aws/secretsmanager`다. dev EKS는 기존 고정 ARN 원본을 사용한다.
3. 두 등록 버전의 규격·시험 서명/검증·활성 kid 정합을 원문 출력 없이 확인한다. 한쪽 등록 실패 시
   배포 참조 확정을 중단하고 준비한 같은 키쌍으로 복구한다. 재시도로 새 키쌍을 만들지 않는다.
4. 개인키·공개키 VersionId, enrollment active-kid, 공개키 파일 맵과 issuer·audience를 하나의 배포 입력으로
   확정한다. 원본 ARN은 승인된 접근 제한 입력에서 관리하고 저장소 예시·공개 증거의 계정은 placeholder로 적는다.
   원문·인증 토큰을 문서·명령 이력·출력·증거 파일에 남기지 않는다.
5. 활성·교체·롤백 버전에 staging label을 유지한다. VersionId 기록만으로 보존을 보장하지 않는다.
   원본 삭제·동일명 재생성은 ARN을 바꾸므로 앱 배포·stack 삭제와 원본 보존 책임을 분리한다.

승인된 운영자 환경의 수동 초기화·검증 절차 안에서 값을 다루며 원문을 에이전트 문맥으로 가져오는 조회 명령을 사용하지 않는다.
아래 검사는 준비된 참조·exit code·버전·키 식별자·성공/실패만 기록한다.

### 11-2. EKS 키 mount 수락

| 확인 대상 | 실행 전에 갖출 구현과 실제 수락 증거 |
|---|---|
| EKS 권한 | enrollment와 dashboard 전용 Pod Identity 역할·SPC, dashboard 개인키 접근 불가·ingest 사용자 JWT 참조 없음(telemetry JWT는 [telemetry Kafka 런북](dev-telemetry-kafka.md)) |
| EKS 버전·추출 | 각각 `objectVersion=VersionId`, 공개키 JSON의 kid별 jmesPath 인용·alias·파일 맵 일치; 이동 label과 버전 selector를 섞지 않음 |
| EKS mount | 기존 configtree 설정과 별도 키 파일 mount, 경로 설정만 전달, UID 10001로 전체 필수 파일을 원문 출력 없이 검사 |
| 앱 기동 | 파일 누락·빈 내용·읽기 불가·PEM 오류·RSA 규격 거부; enrollment의 활성 kid·modulus 검사와 공급자의 시험 서명/검증을 구별 |
| 실제 인증 | 선택 버전에서 발급한 AT의 모든 enrollment·dashboard 인스턴스 검증, 모르는 kid·다른 키 서명 거부 |

`PULSEMETRY_USER_AUTH_PRIVATE_KEY_FILE`은 enrollment의 실제 파일 경로이며 Secret ARN이나 PEM을 넣지 않는다.
`PULSEMETRY_USER_AUTH_PUBLIC_KEY_FILE`은 `local` 맵의 경로만 바꾸므로 임의 kid와 신·구 키는
`pulsemetry.user-auth.public-key-files`에 정확한 파일 맵으로 제공한다. 공개키 JSON 원문은 PEM 파일이 아니다.
앱이 빈 맵 경로를 제외하는 현행 동작과 별개로 공급자는 배포 입력의 모든 기대 kid·파일을 검사한다.
dashboard에는 개인키·HMAC·관리자 token·raw S3 권한을 제공하지 않는다.

### 11-3. 전체 인스턴스 교체와 롤백

1. 새 키 버전을 등록·검증하고 구·신 공개키가 함께 있는 공개키 버전과 파일 맵을 준비한다.
2. **EKS의 모든 enrollment·dashboard verifier**를 새 공개키 버전·맵으로 재생성한다.
   신·구 토큰 검증이 모두 성공할 때까지 signer는 구 개인키·kid를 사용한다.
3. 모든 enrollment signer의 개인키 VersionId·active-kid를 함께 전환한다. 일부 인스턴스가 실패하면
   후속 제거를 중단하고 구·신 공개키를 유지한다. 전체 signer 중 마지막 구 키 발급 시각을 확인한다.
4. **마지막 구 키 발급 후 330초 이상** 대기한 뒤 구 공개키를 제거한 버전·맵으로 모든 verifier를 재생성한다.
   AT 300초와 skew 30초가 바뀌면 대기 계약도 개정한다. 일반 Helm 설치 순서는 이 절차를 대체하지 않는다.

Secret 값·label·mount 변경만으로 실행 중인 앱의 키가 바뀌지 않는다. 자동 회전·자동 reload는 도입하지 않는다.
각 단계의 참조 버전·인스턴스 전파·실제 검증·마지막 발급 시각·대기·제거 결과를 별도로 남긴다.

롤백은 모든 verifier에 복구 signer의 공개키를 **먼저** 적용·검증한 뒤 개인키 VersionId와 active-kid를 복구한다.
구 공개키가 이미 제거됐다면 보존 버전으로 신·구 키를 다시 제공한다. 신 키 토큰이 발급됐으면
마지막 신 키 발급 후 330초 이상까지 신 공개키를 유지한다. `AWSPREVIOUS`나 최신 값으로 복구 버전을 추측하지 않는다.
이미지·Helm revision만 되돌리고 Secret 참조·파일 맵·label도 복구됐다고 판단하지 않는다.
키 누락·잘못된 PEM·키쌍/kid 불일치·등록 부분 실패·인스턴스 일부 실패·제거 후 롤백을 리허설 수락 조건에 포함한다.

## 12. dev JVM의 임시 blocked.certs 공급

[ADR 0036](../adr/0036-dev-jvm-blocked-certs-configmap.md)은 OpenJDK CVE-2026-91403에 대한
임시 대응으로 dev Spring 앱 네 개(enrollment·ingest·dashboard·Gateway)에 공식 Unix용 차단 목록을 공급한다. 아래 운영 절차는 실제 배포가
승인된 환경에서만 수행한다. PROJ-253의 코드·문서·로컬 검증은 이 절차의 실행 완료를 의미하지 않는다.

### 12-1. 원본과 이미지 사전 검증

1. chart의 `files/blocked.certs`와 [`files/SOURCE.json`](../../helm/dev/workloads/spring-app/files/SOURCE.json)의
   공식 URL·취득 시점·SHA-256을 확인한다. 파일 전체를 원본 그대로 보존한다. 다운로드 오류·빈 파일·
   형식·해시 불일치는 배포를 중단할 조건이며 임의 목록으로 대체하지 않는다.
2. 배포할 네 ARM64 이미지에서 `java.home=/opt/java/openjdk`, 대상 `lib/security/blocked.certs`가
   일반 파일이고 UID 10001로 읽을 수 있는지 확인한다. `cacerts`와 나머지 security 파일도 접근 가능해야 한다.
   이미지에 별도로 추가한 차단 항목이 있으면 새 목록에 보존되는지 대조한 뒤 진행한다.
3. §9의 로컬 검증과 JVM 로드 검증을 수행한다. 앱별 chart 렌더링에서 release별 ConfigMap,
   단일 파일 `subPath`, 읽기 전용 모드 `0444`, checksum annotation을 확인한다.

로컬 파일 해시는 다음처럼 확인한다. SOURCE.json의 해시는 취득 시 고정한 원본과 대조하기 위한 값이다.

```bash
python3 - <<'PY'
import hashlib, json, pathlib
root = pathlib.Path('helm/dev/workloads/spring-app/files')
data = (root / 'blocked.certs').read_bytes()
source = json.loads((root / 'SOURCE.json').read_text())
assert data, 'blocked.certs가 비어 있다'
assert hashlib.sha256(data).hexdigest() == source['sha256'], 'blocked.certs SHA-256 불일치'
print(source['sha256'])
PY
```

JVM 로드 검증에는 로컬 JDK 25의 `javac`와 Docker가 필요하다. 다른 컴파일러가 기본값이면
`JAVAC_BIN`에 JDK 25 `javac` 경로를 지정한다. 실제 배포할 네 ARM64 이미지를 로컬에 준비하고
각 이미지 ID/digest마다 다음을 실행한다. 스크립트는 이미지를 pull하거나 앱을 시작하지 않으며,
네트워크를 차단한 UID 10001 컨테이너에서 기존 차단 항목 보존·JVM 로드·`cacerts` 보존을 검사한다.
ECR 인증 후 `docker pull --platform linux/arm64 <repository@sha256:digest>`로 이미지를 먼저 준비한다.
이미지에 번들보다 최신 차단 항목이 있으면 목록 보존 검증이 실패하므로 검사를 우회하지 않는다.

```bash
set -euo pipefail
: "${ENROLLMENT_IMAGE:?실제 배포 ARM64 repository@sha256:digest}"
: "${INGEST_IMAGE:?실제 배포 ARM64 repository@sha256:digest}"
: "${DASHBOARD_IMAGE:?실제 배포 ARM64 repository@sha256:digest}"
: "${GATEWAY_IMAGE:?실제 배포 ARM64 repository@sha256:digest}"
for image in "$ENROLLMENT_IMAGE" "$INGEST_IMAGE" "$DASHBOARD_IMAGE" "$GATEWAY_IMAGE"; do
  python3 scripts/test-blocked-certs.py --image "$image"
done
```

### 12-2. 적용과 목록 갱신

파일은 각 앱 release의 `<Release.Name>-blocked-certs` ConfigMap으로 공급된다. 앱 컨테이너에만
`/opt/java/openjdk/lib/security/blocked.certs`를 마운트하므로 `runtime-config` release나 기존 Secret/JWT
원본을 변경하지 않는다. runtime/JWT 비활성 렌더링에서도 이 보호는 적용된다.
Gateway에는 기존 telemetry JWT 공개키 mount만 유지하며 DB configtree를 새로 공급하지 않는다.
initContainer는 기존 Secret/JWT 검증만 수행하고 차단 목록 파일은 앱 컨테이너에서 읽는다.

최초 설치는 §4·§10의 순서를 따른다. 이미 네 앱을 운영하는 환경에서 임시 보호만 적용하거나 목록을
갱신할 때는 현재 사용 중인 image digest·runtime 입력을 유지하고 아래처럼 앱 release만 갱신한다.
각 앱이 실패하면 다음 앱으로 넘어가지 않는다. **replica 1·`Recreate`이므로 앱별 재시작 중 중단이 있다.**

```bash
set -euo pipefail
: "${RUN_DIR:?현재 배포에 사용한 generated YAML과 증거 디렉터리}"
for release in enrollment-api telemetry-ingest dashboard-api telemetry-gateway; do
  helm upgrade "$release" helm/dev/workloads/spring-app --namespace pulsemetry-dev \
    --values "helm/dev/workloads/$release.yaml" \
    --values "$RUN_DIR/generated/$release.yaml" --wait --timeout 10m
  kubectl -n pulsemetry-dev rollout status "deployment/$release" --timeout=5m
done
```

`pulsemetry.io/blocked-certs-revision` annotation은 번들 내용의 SHA-256이다. 목록 변경이 새 Pod를
만들어야 하며, 실행 중인 `subPath` 파일이나 이미 초기화된 JVM이 자동 갱신된다고 가정하지 않는다.
ConfigMap만 `kubectl edit`하여 교체하는 방식은 사용하지 않는다. 갱신할 때 공식 원본을 다시 확보하여
출처·취득 시점·해시와 함께 검토하고, 로컬 검증을 통과한 chart를 각 앱에 upgrade한다.

### 12-3. 배포 후 확인과 기록

```bash
set -euo pipefail
for release in enrollment-api telemetry-ingest dashboard-api telemetry-gateway; do
  kubectl -n pulsemetry-dev get "configmap/$release-blocked-certs" -o json \
    | jq -j '.data["blocked.certs"]' | shasum -a 256
  kubectl -n pulsemetry-dev get "deployment/$release" \
    -o jsonpath='{.spec.template.metadata.annotations.pulsemetry\.io/blocked-certs-revision}{"\n"}'
  kubectl -n pulsemetry-dev get pods -l "app.kubernetes.io/instance=$release" \
    -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.metadata.uid}{" "}{.metadata.annotations.pulsemetry\.io/blocked-certs-revision}{" "}{.status.containerStatuses[*].imageID}{"\n"}{end}'
  kubectl -n pulsemetry-dev exec "deployment/$release" -c "$release" -- \
    /bin/sh -ec 'test "$(id -u)" = 10001; test -r /opt/java/openjdk/lib/security/cacerts; sha256sum /opt/java/openjdk/lib/security/blocked.certs'
done
```

세 위치의 해시를 SOURCE.json과 대조하고 실제 Pod가 새 revision·예상 imageID로 생성됐는지 확인한다.
이 명령은 공개 차단 목록만 다루며 Secret/JWT 파일은 읽거나 출력하지 않는다.
Ready·target health·시작 로그와 기존 OIDC·외부 HTTPS 요청의 기능 회귀도 확인한다. 파일 해시·Ready만으로
JVM의 차단 처리나 취약점 E2E가 검증됐다고 기록하지 않는다. 적용 commit, 앱별 Helm revision,
image digest·JVM 버전·Pod UID·차단 목록 해시와 검증 결과를 증거에 남긴다.

### 12-4. 패치 이미지 전환과 임시 조치 제거

1. 해당 취약점이 수정된 Temurin 배포를 확인하고 backend 이미지를 재빌드한다. 실제 ARM64 이미지
   자체의 JVM 버전과 내장 차단 목록을 **임시 mount 없이** 검증한다. 태그 이름만으로 패치를 판정하지 않는다.
2. 검증한 새 image digest를 generated 앱 YAML에 반영하고, chart의 임시 ConfigMap·mount·checksum
   annotation과 번들 파일·관련 임시 검증을 제거하는 변경을 함께 검토한다.
3. 각 앱 release에서 **새 이미지와 보호 제거를 같은 Helm upgrade로** 적용한다. 앱을 하나씩 전환하고
   정상 기동·기능과 이미지 자체의 차단 목록을 확인한다. 이때 기존 보호 없는 이미지에 mount만 먼저 제거하지 않는다.
4. 네 앱의 새 이미지 적용과 ConfigMap·mount·annotation 제거를 확인하고 이 임시 조치의 종료를 기록한다.

복구 시 취약한 이미지를 사용해야 한다면 임시 보호가 있는 chart로 해당 digest를 배포한다.
PROJ-253 이전의 보호 없는 Helm revision으로 무조건 rollback하지 않는다. 적용 실패 시에도 ConfigMap을
먼저 지워 Pod 시작을 막거나, security 디렉터리 전체를 덮어 `cacerts`를 숨기는 방식으로 복구하지 않는다.
