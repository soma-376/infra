# dev 백엔드 ECS 수동 철거

[ADR-0035](../adr/0035-dev-backend-eks-only.md)·PROJ-248의 실행 인계 문서다.
**PROJ-248에서는 아래 AWS 명령을 실행하지 않는다.** 실제 철거·Snapshot·EKS 기능 검증 결과는 별도 기록한다.
대상은 backend CDK dev이며 prod와 `frontend/` Terraform의 ECS는 대상이 아니다.

## 1. 실행 전제와 보존 대상

- PROJ-249가 backend workflow의 ECS 사전 검사·재배포를 제거하고 Gateway를 포함한 네 ARM64 이미지를 ECR에 정상 게시해야 한다.
  허브 dashboard 계약 §5·ADR 0021의 dev 배포 경계도 정합화한 뒤 진행한다. ECS 사전 검사가 남으면 이미지 공급도 실패한다.
- EKS private API·SSM 릴레이 접근, 네 workload와 TG 상태, 사용 중인 API/OTLP/ClickHouse 주소가 EKS를 가리키는지 확인한다.
  EKS workload가 구 `clickhouse.obs.local` 또는 ECS ALB를 사용하는 상태에서는 철거하지 않는다.
- 운영자는 인증·수집·조회 기본 확인 결과와 미검증 기능을 구분해 기록한다. 기존 Canary 완료를 가정하지 않는다.
- RDS·S3·Secret 원본·EKS·PVC·EKS ALB/TG/WAF·SSM 릴레이를 보존한다. ECR 저장소와 이미지도 삭제하지 않는다.
- 기존 ECS 로그는 DESTROY 정책에 따라 제거된다. 필요한 진단 결과는 중지 전에 비밀이 없는 형태로 확보한다.
- ECS ClickHouse 데이터는 수동 EBS Snapshot으로만 보존하며 EKS PVC로 이관하지 않는다.

아래 셸 블록은 한 Bash 세션에서 순서대로 실행한다. 실패하면 다음 단계로 넘어가지 않는다.
명령별 반환 코드와 CloudFormation 상태를 확인하며 `set -x`를 사용하지 않는다.

```bash
set -euo pipefail
: "${DEPLOY_PROFILE:?기존 CloudFormation 배포용 AWS 프로필}"
: "${CDK_DEFAULT_ACCOUNT:?대상 계정을 환경으로 지정}"
: "${DEV_ALLOWED_CIDRS:?기존 ALB/RDS 허용 CIDR}"
: "${DEV_OIDC_CLIENT_KEYS:?기존 OIDC key 전체를 담은 JSON 배열, 없으면 []}"
: "${DEV_EKS_ARCHIVE_PREFIX:?기존 eks_validation 또는 eks 값}"
: "${DEV_EKS_OTLP_TARGET:?기존 ingest 또는 gateway 값}"
: "${RUN_DIR:?레포 밖 또는 ignore된 generated 아래의 증거 디렉터리}"
export AWS_PROFILE="$DEPLOY_PROFILE"
export AWS_REGION=ap-northeast-2
export CDK_DEFAULT_REGION=ap-northeast-2
umask 077
mkdir -p "$RUN_DIR/before" "$RUN_DIR/after"
EKS_CONTEXT=(-c env=dev -c "devAllowedCidr=$DEV_ALLOWED_CIDRS"
  -c "devOidcClientKeys=$DEV_OIDC_CLIENT_KEYS"
  -c "devEksArchivePrefix=$DEV_EKS_ARCHIVE_PREFIX"
  -c "devEksOtlpTarget=$DEV_EKS_OTLP_TARGET")
if [[ -n "${DEV_EKS_CERTIFICATE_ARN:-}" ]]; then
  EKS_CONTEXT+=(-c "devEksCertificateArn=$DEV_EKS_CERTIFICATE_ARN")
fi
EKS_CONTEXT+=(-c "devHttpRedirectEnabled=${DEV_HTTP_REDIRECT_ENABLED:-true}")
printf '%s\n' "${EKS_CONTEXT[@]}" > "$RUN_DIR/cdk-context-args.txt"
git rev-parse HEAD > "$RUN_DIR/infra-commit.txt"
aws sts get-caller-identity --query Account --output text > "$RUN_DIR/account.txt"
test "$(cat "$RUN_DIR/account.txt")" = "$CDK_DEFAULT_ACCOUNT"
```

`DEV_OIDC_CLIENT_KEYS`는 이전 `oidc.clients[].key`의 **전체 집합**을 옮긴다. 현재 EKS에서 비활성인 key도
누락하지 않는다. 삭제하면 Retain Secret은 남아도 CloudFormation 관리·output·IAM에서는 빠진다.
기존 인증서·redirect·CIDR·archive prefix·OTLP 대상을 그대로 전달한다. 폐기된 `devDashboardRuntimeFile`,
`devImageTag`, `devAppAsgMaxCapacity`, `devCertificateArn`, `devEksApiAllowedCidrs`는 모든 context 출처에서 제거한다.

ECS 철거가 이미 완료된 환경에서는 이 문서의 삭제 단계를 반복하지 않는다. CloudFormation의
`DevApplicationStack` 부재와 ECS 서비스·ASG·구 ALB/TG·SG 부재를 확인하고 EKS 런북의 일반 배포로 진행한다.
접두사 없는 `ApplicationStack`은 별도 prod 스택이므로 이 문서의 삭제 대상이 아니다.

## 2. 배포 상태와 복구 자료 확보

배포 템플릿과 리소스 메타데이터만 저장한다. Secrets Manager 값·CSI 파일·토큰은 읽거나 출력하지 않는다.
이전 commit과 전체 cloud assembly/context는 삭제 후 인프라 재생성용으로 별도 보관한다.
삭제 명령 자체는 이전 assembly를 요구하지 않는다.

```bash
for stack in DevApplicationStack DevEdgeStack DevNetworkStack DevDataStack DevEksStack; do
  aws cloudformation describe-stacks --stack-name "$stack" > "$RUN_DIR/before/$stack.json"
  aws cloudformation get-template --stack-name "$stack" > "$RUN_DIR/before/$stack-template.json"
  aws cloudformation list-stack-resources --stack-name "$stack" > "$RUN_DIR/before/$stack-resources.json"
done
APP_STACK_ID=$(aws cloudformation describe-stacks --stack-name DevApplicationStack --query 'Stacks[0].StackId' --output text)
printf '%s\n' "$APP_STACK_ID" > "$RUN_DIR/application-stack-id.txt"
aws cloudformation list-exports > "$RUN_DIR/before/exports.json"
```

Application 스택의 termination protection·실제 export/import·수동 연결을 점검한다. 소비 중인 export가 있으면
먼저 소비자를 분리하는 별도 절차가 필요하다. 보호 설정을 임의로 해제하거나 강제 삭제로 우회하지 않는다.
`list-stack-resources`의 물리 ID를 바탕으로 아래 값을 확인해 입력한다. 이름 검색 결과 한 건만 보고
다른 환경의 리소스를 선택하지 않는다.

```bash
: "${ECS_CLUSTER_ARN:?DevApplicationStack의 ECS cluster ARN}"
: "${CH_INSTANCE_ID:?DevApplicationStack ClickHouse ASG의 현재 인스턴스 ID}"
: "${CH_ASG_NAME:?동일 ClickHouse ASG의 물리 이름}"
: "${CH_DATA_VOLUME_ID:?그 인스턴스 /dev/xvdb 데이터 EBS volume ID}"
: "${CH_AVAILABILITY_ZONE:?데이터 EBS의 실제 AZ}"
: "${ECS_APP_ASG_NAME:?DevApplicationStack 앱 ASG의 물리 이름}"
: "${ECS_APP_HOST_SG_ID:?구 DevAppHostSg의 물리 ID}"
: "${ECS_CLICKHOUSE_SG_ID:?구 DevClickhouseSg의 물리 ID}"
: "${RDS_INSTANCE_ID:?보존할 dev RDS 인스턴스 ID}"
aws ecs describe-services --cluster "$ECS_CLUSTER_ARN" \
  --services enrollment-api telemetry-ingest dashboard-api clickhouse > "$RUN_DIR/before/ecs-services.json"
aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names "$CH_ASG_NAME" "$ECS_APP_ASG_NAME" \
  > "$RUN_DIR/before/asgs.json"
aws ec2 describe-instances --instance-ids "$CH_INSTANCE_ID" > "$RUN_DIR/before/clickhouse-instance.json"
aws ec2 describe-volumes --volume-ids "$CH_DATA_VOLUME_ID" > "$RUN_DIR/before/clickhouse-volume.json"
```

metadata에서 인스턴스·ASG·데이터 볼륨의 연결과 AZ를 대조한다. 현재 코드의 ClickHouse ASG는 min=max=1이지만
실제 설정도 확인한다. Snapshot 완료 전 ASG 축소·호스트 종료·EC2 stop·스택 삭제를 하지 않는다.
EC2를 stop하면 ASG가 비정상 인스턴스로 교체할 수 있다. 태스크를 중지하되 호스트는 유지한다.
RDS `AWS/RDS`의 `DatabaseConnections`를 동일 시간 범위·통계로 전후 기록하고, 기존 연결 수를 근거 없이
ECS 수 또는 연결 누수로 환산하지 않는다.

## 3. ECS 쓰기 중지와 수동 Snapshot

외부 호출을 EKS로 전환한 뒤 ECS 앱부터 중지한다. 진행 중 수집·캐시 작업의 종료 및 정상 shutdown을 확인한다.

```bash
for service in enrollment-api telemetry-ingest dashboard-api; do
  aws ecs update-service --cluster "$ECS_CLUSTER_ARN" --service "$service" --desired-count 0 \
    --query 'service.{name:serviceName,desired:desiredCount,running:runningCount,pending:pendingCount}'
done
aws ecs wait services-stable --cluster "$ECS_CLUSTER_ARN" --services enrollment-api telemetry-ingest dashboard-api
aws ecs describe-services --cluster "$ECS_CLUSTER_ARN" --services enrollment-api telemetry-ingest dashboard-api \
  --query 'services[].{name:serviceName,desired:desiredCount,running:runningCount,pending:pendingCount}'
```

세 앱의 desired/running/pending이 모두 0인지 확인한다. ClickHouse에 남은 쓰기·진행 작업이 없음을 확인한 후
ClickHouse 서비스도 desired=0으로 바꾸고 정상 종료 로그를 확인한다. 강제 종료나 timeout이면 Snapshot의
애플리케이션 정합성이 확인되지 않았으므로 다음 단계로 넘어가지 않는다.

```bash
aws ecs update-service --cluster "$ECS_CLUSTER_ARN" --service clickhouse --desired-count 0 \
  --query 'service.{name:serviceName,desired:desiredCount,running:runningCount,pending:pendingCount}'
aws ecs wait services-stable --cluster "$ECS_CLUSTER_ARN" --services clickhouse
aws ecs describe-services --cluster "$ECS_CLUSTER_ARN" --services clickhouse \
  --query 'services[].{name:serviceName,desired:desiredCount,running:runningCount,pending:pendingCount}'
aws ec2 describe-volumes --volume-ids "$CH_DATA_VOLUME_ID" \
  --query 'Volumes[].{id:VolumeId,az:AvailabilityZone,state:State,attachments:Attachments}'
```

ClickHouse task 종료 후 호스트의 데이터 파일 쓰기가 끝났는지 확인한다. 승인된 SSM 호스트 세션에서 `sync`로
OS 버퍼를 내리고 `/data/clickhouse` 볼륨을 사용하는 프로세스가 없는지 점검한다. Secret 파일이나 데이터 내용은
출력하지 않는다. 마지막 메타데이터 조회에서 동일 볼륨이 같은 호스트에 유지되는 것을 확인한 뒤 실행한다.
EBS Snapshot은 요청 시 디스크에 기록된 데이터만 포함하고 메모리 버퍼는 포함하지 않는다.
[AWS Snapshot 일관성 안내](https://docs.aws.amazon.com/ebs/latest/userguide/ebs-creating-snapshot.html)를 따른다.

```bash
CH_SNAPSHOT_ID=$(aws ec2 create-snapshot --volume-id "$CH_DATA_VOLUME_ID" \
  --description 'PROJ-248 dev backend ECS ClickHouse retirement backup' \
  --tag-specifications 'ResourceType=snapshot,Tags=[{Key=Project,Value=PROJ-248},{Key=Purpose,Value=ecs-retirement}]' \
  --query SnapshotId --output text)
printf '%s\n' "$CH_SNAPSHOT_ID" > "$RUN_DIR/clickhouse-snapshot-id.txt"
aws ec2 wait snapshot-completed --snapshot-ids "$CH_SNAPSHOT_ID"
aws ec2 describe-snapshots --snapshot-ids "$CH_SNAPSHOT_ID" \
  --query 'Snapshots[].{id:SnapshotId,state:State,source:VolumeId,started:StartTime,encrypted:Encrypted,kms:KmsKeyId}' \
  > "$RUN_DIR/clickhouse-snapshot.json"
printf '%s\n' "$CH_DATA_VOLUME_ID" "$CH_AVAILABILITY_ZONE" > "$RUN_DIR/clickhouse-source.txt"
```

`completed`와 원본 VolumeId를 확인한다. waiter timeout은 완료가 아니며 별도 조회로 확인하기 전 삭제하지 않는다.
Snapshot은 수동 보존하고 자동 만료·삭제 기능은 추가하지 않는다. `completed`는 복원 시험 통과를 의미하지 않는다.

## 4. Application 삭제 후 Edge·Network 순차 정리

삭제 직전 새 템플릿의 diff를 확인한다. 기존 Data/EKS 및 EKS ALB/TG/WAF의 교체·변경이 있으면 중단한다.
이때 `devOidcClientKeys` 이전 누락도 확인한다. diff는 실제 변경을 실행하지 않는다.

```bash
npm run build
npx cdk synth --all "${EKS_CONTEXT[@]}" --output "$RUN_DIR/cdk.out"
npx cdk diff --all "${EKS_CONTEXT[@]}" > "$RUN_DIR/cdk-diff.txt"
```

저장한 diff를 검토해 예상한 ECS 제거 외 변경이 없는지 확인한다. Snapshot의 completed와 원본 ID를
다시 확인하고, 삭제 후 복구 자료와 실행 범위가 확정된 경우에만 다음 블록을 실행한다.

```bash
aws cloudformation delete-stack --stack-name "$APP_STACK_ID"
aws cloudformation wait stack-delete-complete --stack-name "$APP_STACK_ID"
```

코드에서 DevApplicationStack을 제거해도 AWS 스택은 자동 삭제되지 않는다. 삭제된 스택 확인에는 저장한
StackId를 쓴다. [DeleteStack](https://docs.aws.amazon.com/cli/latest/reference/cloudformation/delete-stack.html)와
[삭제 waiter](https://docs.aws.amazon.com/cli/latest/reference/cloudformation/wait/stack-delete-complete.html)를 따른다.
`DELETE_FAILED`·waiter 실패 시 이벤트를 확인해 원인을 해결하며 `FORCE_DELETE_STACK`으로 우회하지 않는다.

```bash
aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names "$CH_ASG_NAME" "$ECS_APP_ASG_NAME" \
  > "$RUN_DIR/after/asgs.json"
aws ec2 describe-network-interfaces \
  --filters "Name=group-id,Values=$ECS_APP_HOST_SG_ID,$ECS_CLICKHOUSE_SG_ID" \
  > "$RUN_DIR/after/ecs-enis.json"
aws ecs describe-clusters --clusters "$ECS_CLUSTER_ARN" > "$RUN_DIR/after/ecs-cluster.json"
```

두 ASG와 관련 task·호스트·ENI가 없고 cluster가 비활성/부재인지 확인한다. ECS task definition의 비활성
revision 이력은 활성 서비스가 아니다. 확인이 끝난 뒤에만 ECS ALB/TG와 그 SG를 다음 순서로 제거한다.

```bash
npx cdk deploy DevEdgeStack --exclusively "${EKS_CONTEXT[@]}" --outputs-file "$RUN_DIR/edge-outputs.json"
```

Edge의 UPDATE_COMPLETE, 구 ECS ALB/TG 부재, 기존 EKS ALB/TG의 identity·target health를 확인한다.
실패나 rollback 중이면 Network를 갱신하지 않는다. 확인이 끝난 뒤 아래 블록을 실행한다.

```bash
npx cdk deploy DevNetworkStack --exclusively "${EKS_CONTEXT[@]}" --outputs-file "$RUN_DIR/network-outputs.json"
```

**최초 철거에 `deploy --all`을 사용하지 않는다.** 기본 DAG대로 Network부터 갱신하면 아직 사용 중인 ECS SG를
삭제하려 할 수 있다. Data·EKS는 보존하므로 제거 목적으로 배포하지 않는다. Edge 완료 후 구 ALB/TG 부재와
EKS ALB/TG 정상 상태를 확인하고, Network 완료 후 구 ECS SG 부재를 확인한다.

마지막으로 기존 GitHub OIDC provider 생성/참조 모드를 그대로 유지해 cicd를 갱신한다.

```bash
CICD_CONTEXT=(-c env=cicd)
if [[ -n "${GITHUB_OIDC_PROVIDER_ARN:-}" ]]; then
  CICD_CONTEXT+=(-c "githubOidcProviderArn=$GITHUB_OIDC_PROVIDER_ARN")
fi
npx cdk diff DeployStack "${CICD_CONTEXT[@]}" > "$RUN_DIR/cicd-diff.txt"
```

backend-dev ECS 권한 회수 외 IAM 변경이 없음을 확인한 뒤 실행한다.

```bash
npx cdk deploy DeployStack --exclusively "${CICD_CONTEXT[@]}" --outputs-file "$RUN_DIR/cicd-outputs.json"
```

diff는 backend-dev의 ECS 권한 회수만 허용하며 Gateway를 포함한 ECR 네 저장소·역할 네 개·trust·prod 권한을 보존해야 한다.

## 5. 완료 증거와 중단·복구

- CloudFormation 삭제/갱신 상태와 남은 dev 네 스택, ALB 1개·TG 5개·WAF association 1개·사용자 정의 SG 8개를 기록한다.
- EKS private API/SSM, 네 workload·TGB·target health, 실제 인증·수집·조회 결과를 각각 기록한다.
- RDS DatabaseConnections 전후와 ECS 재기동 부재를 확인한다. 연결 수 감소나 원인 해소를 정적 pool 계산으로 단정하지 않는다.
- Snapshot ID·원본 볼륨·AZ·최종 상태와 미실시 복원 시험, 미검증 기능을 인계한다.
- Application 삭제 전 실패는 기존 desiredCount와 입력으로 서비스 복귀가 가능하지만, EKS 전환 이후의 데이터 일관성을 먼저 판단한다.
- Application 삭제 이후에는 이전 인프라 재생성·같은 AZ의 Snapshot 볼륨 복원·데이터 연결·기능 검증이 필요한 별도 복구 작업이다.
  이전 assembly를 무조건 재배포하거나 새 빈 볼륨으로 서비스를 시작하지 않는다. 코드 revert와 Helm rollback은 데이터 복구가 아니다.
- Edge/Network/cicd에서 실패하면 이후 단계를 중지하고 CloudFormation 이벤트·rollback 결과를 확인한다.
  EKS나 Data 스택을 삭제하거나 EKS 비활성화로 복구하지 않는다.
