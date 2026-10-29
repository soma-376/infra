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

이하 `RUN_DIR`는 접근 제한된 배포 기록 디렉터리, `HELM`은 검증된 Helm 3.22.0 실행 경로다.
이미지 변수는 기존 운영 digest 또는 이번 검증된 backend digest이며 가변 태그를 쓰지 않는다.

## 2. 병렬 준비: 기존 MSK retain

추적 profile은 `devKafkaProvider=strimzi`, `devMskRetirementStage=retain`, `devEksOtlpTarget=ingest`,
`devEksArchivePrefix=eks_validation`으로 시작한다. diff에서 새 Kafka SG만 추가되고 기존 MSK·PVC·Data 리소스는 삭제/교체되지 않는지 확인한다.
기존 절차로 CDK를 적용해 output을 모은 후:

```bash
node scripts/eks-values.mjs --outputs "$RUN_DIR/cdk-outputs.json" \
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

## 3. 앱 값 생성과 검증 경로

Secret 원문을 `kubectl get -o yaml/json`으로 저장하지 않는다. 다음 도구는 지정 Secret의 name/namespace/UID/resourceVersion만 투영한다.
`tlsRevision`은 CA 및 앱 사용자 metadata에서 계산한다. `data`, `stringData`, 잘못된 stage/namespace, 누락·중복은 생성기가 거부한다.

```bash
node scripts/strimzi-secret-metadata.mjs validation "$RUN_DIR/strimzi-metadata.json"
node scripts/eks-values.mjs --deployment-profile config/dev/deployment.json \
  --outputs "$RUN_DIR/cdk-outputs.json" --output-dir "$RUN_DIR/generated" \
  --enrollment-image "$ENROLLMENT_IMAGE" --ingest-image "$INGEST_MTLS_IMAGE" \
  --dashboard-image "$DASHBOARD_IMAGE" --gateway-image "$GATEWAY_MTLS_IMAGE" \
  --strimzi-secrets "$RUN_DIR/strimzi-metadata.json"
```

Strimzi 모드는 MSK ARN/bootstrap/list-nodes 입력이 필요 없다. MSK 조회 옵션을 함께 주면 거부한다.
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

validation E2E와 validation backlog drain을 확인한 뒤 기존 HTTP ALB 경로를 유지한 채 main으로 전환한다.
`devEksArchivePrefix=eks`·`KafkaStage=main` output과 main Secret metadata로 앱 값을 재생성하고
ingest를 main `dual`로 재배포한다. HTTP 수집을 계속하며 Gateway main을 내부 검증한 다음
`devEksOtlpTarget=gateway` ALB 전환을 적용하고 ingest를 `kafka`로 바꾼다. 전체 입력 중지를 요구하지 않는다.
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

실패하면 먼저 ALB OTLP target을 ingest로 복구하고 ingest를 `http` 또는 `dual`로 유지한다. JWT·DB·S3·ClickHouse 설정은 보존한다.
Gateway 유입을 중지해 중복 입력을 피하고 Kafka backlog를 보관한다. Kafka release/operator/CRD/PVC/Secret을 삭제하거나
Helm uninstall로 되돌리지 않는다. retained PVC는 디스크 보존 수단이며 백업 대체가 아니다.

MSK 삭제는 실제 main 성공·30분 안정화·비정상 증거 없음·HTTP 복구 가능 확인 후에만 진행한다.
자동 dev-cdk 파이프라인은 `cluster-removed`를 차단한다. `network-removed`는 실제 AWS의 안정 baseline에서
MSK cluster/configuration·전용 SG/subnet 제거가 모두 끝났을 때만 허용한다. 최초 삭제에 `deploy --all`을 사용하지 않는다.
각 단계는 추적 profile을 수정하고 동일 profile로 synth/diff한다. profile과 상충하는 CLI context는 거부된다.

1. `devMskRetirementStage=cluster-removed`: `DevEksStack`만 diff/deploy `--exclusively`한다.
   MSK cluster/configuration/log·IAM·PodIdentity 제거만 확인하고 Kafka/EKS/기존 Data 변경은 없어야 한다.
   ```bash
   npx cdk diff DevEksStack --exclusively -c env=dev -c devDeploymentProfile=config/dev/deployment.json
   npx cdk deploy DevEksStack --exclusively -c env=dev -c devDeploymentProfile=config/dev/deployment.json
   ```
2. AWS MSK 삭제 완료와 세 MSK subnet/SG를 사용하는 ENI가 **0개**인지 `ec2 describe-network-interfaces`로 확인해 기록한다.
   MSK 상태가 DELETING이거나 ENI가 남으면 기다리고 Network 제거를 진행하지 않는다.
3. `devMskRetirementStage=network-removed`: `DevNetworkStack`만 diff/deploy `--exclusively`한다.
   MSK 전용 subnet/route table/SG만 제거하고 기존 EKS public subnet·Kafka SG·Data SG를 유지한다.
   ```bash
   npx cdk diff DevNetworkStack --exclusively -c env=dev -c devDeploymentProfile=config/dev/deployment.json
   npx cdk deploy DevNetworkStack --exclusively -c env=dev -c devDeploymentProfile=config/dev/deployment.json
   ```
4. Kafka 재접속·lag·ISR·앱 E2E를 다시 확인하고 비용/리소스 잔존을 기록한다. MSK 삭제 후 재생성은 복구 절차가 아니다.

수동 철거 완료 후 `network-removed` profile의 다음 자동 plan은 실제 AWS baseline에서 MSK 부재를 검사한다.
verify는 무결성 검증된 baseline artifact를 검사하고 deploy는 실제 AWS baseline을 다시 읽어 승인 당시와 비교한다.
잔존 MSK·삭제 진행 상태·조회 실패·승인 후 변경이 있으면 배포하지 않는다. 별도 guard 해제 없이 후속 자동 배포를 사용한다.
실행 증거에는 시간·commit/image digest·context·readiness·metric·E2E 결과만 남기며 Secret 원문은 남기지 않는다.
