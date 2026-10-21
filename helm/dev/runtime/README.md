# dev EKS 런타임

CDK는 기존·dashboard 전용 Secrets Manager ARN·Pod Identity 역할·association과 `/eks/dev/application` 로그 그룹을 소유한다. Helm은 아래 release를 소유한다. Secret 값은 values에 넣지 않는다.

| release | namespace | chart | 고정 버전 |
|---|---|---|---|
| secrets-store-csi-driver | kube-system | secrets-store-csi-driver | 1.6.1 |
| secrets-provider-aws | kube-system | secrets-store-csi-driver-provider-aws | 3.1.4 |
| fluent-bit | pulsemetry-dev-logs | fluent-bit | 0.58.3 (image 5.1.3) |
| runtime-config | pulsemetry-dev | `chart/` | 0.1.0 |

`versions.json`은 공개 chart index와 tgz를 대조한 URL·SHA256이다. 별도 CSI release를 설치하고 ASCP의 driver dependency를 꺼서 `^1` 범위가 설치 버전을 바꾸지 않게 한다. Auto Mode 제공 Pod Identity Agent·EBS·네트워크 구성요소는 설치하지 않는다. CSI·ASCP·Fluent Bit은 앱·ClickHouse·관측 ARM64 NodePool 모두에 배치한다.

Spring 앱은 UID/GID 10001로 `configtree:/mnt/secrets-store/`를 읽는다. PULSEMETRY 파일은 Pod 전용 readOnly CSI volume의 `0444` 파일로 만들며, Secret 읽기 권한은 namespace·ServiceAccount·cluster별 Pod Identity로 제한한다. driver 1.6.1의 CSIDriver는 fsGroupPolicy를 명시하지 않으므로 `0440`과 fsGroup만으로 읽기 권한이 생긴다고 가정하지 않는다. 앱 chart의 initContainer가 같은 UID로 필수 파일의 존재·읽기 가능·비어 있지 않음을 검사한다. 실제 CSI mount·Pod Identity·UID 권한은 배포 후 검증 대상이다.

ASCP jmesPath는 원본 JSON도 파일로 제공한다. `_source_db_json`·`_source_admin_json`은 `0400`이고 앱이 사용하는 PULSEMETRY 필드만 `0444`다. HMAC Secret은 JSON 추출 없이 전체 SecretString을 읽는다. 관리자 Secret ARN·token 파일은 enrollment SPC에만 존재하며 ingest 권한·SPC에는 없다. Kubernetes Secret 복제·자동 회전은 비활성화한다. 기존 설정 변경은 명시적 재배포로 반영한다. JWT 교체는 아래 verifier → signer 순서를 따른다.

Fluent Bit은 `pulsemetry-dev`·`pulsemetry-observability`·`pulsemetry-dev-logs` namespace의 컨테이너 로그를 tail하고
Kubernetes metadata의 namespace도 재검사한다. 앱은 `/eks/dev/application`, 관측 스택과 수집기는
`/eks/dev/observability`로 보낸다. 원문 `log`와 `kubernetes.*` metadata를 JSON envelope에 함께 보존한다.
`auto_create_group Off`와 그룹별 IAM으로 그룹 생성을 막는다. tail DB·filesystem buffer는 같은 노드의 Pod 교체를
견디지만 노드 손실을 보장하지 않는다. queue 상한과 긴 줄 누락 경계는 [관측 런북](../../../docs/runbooks/dev-observability.md)에 있다.
Events는 독립 관측 차트의 단일 collector, 노드 상세 로그는 NodeDiagnostic을 사용한다. 실제 배송·누락·권한 검증은 배포 후 수행한다.

검증 prefix `eks_validation`와 병행 운영 prefix `eks`는 CDK `ArchivePrefix` output에서 values로 전달한다. ingest의 S3 권한은 해당 prefix의 PutObject뿐이며 조회·정리는 운영자 권한이다. 두 값을 함께 바꾸는 절차는 배포 런북을 따른다.

설치·복구 전체 순서는 [dev EKS 런북](../../../docs/runbooks/dev-eks-manual-deployment.md)을 따른다. 로컬 configtree 검증은 `python3 scripts/test-configtree.py --backend <backend checkout 또는 고정 source snapshot>`으로 실행한다. backend 소스·YAML을 변경하거나 DB·AWS에 접속하지 않는다.

PROJ-212 당시 configtree 검증 대상은 backend commit `4d6ccf2e2809344eac9feb1873f2d527eee2f212`다. 같은 소스를 재현하려면 `python3 scripts/test-configtree.py --fetch-ref 4d6ccf2e2809344eac9feb1873f2d527eee2f212`를 실행한다. 이 옵션은 기존 `gh` 접근으로 YAML·DTO·버전 카탈로그 5개만 임시 경로에 읽고 검증 뒤 삭제한다. 기본 실행은 형제 checkout을 읽으며 각 소스 SHA256을 출력하므로 검증 대상이 달라졌는지 비교할 수 있다. Spring Boot 4.1.0·Kotlin 2.3.21·JDK 25와 준비된 Gradle dependency cache가 필요하고 `--gradle-cache`로 cache 위치를 지정할 수 있다.

이 configtree fixture는 지정한 두 Kotlin DTO 소스를 다시 컴파일해 Boot의 ConfigDataEnvironmentPostProcessor와 Binder에 전달한다. 네트워크 클라이언트의 기본 상수만 무해한 상수 stub으로 격리하며, 실제 앱 자동설정·HTTP·RDS·AWS 연결은 실행하지 않는다. 원본 JSON `0400` 파일도 fixture에 포함하고 PULSEMETRY 값·OS 환경변수 우선순위·필수 디렉터리 누락을 검사한다. 개별 필수 파일 누락·빈 파일은 앱 chart의 실제 init shell command로 검사한다. 로컬 파일 검증은 CSI mount와 UID 10001의 live 접근 증거가 아니다. 이 고정 source 검증을
dashboard·JWT 전체 설정이나 현재 backend 계약의 검증 완료로 확대하지 않는다.

근거: [AWS ASCP](https://github.com/aws/secrets-store-csi-driver-provider-aws), [CSI driver](https://github.com/kubernetes-sigs/secrets-store-csi-driver/releases/tag/v1.6.1), [Pod Identity trust](https://docs.aws.amazon.com/eks/latest/userguide/pod-id-role.html), [Fluent Bit CloudWatch output](https://docs.fluentbit.io/manual/data-pipeline/outputs/cloudwatch), [Spring configtree](https://docs.spring.io/spring-boot/reference/features/external-config.html).

## dashboard와 JWT의 YAML 공급

PROJ-231은 runtime-config release에 SPC 다섯 개를 만든다(PROJ-246의 telemetry JWT SPC 세 개를 더해 현재 여덟 개). 기존 두 configtree SPC와
`dashboard-api-runtime`, `enrollment-api-jwt`, `dashboard-api-jwt`다. dashboard configtree에는
네 전용 계정의 username/password 여덟 파일만 공급한다. dashboard Pod Identity는 이 네 ARN과
공개키 ARN만 읽고 HMAC·관리자 token·개인키·raw S3 권한을 받지 않는다. enrollment만 JWT 두
원본을 읽으며 ingest의 기존 원본·권한·configtree는 유지한다.

추가 운영 입력은 `--runtime-values <yaml>`로 생성기에 전달한다. `userAuth`·`dashboard`·선택적 `oidc` 구조는
공통 `lib/dev/runtime-input.cjs` 검증기를 사용하며 ECS JSON 입력과 같다. `writerImage`는 ECS 전용이므로
이 YAML에 넣지 않는다. 중복 YAML key·알 수 없는 필드·DB endpoint/ARN/비밀번호 재정의는 거부한다.
관리 기능과 메일의 추가 Secret·transport 공급은 이 릴리스 범위 밖이므로 두 enabled 값은 false만 허용한다.
`test/fixtures/eks-runtime.yaml`은 구조 검증용 예시이며 그 운영 수치는 실제 배포 기본값이 아니다.
운영자는 issuer·audience·origin·버전·kid 맵·운영 한도를 검토한 제한된 입력 파일을 준비한다.

CDK output이 ARN·RDS endpoint·NodePort·TG를 소유하고 추가 YAML은 JWT VersionId·kid/alias와
운영값을 소유한다. 생성 후에는 추가 입력을 Helm에 다시 중첩하거나 `--set-json`으로 재정의하지 않는다.

```bash
node scripts/eks-values.mjs \
  --outputs /secure/cdk-outputs.json \
  --output-dir generated \
  --runtime-values /secure/eks-runtime-values.yaml \
  --enrollment-image "$ENROLLMENT_IMAGE" \
  --ingest-image "$INGEST_IMAGE" \
  --dashboard-image "$DASHBOARD_IMAGE"
```

생성기는 같은 입력에서 `generated/runtime.yaml`과 앱별 YAML을 함께 만든다. runtime chart는
`generated/runtime.yaml`을 사용하고 각 workload는 정적 앱 YAML 다음에 `generated/<app>.yaml`을
전달한다. 비밀 원문 없이도 ARN은 계정 ID를 포함하므로 생성 파일은 접근 제한 경로에서 mode 0600으로 관리한다.

JWT SPC는 고정 `objectVersion`만 사용하며 이동 label을 함께 지정하지 않는다. 공개키 JSON의 kid를
인용 JMESPath identifier로 escape하고 별도 검토 alias의 PEM으로 추출한다. alias는 경로가 될 수 없고
중복·개인키 파일 충돌을 거부한다. 개인키 파일은 enrollment에만 존재한다. 키 mount는
`/mnt/user-jwt/keys`, 설정 mount는 `/mnt/secrets-store`로 분리하며 둘 다 앱/init에 읽기 전용이다.
PEM을 configtree나 환경변수로 전달하지 않고 chart가 bracket map의 파일 경로만
`SPRING_APPLICATION_JSON`에 구성한다.

같은 앱 이미지의 UID 10001 initContainer가 두 디렉터리 접근과 모든 필수 파일의 존재·읽기·크기,
실제 1-byte read를 출력 없이 검사한다. 로컬 테스트는 fixture에서 이 명령의 정상·누락·빈 파일·읽기
불가 실패를 확인한다. 이 결과는 실제 CSI 파일 소유권과 UID 10001의 live mount 접근을 증명하지 않는다.
PEM 형식·RSA 크기·키쌍 정합은 앱 기동 검증이며 선택한 키링과 배포 manifest의 전체 kid 일치와 시험
서명/검증은 수동 준비·배포 관문이다. 단순 파일 검사로 이를 완료 처리하지 않는다.

VersionId·키 맵은 Pod template annotation의 hash에 포함된다. 새로운 runtime/app YAML을 함께 적용해야
Pod가 새 파일을 다시 읽으며 SPC만 바꿔서는 완료되지 않는다. 모든 ECS/EKS verifier에 신·구 공개키를
먼저 적용한 뒤 signer의 private VersionId·active-kid를 전환한다. 마지막 구 발급 이후 330초 이상
대기한 뒤 구 공개키를 제거한다. 실패 시 겹치는 공개키 상태를 유지하고 중단하며, 제거 후 롤백도
모든 verifier 복구가 signer 복구보다 앞선다. Secret label 보존·실제 UID 접근·인증 조회·캐시 DDL·
교체/롤백은 PROJ-225의 실제 배포 증거로 남긴다.

## 기존 Cognito의 OIDC client secret 공급

[ADR-0032](../../../docs/adr/0032-dev-oidc-client-secret-runtime-supply.md)와
[OIDC 준비 런북](../../../docs/runbooks/dev-oidc-prerequisites.md)을 따른다. ECS JSON에서 선언한 client key마다
CDK가 빈 원본을 만들고 DataStack의 `OidcClientSecretArns` JSON output을 제공한다. EKS 생성기는
`DevEksStack`·`DevEdgeStack`과 **`DevDataStack`** output을 함께 받아야 한다.

`oidc` 생략 또는 `enabled:false`는 값 mount·필수 파일 검사를 추가하지 않는다. 활성화하려면 운영자가
Cognito client secret 문자열을 원본에 등록한 뒤 runtime YAML의 `clients[].key/versionId`, HTTP/HTTPS callback 입력,
`userAuth.allowedRedirectUris`를 지정한다. key는 선언된 원본의 부분집합이며 ARN·원문 override는 거부한다.
CDK enrollment Pod Identity의 원본 권한은 ECS의 활성화 여부와 독립적이다.

기존 `enrollment-api-runtime` SPC가 전체 문자열을 고정 `objectVersion`으로 mount한다. 정렬된 key별
`PULSEMETRY_OIDC_CLIENT_SECRET_<index>` alias를 기존 configtree에 추가하고 앱/init의 필수 파일로 검사한다.
chart는 정확한 client key와 placeholder를 기존 JWT `SPRING_APPLICATION_JSON` 맵에 합친다.
dashboard·ingest에는 OIDC object·설정·권한을 추가하지 않는다.

key·ARN·VersionId 변경은 Pod annotation에 반영된다. generated runtime → enrollment values 순서로 적용하고,
복구 때도 동일한 배포 기록의 두 파일을 같은 순서로 적용한다. SPC 단독 갱신이나 앱 release만 rollback하면
공급 버전이 일치하지 않을 수 있다. HTTP values의 생성·렌더링 허용과 실제 로그인 검증은 별도다.
현재 backend는 원격 HTTP callback/복귀를 거부하고 Cognito의 HTTP 웹 callback 예외는 localhost 테스트용이다.
실제 원격 로그인에는 HTTPS가 필요하며 local 프로필을 자동 적용하지 않는다.
`python3 scripts/test-oidc-config.py`는 실제 backend DTO·Spring Boot로 ECS/EKS synthetic secret의 map binding과
JWT 맵 보존을 검증한다. 로컬 fixture가 실제 CSI mount 또는 Cognito 연결을 대신하지 않는다.

## telemetry JWT 공급 (PROJ-246)

[ADR-0036](../../../docs/adr/0036-dev-telemetry-gateway-workload-and-msk-iam.md)에 따라 runtime chart가 `enrollment-api-telemetry-jwt`,
`telemetry-gateway-telemetry-jwt`, `telemetry-ingest-telemetry-jwt` SPC를 만든다. 원본은 `DevDataStack` output
`TelemetryJwtPrivateKeySecretArn`·`TelemetryJwtPublicKeysSecretArn`이고 사용자 JWT 원본과 달라야 한다.
개인키 `private.pem`은 enrollment SPC에만 있고 세 SPC 모두 공개키 JSON에서 kid별 alias를 고정 `objectVersion`으로 추출한다.
runtime 입력 YAML의 `telemetryJwt`(`privateVersionId`·`publicVersionId`·`activeKid`·`publicKeys`·`issueEnabled`)와 `ingestMode`는
EKS 생성기 전용이며 ECS JSON은 이 키를 거부한다. 앱 chart는 키를 `/mnt/telemetry-jwt/keys`에 configtree·사용자 JWT와 분리해 mount하고
`SPRING_APPLICATION_JSON`의 `pulsemetry.telemetry-jwt`에 파일 맵·issuer·audience(enrollment는 active-kid·private-key-file·issue-enabled 추가)를 합친다.
공개키 선배포 → `issueEnabled: true` 순서와 회전·폐기는 [telemetry Kafka 런북](../../../docs/runbooks/dev-telemetry-kafka.md)을 따른다.
