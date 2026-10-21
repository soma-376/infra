# dev EKS 수동 설치·검증·복구 런북

> PROJ-206~212 구현 인터페이스를 반영한 런북이다. 이 문서의 AWS/Kubernetes 명령은 이번 작업에서
> 실행하지 않았다. 로컬 synth·렌더링·fixture 통과와 실제 배포 성공은 다르다.
> 정책의 기준은 [ADR-0028](../adr/0028-dev-eks-auto-mode-transition.md)이다.

## 1. 실행 범위와 사전 조건

운영자가 별도로 배포를 승인받은 뒤 이 순서를 실행한다. 기존 ECS 경로·prod·cicd는 유지한다.
PROJ-213~215의 실제 병행 운영·데이터 이관·Canary·ECS 제거는 이 문서의 초기 설치와 별도 실행이다.

- 원래 배포 주체에 infra 배포와 CloudFormation output 조회 권한이 있어야 한다. CDK가 생성하는
  `soma-376-dev-eks-operator` role은 해당 클러스터의 `eks:DescribeCluster`와 AccessEntry 기반
  Kubernetes 관리 권한만 가진다. CloudFormation/IAM 배포 및 S3 조회·정리는 원래 주체로 실행한다.
- 생성한 role은 같은 계정에 AssumeRole 권한을 위임한다. 계정 IAM에서 실제 운영자에게
  output `EksOperatorRoleArn`에 대한 `sts:AssumeRole` 권한을 부여한다. 모든 계정 주체에게
  AssumeRole 권한이 자동 부여되는 것은 아니며 별도 role/principal ARN context 입력도 없다.
- AWS 계정은 환경 `CDK_DEFAULT_ACCOUNT`로만 전달한다. region은 `ap-northeast-2`다.
- Kubernetes 1.36과 ARM64 t4g.medium의 리전 가용성·할당량, 2개 public subnet의 여유 IP,
  public IPv4 egress를 확인한다. Auto Mode 노드는 SSH/SSM 직접 접속하지 않는다.
- backend와 호환되는 Flyway migration, immutable ARM64 이미지 digest 2개,
  `/api/v1/healthz`의 200 응답, `/bin/sh`, UID 10001 및 바이너리 공급을 확인한다.
- 별도 검증 tenant/token과 검증 event ID 집합을 준비한다. 공유 RDS에는 기존 ECS와 호환되지 않는
  DDL·이미지를 사용하지 않는다. 검증 prefix는 `eks_validation`이고 기존 객체 7일 expiration을 유지한다.
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
: "${EKS_API_ALLOWED_CIDRS:?운영자 IPv4 CIDR 목록}"
: "${DEV_ALLOWED_CIDRS:?ALB와 RDS에 접근할 IPv4 CIDR 목록}"
: "${ENROLLMENT_IMAGE:?registry/repository@sha256:digest}"
: "${INGEST_IMAGE:?registry/repository@sha256:digest}"
: "${RUN_DIR:?실행 증거 디렉터리 절대 경로}"
mkdir -p "$RUN_DIR/generated" "$RUN_DIR/charts"
chmod 700 "$RUN_DIR"
EKS_CONTEXT=(-c env=dev -c devEksEnabled=true
  -c "devEksApiAllowedCidrs=$EKS_API_ALLOWED_CIDRS"
  -c "devAllowedCidr=$DEV_ALLOWED_CIDRS"
  -c devEksArchivePrefix=eks_validation)
printf '%s\n' "${EKS_CONTEXT[@]}" > "$RUN_DIR/cdk-context-args.txt"
git rev-parse HEAD > "$RUN_DIR/infra-commit.txt"
npm run build
npm test -- --runInBand
npx cdk synth --all "${EKS_CONTEXT[@]}" --output "$RUN_DIR/cdk.out"
npx cdk diff --all "${EKS_CONTEXT[@]}" > "$RUN_DIR/cdk-diff.txt"
```

diff에서 기존 ECS·RDS·S3·실제 Secret·ALB/TG·WAF 정책의 삭제/교체가 없고 prod/cicd가
포함되지 않았는지 확인한다. 사용자 정의 SG·규칙은 Network에 있고 EKS↔Edge 순환 의존은 없어야 한다.
활성화 구성은 5스택이다. **첫 배포 후 이 context 전체를 운영 배포 설정에 보존한다.**
특히 `devEksEnabled=false` 또는 키 누락 상태로 Network/Edge를 배포하면 EKS 전용 리소스를 제거한다.
`--outputs-file`은 마지막 배포에 포함된 stack output만 담을 수 있으므로 조회 단계에서 필요한 두 스택을 합친다.

```bash
npx cdk deploy --all "${EKS_CONTEXT[@]}" --outputs-file "$RUN_DIR/cdk-outputs.json"
for stack in DevEksStack DevEdgeStack; do
  aws cloudformation describe-stacks --stack-name "$stack" --region "$AWS_REGION" \
    > "$RUN_DIR/$stack.json"
done
jq -s '{Stacks: [.[].Stacks[]]}' "$RUN_DIR/DevEksStack.json" "$RUN_DIR/DevEdgeStack.json" \
  > "$RUN_DIR/deployed-outputs.json"
node scripts/eks-values.mjs --outputs "$RUN_DIR/deployed-outputs.json" \
  --output-dir "$RUN_DIR/generated" \
  --enrollment-image "$ENROLLMENT_IMAGE" --ingest-image "$INGEST_IMAGE"
EKS_CLUSTER_NAME=$(jq -er '.Stacks[].Outputs[] | select(.OutputKey=="EksClusterName") | .OutputValue' \
  "$RUN_DIR/deployed-outputs.json")
EKS_OPERATOR_ROLE_ARN=$(jq -er '.Stacks[].Outputs[] | select(.OutputKey=="EksOperatorRoleArn") | .OutputValue' \
  "$RUN_DIR/deployed-outputs.json")
aws eks update-kubeconfig --name "$EKS_CLUSTER_NAME" --region "$AWS_REGION" \
  --assume-role-arn "$EKS_OPERATOR_ROLE_ARN" \
  --role-arn "$EKS_OPERATOR_ROLE_ARN"
kubectl config current-context
kubectl auth can-i create nodepools.karpenter.sh
kubectl auth can-i create secretproviderclasses.secrets-store.csi.x-k8s.io --namespace pulsemetry-dev
```

위 명령은 원래 배포·운영 주체를 유지한 상태에서 실행한다. `--assume-role-arn`은 클러스터 정보 조회,
`--role-arn`은 이후 kubectl·Helm 인증에 생성 role을 사용한다. 원래 주체에는 이 role의
`sts:AssumeRole` 권한이 필요하다. 이미 생성 role의 세션을 사용하는 경우 두 role 옵션을 생략해
자기 자신을 다시 AssumeRole하지 않는다. 반환된 context의 cluster ARN과 대상 계정·리전이 계획과
일치하는지 확인한다. 마지막 `can-i`는 CRD 설치 전 리소스 인식 경고가 날 수
있으며 설치 후 다시 확인한다. 생성기는 리소스 참조만 읽고 AWS·Secrets Manager를 호출하지 않는다.
두 role 옵션의 의미는 [AWS CLI update-kubeconfig 문서](https://docs.aws.amazon.com/cli/latest/reference/eks/update-kubeconfig.html)를 따른다.

### 주요 output 대응

| output | 소비자 |
|---|---|
| EksNodeRoleName, EksSubnetIds, EksAppNodeSecurityGroupId, EksClickhouseNodeSecurityGroupId, EksClickhouseAvailabilityZone | 기반 NodeClass/NodePool |
| EksClusterName, EksRegion, EksVpcId | LBC 및 앱 TGB |
| EksOperatorRoleArn, EksOperatorRoleName | 계정 IAM의 AssumeRole 권한 지정과 kubeconfig 인증 |
| DbEndpoint, DbSecretArn, TokenHashSecretArn, AdminApiTokenSecretArn, RawSignalBucketName, ArchivePrefix | runtime/앱 values |
| ValidationPublicBaseUrl, ValidationTelemetryIngestTargetGroupArn, ValidationEnrollmentApiTargetGroupArn, ValidationClickhouseTargetGroupArn | 검증 앱/TGB |
| ApplicationLogGroupName | Fluent Bit |
| EksLbcRoleArn, RuntimeEnrollmentRoleArn, RuntimeTelemetryIngestRoleArn, RuntimeFluentBitRoleArn | CDK Pod Identity 검증 증거 |

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

## 4. ClickHouse → enrollment → ingest 순서

```bash
helm upgrade --install clickhouse helm/dev/workloads/clickhouse --namespace pulsemetry-dev \
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
Secret을 바꾼 뒤에는 enrollment부터 명시적으로 재시작하고 ready를 확인한 다음 ingest를 재시작한다.

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
curl --path-as-is -sS -o /dev/null -w '%{http_code}\n' "$VALIDATION_URL:8123/ping"
```

두 첫 요청은 public routing상 404, ClickHouse ping은 200이어야 한다. healthz는 TG health check 전용이며
public rule로 추가하지 않는다. 앱 TG는 NodePort 30416/30080의 instance target, CH는 Pod IP:8123이어야 한다.
기존 ECS TG의 target 목록과 healthy 상태를 배포 전후 비교한다. 같은 TG를 양쪽이 소유하면 중단한다.
같은 Web ACL을 공유하므로 검증 요청도 같은 rate rule 집계에 영향을 줄 수 있다. 이는 [AWS의
rule 인스턴스별 집계 설명](https://docs.aws.amazon.com/waf/latest/developerguide/waf-rule-statement-type-rate-based.html)에
따른 운영상 추론이며, 부하 검증 전 ECS 트래픽과 공유 NAT/IP 영향을 확인한다.

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

## 6. 검증 완료 후 병행 운영 prefix 전환

검증용 객체는 이동하지 않는다. EKS가 새로 받는 데이터부터 `eks/`에 쓴다. 기존 ECS prefix와 권한은 유지한다.
PutObject IAM과 Helm values가 한쪽만 바뀐 상태에서 ingest가 계속 수신하면 S3 쓰기가 실패하므로 다음 순서다.

1. 검증 트래픽을 멈추고 처리 완료를 확인한다. 아직 기존 ALB는 ECS만 향한다.
2. EKS ingest를 0 replica로 내려 쓰기를 멈춘다. 직접 scale은 임시 운영 조치이고 Helm 선언은 replica 1을 유지한다.
3. 영속 CDK 설정의 `devEksArchivePrefix=eks`를 반영하고 EKS stack의 IAM을 배포한다. `devEksEnabled=true`를 유지한다.
4. 배포 output을 다시 조회해 generator를 실행한다. generated ingest prefix가 `eks`, IAM Resource가 `eks/*`인지 대조한다.
5. Helm upgrade로 replica 1을 복구하고 새 event ID가 `eks/`에 기록되는지 확인한다.

```bash
kubectl -n pulsemetry-dev scale deployment/telemetry-ingest --replicas=0
# EKS_CONTEXT의 기존 prefix 인자를 변경한다. 서로 다른 prefix 인자를 중복 전달하지 않는다.
EKS_CONTEXT=(-c env=dev -c devEksEnabled=true
  -c "devEksApiAllowedCidrs=$EKS_API_ALLOWED_CIDRS"
  -c "devAllowedCidr=$DEV_ALLOWED_CIDRS" -c devEksArchivePrefix=eks)
printf '%s\n' "${EKS_CONTEXT[@]}" > "$RUN_DIR/cdk-context-args.txt"
npx cdk diff DevEksStack "${EKS_CONTEXT[@]}"
npx cdk deploy DevEksStack "${EKS_CONTEXT[@]}" --outputs-file "$RUN_DIR/cdk-outputs.json"
```

§2의 output 재조회·generator와 §4의 ingest Helm upgrade를 다시 실행한다. 검증 prefix로 돌아갈 때도
수신 중단 → IAM 변경 → output/values 재생성 → Helm 재개 순서다. `eks_validation/*`은 7일 expiration으로
정리하며 이동·복사하지 않는다. prefix 전환 자체가 Canary 승격은 아니다.

## 7. 후속 Canary와 최종 이관 경계

PROJ-213~215에서 실행한다. 먼저 기존 ECS ClickHouse를 양쪽 ingest가 보는지 확인하고, **검증 TG와
다른 Canary TG ARN**을 CDK로 생성한다. apps values `targetGroupBindings`의 별도 `canary` 항목을 사용한다.
기존 ECS TG ARN은 입력하지 않는다. backend 변경·인증 identity header 전파·ArgoCD 도입은 하지 않는다.

승격 초기가설은 EKS 1→10→50→100%, 단계별 최소 30분과 서비스별 성공 요청 100건, 100% 24시간이다.
예상 밖 인증 실패·검증 event ID 유실은 0건, 5xx≤1% 및 ECS 대비 증가≤0.5%p, p95≤기준선120%다.
초과하면 승격을 중단하고 저장된 기존 ALB ECS 비중으로 복구한다. **수치는 실측·AWS 권장값·확정 SLO가
아니다.** 실행 전 관찰 기준선과 트래픽 표본에 맞춰 재승인한다.

최종 CH 전환은 쓰기 차단·처리 완료 확인·CH 정지·EBS snapshot·동일 AZ 복원·PVC 복사·event ID 정합성
확인·재개 순서다. 수락·저장 완료 데이터 기준 RPO 0/RTO 30분도 초기 가설이며 리허설로 확인한다.
이 문서는 snapshot 식별자나 데이터 복사 명령을 추정하지 않는다. 리허설에서 확정한 원본 볼륨·AZ·PV와
복구 snapshot을 고정한 뒤 별도 실행한다. 데이터 전환 후 구 CH로 되돌릴 때는 전환 이후 쓰기의 보존을
먼저 해결하며, ALB 비중만 되돌려 서로 다른 저장소에 쓰지 않는다.

## 8. 장애 유형별 복구

| 실패 | 복구 | 복구하지 않는 것 |
|---|---|---|
| Helm 앱 설정·이미지 | 기록된 마지막 검증 revision으로 해당 release rollback, rollout/health 확인 | DB migration·PVC 내용 |
| LBC·CSI·ASCP | controller 로그/이벤트·association·버전을 확인하고 호환 release 복구 | CRD 자동 다운그레이드·CRD 삭제 |
| 검증 경로 장애 | 검증 트래픽 중단, 기존 ECS healthy 확인 후 원인 분석 | 기존 ALB를 검증 TG로 임의 변경 |
| Canary 지표 초과 | 기록한 ALB 가중치를 ECS 쪽으로 복구 | 이미 저장된 데이터의 자동 복구 |
| 데이터 손상·이관 실패 | 쓰기 차단 후 검증한 snapshot/PV 복구 절차 | Helm rollback만으로 데이터 복구 |

```bash
: "${FAILED_RELEASE:?복구할 release}"
: "${LAST_GOOD_REVISION:?실제로 검증한 revision}"
helm history "$FAILED_RELEASE" --namespace pulsemetry-dev
helm rollback "$FAILED_RELEASE" "$LAST_GOOD_REVISION" --namespace pulsemetry-dev --wait --timeout 10m
kubectl -n pulsemetry-dev get pods,pvc,targetgroupbindings -o wide
```

rollback은 앱 release용 예시다. platform/controller의 namespace는 버전 표를 따른다. DB migration 호환성을
확인하지 못하면 앱 rollback보다 쓰기 차단·원인 진단을 먼저 한다. PVC·PV·namespace·CRD를 실패 정리
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

configtree harness의 source·캐시 준비와 정확한 명령은 [runtime README](../../helm/dev/runtime/README.md)를
따른다. 형제 checkout이 과거 버전이면 무조건 최신 계약 검증이라고 부르지 않는다. 검증 source SHA와
YAML·DTO hash를 기록한다. NodeClass/NodePool의 로컬 구조 검사와 Kubernetes API server 승인도 구별한다.
`--fetch-ref`는 지정한 backend commit의 소스 5개를 `gh`로 읽는다. 준비한 snapshot이 있으면
`--backend <snapshot 경로>`로 네트워크 없이 실행한다. runtime 검증은 §3에서 받은 고정 archive를
사용한다. schema를 미리 내려받은 환경은 workload 검사에 `KUBERNETES_SCHEMA_LOCATION`, runtime 검사에
`KUBERNETES_SCHEMA_DIR`를 지정할 수 있다. 기본값은 공개 Kubernetes 1.36 schema다.

이번 구현의 로컬 검증 결과와 미검증 경계는 [로컬 검증 기록](dev-eks-local-validation.md)에 남겼다.

각 실제 실행은 다음 표를 복사해 별도 증거 파일로 남긴다. 이번 로컬 작업은 아래 live 결과를 채우지 않는다.

| 항목 | 기록 |
|---|---|
| 실행자·승인·시각(KST) | |
| infra SHA·context·CDK diff | |
| backend SHA·ARM64 immutable digest 2개 | |
| cluster/NodeClass/NodePool 상태·AZ·노드 | |
| Helm 버전·release/revision·values hash | |
| Pod Identity·CSI 파일 검사 결과(원문 제외) | |
| 신규/기존 TG ARN·등록 대상·healthy | |
| event ID·S3 prefix·CH 정합성 | |
| WAF·로그 보호·로그 전달·관찰 메모리 | |
| 실패/중단/복구 시각·데이터 복구점 | |
| 미실행·다음 단계 진입 승인 | |
