# dev Strimzi Kafka 설치·전환·인증서·철거

PROJ-282 / 구현 PROJ-283 / 실제 검증 PROJ-285. [ADR-0049](../adr/0049-dev-strimzi-kafka-and-staged-msk-retirement.md)와
[허브 계약](https://github.com/soma-376/docs/blob/main/contracts/telemetry-kafka.md)을 따른다.
이 런북의 배포 명령은 운영 절차이며 코드·렌더링 테스트 통과만으로 실제 접속이나 전환 성공을 판정하지 않는다.
기존 MSK용 [이전 런북](dev-telemetry-kafka.md)의 IAM·topic-init 절차는 `msk` 호환 경로에만 적용한다.

## 1. 고정 계약과 선행 확인

| 항목 | 계약 |
|---|---|
| 버전 | Strimzi 1.3.0, Kafka 4.2.2, EKS 1.36, Helm 3.22.0 |
| namespace | operator `strimzi-system`, 감시·Kafka·앱 `pulsemetry-dev` |
| cluster/bootstrap | `soma-376-dev-telemetry` / `soma-376-dev-telemetry-kafka-bootstrap.pulsemetry-dev.svc.cluster.local:9093` |
| 노드 | ClickHouse와 같은 단일 AZ, m7g.large ARM64 On-Demand 3대, 전용 NodePool/SG/taint, CPU limit 8 |
| broker/controller | dual-role 3 Pod, hostname 강제 anti-affinity, request 1 CPU/4Gi, limit 6Gi, heap 2Gi, PDB maxUnavailable 1 |
| 디스크 | 노드별 encrypted gp3 100Gi, WFFC, Retain, deleteClaim=false, 확장 허용 |
| topic | validation/main 각각 6 partitions, RF3, ISR2, 72시간, cleanup=delete, unclean=false |
| 크기 | HTTP body 최대 **10MiB(10485760)**, producer request 최대 **12MiB(12582912)**, broker/topic/fetch 최대 **13MiB(13631488)** |
| 인증 | 내부 mTLS, stage별 gateway/ingest/offset-admin ACL, topic-admin은 조회 전용 |

단일 AZ 장애 내성은 없다. 기존 EKS·ClickHouse·Data·JWT·HTTP 경로를 보존한다. Kafka 데이터나 offset은
MSK에서 이관하지 않으며 미확인 MSK 데이터 폐기는 사용자 승인 범위다. 앱 실패 복구는 기존 HTTP ingest다.

[EKS 수동 배포](dev-eks-manual-deployment.md)의 터널·kubeconfig·output 수집·현재 Helm release 백업을 먼저 한다.
`kubectl config current-context`, 서버 1.36, 노드 AZ, PV/PVC, 현재 Helm values와 앱 digest를 확인한다.
backend PKCS12 지원 커밋을 포함한 새 Gateway·ingest ARM64 이미지를 준비한다. 기존 IAM 전용 이미지는 사용할 수 없다.
NodePool 8 vCPU 제한 외에도 계정 vCPU quota·해당 AZ의 m7g.large 용량과 세 노드의 4Gi allocatable 여유를 확인한다.
CRD `kafkas.kafka.strimzi.io`가 이미 있으면 운영자 중복 설치 대신 기존 버전·소유권을 먼저 확인한다.

Operator는 apps 노드에 있으므로 다음 경로를 CDK의 apps SG → Kafka SG와 Strimzi가 생성한 NetworkPolicy에서 함께 확인한다.
9090·8443은 Strimzi 1.3.0 [KafkaRoller](https://github.com/strimzi/strimzi-kafka-operator/blob/1.3.0/cluster-operator/src/main/java/io/strimzi/operator/cluster/operator/resource/KafkaRoller.java)의
controller Admin 및 KafkaAgent 복구 상태 조회에 필요하다. [KafkaCluster.generateNetworkPolicy](https://github.com/strimzi/strimzi-kafka-operator/blob/1.3.0/cluster-operator/src/main/java/io/strimzi/operator/cluster/model/KafkaCluster.java)는 두 포트의 Operator peer를 이미 허용한다.

| 출발 Pod → Kafka Pod | TCP | 목적 |
|---|---|---|
| Cluster Operator → 각 controller | 9090 | metadata quorum·active controller 확인, 안전한 순차 재시작 |
| Cluster Operator → 각 broker | 9091 | 내부 broker Admin 연결 |
| Cluster Operator → 각 broker의 KafkaAgent | 8443 | 준비되지 않은 broker의 log recovery 상태 확인 |
| Gateway·ingest·수동 관리 Job → broker | 9093 | 명시적으로 허용된 앱의 mTLS 접속 |

외부 CIDR 또는 9092를 추가하지 않는다. SG는 노드 단위이며 Pod 접근은 기존 Strimzi NetworkPolicy가 제한한다.
Operator의 9093 접속은 필요하지 않으므로 해당 앱 listener의 peer 목록에 Operator를 추가하지 않는다.

이하 `RUN_DIR`는 접근 제한된 배포 기록 디렉터리, `HELM`은 검증된 Helm 3.22.0 실행 경로다.
이미지 변수는 기존 운영 digest 또는 이번 검증된 backend digest이며 가변 태그를 쓰지 않는다.

## 2. 병렬 준비: 기존 MSK retain

병렬 준비 profile은 `devKafkaProvider=strimzi`, `devMskRetirementStage=retain`, `devEksOtlpTarget=ingest`,
`devEksArchivePrefix=eks_validation`으로 시작한다. diff에서 새 Kafka SG만 추가되고 기존 MSK·PVC·Data 리소스는 삭제/교체되지 않는지 확인한다.
최종 추적 profile은 §6의 후속 정합 상태(`eks`, `network-removed`, ALB Gateway, ingest kafka)를 나타낸다.
이 profile은 실제 두 단계 철거와 MSK/ENI 부재 확인 뒤에만 머지·사용하며, 아래 초기 설치 절차로 삭제를 시작하지 않는다.
validation 준비를 재현할 때는 해당 단계의 별도 profile과 일치하는 output·metadata를 사용하며 main profile에 validation output을 섞지 않는다.
`DEPLOYMENT_PROFILE`은 이번 CDK 적용에 사용한 추적 profile의 파일 경로다. validation 재현에는
`devEksArchivePrefix=eks_validation`인 profile을 선택한다. 같은 파일을 §3 앱 값 생성에도 사용한다.
기존 절차로 CDK를 적용해 output을 모은 후:

```bash
: "${DEPLOYMENT_PROFILE:?이번 CDK 단계와 일치하는 추적 profile 경로가 필요하다}"
node scripts/eks-values.mjs --deployment-profile "$DEPLOYMENT_PROFILE" --outputs "$RUN_DIR/cdk-outputs.json" \
  --output-dir "$RUN_DIR/generated" --prepare-kafka true
"$HELM" upgrade --install dev-platform helm/dev/platform/base \
  -f "$RUN_DIR/generated/base.yaml" --wait --timeout 10m
"$HELM" upgrade --install strimzi helm/dev/platform/strimzi/vendor/strimzi-kafka-operator-1.3.0.tgz \
  -n strimzi-system --create-namespace -f helm/dev/platform/strimzi/values.yaml \
  --post-renderer ./scripts/strimzi-operator-post-render.mjs --wait --timeout 10m
kubectl -n strimzi-system rollout status deployment/strimzi-cluster-operator --timeout=300s
"$HELM" upgrade --install telemetry-kafka helm/dev/kafka -n pulsemetry-dev \
  -f "$RUN_DIR/generated/kafka-strimzi.yaml" --wait --timeout 20m
kubectl -n pulsemetry-dev wait kafka/soma-376-dev-telemetry --for=condition=Ready --timeout=1200s
kubectl -n pulsemetry-dev wait kafkatopic --all --for=condition=Ready --timeout=300s
kubectl -n pulsemetry-dev wait kafkauser --all --for=condition=Ready --timeout=300s
kubectl -n pulsemetry-dev get pods -l strimzi.io/cluster=soma-376-dev-telemetry -o wide
kubectl -n pulsemetry-dev get pvc
```

실제 기존 platform release 이름이 `dev-platform`과 다르면 그 이름으로 upgrade한다. 새 release로 기존 NodeClass를 중복 생성하지 않는다.
Helm `--wait`는 Kafka CR readiness를 보장하지 않으므로 위 `kubectl wait`가 필수다.
Kafka Pod 3개가 다른 hostname이며 모두 ClickHouse AZ인지, PVC가 각각 100Gi/Bound인지 확인한다.
KafkaTopic 두 개와 stage별 4개 KafkaUser는 계속 선언한다. stage 전환으로 이전 리소스를 제거하지 않는다.
Topic 설정은 KafkaTopic만 바꾼다. Strimzi에 `topicInit.enabled=true`를 주면 schema가 실패한다.

broker 3개가 Ready여도 Operator의 제어 경로는 막혀 있을 수 있다. 순차 재시작 전에 Operator에서 각 Kafka Pod의
9090·8443 TCP 연결과 quorum 조회가 가능한지 확인한다. `Error determining active controller` 또는
`describeMetadataQuorum` timeout으로 rolling이 멈추면 두 포트의 SG·NetworkPolicy를 대조한다.
KafkaAgent 연결 실패도 복구 상태 확인을 막으므로 9090만 열어 해결됐다고 판단하지 않는다.
경로를 수정한 뒤 Operator reconciliation·순차 재시작 완료, 새 Pod UID, 동일 PVC/PV, ISR 복구와 실제 수집을 확인한다.
검사 실패를 강제 재시작으로 우회하거나 PVC를 삭제하지 않는다.

## 3. 앱 값 생성과 검증 경로

Secret 원문을 `kubectl get -o yaml/json`으로 저장하지 않는다. 다음 도구는 지정 Secret의 name/namespace/UID/resourceVersion만 투영한다.
`tlsRevision`은 CA 및 앱 사용자 metadata에서 계산한다. `data`, `stringData`, 잘못된 stage/namespace, 누락·중복은 생성기가 거부한다.

```bash
node scripts/strimzi-secret-metadata.mjs validation "$RUN_DIR/strimzi-metadata.json"
node scripts/eks-values.mjs --deployment-profile "$DEPLOYMENT_PROFILE" \
  --outputs "$RUN_DIR/cdk-outputs.json" --output-dir "$RUN_DIR/generated" \
  --enrollment-image "$ENROLLMENT_IMAGE" --ingest-image "$INGEST_MTLS_IMAGE" \
  --dashboard-image "$DASHBOARD_IMAGE" --gateway-image "$GATEWAY_MTLS_IMAGE" \
  --strimzi-secrets "$RUN_DIR/strimzi-metadata.json"
```

Strimzi 모드는 MSK ARN/bootstrap/list-nodes 입력이 필요 없다. MSK 조회 옵션을 함께 주면 거부한다.
profile의 공급자 또는 archive prefix가 배포 output과 다르면 일반 생성과 `--prepare-kafka` 모두 실패한다.
main profile에는 CDK main 배포 이후 다시 수집한 output을 사용한다.
`config/dev/runtime.yaml`의 기존 JWT·OIDC·DB TLS·tracing 값을 보존하고 검증 시 `ingestMode=dual`을 사용한다.
생성기 실행 전에 이 모드를 배포 원본에 반영한다. validation prefix와 main prefix는 CDK output·앱 topic/group·S3가 일치해야 한다.

```bash
"$HELM" upgrade --install telemetry-ingest helm/dev/workloads/spring-app -n pulsemetry-dev \
  -f helm/dev/workloads/telemetry-ingest.yaml -f "$RUN_DIR/generated/telemetry-ingest.yaml" --wait --timeout 10m
"$HELM" upgrade --install telemetry-gateway helm/dev/workloads/spring-app -n pulsemetry-dev \
  -f helm/dev/workloads/telemetry-gateway.yaml -f "$RUN_DIR/generated/telemetry-gateway.yaml" --wait --timeout 10m
```

새 앱은 `PULSEMETRY_KAFKA_SECURITY=mtls`와 아래 파일 4개만 받는다. Secret은 readOnly/0440이며 fsGroup10001로 읽는다.

| 환경변수 | 파일 |
|---|---|
| `PULSEMETRY_KAFKA_TLS_TRUSTSTORE_LOCATION` | `/mnt/kafka-tls/cluster/ca.p12` |
| `PULSEMETRY_KAFKA_TLS_TRUSTSTORE_PASSWORD_FILE` | `/mnt/kafka-tls/cluster/ca.password` |
| `PULSEMETRY_KAFKA_TLS_KEYSTORE_LOCATION` | `/mnt/kafka-tls/user/user.p12` |
| `PULSEMETRY_KAFKA_TLS_KEYSTORE_PASSWORD_FILE` | `/mnt/kafka-tls/user/user.password` |

init container의 readable/nonempty 확인 후 backend가 PKCS12와 password를 검증한다. 비밀번호는 YAML/env/로그에 없다.
관측 설치는 [관측 런북](dev-observability.md)과 생성한 observability.yaml을 사용한다. broker/exporter는9404,
operator는8080, entity operator는8080/8081이며 해당 namespace selector·SG 경로를 함께 확인한다.
Fluent Bit도 정적 runtime values → Loki overlay(사용 중인 경우) → generated values 순서로 갱신한다.
`workload=kafka` toleration이 반영되고 Kafka 노드 3대마다 Fluent Bit·node-exporter Pod가 Ready인지 확인한다.
broker 로그가 `/eks/dev/application` 및 사용 중인 Loki에 도착해야 로그 수집 완료다.

## 4. 실제 승인 기준과 main 전환

- 인증서 없는 client와 잘못된 stage 인증서는 거부되고 정확한 stage 사용자만 작업을 수행한다.
  Gateway의 Read·group 변경, ingest의 Write·다른 topic/group 접근은 거부되어야 한다. topic-admin은 조회만 가능하다.
- 합법적인 telemetry JWT OTLP 요청이 Gateway에서 Kafka ACK 후 성공하고 consumer가 소비·ClickHouse 쓰기 후 offset commit한다.
  trace/metric/log 고유 ID로 S3·ClickHouse 결과를 확인한다. JWT/OTLP 계약은 기존 E2E 절차를 따른다.
- HTTP body 10MiB 경계·초과 거부, producer request 12MiB 상한, broker 13MiB 한도, 재시도·중복 처리·poison record·commit 실패 동작을 확인한다.
  producer의 `max.request.size`는 request 한도이며 12MiB payload 허용을 의미하지 않는다.
- 앱 재기동과 broker 하나의 재시작 중 재연결·ISR 복구·중복 허용 범위·offset 보존을 확인한다.
  노드 하나를 drain하기 전 PDB/ISR=3을 확인하고 복구 완료 전 다음 노드를 건드리지 않는다.
  검증 stage에서 제어된 2 broker 장애 시 ISR<2에서 false ACK가 없고 publish가 실패하는지 확인한다.
  노드 교체 후 동일 PVC/PV를 재부착하고 데이터·committed offset이 보존되는지 확인한다. PVC/PV 삭제는 하지 않는다.
- Prometheus에서 broker/exporter/operator targets가 UP이며 ISR<2·under-replicated·offline partition·lag·Pod/PVC·CA 만료 경보가 평가되는지 확인한다.
  인증서 갱신 검증은 다음 절을 따른다.

validation E2E를 확인한 뒤 기존 HTTP ALB 경로를 유지한 채 아래 순서로 main으로 전환한다.

1. 추적 profile을 `strimzi`, `devEksArchivePrefix=eks`, `retain`, `devEksOtlpTarget=ingest`로 변경한다.
   `runtime.yaml`의 `ingestMode=dual`·telemetry JWT 발급 활성화·기존 키 버전·이미지 digest는 유지한다.
   CDK diff에서 ingest S3 정책이 정확한 `eks/*` + `eks_validation/*` PutObject/TLS 조건으로 확장되는지 확인하고
   이를 먼저 배포한다. 아직 실행 중인 validation HTTP ingest는 `eks_validation/*`에 계속 쓸 수 있어야 한다.
   현재 코드는 이 profile 조건에서 Edge의 ingest 100/Gateway 0 연결도 함께 합성한다. 따라서 이 버전으로 main을
   처음 적용하면 내부 E2E 전에도 listener 준비가 반영될 수 있다. weight 0은 외부 수집을 Gateway로 보내지 않으며,
   내부 main E2E 성공과 실제 Gateway healthy는 이후 단일 Gateway 전환 전에 반드시 확인하는 운영 gate다.
2. validation Gateway의 합성 입력을 중지하고 validation backlog가 모두 처리·commit됐는지 확인한다.
   외부 HTTP 수집은 계속 유지한다. Kafka 데이터나 offset을 main으로 복사하지 않는다.
3. main CDK 적용 후 `DEPLOYMENT_PROFILE=config/dev/deployment.json`을 선택한다. 새 `KafkaStage=main` output과
   main Secret metadata로 앱 값을 다시 만들고 main `dual` ingest와 Gateway를 배포한다.
   실제 Pod의 prefix·topic·group·인증서와 HTTP 및 내부 main ACK/consume/commit/S3/ClickHouse를 확인한다.
4. 내부 main 검증 뒤 listener 연결 준비가 적용됐는지 확인하고, 아직 없으면 적용한다. 이번 전환은 `a26a90f`의
   main CDK·앱과 내부 E2E를 먼저 검증한 뒤 준비 코드를 추가했으므로 이 단계에서 Edge만 별도로 바뀐다.
   Gateway TG가 아직 어느 listener에도 참조되지 않으면
   `unused/Target.NotInUse`이며 healthy를 기다려도 health check가 시작되지 않는다.
   `strimzi` + main prefix `eks` + `devEksOtlpTarget=ingest`에서만 기존 OTLP 규칙을 ingest weight 100/Gateway weight 0으로 연결한다.
   실제 외부 수집은 ingest로 유지하고 `ValidationOtlpTarget=ingest`, `retain`, `ingestMode=dual`·JWT 발급·키 버전을 보존한다.
   보호된 CD plan에서 `DevEdgeStack`의 `EksValidationAlbHttpOtlpRule810EC07C` forward 대상과
   가중치 외에는 output·Network/Data/EKS·인증서·WAF·나머지 경로·TG가 그대로인지 확인하고 승인된 같은 Assembly로 배포한다.
5. 실제 listener action이 ingest 100/Gateway 0인지, 기존 HTTP 수집과 로그인·등록이 유지되는지 확인한다.
   연결 후 Gateway TG의 등록 target들이 실제 healthy가 되어야 한다. weight 0은 수집 전환이나 Kafka E2E 성공 증거가 아니다.
6. 준비 단계 검증 뒤 별도 PR에서 추적 profile의 `devEksOtlpTarget`만 `gateway`로 바꾼다.
   기존 단일 Gateway forward와 `ValidationOtlpTarget=gateway`만 바뀌고 main·Strimzi·retain·dual을 유지하는지 확인한다.
   승인된 CD plan을 배포한 뒤 공개 ALB에 실제 telemetry JWT 요청을 보내 Gateway Kafka ACK → main consumer → offset commit 및
   S3/ClickHouse 저장을 확인한다. 로그인·등록 경로도 유지되어야 한다. 실패 시 dual ingest가 Ready인 것을 확인하고
   profile의 OTLP 대상만 `ingest`로 되돌려 ingest 100/Gateway 0 준비 상태로 복구한다. Kafka/PVC/offset은 지우거나 초기화하지 않는다.
7. 공개 경로 성공 뒤 별도 runtime PR에서만 `ingestMode=kafka`로 바꾼다. 실제 ALB rule과 새 CDK output이
   이미 Gateway를 가리키고 main consumer가 정상인 것을 다시 확인한다. 생성기는 ALB ingest + Kafka 전용 조합을 거부한다.
   전환 전에 현재 main output·기존 앱 이미지 digest·JWT 키 버전·최신 Strimzi Secret metadata로
   main `dual` 복구 values를 새로 생성해 비공개 실행 폴더에 보관한다. 현행 runtime 사본에서 `ingestMode`만 dual로
   바꿔 `--runtime-values`로 공급한다. 이는 Secret 원문 복제나 validation 배포 재사용을 의미하지 않는다.
8. 같은 입력으로 Kafka 전용 values를 생성하고 ingest release에만 적용한다. Service는 ClusterIP로 바뀌어
   NodePort를 해제하고 HTTP TGB는 제거된다. CDK 소유 ingest TG와 Gateway의 NodePort/TGB는 남긴다.
   TGB 삭제/finalizer 완료, ingest Ready·main consumer commit, 공개 Gateway ACK와 S3/ClickHouse 저장을 확인한다.
   runtime 변경·Helm 적용은 서로 별도다. 이번 단계는 ALB·CDK 리소스를 바꾸거나 Kafka offset을 초기화하지 않는다.
9. Kafka 전용 전환 후 HTTP 복구가 필요하면 현재 입력과 인증서 metadata를 대조하여 main dual values를
   다시 생성하거나 보관본의 유효성을 확인한다. main dual ingest/TGB를 먼저 배포하고 직접 서비스·NodePort·Pod Ready·
   target 등록을 확인한 뒤 ALB 대상만 ingest로 되돌려 weight 100/0 준비 상태로 복구한다. listener 연결 전 NotInUse이면
   healthy를 기다리지 않고 연결 뒤 실제 target healthy와 공개 수집을 확인한다. 과거 validation Helm revision으로 rollback하지 않는다.

두 prefix 권한은 세 조건이 모두 일치할 때만 존재한다. `cluster-removed` 배포에서 validation 권한을 회수하며
`network-removed`도 main 권한만 유지한다. MSK 공급자·validation prefix·prod에는 추가 경로를 주지 않는다.
validation writer가 남아 있으면 제거 단계로 진행하지 않는다. 복구에 validation prefix가 필요하면 권한을 먼저 복구한다.
전체 입력 중지를 요구하지 않는다.
다만 replica1/Recreate 앱을 교체하는 동안 짧은 중단은 발생할 수 있으므로 client retry를 확인한다.
변경은 추적 profile/runtime에 남긴다. main 전환 뒤 30분 동안 오류·lag·ISR·ClickHouse 저장을 확인한 후에만 MSK를 제거한다.

## 5. 인증서 회전과 수동 offset

CA/사용자 유효기간365일, 갱신 창30일이다. mounted Secret 갱신만으로 JVM KafkaClient가 재로딩한다고 가정하지 않는다.
사용자 갱신은 검증 stage에서 [공식 Strimzi 인증서 갱신](https://strimzi.io/docs/operators/1.3.0/deploying#security-str) `strimzi.io/force-renew=true` 사용자 Secret annotation 절차를 사용한다.
CA 강제 갱신은 cluster/clients CA certificate Secret에 대한 공식 절차가 달라 사용자 회전과 섞지 않는다.
운영 CA key 교체는 별도 공식 rotation 절차의 두 번 reconciliation 및 trust overlap을 따른다.

annotation만 추가해도 resourceVersion이 바뀌므로 metadata 변경만으로 인증서 갱신 성공을 판단하지 않는다.
공개 `user.crt`는 파일로 저장하지 않고 파이프로 SHA256 fingerprint·serial만 출력해 전후 값을 기록한다.

```bash
# 갱신 전 fingerprint/serial (인증서 본문은 출력·저장하지 않는다)
kubectl -n pulsemetry-dev get secret pulsemetry-gateway-validation -o jsonpath='{.data.user\.crt}' \
  | base64 --decode | openssl x509 -noout -fingerprint -sha256 -serial
kubectl -n pulsemetry-dev annotate secret pulsemetry-gateway-validation strimzi.io/force-renew=true --overwrite
# 다음 reconciliation 뒤 아래 fingerprint/serial이 실제 바뀌었는지 확인한다.
kubectl -n pulsemetry-dev get secret pulsemetry-gateway-validation -o jsonpath='{.data.user\.crt}' \
  | base64 --decode | openssl x509 -noout -fingerprint -sha256 -serial
# force-renew annotation이 제거되고 새 인증서가 반영된 뒤에만 metadata를 다시 수집한다.
node scripts/strimzi-secret-metadata.mjs validation "$RUN_DIR/strimzi-metadata-after.json"
```

새 fingerprint/serial과 Ready 상태를 확인한 뒤 §3 생성기로 값을 다시 만들고 Gateway·ingest를 upgrade한다.
사용자 하나 갱신은 그 앱의 `pulsemetry.io/kafka-tls-revision`만, CA 갱신은 양쪽 annotation을 바꿔야 한다.
`kubectl get deployment/pod -o jsonpath`로 실제 annotation이 생성값과 같고 새 Pod가 Ready인지 확인한다.
새 Pod의 마운트된 PKCS12도 keytool의 password-file 옵션으로 읽어 공개 fingerprint만 출력하고 새 Secret fingerprint가 포함되는지 대조한다.

```bash
kubectl -n pulsemetry-dev exec deployment/telemetry-gateway -- \
  keytool -list -v -storetype PKCS12 -keystore /mnt/kafka-tls/user/user.p12 \
  -storepass:file /mnt/kafka-tls/user/user.password | awk '/SHA256:/{print $2}'
```

PKCS12에는 인증서 chain도 포함되므로 여러 fingerprint가 출력될 수 있다. 사용자 fingerprint의 일치가 필수다.
그 뒤 새 Kafka 연결의 OTLP publish/consume/commit을 검증한다. 비밀번호를 명령 인자·환경변수에 넣지 않는다.
오래된 인증서를 되돌리는 대신 유효한 Secret과 새 앱으로 재배포하며 복구 중에는 HTTP 경로를 사용한다.

offset 변경은 Strimzi `KafkaTopic`과 별개인 수동 Job이다. 모든 consumer를 먼저 중지하고 group이 Empty/Dead인지 확인한다.
ingest·offset-admin 모두 지정 topic과 group의 `Read, Describe`만 갖는다. Kafka의 offset 변경 API도 정상 commit과
같은 Group Read + Topic Read를 요구하므로 별도 사용자만 reset할 수 있다는 ACL 보장은 없다.
Group `Alter`는 지원 권한이 아니며 `AlterConfigs`는 group 설정 변경 권한으로 대체해서도 안 된다.
수동 Job의 별도 Secret·활성 group 거부·계획 검토로 운영 절차를 분리한다([공식 ACL 표](https://kafka.apache.org/42/security/authorization-and-acls/)).
다음은 partition0 offset100의 **계획만** 생성한다. 실행은 결과 CSV 확인 후 `offsets.mode=execute`로 별도 Job을 만든다.

```bash
"$HELM" upgrade --install telemetry-offset-plan helm/dev/workloads/telemetry-kafka-admin -n pulsemetry-dev \
  -f "$RUN_DIR/generated/telemetry-kafka-admin.yaml" \
  --set offsets.enabled=true,offsets.mode=plan,offsets.partition=0,offsets.toOffset=100 \
  --wait --wait-for-jobs --timeout 10m
```

`topicInit`은 항상 false다. `toDatetime`은 partition/toOffset 대신 하나만 선택한다.
Job은 활성 group을 거부하고 CLI `Error:` 출력·CSV 결과·실행 후 committed offset을 검증한다.
PKCS12 password는 Job 안에서만 읽고 memory emptyDir의0600 properties에 쓴 뒤 삭제한다.
실행 Job의 이름 충돌을 피하려면 같은 release를 upgrade하여 revision을 올린다. 앱 consumer를 재개한 후 결과를 확인한다.

## 6. 복구와 MSK 단계별 제거

실패하면 ingest의 `http` 또는 main `dual` 수신기·TGB를 먼저 복구하고 직접 서비스·NodePort 응답, Pod Ready와 target 등록을 확인한 뒤 ALB OTLP target을 ingest로 돌린다. JWT·DB·S3·ClickHouse 설정은 보존한다.
단일 Gateway forward 뒤 ingest TG도 listener 참조가 없어 `Target.NotInUse`일 수 있으므로 연결 전 healthy를 기다리지 않는다.
ALB를 연결한 뒤 실제 ingest target healthy와 공개 수집 복구를 확인한다. 연결 전에 ALB health check를 마쳐야 하는 복구라면
별도 Gateway 100/ingest 0 준비 변경이 필요하며, 현재 profile 복귀만으로 무중단을 보장하지 않는다.
Gateway 유입을 중지해 중복 입력을 피하고 Kafka backlog를 보관한다. Kafka release/operator/CRD/PVC/Secret을 삭제하거나
Helm uninstall로 되돌리지 않는다. retained PVC는 디스크 보존 수단이며 백업 대체가 아니다.

MSK 삭제는 실제 main 성공·30분 안정화·비정상 증거 없음·HTTP 복구 가능 확인 후에만 진행한다.
자동 dev-cdk 파이프라인은 `cluster-removed`를 차단한다. `network-removed`는 실제 AWS의 안정 baseline에서
MSK cluster/configuration·전용 SG/subnet 제거가 모두 끝났을 때만 허용한다. 최초 삭제에 `deploy --all`을 사용하지 않는다.
`cluster-removed`를 추적 profile에 넣어 먼저 머지하지 않는다. 검증을 마친 최신 merged SHA를 고정하고,
그 SHA의 `config/dev/deployment.json`·`runtime.yaml`을 같은 private 폴더(`RETIRE_DIR`)에 복사한다.
상대 `runtimeValuesFile` 경로가 유지되어야 하며 commit SHA와 두 원본 파일 SHA256, 변경 전 profile 사본을 보관한다.
stage 외 origin·인증서·main prefix·Gateway 대상·runtime·키 버전을 바꾸지 않는다. profile과 상충하는 CLI context는 거부된다.
실행 중인 retain 자동 CD가 끝났는지 확인하고, 수동 철거 중에는 대기 중 retain CD를 승인하거나 다른 dev 배포를 실행하지 않는다.
자동 guard·환경 보호·승인 설정은 변경하지 않는다.

1. private profile의 `devMskRetirementStage` 한 값만 `cluster-removed`로 바꾸고 원본 대비 diff를 root가 검토한다.
   이 입력으로 Assembly를 한 번 합성하고 template/manifest 해시를 보관한다. `DevEksStack`만 diff/deploy `--exclusively`한다.
   MSK cluster/configuration/log·전용 IAM·PodIdentity 제거와 ingest의 임시 `eks_validation/*` PutObject 회수만 확인한다.
   기존 앱 Pod Identity·Secret 권한·`eks/*` PutObject/TLS 조건 및 Kafka/EKS/기존 Data는 보존한다.
   이 전에 모든 ingest가 main prefix를 쓰며 validation writer·backlog가 없는지 확인한다.
   ```bash
   npx cdk synth --all -c env=dev -c devDeploymentProfile="$RETIRE_DIR/deployment.json" --output "$RETIRE_DIR/cluster-removed-assembly"
   npx cdk diff DevEksStack --exclusively --app "$RETIRE_DIR/cluster-removed-assembly"
   # root가 diff·Assembly 해시·실제 baseline을 검토한 뒤 같은 Assembly로만 배포한다.
   npx cdk deploy DevEksStack --exclusively --app "$RETIRE_DIR/cluster-removed-assembly"
   ```
2. AWS MSK 삭제 완료와 세 MSK subnet/SG를 사용하는 ENI가 **0개**인지 `ec2 describe-network-interfaces`로 확인해 기록한다.
   MSK 상태가 DELETING이거나 ENI가 남으면 기다리고 Network 제거를 진행하지 않는다.
3. private profile의 stage만 `network-removed`로 바꾸고 새 Assembly를 고정한다. `DevNetworkStack`만 diff/deploy `--exclusively`한다.
   MSK 전용 subnet/route table/SG만 제거하고 기존 EKS public subnet·Kafka SG·Data SG를 유지한다.
   ```bash
   npx cdk synth --all -c env=dev -c devDeploymentProfile="$RETIRE_DIR/deployment.json" --output "$RETIRE_DIR/network-removed-assembly"
   npx cdk diff DevNetworkStack --exclusively --app "$RETIRE_DIR/network-removed-assembly"
   # 실제 MSK/ENI 부재와 새 Assembly 해시를 확인한 뒤 Network만 배포한다.
   npx cdk deploy DevNetworkStack --exclusively --app "$RETIRE_DIR/network-removed-assembly"
   ```
4. Kafka 재접속·lag·ISR·앱 E2E를 다시 확인하고 비용/리소스 잔존을 기록한다. MSK 삭제 후 재생성은 복구 절차가 아니다.
5. 두 수동 삭제가 끝난 뒤에만 추적 profile을 `network-removed`로 갱신하는 별도 PR을 만든다.
   CI가 실제 안정 AWS baseline의 MSK cluster/configuration·전용 SG/subnet 부재를 확인해야 한다.
   이 최종 profile은 이미 수동 철거한 baseline과 소스를 맞추는 용도다. PR 본문에 두 단독 배포·ENI0·수집 보존의
   실제 증거를 연결하고, retain 합성본과의 삭제 차이만으로 live 삭제 성공이나 자동 최초 삭제를 승인하지 않는다.

수동 철거 완료 후 `network-removed` profile의 다음 자동 plan은 실제 AWS baseline에서 MSK 부재를 검사한다.
verify는 무결성 검증된 baseline artifact를 검사하고 deploy는 실제 AWS baseline을 다시 읽어 승인 당시와 비교한다.
잔존 MSK·삭제 진행 상태·조회 실패·승인 후 변경이 있으면 배포하지 않는다. 별도 guard 해제 없이 후속 자동 배포를 사용한다.
실행 증거에는 시간·commit/image digest·context·readiness·metric·E2E 결과만 남기며 Secret 원문은 남기지 않는다.
