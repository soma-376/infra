# 격리 perf 환경 입력과 실제 상태 확인

PROJ-292는 별도 VPC/EKS/RDS와 Kafka provider를 표현하는 로컬 구현이다. 배포·부하·정리는 **NOT_RUN**이다. 사용자 승인 범위는 1회 총 100,000원, 생성 후 24시간 안에 seed·조회·시험·삭제 완료, 두 경로 합계 10,000요청 이하, 최대 20RPS, 실행당 600초, 시험 추가 저장량 1GiB다. 최대 처리용량 측정은 포함하지 않는다. 이 제한을 실제 실행/정리 gate에 반영하는 PROJ-294 전에는 배포하지 않는다.

공개 경로는 `perf-api.pulsemetry.co.kr`이며 PROJ-293의 선택적 ALB/ACM/WAF 선언으로 연결한다. 공유 인증서는 runtime ARN 참조로만 받고 사용자 CNAME 등록을 확인한다. 이 변경의 내부 Service URL을 공개 경로 검증 결과로 취급하지 않는다. seed 초기 기준은 합성 400명/50팀/약 400설치/180일이며 운영 동등성은 별도 판단이다.

## 계약과 소유권

- 원본: telemetry-load-tests `schemas/v2`, `schemas/v3`, `tools/contract.py`.
- 사본: `test/fixtures/perf-contract-v{2,3}`. SOURCE commit·파일별 SHA-256 검사를 통과해야 한다. 수동 schema 편집 금지.
- v2 환경 교환 파일은 기존 MSK IAM 9098 의미를 보존한다. v3 request의 `kafka.provider`로 MSK/Strimzi를 구분한다. request/provisional/resolved/lock의 혼합 버전은 거부한다. run manifest/journal/plan/verdict 버전은 이 묶음과 독립적이다.
- CDK는 perf 전용 AWS 자원, Helm은 노드 배치와 Kafka/앱 CR을 관리한다. `lib/perf`는 `common`만 참조한다.
- 현재 `Retain`/keep, raw 7일/evidence 90일은 과거 foundation 동작이다. 24시간 수명 보장이 아니며 PROJ-294에서 전용 자원과 bucket versions/multipart, Secret, 로그, CR/PVC/PV/EBS의 제거를 구현해야 한다. 증거는 삭제 전에 로컬에 수집한다.

## 로컬 합성과 입력 준비

```sh
npm run build
npx cdk synth --all --no-lookups -c env=perf \
  -c perfEnvironmentId=perf-example \
  -c perfProfile=profiles/perf/strimzi-fixed-v1.json -o /tmp/perf-strimzi-synth
```

`strimzi-fixed-v1`은 현재 dev와 같은 Kafka 4.2.2 이미지, 3개 dual-role broker/controller, mTLS9093, topic 6 partitions/RF3/minISR2를 사용한다. Kafka 전용 m7g.large 3대, 발생기 전용 c7g.large 1대와 앱/CH/관측/system pool을 고정한다. 자원량은 운영 대표성이 입증되지 않은 가설이다. 호환 MSK 합성은 `profiles/perf/fixed-v1.json`으로 선택한다.

ready request에는 해당 profile 파일의 SHA-256, 고정 이미지 digest, 환경 소유 Secret 참조, 배포 `PerfInfraParameters`와 같은 입력을 기록한다. 실제 account ARN, JWT, DB password, private key를 저장소나 결과 문서에 넣지 않는다.

values 생성에 필요한 파일은 ready request, CDK outputs 또는 `describe-stacks`, runtime metadata YAML이다. runtime에는 telemetry JWT VersionId·kid·공개키 파일 맵과 enrollment replica/GC 로그 선택만 둔다. Secret 값은 받지 않는다.

Strimzi는 별도 Secret metadata JSON을 추가한다. 형식은 다음 5개 Secret 각각의 **name/namespace/uid/resourceVersion만** 담은 `{items:[{metadata:{…}}]}`이다.

- `soma-376-perf-telemetry-cluster-ca-cert`
- `pulsemetry-gateway-perf`, `pulsemetry-ingest-perf`
- `pulsemetry-topic-admin-perf`, `pulsemetry-offset-admin-perf`

Kubernetes 권한과 대상 환경 확인을 마친 운영자가 metadata만 투영해서 수집한다. `kubectl get secret -o json` 원문을 파일로 저장하거나 전달하지 않는다. metadata가 변경되면 values를 다시 만들어 TLS revision을 갱신한다.

```sh
npx tsx scripts/perf-values.ts --request request.json --outputs stacks.json \
  --runtime-values runtime.yaml --strimzi-secrets strimzi-secret-metadata.json \
  --output-dir /tmp/perf-generated
```

MSK 호환 경로에서는 `--strimzi-secrets` 대신 `--msk-bootstrap`과 `--msk-nodes`를 사용한다. provider가 다른 입력은 함께 넣을 수 없다. 입력 reference나 profile/hash가 배포 outputs와 다르면 생성하지 않는다.

## 설치 순서와 Strimzi 권한

PROJ-293/294/295/296/297/298 검증 gate 후 설치 순서는 platform → CSI/ASCP → Strimzi operator → Kafka CR → Secret metadata 재수집 → runtime/관측 → CH → enrollment → ingest → gateway다. 공식 operator archive/digest는 `helm/dev/platform/strimzi/SOURCE.json`을 재사용하고 `helm/perf/addons/strimzi-values.yaml`과 `scripts/strimzi-operator-post-render.mjs perf`를 적용한다. operator는 perf namespace만 감시한다. Kafka chart는 `helm/dev/kafka`에 생성된 `kafka-strimzi.yaml`을 적용한다.

KafkaNodePool은 `perf-kafka` 3개 노드에 pod anti-affinity로 분산한다. 100GiB encrypted gp3 PVC 3개와 `deleteClaim:false`를 사용한다. KafkaUser ACL은 gateway topic Write/Describe+cluster IdempotentWrite, ingest/offset-admin topic Read/Describe+group Read/Describe, topic-admin Describe/DescribeConfigs다. 앱/관리 도구에는 CA `ca.p12`/`ca.password`와 해당 user `user.p12`/`user.password`만 mount한다. runner에는 Kafka 인증 자료를 공급하지 않는다.

## 같은 Gateway의 공개 HTTPS 경로

`perfCertificateArn` runtime 입력이 있으면 PerfEdgeStack이 추가된다. ARN은 서울 리전·같은 계정의 기존 인증서여야 하며 소스에 실제 ARN을 저장하지 않는다. 예시 합성은 다음과 같다. 실제 배포는 실행/정리 gate가 완성된 뒤에만 한다.

```sh
npx cdk synth --all --no-lookups -c env=perf -c perfEnvironmentId=perf-example \
  -c perfProfile=profiles/perf/strimzi-fixed-v1.json \
  -c "perfCertificateArn=$PERF_CERTIFICATE_ARN" -o /tmp/perf-https-synth
```

ready v3 request의 `infra.parameters`에 배포 `PerfInfraParameters`와 같은 `certificateArn`·`gatewayHttps`가 있어야 한다. 기존 v2는 공개 경로를 생산하지 않는다. `PerfEdgeStack`의 describe-stacks 결과도 values/provisional/resolved 입력에 포함한다. 인증서 입력과 Edge output 유무가 다르면 거부한다.

생성된 `lbc.yaml`과 `helm/perf/addons/lbc-values.yaml`을 공식 고정 `helm/dev/platform/lbc/vendor/aws-load-balancer-controller-3.6.0.tgz`에 함께 적용한다. dev의 고정 CRD/checksum은 재사용하되 namespace 감시는 pulsemetry-perf, 배치는 perf-system이다. LBC CRD와 controller가 Ready인 뒤 Gateway release를 적용한다. Gateway generated values는 NodePort 30082·TGB 한 개를 추가한다. 내부 Service 8082와 Deployment/selector는 같다.

ALB 생성 후 **실제** `PerfAlbDnsName`을 읽어 사용자에게 전달한다. CNAME 이름은 `PerfDnsCnameName`(`perf-api.pulsemetry.co.kr`), 대상은 이 실제 ALB DNS다. 인증서나 DNS를 새로 만들지 않고, 현재 사용자의 CNAME 작업을 대신했다고 기록하지 않는다.

| output | 용도 |
|---|---|
| GatewayHttpsUrl | v3 `endpoints.gateway_https`에 넣는 공개 origin |
| PerfAlbDnsName / PerfDnsCnameName | 사용자 CNAME 등록 값 |
| PerfAlbArn / PerfGatewayTargetGroupArn | 같은 Gateway 경로/target health 확인 |
| PerfNatPublicIps | 발생기 NAT 출발지 증거와 WAF IPSet 대조 |
| PerfWafArn / PerfWafLogGroupName | 403·Count 탐지 원인 확인 |
| PerfAlbAccessLogBucket | ALB status/target status·TLS·시간 증거 |

Job 입력은 `ingressPath: internal` 또는 `alb_https`다. 선택된 origin을 `endpoints.gateway`/`GATEWAY_ENDPOINT`에 넣고 `INGRESS_PATH`도 전달한다. chart가 infra의 내부 주소 또는 `gatewayHttps`와 대조한다. 공개 URL 누락을 내부 경로로 대체하지 않는다. raw endpoint override는 허용하지 않는다. load-tests의 paired manifest와 run 직전 상태 증거를 함께 사용한다.

외부 요청도 전용 perf-generator에서 NAT→공개 ALB→같은 Gateway로 간다. 자체 NAT EIP/32만 ALB SG/WAF에서 허용하므로 임의 노트북 요청 성공은 이 경로의 readiness 조건이 아니다. WAF는 허용 IP를 즉시 Allow하지 않고 dev OTLP의 managed/Count/query Block을 계속 평가한다. IP당 10,000/300초는 **Count**이며 이번 최대 20RPS/총 10,000요청 실행 제한을 대신하지 않는다. enrollment/OIDC/다운로드 정책은 공개하지 않는다.

ALB access log와 WAF Block/Count 로그는 원인 분석용이다. WAF header/query masking과 sampling off를 유지한다. 1일 lifecycle/retention만으로 24시간 삭제 완료를 보장하지 않으므로 PROJ-294 정리가 두 저장소도 비워야 한다. 공유 ACM은 cleanup 대상이 아니다.

DNS→ALB 일치, 유효한 인증서/SNI, HTTPS 연결, Gateway target health, WAF 정책/원인 로그와 실제 NAT 출발지는 PROJ-298 진단 증거로 확인한다. `gateway_https` 필드나 환경 resolved의 ready만으로 이 외부 경로 검증까지 성공했다고 해석하지 않는다.

## provisional와 resolved

```sh
npx tsx scripts/perf-provisional.ts --request request.json --stacks stacks.json \
  --deployment-id perf-example-d1 --out provisional.json
npx tsx scripts/perf-resolve.ts --request request.json --provisional provisional.json \
  --stacks stacks.json --kubernetes kubernetes-state.json \
  --strimzi-secrets strimzi-secret-metadata.json --readiness readiness.json \
  --out resolved.json
```

`kubernetes-state.json`은 NodePool/Node, 앱 Deployment/StatefulSet, StorageClass/PVC/PV, Kafka/KafkaNodePool/KafkaTopic/KafkaUser의 List를 포함한다. 여러 List 파일은 `--kubernetes`를 반복한다. Secret 원문 항목은 거부한다. resolver는 Ready/observedGeneration, bootstrap identity, mTLS listener, topic 설정, 역할별 ACL, broker nodeIds와 Bound PVC/PV, 요청 자원량·이미지를 대조한다. 부족한 실제 상태를 profile로 채우지 않으며 실패 시 `failed`를 만든다.

readiness 입력은 `checked_at`, `stages`, `smoke_artifact_ids`, `artifacts`, `clickhouse_version`이다. v3 stages는 `kafka_transport`, `secret_supply`, `auth`, `observability`, `storage`; v2는 첫 이름이 `iam_tls`다. 각 stage의 pass는 실제 smoke 증거가 있어야 하며 `clickhouse_version`은 실제 조회값이다. resolver는 증거를 실행하지 않으며 문서의 pass 선언 자체가 실제 성공 증명은 아니다. 파일을 덮어쓰지 않고 바이트 SHA로 request/provisional 연결을 검사한다.

resolved에는 Kubernetes workload UID·배치·자원과 RDS endpoint, Kafka 공급자, ACL/Secret refs/revision, Kafka CR/PVC/PV/EBS 정리 inventory가 남는다. 이 정보는 backend seed target 증거와 runner preflight에서 다시 실제 대상과 대조한다.

## 로컬 검증

```sh
HELM_BIN=/path/to/helm-3.22.0 KUBECONFORM_BIN=/path/to/kubeconform \
  PROMTOOL_BIN=/path/to/promtool-3.9.1 npm test -- --runInBand
```

Helm binary가 없으면 일부 suite는 skip되므로 결과를 전체 통과로 기록하지 않는다. v2/v3 공유 fixture, MSK/Strimzi 합성, provider 혼합 거부, mTLS/ACL/PVC 음성 사례, dev 기본 렌더 회귀를 확인한다. kubeconform의 원격 schema 취득 실패는 테스트 성공으로 바꾸지 않는다.

Strimzi verify Job은 MSK 환경변수와 generic scalar query를 받지 않는다. 배포한 Kafka 이름·namespace·topic·group·partition 수와 `KAFKA_METRICS_ENVIRONMENT=perf`를 전달한다. 고유 `ENVIRONMENT_ID`는 서버 표본의 범주형 environment 태그와 별개다.
[load-tests #4](https://github.com/soma-376/telemetry-load-tests/pull/4)의 도구 이미지를 사용해야 한다. 해당 구현은 exporter UP과 모든 partition의 begin/end/commit 원천 표본 시각·freshness·coverage를 검사하고, 미커밋은 begin=end일 때만 허용한다. 서로 다른 정상 scrape 세 개와 CH 행 수 안정이 있어야 drain을 통과하며, 저장 PASS라도 drain 미확인이면 전체 INCONCLUSIVE다. freshness 기본 30초는 현재 scrape 10초와 함께 기록한다.

관련 결정: [ADR 0050](../adr/0050-perf-strimzi-provider-and-isolated-capacity.md).

## 발생기 관측과 최초 smoke의 Job 입력

v3의 정식 Job 입력은 load-tests `docs/path-comparison.md`의 paired manifest와 실행 직전 상태 검증으로 만든다.
`pathPair`의 ID·SHA·환경 evidence 경로·smoke 예약량·사용 slot을 함께 전달한다. chart는 다른 환경의 경로,
잘못된 SHA/slot과 누락된 pair를 거부한다. smoke는 조건부 S3 slot 기록 후 요청하므로 실패한 시도도 공통 예산을 쓴다.
drain과 최종 검증은 각각 900초 이하이며 verify Job은 두 단계와 업로드 120초를 수용한다(각 900초이면 1,920초).

최초 인증·저장 smoke 전에는 ready resolved가 없으므로 load-tests `tools/prepare/bootstrap.py`를 사용한다.
이 도구가 실제 배포 metadata와 request/provisional SHA를 대조해 만든 `bootstrapMode: true` 입력은 내부
prepare·smoke에만 사용할 수 있다. runner·sentinel·verify·seed에는 허용하지 않는다. 증거는
`runs/bootstrap/<environment>/<request-sha>/<provisional-sha>/executions/<run>/`에 귀속하고, bootstrap 성공을
정식 시험 준비 완료로 바꾸지 않는다. 최초 시험용 identities 생성·DB 적용은 별도의 기존 seed operator 절차다.
배경 rich 데이터와 시험용 계정의 생성량·귀속을 함께 기록한다.

발생기 runner에는 `ENVIRONMENT=perf`와 고유 `ENVIRONMENT_ID`, Prometheus 조회 URL과 remote-write URL을 공급한다.
Pod 이름·namespace·node는 Downward API에서 읽는다. load-tests `docs/generator-readiness.md`에 따라 실제 node/NIC
용량 증거 SHA를 담은 `generator-policy.json`을 만들고 `objects.generatorPolicyConfigMap` 이름의 immutable ConfigMap으로
같은 runner namespace에 준비한다. chart는 `/generator-policy/generator-policy.json`에 읽기 전용으로 mount한다.
정책이나 관측이 없으면 실행을 시작하지 않는다. CPU 약 20% 여유는 해당 단일 발생기에서의 초기 유효성 기준이며 용량 C가 아니다.

로컬 검증은 v2 기존 Job과 v3 pair/bootstrap/Downward API/관측 mount를 포함한 13개 Helm 검사와 공식 Kubernetes schema를 통과했다.
초기 sandbox의 schema 검사 8건은 실패했고, 네트워크를 허용한 동일 suite 재검사에서 13건이 통과했다. load-tests `b9a29034079193aa65a9773fb25107fe4ed4873e`의 원본 bootstrap/paired values로 Job 7종 교차 렌더도 통과했다. AWS 적용·실제 관측은 NOT_RUN이다.

## PROJ-292 검증 기록

- build와 `git diff --check` 통과. v2/v3 SOURCE의 SHA-256 검사 통과; v3 원본 commit은 `65cba77274a1b3a6ffdc8e1c94ac2a32d92f3562`다.
- 전체 54 suite에서 1,485건 통과, 기존 Loki archive 누락 1건 실패를 확인했다. 저장소 lock의 공식 Loki/Tempo/Collector archive SHA-256을 검증해 준비한 뒤 해당 suite 1건이 통과했다. 이후 최종 provider Job 연결 변경을 포함한 대상 10 suite/196건이 통과했다.
- dev 기존 34개 Helm 렌더의 SHA-256이 변경 전과 같다. workload/runtime validator는 191 workload resource, 11 platform resource와 248 실패 입력을 통과했다. Strimzi perf operator의 watch namespace와 perf-system 배치를 별도 렌더로 확인했다.
- prod/dev/cicd/MSK perf/Strimzi perf의 CLI synth를 고정 fixture account/region/AZ와 `--no-lookups`로 통과했다. sandbox의 tsx CLI IPC 제한 때문에 같은 entrypoint를 `node --import tsx`로 실행했다. 실제 AWS 조회/배포 검증이 아니다.
- Strimzi perf 합성에는 MSK resource가 없고 VPC subnet은 ap-northeast-2a/b/c다. 실제 Kafka/노드는 아직 만들지 않았다.

## PROJ-293 검증 기록

- build/diff-check와 HTTPS Edge를 포함한 5-stack CLI synth(`--no-lookups`, fixture 계정/인증서) 통과. ACM/Route53 resource는 생성하지 않는다. 실제 AWS 배포·CNAME 등록·HTTPS/TG/WAF 성공은 NOT_RUN이다.
- perf/CDK/contract/Helm 대상 9 suite·194건과 최종 INGRESS_PATH 연결 후 Job chart 12건 통과. NodePort/내부 Service의 Deployment 렌더는 동일하다.
- 기존 dev 전체 35개 Helm 렌더 SHA-256이 동일하며 workload/runtime validator의 191+11 resource와 248 실패 입력 검증을 통과했다. LBC 공식 chart의 perf namespace 감시와 perf-system 배치도 렌더로 확인했다.
- 전체 55 suite·1,495건 중 1,494건 통과, 변경하지 않은 Strimzi promtool `KafkaConsumerLagHigh` 7분 경계 1건 실패 후 같은 suite 단독 6건은 통과했다. collection→alerts 기록규칙에 `group_eval_order`가 없는 변동 가능성을 관측 작업에 전달했으며, 이를 이 변경의 전체 단일 실행 PASS로 기록하지 않는다.
