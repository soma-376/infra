# dev EKS 워크로드

ADR-0028·0029·0036의 dev 병행 구성을 여섯 release로 구분한다. `spring-app` chart를 `enrollment-api`·
`telemetry-ingest`·`dashboard-api`·`telemetry-gateway` release에서 각각 사용하고, ClickHouse는 `clickhouse`,
MSK topic 관리 Job은 `telemetry-kafka-admin` release를 사용한다.
namespace `pulsemetry-dev`, NodePool과 StorageClass는 기반 platform release가 먼저 만든다.

| release | chart / 기본 values | 워크로드 / Service | 포트 |
|---|---|---|---|
| `clickhouse` | `clickhouse` | StatefulSet / ClusterIP | 8123, 9000 |
| `enrollment-api` | `spring-app` / `enrollment-api.yaml` | Deployment / NodePort | 8080 / 30080 |
| `telemetry-ingest` | `spring-app` / `telemetry-ingest.yaml` | Deployment / NodePort(`http`·`dual`) 또는 ClusterIP(`kafka`) | 4316 / 30416 |
| `dashboard-api` | `spring-app` / `dashboard-api.yaml` | Deployment / NodePort | 8081 / 30081 |
| `telemetry-gateway` | `spring-app` / `telemetry-gateway.yaml` | Deployment / NodePort | 8082 / 30082 |
| `telemetry-kafka-admin` | `telemetry-kafka-admin` / generated만 | Job·ConfigMap·ServiceAccount 2개 | MSK 9098 |

기본 values만으로 앱을 실행하지 않는다. 앱별 `image.repository`와 `image.digest`에 실제 ARM64
이미지 digest를 전달하고 runtime overlay로 RDS·S3 참조와 CSI mount를 구성한다. chart는 이미지
digest 형식을 검사하지만 registry manifest의 ARM64 포함 여부는 배포 전에 별도로 확인한다.
ClickHouse의 `availabilityZone`은 CDK output의 첫 번째 AZ를 사용한다.

PROJ-223은 dashboard NodePort를 30081로 정하고 CDK의 `DEV_EKS_NODE_PORTS.dashboard`와
`EksDashboardApiNodePort` output, chart schema/helpers를 일치시킨다. 실제 클러스터에 이미 쓰는
Service가 없는지는 배포 전 확인한다. PROJ-224의 Network SG·전용 instance TG·CDK output이 같은 값을 사용한다.
실제 target health는 배포 후 검증한다.

`eks-values.mjs`는 네 앱의 `--enrollment-image`, `--ingest-image`, `--dashboard-image`, `--gateway-image`와
`--runtime-values <yaml>`, `--msk-bootstrap <get-bootstrap-brokers JSON>`을 필수로 받아 CDK output에서 `generated/*.yaml`을 만든다. 정적 workload values 뒤 생성 YAML을 전달한다.
예를 들어 dashboard chart의 로컬 렌더링은 다음과 같다.

```bash
helm template dashboard-api helm/dev/workloads/spring-app \
  --namespace pulsemetry-dev --kube-version 1.36.0 \
  --values helm/dev/workloads/dashboard-api.yaml \
  --values generated/dashboard-api.yaml
```

PROJ-231의 `generated/dashboard-api.yaml`은 네 연결 설정·전용 configtree·JWT 공개키 mount를
공급한다. PROJ-224의 `ValidationDashboardApiTargetGroupArn` output을 전용 TGB로 연결한다.
생성기는 검증 TG 네 개의 ARN이 모두 다르고 필요한 output이 존재하는지 확인한다. 사용자 기존 `generated/`는 로컬 검증에서 덮어쓰지 않는다.

앱 `runtime.enabled=true`는 별도 runtime-config release의 `secretProviderClass`를 참조한다.
기존 두 앱의 필수 파일은 `PULSEMETRY_DB_USERNAME`, `PULSEMETRY_DB_PASSWORD`,
`PULSEMETRY_TOKEN_HASH_SECRET`이고 enrollment만 `PULSEMETRY_ADMIN_API_TOKEN`을 추가한다.
dashboard runtime의 필수 파일은 source/cache 네 연결의 username/password 여덟 개이며
HMAC·관리자 토큰을 포함하지 않는다. 해당 SPC 구현은 별도 runtime-config release가 소유한다.
chart는 `SPRING_CONFIG_IMPORT=configtree:/mnt/secrets-store/`를 설정하고 UID/GID/fsGroup 10001로
파일을 읽는다. 같은 이미지의 initContainer가 파일 존재·읽기·비어 있지 않음을 검사하며 내용은
출력하지 않는다. Secret 값과 `SPRING_CONFIG_IMPORT`를 `env` map에 넣으면 렌더링을 거부한다.

`targetGroupBindings`는 선택 사항이며 `stage`, `targetGroupARN`, `confirmExclusiveOwnership: true`를
받는다. `validation`과 `canary`는 각각 하나씩만 선언할 수 있고 서로 다른 전용 TG ARN을 써야 한다.
`vpcId`를 함께 전달한다. ARN은 CDK가 만든 `soma-376-dev-eks-*` 이름만 허용한다. 기존 ECS TG의
소유권은 공유하지 않는다. 이 확인 값은 운영자의 선언이며 실제 ECS binding 부재는 배포 관문에서
조회한다. TGB는 OSS `elbv2.k8s.aws/v1beta1`이고 `networking`을 선언하지 않아 CDK 소유 SG를
변경하지 않는다. chart에는 Ingress나 LoadBalancer Service가 없다.

앱은 request 1Gi/limit 2Gi, replica 1과 `Recreate`를 사용한다. HTTP readiness
`/api/v1/healthz`를 사용한다. dashboard health는 저장소·인증 기능 성공을 대신하지 않는다.
TCP liveness는 외부 DB 실패만으로 프로세스를 재시작하지 않는다. startup probe는 ingest에 48회 × 5초, enrollment·dashboard에 12회 × 5초를 허용한다. 이 값과
메모리·CPU는 실측 전 초기값이다.

ClickHouse는 `24.8-alpine`과 기존 default user 설정, 50Gi PVC를 유지한다.
StatefulSet의 PVC retention은 삭제·축소 모두 `Retain`이고 기반 StorageClass도
`ebs.csi.eks.amazonaws.com`·`WaitForFirstConsumer`·`Retain`을 사용한다. release 삭제나 Helm
rollback은 PVC 데이터 복원을 수행하지 않는다. 기존 ECS EBS 이관은 후속 런북을 따른다.

로컬 검증은 `HELM_BIN=<Helm 3.22.0 경로> KUBECONFORM_BIN=<kubeconform 0.8.0 경로>`를
지정해 `node scripts/validate-helm-workloads.mjs`로 실행한다. 무해한 fixture로 lint/render·표준
Kubernetes schema·포트·selector·TGB·PVC·runtime 경계를 검사한다. 실제 이미지 pull, CSI mount,
Pod Identity, 파일 권한, RDS/S3/ClickHouse 통신과 target health는 AWS 배포 후 확인한다.

TGB schema는 PROJ-208의 고정 CRD에서 추출한 레포 파일을 기본으로 사용한다. 표준 schema를
미리 내려받았다면 `KUBERNETES_SCHEMA_LOCATION`에 kubeconform 경로 템플릿을 전달해 오프라인으로
검사할 수 있다. platform의 Namespace/StorageClass도 schema로 검사하지만 Auto Mode
NodeClass/NodePool은 AWS가 제공하는 실제 CRD 설치 전의 구조 검사로 한정한다.

근거: [Kubernetes startup/readiness/liveness probes](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/),
[StatefulSet PVC 보존](https://kubernetes.io/docs/concepts/workloads/controllers/statefulset/#persistentvolumeclaim-retention),
[OSS TargetGroupBinding](https://kubernetes-sigs.github.io/aws-load-balancer-controller/latest/guide/targetgroupbinding/targetgroupbinding/).
기존 PROJ-212의 health 경로·이미지 UID 확인은 backend develop `4d6ccf2e2809344eac9feb1873f2d527eee2f212`의
`SecurityConfig.HEALTH_PATH`, `HealthController`, `Dockerfile`을 읽기 확인했다.

JWT는 별도 읽기 전용 CSI mount와 정확한 kid → PEM 경로 맵을 사용한다. 버전·키 맵 변경은 Pod
template hash를 바꾸며, 모든 공개키 파일과 enrollment 개인키의 실제 read를 init에서 검사한다.
추가 YAML 입력과 키 교체 순서는 [runtime 안내](../runtime/README.md)를 따른다.

## telemetry Gateway·Kafka 모드·관리 Job (PROJ-246)

[ADR-0036](../../../docs/adr/0036-dev-telemetry-gateway-workload-and-msk-iam.md)을 따른다. Gateway는 `runtime`(DB·HMAC configtree)·사용자 JWT·OIDC를 받지 않으며
telemetry 공개키 mount와 `kafka` values가 없으면 렌더링을 거부한다. `PULSEMETRY_DB_*`·`ARCHIVE_*`·`CLICKHOUSE_*` env도 거부한다.
ingest는 `ingestMode`가 필수다. `dual`·`kafka`는 `kafka.consumerGroup`이 필요하고 grace가 90초이며, `kafka`는 Service ClusterIP·TGB 없음만 허용한다.
`PULSEMETRY_KAFKA_*`·`PULSEMETRY_INGEST_MODE`·telemetry JWT 설정과 정적 AWS 자격 env는 자유 `env`로 넣을 수 없고 구조화된 values에서만 만든다.
MSK 세션 이름은 workload별 고정값(`pulsemetry-dev-telemetry-gateway`·`-ingest`)만 허용한다. liveness는 TCP라 Kafka·RDS·S3 장애로 재시작하지 않는다.
단, `dual`·`kafka` ingest의 liveness는 HTTP `/api/v1/healthz`다. backend health가 멈춘 Kafka listener만 503으로 알리므로 그때만 재기동한다.

`telemetry-kafka-admin` chart는 digest 고정 `apache/kafka:3.9.2`와 release `.sha256`으로 대조한 `aws-msk-iam-auth-2.3.9-all.jar`를
schema 상수로 고정한다. 기본 실행은 topic을 `--if-not-exists`로 만들고 partition 6·RF 3·minISR 2·72시간·13 MiB·unclean off를 대조하며
다르면 실패한다. `offsets.enabled=true`는 group이 Empty일 때만 plan(`--dry-run`) 또는 명시적 execute를 수행한다.
Kafka 3.9 CLI는 오류를 출력하고도 종료 코드 0으로 끝나므로, Job은 `Error:` 출력이나 대상 행 없는 결과를 실패로 본다.
execute는 committed offset을 `--to-current --dry-run`으로 다시 읽어 CLI 계획과 다르면 실패한다.
두 Job은 각각 `telemetry-kafka-admin`·`telemetry-kafka-offsets` ServiceAccount와 Pod Identity, 서로 다른 MSK 역할을 쓴다.
`validate-helm-workloads.mjs`는 Kafka CLI를 stub으로 바꿔 Job shell의 생성·대조·거부 동작을 실행한다. 실제 MSK 접속은 검증하지 않는다.
