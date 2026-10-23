# dev 데이터베이스 비공개 접근과 SSM 릴레이

PROJ-254·[ADR 0038](../adr/0038-dev-databases-private-access-via-ssm-relay.md)의 운영 절차다.
이번 작업은 로컬 구현·검증이며 아래 AWS/Kubernetes 명령을 실행한 증거가 아니다.
RDS와 ClickHouse의 외부 직접 접속은 제거하고, 기존 EKS API 릴레이와 별도의 DB 릴레이 EC2 한 대를 사용한다.
prod·frontend Terraform·앱 내부 DB endpoint와 DB 로그인 방식은 바꾸지 않는다.

## 1. 접속 구조와 준비

| 접속 | 로컬 주소 기본값 | DB 릴레이의 목적지 | 필요한 프로필 |
|---|---|---|---|
| PostgreSQL | `127.0.0.1:15432` | 고정 RDS endpoint:5432 | DB operator |
| ClickHouse HTTP | `127.0.0.1:18123` | 조회한 현재 Ready Pod IPv4:8123 | Pod 조회용 EKS operator + DB operator |

스크립트는 **사용자 PC에서** 실행하며 `aws ssm start-session`으로 TCP 터널을 연다.
릴레이에 스크립트·kubectl·DB 클라이언트를 보내 실행하지 않는다. SSM Agent만 TCP를 중계한다.
네이티브 ClickHouse 9000은 운영자 터널에 추가하지 않는다. 앱 내부 9000 연결은 유지한다.

- 로컬 Node.js, AWS CLI v2, Session Manager plugin을 준비한다. ClickHouse에는 kubectl도 필요하다.
- SSM Agent는 remote-host forwarding을 지원하는 `3.1.1374.0` 이상이며 보안 패치된 버전을 사용한다.
  CloudFormation 완료와 별개로 SSM Online·설치 버전을 배포 프로필에서 확인한다.
- 기존 EKS 터널과 TLS 검증을 유지하는 별도 kubeconfig는 [EKS 런북 §2](dev-eks-manual-deployment.md#2-eks-활성화-설정과-cdk-배포)를 따른다.
  EKS 터널은 Pod IP를 조회하는 동안 열려 있어야 한다. DB 트래픽은 DB 릴레이를 통과한다.
- `DbOperatorRoleArn`의 AssumeRole 권한은 계정 IAM 관리자가 호출자에 부여한다. 이 레포가 임의 사용자에게
  권한을 부여하지 않는다. DB operator는 DB 릴레이·문서 두 개만 사용하며 EKS 권한을 갖지 않는다.
- 기존 source profile을 사용해 DB operator 프로필을 구성한다. 예시는 `~/.aws/config`의 별도 항목이며,
  ARN은 실제 output을 사용하고 `role_session_name`은 담당자별로 구분한다.

```ini
[profile pulsemetry-dev-db-operator]
role_arn = <DbOperatorRoleArn>
source_profile = <기존-인증-프로필>
role_session_name = <담당자별-세션-이름>
region = ap-northeast-2
```

Data output은 `DbRelayInstanceId`, `DbOperatorRoleArn`, `DbRelayPostgresSessionDocumentName`,
`DbRelayClickHouseSessionDocumentName`이다. helper는 이미 역할을 선택한 프로필을 사용하며 다시 AssumeRole하지 않는다.
터널을 여는 동안 해당 프로필의 인증이 유효해야 한다. 계정 정보·인증 정보는 레포에 저장하지 않는다.

## 2. outputs 준비와 로컬 연결

배포 프로필과 DB operator는 역할이 다르다. CloudFormation 조회는 배포 프로필에서 수행하고,
helper는 저장된 output JSON을 읽기만 한다. `RUN_DIR`는 기존 배포의 레포 밖 작업 디렉터리다.
기존 CDK `--outputs-file` JSON 또는 다음 describe-stacks 통합 JSON을 사용할 수 있다.

```bash
: "${DEPLOY_PROFILE:?배포 및 조회 프로필}"
: "${RUN_DIR:?레포 밖 배포 작업 디렉터리}"
for stack in DevNetworkStack DevDataStack DevEdgeStack DevEksStack; do
  aws --profile "$DEPLOY_PROFILE" --region ap-northeast-2 cloudformation describe-stacks \
    --stack-name "$stack" > "$RUN_DIR/$stack-outputs.json"
done
jq -s '{Stacks: [.[].Stacks[]]}' \
  "$RUN_DIR/DevNetworkStack-outputs.json" "$RUN_DIR/DevDataStack-outputs.json" \
  "$RUN_DIR/DevEdgeStack-outputs.json" "$RUN_DIR/DevEksStack-outputs.json" \
  > "$RUN_DIR/deployed-outputs.json"
```

PostgreSQL 터미널:

```bash
node scripts/dev-db-tunnel.mjs postgres \
  --outputs "$RUN_DIR/deployed-outputs.json" \
  --profile pulsemetry-dev-db-operator
```

ClickHouse는 기존 EKS API 터널을 연 뒤 다른 터미널에서 실행한다.

```bash
: "${KUBECONFIG:?EKS 터널용 별도 kubeconfig}"
: "${EKS_OPERATOR_PROFILE:?기존 EKS operator 프로필}"
node scripts/dev-db-tunnel.mjs clickhouse \
  --outputs "$RUN_DIR/deployed-outputs.json" \
  --profile pulsemetry-dev-db-operator \
  --kubeconfig "$KUBECONFIG" --eks-profile "$EKS_OPERATOR_PROFILE"
```

필요하면 `--local-port 25432`처럼 로컬 포트만 변경한다. 두 DB를 동시에 쓰려면 각각 터미널을 유지한다.
사용 중인 로컬 포트·만료된 AWS 인증·SSM 실패는 오류를 해결한 뒤 다시 실행한다. Ctrl-C로 세션을 종료한다.
helper는 AWS/kubectl 오류와 세션 종료 코드를 전달하며 자동 재접속하지 않는다.

ClickHouse 조회 조건은 namespace `pulsemetry-dev`, release `clickhouse`, Running·Ready,
삭제 중 아님, controller owner `StatefulSet/clickhouse`, 후보 정확히 하나와 dev VPC IPv4다.
kubeconfig는 기존 런북의 `aws eks update-kubeconfig`로 만든 dev cluster ARN·AWS exec 구성을 사용한다.
exec 프로필이 `--eks-profile`과 충돌하거나 별도 `--role-arn`이 있으면 해당 구성을 바로잡는다.
Pod 교체 후 기존 IP를 재사용하지 말고 helper를 재실행한다. 기존 output도 릴레이 교체 후 다시 조회한다.

터널이 열린 뒤 DataGrip/psql/HTTP 클라이언트는 표의 로컬 주소에 연결한다. DB 계정·비밀번호는 기존 방식대로
클라이언트에서 사용하며 helper 인자·values·로그에 넣지 않는다. PostgreSQL TLS를 쓰는 클라이언트는
원래 RDS hostname과 CA 검증을 유지한다(예: libpq의 `host=<원래 RDS hostname>`과
`hostaddr=127.0.0.1` 분리). localhost라는 이유로 인증서 검증을 끄지 않는다.

ClickHouse 기본 HTTP 터널 확인:

```bash
curl --fail --silent --show-error http://127.0.0.1:18123/ping
```

`Ok.`는 연결·ping 증거다. 실제 조회 권한·적재·캐시·애플리케이션 기능 검증을 대신하지 않는다.

## 3. 기존 공개 경로에서 전환

기존 EKS/DB 상태·template·output·Helm 사용자 values와 TG ARN을 먼저 보관한다. OIDC 전체 key, 인증서,
redirect, archive prefix와 OTLP 대상 등 기존 CDK context를 그대로 사용한다. `EKS_CONTEXT`는
현재 환경의 완전한 배열이며, 기존 OIDC 목록을 임의로 `[]`로 대체하지 않는다.
기존 ECS가 아직 남아 있으면 [ECS 철거](dev-ecs-retirement.md)의 선행 조건을 먼저 완료한다.

**첫 전환에 `deploy --all`을 사용하지 않는다.** Network 적용 시 공개 DB 접속이 먼저 끊기므로
Data 릴레이 준비까지 운영자 접속 공백을 잡는다. 앱 DB SG 경로는 계속 유지한다.

1. Network·Data·Edge diff를 검토한다. 신규 릴레이·SG·역할·문서 이외의 리소스 교체,
   RDS 재생성·Secret 변경·기존 EKS relay 변경이 있으면 적용하지 않는다.
2. Network를 단독 갱신해 공개 DB SG 경로를 차단하고 새 릴레이 SG를 만든다.
3. Data를 단독 갱신해 RDS 공개 flag를 끄고 DB 릴레이를 만든다. SSM Online·Agent 버전과
   현재 ClickHouse Pod IP가 속한 ENI의 SG가 ClickHouse SG인지 확인한다. §2 방식으로 outputs를 다시 저장하고
   DB role 위임을 완료한 뒤 두 터널을 검증한다.
4. 갱신한 outputs와 기존 이미지 digest·runtime·MSK 입력으로
   [EKS 생성 절차](dev-eks-manual-deployment.md)를 실행해 새 values를 만든다.
   구 output의 ClickHouse TG 키는 새 생성기가 무시하므로 Edge 삭제 전에도 실행할 수 있다.
5. ClickHouse release만 새 values와 `--reset-values`로 갱신한다. 기존 storage/resources 등 사용자 override를
   보존한 입력을 함께 검토하되 폐기한 `vpcId`·`targetGroupBindings`는 제거한다. 구 values를 그대로 재사용하지 않는다.
6. ClickHouse TGB 삭제·finalizer 완료와 기존 TG의 대상 등록 해제를 확인한다. 실패 시 LBC 이벤트/IAM을
   조사하고 finalizer를 강제로 지우지 않는다. 구 TGB가 남아 있으면 Edge 삭제로 진행하지 않는다.
7. Edge를 단독 갱신해 ClickHouse listener·TG·output을 제거한다. 앱 ALB/TG/WAF와 EKS API 접속을 검증한다.
   outputs를 다시 저장한다. 이후 전체 배포에는 이 전환 단계가 필요하지 않다.

해당 단계에서 사용하는 명령은 다음과 같다. 각 명령 사이의 위 확인 관문을 생략하지 않는다.

```bash
npx cdk diff DevNetworkStack DevDataStack DevEdgeStack "${EKS_CONTEXT[@]}"
npx cdk deploy DevNetworkStack --exclusively "${EKS_CONTEXT[@]}"
npx cdk deploy DevDataStack --exclusively "${EKS_CONTEXT[@]}"
# 여기서 SSM 준비·역할 위임·터널 검증·outputs 및 generated values 재생성을 완료한다.
helm upgrade --install clickhouse helm/dev/workloads/clickhouse \
  --namespace pulsemetry-dev --reset-values \
  --values "$RUN_DIR/generated/clickhouse.yaml" --wait --timeout 15m
kubectl -n pulsemetry-dev rollout status statefulset/clickhouse --timeout=10m
kubectl -n pulsemetry-dev get targetgroupbindings
# 기존 CH TGB가 있으면 삭제 완료를 기다린다. 이미 없으면 다음 단계로 진행한다.
# canary를 썼다면 그 이름도 각각 확인한다. 조회 오류는 해결한 뒤 진행한다.
CH_TGB=$(kubectl -n pulsemetry-dev get targetgroupbinding/clickhouse-validation --ignore-not-found -o name) || exit 1
if [ -n "$CH_TGB" ]; then
  kubectl -n pulsemetry-dev wait --for=delete "$CH_TGB" --timeout=5m
fi
: "${PREVIOUS_CLICKHOUSE_TG_ARN:?보관한 기존 ClickHouse TG ARN}"
aws --profile "$DEPLOY_PROFILE" --region ap-northeast-2 elbv2 describe-target-health \
  --target-group-arn "$PREVIOUS_CLICKHOUSE_TG_ARN"
# TargetHealthDescriptions=[]와 모든 CH TGB 정리가 확인된 뒤 실행한다.
npx cdk deploy DevEdgeStack --exclusively "${EKS_CONTEXT[@]}"
```

Helm에 별도 사용자 override가 있었다면 위 upgrade에 정리된 override 파일을 함께 전달한다.
StatefulSet·Service·PVC spec 변경이 없어야 하며 PVC 삭제나 데이터 초기화를 수행하지 않는다.
이 순서의 CLI·Helm 성공만으로 애플리케이션 E2E 완료를 기록하지 않는다.

## 4. 배포 후 수락과 복구

- RDS `PubliclyAccessible=false`, DB SG에 CIDR ingress 없음, ALB에 8123 listener 없음,
  ClickHouse TG/TGB/output 부재를 확인한다. 이전 ALB hostname:8123과 RDS hostname:5432에
  VPC 밖에서 직접 연결할 수 없어야 한다. DNS 결과만으로 차단 완료를 판단하지 않는다.
- SSM을 통한 PostgreSQL 읽기 쿼리와 ClickHouse ping·읽기 쿼리를 확인한다. 기존 앱의 RDS·ClickHouse 연결,
  적재·조회와 EKS API 터널도 확인한다. Pod/ENI의 SG와 실제 접근 경로를 기록한다.
- DB operator에서 다른 instance·EKS 문서·기본 셸·범용 remote-host 문서·다른 운영자의 세션 종료/재개가
  거부되는지 확인한다. 허용된 ClickHouse host의 실제 목적지는 SG로도 제한된다.
- 운영자가 승인한 ClickHouse 재시작 검증에서는 새 Pod IP 조회·재연결을 확인한다. 데이터/PVC는 유지한다.
- SSM은 포워딩한 SQL 내용을 세션 로그로 보관하지 않는다. API 호출 기록과 DB audit은 다른 증거다.
  비용 이상 원인이 DB 접속인지, PostgreSQL audit 도입은 이번 수락 조건에 포함하지 않는다.

실패하면 공개 RDS flag·CIDR ingress·ClickHouse ALB를 되살리는 전체 rollback을 하지 않는다.
릴레이 instance/Agent/SG/문서/역할, kubeconfig와 Pod 상태를 순서대로 고친다. TGB 제거 단계가 실패했으면
Edge TG 삭제를 보류하고 기존 EKS 관리 경로로 정리한다. 앱·PVC를 보존한 채 릴레이를 복구한다.
공개 접근 재허용은 이 ADR의 복구 절차가 아니며 별도 결정이 필요하다.

## 참고

- [SSM remote-host forwarding](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-sessions-start.html)
- [RDS public access 변경 동작](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_ModifyInstance.Settings.html)
- [EKS NodeClass의 Pod 네트워크](https://docs.aws.amazon.com/eks/latest/userguide/create-node-class.html)
