# 0036. telemetry Gateway는 Pod Identity와 workload별 MSK 전용 역할로 dev EKS에 배포하고 OTLP 대상은 context로 전환한다

## Status

Accepted (PROJ-246; 로컬 구현·검증 대상, AWS 배포·MSK IAM 실접속·ALB 전환 증거 별도)

[ADR-0028](0028-dev-eks-auto-mode-transition.md)의 "앱 세 종류, 모든 앱 NodePort" 전제와
[ADR-0030](0030-dev-user-jwt-keys-from-secrets-manager.md)의 "ingest에는 JWT 권한 없음" 문구를 telemetry JWT 범위에서 부분 대체한다.
사용자 로그인 JWT 원본·SPC·ingest의 사용자 JWT 부재는 그대로다. 네트워크·MSK는 [ADR-0035](0035-dev-msk-isolated-subnets-under-eks-stack.md)를 따른다.

## Context

backend(PROJ-245)는 telemetry 전용 RS256 JWT를 enrollment에서 발급하고, DB 없는 Gateway가 JWT를 검증한 뒤 MSK에 발행한다.
ingest는 HTTP 호환(`http`), HTTP+Consumer(`dual`), Consumer 전용(`kafka`) 모드로 동작한다.

MSK IAM은 연결 수명 동안 재인증한다. 재인증 주체가 처음과 다르면 broker가 거부한다. Pod Identity 자격은 갱신마다 role session 이름이
바뀔 수 있으므로 Pod Identity 자격을 MSK에 그대로 쓰면 장시간 연결이 끊긴다. `aws-msk-iam-auth`는 `awsRoleArn`과 고정
`awsRoleSessionName`으로 다른 역할을 assume할 수 있다. Pod Identity가 붙이는 session tag는 transitive이므로 다음 역할의 trust에
`sts:TagSession`이 필요하다.

현재 Helm chart와 values 생성기는 enrollment·ingest·dashboard 세 앱과 SPC 5개를 전제로 한다. 검증 ALB의 OTLP 규칙은 ingest TG로 고정돼 있다.

## Decision

### 1. workload

| 앱 | 포트 / Service | TG / TGB | grace | configtree SPC | telemetry JWT SPC |
|---|---|---|---|---|---|
| telemetry-gateway | 8082 / NodePort 30082 | `soma-376-dev-eks-gateway-v` | 60s | 없음 | `telemetry-gateway-telemetry-jwt`(공개키) |
| telemetry-ingest `http` | 4316 / NodePort 30416 | 기존 ingest TG | 60s | 기존 | `telemetry-ingest-telemetry-jwt`(공개키) |
| telemetry-ingest `dual` | 4316 / NodePort 30416 | 기존 ingest TG | 90s | 기존 | 공개키 |
| telemetry-ingest `kafka` | 4316 / ClusterIP | 없음 | 90s | 기존 | 공개키 |
| enrollment-api | 8080 / NodePort 30080 | 기존 | 60s | 기존 | `enrollment-api-telemetry-jwt`(개인키·공개키) |

- 모든 앱은 `GET /api/v1/healthz` readiness와 TCP liveness를 쓴다. liveness를 Kafka·RDS·S3 상태에 묶지 않는다.
- Gateway에는 DB·HMAC·관리 token·사용자 JWT·OIDC·S3 설정과 권한이 없다. chart는 Gateway의 configtree·사용자 JWT mount와 DB 계열 env를 거부한다.
- ClusterIP는 ingest `kafka` 모드 전용이며 TGB를 선언할 수 없다. 반대로 `kafka` 모드는 ClusterIP여야 한다.

### 2. Pod Identity와 MSK 전용 역할

- `podRole`로 SA `telemetry-gateway`, `telemetry-kafka-admin`, `telemetry-kafka-offsets`의 Pod Identity 역할을 추가한다. 기존 enrollment·ingest 역할을 재사용한다.
- workload마다 MSK 전용 역할을 둔다. trust는 해당 Pod 역할 ARN 하나만 허용한다.
  `sts:AssumeRole`에는 `sts:RoleSessionName` 고정값 조건을 걸고, `sts:TagSession`을 함께 허용한다.
  Pod 역할에는 자기 MSK 역할에 대한 `sts:AssumeRole`·`sts:TagSession`만 준다.
- 세션 이름은 `pulsemetry-dev-telemetry-gateway`, `-ingest`, `-kafka-admin`, `-kafka-offsets`이고 STS region은 `ap-northeast-2`다.

| MSK 역할 | 권한 |
|---|---|
| gateway | cluster `Connect`·`WriteDataIdempotently`, topic `DescribeTopic`·`WriteData` |
| ingest | cluster `Connect`, topic `DescribeTopic`·`ReadData`, group `DescribeGroup`·`AlterGroup` |
| topic 관리 Job | cluster `Connect`, topic `CreateTopic`·`DescribeTopic`·`DescribeTopicDynamicConfiguration`·`AlterTopicDynamicConfiguration` |
| offset Job | cluster `Connect`, group `DescribeGroup`·`AlterGroup`, topic `DescribeTopic`·`ReadData` |

- topic·group ARN은 cluster ARN의 UUID(`Fn.select(2, Fn.split('/', attrArn))`)와 stage 이름으로 만든다. wildcard, `kafka:*`, `kafka-cluster:*`,
  삭제·transactional·cluster 변경 권한은 주지 않는다.

### 3. telemetry JWT 키 원본

- `DevDataStack`에 값 없는 `CfnSecret` 2개를 RETAIN으로 둔다. `soma-376/dev/telemetry-jwt/private-key`, `soma-376/dev/telemetry-jwt/public-keys`.
  ARN은 DataStack output(`TelemetryJwtPrivateKeySecretArn`, `TelemetryJwtPublicKeysSecretArn`)이다. Secret 정의는 기본 11개가 된다.
- 개인키는 enrollment만 읽는다. Gateway와 ingest는 공개키만 읽는다. dashboard는 telemetry 키를 받지 않는다.
- runtime chart가 앱별 `<app>-telemetry-jwt` SPC 3개를 고정 `objectVersion`으로 만든다. SPC는 기존 5개와 합쳐 8개다.
  키는 `/mnt/telemetry-jwt/keys`에 읽기 전용으로 mount하며 configtree·사용자 JWT 디렉터리와 분리한다. 같은 이미지의 UID 10001 initContainer가 파일을 검사한다.
- chart는 기존 `SPRING_APPLICATION_JSON`의 `pulsemetry` 맵에 `telemetry-jwt`를 합친다. `public-key-files`(`[kid] → 파일`)를 넣고
  enrollment에만 `active-kid`, `private-key-file`, `issue-enabled`를 넣는다. VersionId·kid 맵은 Pod annotation hash에 포함한다.
  `iss`·`aud`·`typ`·`scope`는 backend 고정 계약값(backend ADR 0065)이라 설정으로 공급하지 않는다.

### 4. Kafka 설정 공급

- chart가 `PULSEMETRY_KAFKA_BOOTSTRAP_SERVERS`, `PULSEMETRY_KAFKA_SECURITY=iam`, `PULSEMETRY_KAFKA_TOPIC`, `PULSEMETRY_KAFKA_CONSUMER_GROUP`(ingest),
  `PULSEMETRY_KAFKA_IAM_ROLE_ARN`, `PULSEMETRY_KAFKA_IAM_SESSION_NAME`, `PULSEMETRY_INGEST_MODE`(ingest)를 구조화된 values에서 만든다.
  같은 이름을 자유 `env`로 넣으면 렌더링을 거부한다.
- 값은 CDK output과 운영자가 조회한 bootstrap JSON에서만 온다. runtime 입력으로 ARN·topic·group·세션 이름을 덮어쓸 수 없다.

### 5. OTLP 대상 전환

- 검증 ALB에는 Gateway TG가 항상 있다. `devEksOtlpTarget=ingest|gateway`(기본 `ingest`, EKS 활성 시에만 사용)가 EKS listener의 priority 1 OTLP 규칙 대상만 바꾼다.
  ECS listener, 규칙 수·우선순위·logical ID, WAF는 바뀌지 않는다. 현재 값은 `ValidationOtlpTarget` output이다.
- 생성기는 이 output과 ingest 모드를 대조한다. 대상이 `gateway`면 ingest는 `dual|kafka`, `ingest`면 `http|dual`이어야 한다.
  따라서 전환은 `dual` 배포 → `devEksOtlpTarget=gateway` 배포 → ingest `kafka`, 복구는 ingest `dual` → `devEksOtlpTarget=ingest` 순서로만 가능하다.
- 자동 direct fallback은 없다. 복구 중에도 같은 group·저장 대상으로 backlog를 계속 소비한다.

### 6. 이미지 공급

- ECR `soma-376/telemetry-gateway`는 CDK 밖에서 만든다(ADR-0007). backend-dev 배포 역할에는 이 레포의 ECR push만 추가하고 ECS service는 추가하지 않는다.
- Kafka 관리 Job은 digest 고정 `apache/kafka:3.9.2` 이미지와 공식 SHA256을 대조한 `aws-msk-iam-auth-2.3.9-all.jar`를 사용한다.

## Alternatives Considered

### A. Pod Identity 자격을 MSK에 그대로 사용
- 장점: 역할이 하나 줄어든다.
- 단점: 자격 갱신으로 세션 이름이 바뀌면 MSK 재인증이 실패한다.
- 탈락 이유: 장시간 연결의 안정성을 보장할 수 없다.

### B. EKS Pod Identity target role(EKS가 수행하는 role chaining)
- 장점: 앱 설정에 역할 ARN이 필요 없다.
- 단점: 세션 이름을 EKS가 정하므로 고정할 수 없다.
- 탈락 이유: A와 같은 재인증 문제가 남는다.

### C. 모든 workload가 MSK 역할 하나를 공유
- 장점: 리소스가 적다.
- 단점: Consumer가 쓰기, Gateway가 group 변경, Job이 데이터 쓰기 권한을 얻는다.
- 탈락 이유: Gateway만 ingress에 쓴다는 신뢰 경계(PLAN §3.2)를 깬다.

### D. Gateway 전용 ALB 또는 가중치 라우팅
- 장점: 점진 전환이 가능하다.
- 단점: ALB·WAF·인증서가 늘고, 가중치 라우팅은 자동 fallback처럼 동작한다.
- 탈락 이유: 같은 검증 ALB에서 규칙 대상만 바꾸는 편이 단순하고 복구 절차가 명확하다.

## Consequences/Tradeoffs

### Positive
- Gateway에는 DB·HMAC·개인키·S3 권한이 없고, MSK 쓰기는 Gateway 역할만 가진다.
- 키 원본·SPC·mount가 사용자 JWT와 분리돼 교체·폐기가 서로 영향을 주지 않는다.
- 전환·복구 순서가 output과 생성기 검사로 강제된다.

### Negative
- 역할·association·SPC가 늘어나 배포 입력과 검사 항목이 많아진다.
- 운영자가 공개키를 먼저 등록하지 않으면 runtime chart를 렌더링할 수 없다. 키 등록이 EKS 재배포의 선행 조건이 된다.
- `devEksOtlpTarget=ingest`일 때 Gateway TG는 listener에 연결되지 않아 ALB health check가 없다. 전환 전 Pod readiness로 확인한다.
- Kafka 관리 Job은 노드의 public egress로 GitHub에서 jar를 받는다. 해당 경로가 막히면 Job이 실패한다.

## Follow-up

- 허브 contracts(enrollment·telemetry ingest)와 ADR 0001·0005·0006 개정은 [ADR-0035](0035-dev-msk-isolated-subnets-under-eks-stack.md) Follow-up과 함께 진행한다.
- ingest의 HMAC·공개키 제거는 backend가 HTTP/기존 토큰 호환 의존성 제거를 확인한 뒤 결정한다.
- Kafka 관리 이미지를 jar가 포함된 사내 이미지로 바꿀지 검토한다.
- 앱 다중 replica·전용 NodePool·NetworkPolicy는 범위 밖이다.

## Acceptance Criteria

- template assertion으로 역할별 trust(Pod 역할 하나·세션 이름 조건)·권한 표·부재(Gateway의 DB·HMAC·개인키·S3, enrollment 외 개인키)를 검증한다.
- 검증 ALB의 53개 규칙이 두 listener에서 같고, `devEksOtlpTarget=gateway`일 때 EKS priority 1 규칙의 대상만 바뀐다.
- Helm 3.22.0·kubeconform 0.8.0으로 gateway·ingest 세 모드·enrollment·Job chart를 lint/render/schema 검사하고 잘못된 입력 거부를 확인한다.
- 실제 Pod Identity → MSK 역할 assume, MSK IAM 재인증 soak, ALB 전환·복구는 AWS 적용 후 별도 수락 항목이다.

## References

- [PROJ-246](https://team376.atlassian.net/browse/PROJ-246), backend [PROJ-245](https://team376.atlassian.net/browse/PROJ-245)
- [MSK IAM actions and resources](https://docs.aws.amazon.com/msk/latest/developerguide/kafka-actions.html)
- [MSK IAM use cases](https://docs.aws.amazon.com/msk/latest/developerguide/iam-access-control-use-cases.html)
- [aws-msk-iam-auth role assumption](https://github.com/aws/aws-msk-iam-auth#specifying-an-aws-iam-role-for-a-client)
- [EKS Pod Identity session tags (transitive)](https://docs.aws.amazon.com/eks/latest/userguide/pod-id-abac.html)
- [EKS Pod Identity target role trust 예시](https://docs.aws.amazon.com/eks/latest/userguide/pod-id-assign-target-role.html)
- [IAM sts:RoleSessionName 조건 키](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_iam-condition-keys.html#ck_rolesessionname)
