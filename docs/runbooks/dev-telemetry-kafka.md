# dev telemetry Gateway·MSK 설치·전환·복구 런북

> PROJ-246 구현 인터페이스의 운영 절차다. 이 문서의 AWS/Kubernetes 명령은 이번 작업에서 실행하지 않았다.
> 로컬 build·Jest·synth·Helm 렌더링 통과는 MSK 생성·IAM 접속·ALB 전환 성공을 뜻하지 않는다.
> 결정은 [ADR-0035](../adr/0035-dev-msk-isolated-subnets-under-eks-stack.md)(MSK·네트워크)와
> [ADR-0036](../adr/0036-dev-telemetry-gateway-workload-and-msk-iam.md)(Gateway·IAM·키·전환)을 따른다.
> 공통 EKS 설치·터널·출력 수집은 [EKS 수동 런북](dev-eks-manual-deployment.md) §1~§4를 먼저 따른다.

## 1. 구성 요약

```text
검증 ALB (EKS) ── priority 1 /v1/{traces,metrics,logs} ──▶ devEksOtlpTarget=ingest  → ingest TG (30416)
                                                          devEksOtlpTarget=gateway → gateway TG (30082)
telemetry-gateway Pod ── SASL/IAM 9098 ──▶ MSK(3 broker, 3 AZ) ──▶ telemetry-ingest Pod(dual|kafka)
```

| 항목 | 값 |
|---|---|
| MSK | `soma-376-dev-telemetry`, Kafka `3.9.x.kraft`, `kafka.m7g.large` × 3, 100 GiB, IAM 전용, public access off |
| MSK subnet / SG | `10.1.32.0/24`(2a)·`10.1.33.0/24`(2b)·`10.1.34.0/24`(2c), `DevMskSg`는 앱 node SG의 9098만 허용 |
| stage | `devEksArchivePrefix=eks_validation` → `validation`, `eks` → `main` |
| topic / group | `pulsemetry-dev-telemetry-ingress-<stage>` / `pulsemetry-dev-telemetry-ingest-<stage>` |
| topic 설정 | partition 6, RF 3, `min.insync.replicas=2`, `retention.ms=259200000`, `cleanup.policy=delete`, `max.message.bytes=13631488`, unclean off |
| Gateway | 컨테이너 8082, NodePort 30082, TG `soma-376-dev-eks-gateway-v`, health `/api/v1/healthz`, grace 60s |
| ingest 모드 | `http`(NodePort+TGB, grace 60s), `dual`(NodePort+TGB+Consumer, 90s), `kafka`(ClusterIP, TGB 없음, 90s) |
| 경보 | `soma-376-dev-telemetry-*` 10개. SNS가 없어 상태만 남는다 |

## 2. backend 인계 계약

backend(PROJ-245)는 아래 이름을 그대로 읽는다. backend 브랜치 `feature/PROJ-245-telemetry-jwt-gateway-consumer`의 설정 키와 대조했으며,
인프라 테스트만으로는 앱이 이름을 읽는지 증명할 수 없다. `iss`·`aud`·`typ`·`scope`는 backend 고정 계약값이라 공급하지 않는다.

| 대상 | 이름 | 값·형식 |
|---|---|---|
| Gateway·ingest(dual/kafka) | `PULSEMETRY_KAFKA_BOOTSTRAP_SERVERS` | `b-<n>.<cluster>.<id>.c<n>.kafka.ap-northeast-2.amazonaws.com:9098`을 쉼표로 이은 1~3개 (bootstrap 조회 JSON 그대로, 정렬) |
| 〃 | `PULSEMETRY_KAFKA_SECURITY` | `iam` |
| 〃 | `PULSEMETRY_KAFKA_TOPIC` | `pulsemetry-dev-telemetry-ingress-<stage>` |
| ingest(dual/kafka) | `PULSEMETRY_KAFKA_CONSUMER_GROUP` | `pulsemetry-dev-telemetry-ingest-<stage>` |
| Gateway·ingest | `PULSEMETRY_KAFKA_IAM_ROLE_ARN` | output `MskGatewayRoleArn` / `MskIngestRoleArn` |
| 〃 | `PULSEMETRY_KAFKA_IAM_SESSION_NAME` | `pulsemetry-dev-telemetry-gateway` / `pulsemetry-dev-telemetry-ingest`. 역할 trust가 이 이름만 허용한다 |
| Gateway·ingest | `AWS_REGION` | `ap-northeast-2`. aws-msk-iam-auth의 `awsStsRegion`도 같은 값이어야 한다 |
| ingest | `PULSEMETRY_INGEST_MODE` | `http`·`dual`·`kafka` |
| enrollment·Gateway·ingest | Spring `pulsemetry.telemetry-jwt.public-key-files` | `SPRING_APPLICATION_JSON`의 `{"[<kid>]": "/mnt/telemetry-jwt/keys/<alias>"}` |
| enrollment | `pulsemetry.telemetry-jwt.active-kid`, `.private-key-file`, `.issue-enabled` | runtime 입력 kid, `/mnt/telemetry-jwt/keys/private.pem`, JSON boolean |
| 모두 | health | `GET /api/v1/healthz` readiness. liveness는 TCP, dual·kafka ingest만 같은 HTTP health(listener 정지 시 503 `listener_stopped`) |

추가로 다음을 전제로 한다. 이 전제가 backend 구현과 다르면 chart·생성기를 고친다.

- Gateway는 포트 env 없이 기본 8082로 listen한다. infra는 Gateway에 포트 env를 공급하지 않는다.
- `SPRING_APPLICATION_JSON`은 `pulsemetry` 아래에 `user-auth`·`oidc`·`telemetry-jwt`를 한 번에 담는다. 같은 env를 중복 선언하지 않는다.
- 공개키 원본은 사용자 JWT와 같은 `kid → X.509 PEM` JSON, 개인키는 PKCS8 PEM이다. kid 맵의 파일만 읽고 URL에서 키를 받지 않는다.
- `issue-enabled` 기본값은 false이며 ECS 경로에는 telemetry JWT 설정·키를 공급하지 않는다. ECS enrollment는 키 없이 기동해야 한다.
- Gateway는 DB·HMAC·S3 설정 없이 기동한다. chart는 Gateway의 `PULSEMETRY_DB_*`·`ARCHIVE_*`·`CLICKHOUSE_*` env와 configtree mount를 거부한다.
- 실패 로그는 평문 한 줄 `event=<code>`다. `telemetry_gateway_rejected`, `telemetry_publish_failed`, `telemetry_permanent_failure`,
  `telemetry_retry_exhausted`, `telemetry_commit_failed`를 CloudWatch Logs term으로 집계한다.
- Gateway 앱 종료는 30s 안, Consumer 컨테이너 종료는 45s 안이다. Pod grace는 Gateway 60s, dual/kafka ingest 90s다.

## 3. 사전 준비

1. ECR `soma-376/telemetry-gateway`를 CDK 밖에서 만든다(ADR-0007). 이미지는 backend workflow가 ARM64로 push한다.
   workflow는 `dev` tag를 다시 push하므로 tag 변경 가능 여부·scan·암호화는 기존 `soma-376/telemetry-ingest`와 같게 맞춘다.
   ```bash
   aws ecr describe-repositories --repository-names soma-376/telemetry-ingest --region ap-northeast-2 \
     --query 'repositories[0].{mutability:imageTagMutability,scan:imageScanningConfiguration,encryption:encryptionConfiguration}'
   aws ecr create-repository --repository-name soma-376/telemetry-gateway --region ap-northeast-2   # 위 설정을 같은 옵션으로 지정
   ```
2. cicd stack을 배포해 backend-dev 역할에 이 레포의 ECR push를 추가한다. ECS service 권한은 추가되지 않는다.
   backend 레포 GitHub secret `ECR_REPO_TELEMETRY_GATEWAY_DEV` 등록은 backend 담당이다.
3. 서울 리전에서 `aws kafka list-kafka-versions`로 `3.9.x.kraft`, 콘솔·요금표로 `kafka.m7g.large`의 2a·2b·2c 가용성을 확인한다.
4. Kafka 관리 Job은 앱 node의 public egress로 GitHub release에서 `aws-msk-iam-auth-2.3.9-all.jar`를 받는다. 경로 차단 여부를 확인한다.

## 4. CDK 적용

[EKS 런북](dev-eks-manual-deployment.md) §2의 `EKS_CONTEXT`에 `-c devEksOtlpTarget=ingest`를 포함한다.
MSK 생성은 수십 분이 걸리고 실패하면 EKS 스택 업데이트 전체가 롤백된다. 다른 변경 없이 이 기능만 담은 배포를 먼저 수행한다.

```bash
npx cdk diff --all "${EKS_CONTEXT[@]}" > "$RUN_DIR/cdk-diff-telemetry.txt"
npx cdk deploy --all "${EKS_CONTEXT[@]}" --outputs-file "$RUN_DIR/cdk-outputs.json"
```

diff에서 확인할 것: Network에 subnet 3·route table 3·`DevMskSg`·ingress 3(9098, 30082×2)만 추가되고 기존 subnet·SG 속성은 그대로다.
Data에 Secret 2개와 output 2개, Edge에 Gateway TG와 output 2개, EKS에 MSK·역할·association·경보가 추가된다. 삭제·교체는 없어야 한다.
이후 EKS 런북 §2-2로 output을 모으고 `aws kafka get-bootstrap-brokers` JSON을 저장한다. JSON에는 `BootstrapBrokerStringSaslIam`만 있어야 한다.

## 5. telemetry JWT 키 등록

[공통 준비 런북](dev-dashboard-prerequisites.md)의 사용자 JWT 초기화 절차를 원본 이름만 바꿔 적용한다.
원본은 `soma-376/dev/telemetry-jwt/private-key`(PKCS8 PEM)와 `soma-376/dev/telemetry-jwt/public-keys`(`kid → PEM` JSON)다.
ARN은 `DevDataStack` output `TelemetryJwtPrivateKeySecretArn`·`TelemetryJwtPublicKeysSecretArn`이다. 사용자 JWT 키를 재사용하지 않는다.
등록한 두 VersionId, active kid, alias를 runtime 입력 YAML에 적는다. 원문은 출력·저장하지 않는다.

```yaml
telemetryJwt:
  privateVersionId: <개인키 VersionId>
  publicVersionId: <공개키 VersionId>
  activeKid: <kid>
  publicKeys:
    - kid: <kid>
      alias: <kid와 무관한 검토된 파일명>.pem
  issueEnabled: false   # 모든 verifier 배포 뒤에만 true
ingestMode: http
```

## 6. 설치 순서

1. EKS 런북 §2-2 생성기에 `--gateway-image`와 `--msk-bootstrap`을 함께 전달한다. 생성기는 `ValidationOtlpTarget`과 `ingestMode`가 맞지 않으면 실패한다
   (`ingest` 대상 → `http|dual`, `gateway` 대상 → `dual|kafka`).
2. `runtime-config` release를 갱신한다. SPC는 8개이며 `<app>-telemetry-jwt` 3개를 포함한다.
3. topic을 만들고 설정을 대조한다. Job은 실패 시 재생성·변경하지 않는다.
   ```bash
   helm upgrade --install telemetry-kafka-admin helm/dev/workloads/telemetry-kafka-admin --namespace pulsemetry-dev \
     --values "$RUN_DIR/generated/telemetry-kafka-admin.yaml"
   JOB=$(kubectl -n pulsemetry-dev get jobs -l pulsemetry.io/job=topic-init -o name | sort | tail -n 1)
   kubectl -n pulsemetry-dev wait --for=condition=complete "$JOB" --timeout=10m
   kubectl -n pulsemetry-dev logs "$JOB" --all-containers
   ```
   `불일치` 로그가 나오면 topic을 지우지 말고 관리 역할 client 설정으로 `kafka-configs --describe --all` 결과를 기록한 뒤 별도 승인으로 정정한다.
4. 공개키를 모든 verifier에 먼저 배포한다. enrollment(`issueEnabled: false`) → ingest(`http` 또는 `dual`) → Gateway 순으로 설치한다.
   ```bash
   for app in enrollment-api telemetry-ingest telemetry-gateway; do
     helm upgrade --install "$app" helm/dev/workloads/spring-app --namespace pulsemetry-dev \
       --values "helm/dev/workloads/$app.yaml" --values "$RUN_DIR/generated/$app.yaml" --wait --timeout 10m
   done
   kubectl -n pulsemetry-dev get pods,services,targetgroupbindings -o wide
   ```
5. Gateway 검증: `devEksOtlpTarget=ingest`인 동안 Gateway TG는 listener에 연결되지 않아 ALB health check가 없다.
   Pod readiness와 `kubectl -n pulsemetry-dev port-forward svc/telemetry-gateway 8082:8082`로 확인한다. Bearer는 명령 이력에 남기지 않는다.
6. 모든 verifier가 새 공개키로 Ready인지 확인한 뒤 runtime 입력의 `issueEnabled: true`로 enrollment만 다시 생성·배포한다.

## 7. ALB 전환과 Kafka 전용화

1. ingest를 `dual`로 배포하고 Consumer가 group에 가입했는지 확인한다(consumer lag 지표 출현, `event=` 실패 로그 없음).
2. `EKS_CONTEXT`의 `devEksOtlpTarget=gateway`로 바꿔 Edge만 배포한다. 변경은 EKS listener priority 1 규칙의 대상 하나다.
   ```bash
   npx cdk diff DevEdgeStack "${EKS_CONTEXT[@]}"   # EksValidationAlbHttpOtlpRule 대상과 ValidationOtlpTarget만 바뀐다
   npx cdk deploy DevEdgeStack --exclusively "${EKS_CONTEXT[@]}" --outputs-file "$RUN_DIR/cdk-outputs-edge.json"
   ```
3. `ptt_` 토큰의 401 → `pit_` 재발급 → JWT 재전송과 ClickHouse 적재를 확인한다.
4. 안정화 후 output을 다시 모으고 `ingestMode: kafka`로 생성해 ingest를 배포한다. Service가 ClusterIP로 바뀌고 TGB가 삭제된다.
   생성기는 `ValidationOtlpTarget=gateway` output이 없으면 kafka 모드를 거부한다.

## 8. 복구

자동 direct fallback은 없다. 같은 group·저장 대상으로 backlog를 계속 소비하며 다음 순서만 허용한다.

1. ingest를 `dual`(NodePort+TGB)로 다시 생성·배포하고 ingest TG의 target 등록을 확인한다.
2. `devEksOtlpTarget=ingest`로 Edge를 배포한다. 생성기 검사가 `ingest` 대상에서 `kafka` 모드를 거부하므로 순서를 바꿀 수 없다.
3. enrollment signer를 되돌리기 전에 모든 verifier에 해당 공개키가 있어야 한다.
4. Helm revision 복구·키 버전 복구·ALB 전환·DB/PVC 복구는 각각 따로 확인한다.

stage 전환(`eks_validation` → `eks`)은 topic·group·IAM 범위가 함께 바뀐다. 기존 topic backlog를 소비 완료(lag 0)한 뒤
EKS 런북 §6과 같이 prefix를 바꾸고 이 문서 §6의 topic 초기화부터 다시 수행한다.

## 9. 키 회전과 보안 폐기

- 정상 회전: 새 키 등록 → 모든 verifier(Gateway·ingest·enrollment)에 신·구 공개키 배포 → enrollment의 private VersionId·active-kid 전환
  → 마지막 구 키 발급 후 **3시간+30초** 대기 → 구 공개키 제거 순서다. VersionId·kid 맵은 Pod annotation hash에 포함되므로 SPC만 바꿔서는 반영되지 않는다.
- 키 유출: 해당 kid를 공개키 집합에서 제거한 버전을 모든 verifier에 즉시 배포한다. 이미 Kafka에 접수된 record는 Consumer의 RDB 검증으로 거부해야 하므로
  backend의 보안 폐기 SQL 절차(`revoke_reason=security`)를 함께 실행한다. 순서와 SQL은 backend 운영 문서를 따른다.
- 개별 토큰 보안 폐기는 backend 절차다. Gateway는 만료 전 폐기 토큰을 통과시키며 Consumer가 거부한다.

## 10. 수동 offset 재처리

72시간 보존 안의 record만 가능하다. 재처리는 중복 적재가 생길 수 있고 보존 기간이 지난 record는 복구할 수 없다.

1. 실패 로그의 topic·partition·offset과 대상 저장소를 기록한다.
2. 같은 group의 Consumer를 모두 멈춘다. `ingestMode: kafka`면 외부 트래픽이 없으므로 `kubectl -n pulsemetry-dev scale deployment/telemetry-ingest --replicas=0`.
   `dual`이면 먼저 §8로 HTTP 경로를 정리하거나 승인된 중단 시간을 잡는다.
3. plan(`--dry-run`)으로 예상 offset을 확인한다. group이 Empty가 아니면 Job이 실패한다.
   ```bash
   : "${RESET_PARTITION:?0~5}" "${RESET_OFFSET:?재처리를 시작할 offset}"
   helm upgrade --install telemetry-kafka-admin helm/dev/workloads/telemetry-kafka-admin --namespace pulsemetry-dev \
     --values "$RUN_DIR/generated/telemetry-kafka-admin.yaml" \
     --set topicInit.enabled=false --set offsets.enabled=true --set offsets.mode=plan \
     --set "offsets.partition=$RESET_PARTITION" --set "offsets.toOffset=$RESET_OFFSET"
   ```
   전체 partition을 시각으로 옮길 때는 `--set offsets.toDatetime=2026-10-21T00:00:00.000+09:00`을 대신 쓴다.
4. 결과를 검토한 뒤 같은 입력에 `offsets.mode=execute`로 실행하고, 적용된 offset 로그를 기록한다.
   Job은 CLI의 `Error:` 출력·빈 결과, 그리고 실행 뒤 다시 읽은 committed offset이 계획(`topic,partition,offset` CSV)과 다른 경우 실패한다.
   그 사이 Consumer가 다시 가입해도 실패한다. 목표가 보존 범위 밖이면 CLI가 가장 가까운 offset으로 보정하므로 계획 행의 값을 기준으로 본다.
5. `helm upgrade`로 ingest를 원래 values(replica 1)로 되돌린다. 마지막에 topic 초기화 기본 release로 되돌려 offset Job을 남기지 않는다.

## 11. 관측

```bash
aws cloudwatch describe-alarms --alarm-name-prefix soma-376-dev-telemetry- --region ap-northeast-2 \
  --query 'MetricAlarms[].{Name:AlarmName,State:StateValue}' --output table
```

| 경보 | 조건(초기 가설) |
|---|---|
| `msk-disk-used` | 세 broker의 `KafkaDataLogsDiskUsed` 최대 ≥ 80%, 5분 2회 |
| `msk-under-min-isr` | `UnderMinIsrPartitionCount` 합 ≥ 1, 1분 5회 중 3회 |
| `msk-offline-partitions` | `OfflinePartitionsCount` ≥ 1, 1분 5회 중 3회 |
| `consumer-time-lag` / `consumer-offset-lag` | stage group·topic의 `EstimatedMaxTimeLag` ≥ 600s / `SumOffsetLag` ≥ 10000, 5분 3회 |
| `gateway-rejected` | `event=telemetry_gateway_rejected` 5분 합 ≥ 50 |
| `publish-failed`·`permanent-failure`·`retry-exhausted`·`commit-failed` | 해당 `event=` 5분 합 ≥ 1 |

경보 action이 없다. 운영자가 상태를 조회한다. Pod 재시작·OOM 경보는 Container Insights가 없어 이번 범위에서 제외했다(ADR-0035 Follow-up).
broker 로그는 output `MskBrokerLogGroupName`(14일)이다.

## 12. 로컬 검증 기록과 미검증 경계

2026-10-21 로컬 검증(`feature/PROJ-246-telemetry-gateway-msk`)은 build, 전체 Jest 27 suites·692 tests(Helm 3.22.0·kubeconform 0.8.0 지정, skip 없음),
`validate-helm-workloads.mjs`의 workload resource 103개·platform 6개·실패 입력 214개, prod 모드 A/B·dev(EKS 비활성/활성/main prefix/Gateway 대상)·cicd
fixture synth를 수행했다. prod 템플릿은 develop과 바이트 단위로 같고
cicd는 backend-dev 정책에 `soma-376/telemetry-gateway` ECR ARN 한 줄만 추가된다.
`scripts/eks-values-check-runtime.mjs`는 telemetry SPC·Gateway·관리 Job 렌더링까지 통과했지만, 고정 CSI chart 1.6.1 archive가 upstream에서
재게시돼(index `created` 2026-10-15) `versions.json` SHA256과 달라 그 뒤 단계에서 중단된다. develop에서도 같은 결과이며 이번 변경과 무관하다.

미검증: 실제 MSK 생성·`3.9.x.kraft` 수락, Pod Identity → MSK 역할 assume(`sts:TagSession` 포함)과 재인증 soak, broker/AZ 장애 뒤 ISR 2 쓰기 재개,
CSI mount·UID 10001 접근, jar 다운로드 경로, ALB 전환·복구, 경보 발생, 실제 daemon E2E.
