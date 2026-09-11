# 0026. dev 백엔드를 telemetry-ingest·enrollment-api·ClickHouse 세 서비스로 전환한다

## Status

Accepted

이 ADR은 dev 환경에 한해 다음 결정을 대체한다.

- [ADR 0004](0004-task-level-colocation.md)의 Collector/Post Processor 및 API Server/Batch Processor co-location
- [ADR 0007](0007-precreate-ecr-outside-cdk.md)의 dev 자체 빌드 이미지 목록
- [ADR 0017](0017-inject-collector-config-via-env-provider.md)의 dev Collector config 주입
- [ADR 0018](0018-post-processor-runtime-contract-via-derived-dsn-secret.md)의 dev post-processor 계약과 enrollment-api 임시 슬롯
- [ADR 0022](0022-dev-infrastructure-topology.md)의 dev 앱 태스크·네트워크 모드·ALB 구성
- [ADR 0024](0024-github-actions-oidc-deploy-roles.md)의 dev backend/pipeline 배포 대상과 권한
- [ADR 0025](0025-use-60-second-dev-deregistration-delay.md)의 dev 비-ClickHouse 타깃 목록

[ADR 0023](0023-dev-auth-proxy-between-alb-and-collector.md)은 전체를 대체한다. [ADR 0005](0005-cloud-map-private-dns-discovery.md)의
ClickHouse A 레코드 결정은 유지하고, dev Collector A 레코드 등록만 폐지한다. 위 ADR의 prod 결정과
그 밖의 결정은 그대로 유효하다.

## Context

허브 ADR 0004는 `ai-telemetry-pipeline`을 `pulsemetry-backend`로 병합하기로 했고, 허브 ADR 0005는
인증·수집·마스킹·정규화·보강·ClickHouse 적재를 `:apps:telemetry-ingest` Spring 애플리케이션 하나가
담도록 확정했다. 별도 OTel Collector와 auth-proxy를 목표 토폴로지에 남기지 않는다.
`pulsemetry-backend`에는 enrollment API와 Flyway 진실원을 가진 `:apps:enrollment-api`도 있다.

반면 현재 dev 인프라는 다음 네 ECS 서비스로 구성된다.

1. `collector`: `otel-collector` + `post-processor`
2. `auth-proxy`: 토큰 인증 후 Collector로 중계
3. `dashboard`: 임시로 enrollment-api 이미지를 `api-server` 슬롯에 배치하고 구현체가 없는
   `batch-processor` 컨테이너를 함께 선언
4. `clickhouse`

이 구성에서는 enrollment-api가 독립 배포 단위가 아니고, 새 telemetry-ingest가 들어갈 자리도 없다.
또한 허브 `contracts/telemetry-ingest.md`의 B3처럼 enrollment-api와 ingest가 같은 dev RDS
`controlplane`을 사용하는 실제 배선이 완성되지 않았다. 목표 구성을 한 번에 교체하면 새 이미지·환경
계약·ALB 경로 중 어느 하나가 실패했을 때 되돌릴 실행 자리가 사라진다.

이 ADR은 `infra`가 소유하는 dev AWS 리소스와 전환 순서만 결정한다. 앱 코드와 이미지 빌드는
`pulsemetry-backend`가 소유한다. 계약 문서는 실제 전환과 구 서비스 제거가 끝난 뒤 현행화한다.
따라서 이 ADR의 Accepted 상태는 설계가 확정됐다는 뜻이며, 새 서비스가 이미 배포됐거나 런타임에서
안정적이라는 뜻이 아니다.

## Decision

### 1. 목표 토폴로지는 ECS 서비스 세 개다

dev ECS 클러스터 `soma-376-dev` 안의 최종 서비스는 다음 셋이다.

| ECS 서비스 | 앱/ECR | 컨테이너 포트 | 네트워크 | 호스트 | 메모리 예약 | 로그 그룹 |
|---|---|---:|---|---|---:|---|
| `telemetry-ingest` | `:apps:telemetry-ingest` / `soma-376/telemetry-ingest` | 4316 | bridge + 동적 host port | 기존 앱 ASG | 1024 MiB | `/ecs/dev/telemetry-ingest` |
| `enrollment-api` | `:apps:enrollment-api` / `soma-376/enrollment-api` | 8080 | bridge + 동적 host port | 기존 앱 ASG | 1024 MiB | `/ecs/dev/enrollment-api` |
| `clickhouse` | 기존 ClickHouse 이미지 | 8123, 9000 | awsvpc | 기존 ClickHouse ASG | 1024 MiB | 기존 `/ecs/dev/clickhouse` |

ECR 저장소와 ECS 서비스의 물리 이름은 표의 앱 이름과 정확히 같게 한다. 자체 빌드 ECR 저장소는
[ADR 0007](0007-precreate-ecr-outside-cdk.md)에 따라 CDK 밖에서 선생성하고 CDK는 참조만 한다.
기존 ECR 저장소는 이 전환에서 물리 삭제하지 않는다.

두 Spring 서비스는 태스크 내부 localhost 의존도, Cloud Map A 레코드 등록 요구도 없으므로 bridge를
쓴다. 동적 host port를 사용하고 ALB에는 instance target으로 등록한다. 둘 다 기존 앱 ASG와
`minHealthyPercent: 0`, `maxHealthyPercent: 100` 교체 배포 설정을 사용한다. ClickHouse의 awsvpc,
Cloud Map `clickhouse.obs.local`, 타깃 타입, 배포 설정은 바꾸지 않는다.

새 로그 그룹은 기존 dev 정책인 보존 14일과 `RemovalPolicy.DESTROY`를 따른다. 이는 예약된
ADR-0020이 로그 정책을 다시 결정할 때까지의 현행 정책을 새 앱 이름에 적용한 것이다.

### 2. 기존 서비스는 병행 검증 뒤 제거한다

`collector`, `auth-proxy`, `dashboard`를 새 서비스 생성과 동시에 제거하지 않는다. 새 서비스를
기존 트래픽 경로에 연결하지 않은 상태로 먼저 합성·배포하고, 이미지 pull과 `/v1/healthz`를 확인한다.
그 다음 ALB 경로를 전환하고 실제 enrollment 및 OTLP E2E를 확인한 뒤 구 서비스를 제거한다.

병행 기간의 앱 호스트 메모리 소프트 예약은 기존 2304 MiB에 새 서비스 2048 MiB가 더해져
4352 MiB다. 이는 t4g.medium 한 대의 4 GiB를 초과한다. 따라서 병행 기간에만 앱 ASG
`maxCapacity`를 2로 올리고 두 호스트에 태스크를 배치할 여지를 만든다. 구 서비스 제거 뒤 최종
예약량과 배치를 다시 확인하고 `maxCapacity`를 1로 되돌린다. 이 계산은 소프트 예약의 합일 뿐이며
실제 런타임 메모리 안정성을 보장하지 않는다. 배포 후 메모리·배치·OOM을 별도로 관측한다.

### 3. 런타임 계약은 앱 소스를 기준으로 주입한다

telemetry-ingest 환경변수 이름은 `apps/telemetry-ingest/src/main/resources/application.yaml`,
enrollment-api 환경변수 이름은 해당 앱의 `application.yaml`을 권위로 삼는다. 이름이 맞지 않아도
CDK synth와 배포가 통과할 수 있으므로 합성 테스트와 실제 RDS·S3·ClickHouse 경계 검증을 함께 둔다.

telemetry-ingest에는 비밀이 아닌 다음 값을 일반 환경변수로 넣는다.

| 환경변수 | 값의 출처 |
|---|---|
| `PULSEMETRY_INGEST_PORT` | `4316` |
| `PULSEMETRY_DB_URL` | dev RDS `controlplane` JDBC URL |
| `PULSEMETRY_CLICKHOUSE_URL` | 기존 `clickhouse.obs.local:8123` HTTP URL |
| `PULSEMETRY_CLICKHOUSE_DATABASE` | 기존 ClickHouse database 계약 |
| `PULSEMETRY_ARCHIVE_TYPE` | `s3` |
| `PULSEMETRY_ARCHIVE_BUCKET` | 기존 Raw Signal 버킷 이름 |
| `PULSEMETRY_ARCHIVE_PREFIX` | dev archive prefix 계약 |

RDS 마스터 Secret의 `username`·`password`는 각각 `PULSEMETRY_DB_USERNAME`·
`PULSEMETRY_DB_PASSWORD` ECS secret으로 넣고, telemetry-ingest task role에는 Raw Signal 버킷
read/write 권한을 준다.

enrollment-api에는 PROJ-112의 `PULSEMETRY_DB_URL`, `PULSEMETRY_DB_USERNAME`,
`PULSEMETRY_DB_PASSWORD`, `PULSEMETRY_ADMIN_API_TOKEN`, `PULSEMETRY_TOKEN_HASH_SECRET` 계약을
그대로 옮기고 아래의 public base URL과 binaries directory를 더한다. 구 `api-server` 컨테이너 이름이나
`dashboard` 서비스 이름은 신규 배포 단위에 사용하지 않는다.

두 앱은 기존 `tokenHashSecret` 하나를 공유하고 모두 `PULSEMETRY_TOKEN_HASH_SECRET` ECS secret으로
주입한다. 새 키를 만들지 않고 합성 시점에 값을 읽지 않는다. RDS username/password와 관리자
토큰도 ECS `secrets`로만 주입하며, 일반 환경변수나 `CfnOutput`에 값을 쓰지 않는다.

enrollment-api의 `PULSEMETRY_PUBLIC_BASE_URL`은 실제 dev ALB의 `http://<ALB DNS>`를 사용한다.
고정 문자열이나 별도 수동 입력을 두지 않는다. `synthDev()`가 EdgeStack을 만든 뒤 ApplicationStack의
태스크 정의에 이 값을 명시적으로 late binding한다. 이때 `cdk.json`에 이미 설정된 weak cross-stack
reference를 그대로 사용한다. 새 reference strength 전환이나 수동 `exportValue`/`Fn::ImportValue`
우회 계약은 만들지 않는다. 바이너리 경로는
`PULSEMETRY_BINARIES_DIR=/app/binaries`로 둔다.

이 작업은 바이너리를 만들거나 이미지에 공급하는 책임을 포함하지 않는다. 설치 URL과 라우팅을
배선하되, `/bin/*` 설치 E2E는 해당 산출물이 이미지에 준비될 때까지 미완료로 기록한다.

`config/otel-collector.yaml`, `ENRICHMENT_ENV`, 운영의 `apiServer`·`batchProcessor`·
`postProcessor` ECR 상수, 운영 파생 DSN은 변경하지 않는다. dev에서 구 소비 경로만 제거한다.
prod 템플릿은 이 전환 전후에 동일해야 한다.

### 4. dev 배포 권한은 새 이름으로 옮긴다

`pulsemetry-backend` dev 역할은 신규 ECR 두 개에 이미지를 push하고 신규 ECS 서비스 두 개를
강제 재배포할 수 있어야 한다. 기존 이름의 권한은 병행·롤백 기간에 유지하고 구 서비스 제거 단계에서
회수한다. 태스크 정의 등록과 `iam:PassRole`은 계속 허용하지 않는다.

기존 `ai-telemetry-pipeline` dev 역할은 역할 자체, GitHub OIDC 신뢰 정책과 ARN output을 유지하되,
정리 후 inline/attached permission statement를 0개로 만든다. 여기에는 ECR 인증을 위한
`ecr:GetAuthorizationToken`도 포함한다. 역할 삭제는 PROJ-106의 구 레포 정리 결정까지 미룬다.
prod 역할과 대상은 변경하지 않는다.

### 5. ALB `:80`은 정확한 경로만 새 앱으로 전달한다

전환 후 리스너 표는 다음과 같다.

| 리스너 | 우선순위 | 조건 | 타깃 | 타입/포트 | health check | deregistration delay |
|---|---:|---|---|---|---|---:|
| `:80` | default | 그 밖의 요청 | fixed 404 | - | - | - |
| `:80` | 1 | `/v1/traces`, `/v1/metrics`, `/v1/logs` 정확히 세 경로 | `telemetry-ingest` | instance/4316 | `/v1/healthz`, 200 | 60초 |
| `:80` | 2 | `/api/*` | 기존 `dashboard` | instance/8080 | 기존 `/`, 200-404 | 60초 |
| `:80` | 3 | `/v1/enroll`, `/v1/installations/*`, `/v1/invitations*` | `enrollment-api` | instance/8080 | `/v1/healthz`, 200 | 60초 |
| `:80` | 4 | `/windows`, `/unix`, `/bin/*` | `enrollment-api` | instance/8080 | 위와 같은 TG | 60초 |
| `:8123` | default | 전체 | `clickhouse` | ip/8123 | `/ping`, 200 | 기존 300초 |

`/v1/*` 와일드카드는 쓰지 않는다. 그러면 enrollment 경로가 telemetry-ingest에 가려진다.
ALB rule당 match evaluation 한도를 지키기 위해 enrollment API와 bootstrap 경로를 규칙 둘로 나눈다.
두 규칙은 같은 enrollment target group을 재사용한다. `/v1/healthz`는 ALB target group이 직접
호출하며 외부 리스너 규칙을 만들지 않는다. 모든 리스너의 `open: false`를 유지한다.

인증을 우회하던 `:4318` 리스너·인그레스·output은 이 전환에서 제거한다. 다만 CloudFormation의
ECS 서비스 삭제 순서와 롤백 경로를 보존하기 위해 PROJ-143에서는 구 target group 리소스와
service binding을 바로 삭제하지 않는다. 리스너가 새 target group을 향하고 `:4318`이 닫힌 상태를
먼저 배포한다. 기존 `/api/*` 규칙도 이 단계에는 유지한다.

### 6. 정리는 두 번의 배포로 나눈다

새 경로의 live E2E가 성공한 뒤 PROJ-144를 다음 두 커밋·배포로 실행한다.

1. 구 target group과 ECS 서비스의 binding을 끊되 구 target group 리소스는 유지한다. 이 배포가
   완료되어 EdgeStack이 더 이상 구 서비스를 참조하지 않는지 확인한다.
2. 그 다음 구 target group·서비스·태스크 정의·Cloud Map 등록·dev 전용 SG 규칙·파생 Secret·로그
   그룹·props·outputs·죽은 상수와 권한을 삭제한다.

기존 weak cross-stack reference 설정을 유지한 채 실제 ECS `LoadBalancers` binding을 먼저 해제하고,
그 배포가 끝난 뒤 target group을 삭제한다. 새 strong export/import 결합이나 이를 숨기는 수동
`exportValue`는 추가하지 않는다. 두 배포 사이에 실패하면 첫 배포 이전 템플릿 또는 구 리스너
액션으로 돌아가 기존 서비스를 다시 연결한다.

### 7. 구현과 배포 관문을 티켓 순서로 고정한다

| 순서 | 티켓 | 결과 | 실행 관문 |
|---:|---|---|---|
| 1 | PROJ-137 | 이 ADR과 영향 ADR | 선행 없음 |
| 2 | PROJ-138 | ECR·ECS 물리 이름과 IAM을 병행 가능한 상태로 추가 | PROJ-137 |
| 병행 | PROJ-139 | backend가 두 ARM64 이미지를 빌드·push하고 두 서비스를 재배포 | PROJ-138 및 PROJ-105/PR #13의 `develop` 머지 |
| 3 | PROJ-140 | telemetry-ingest 서비스 추가, 라우팅은 유지 | 코드: PROJ-138, 실제 배포: PROJ-139와 PROJ-141 |
| 4 | PROJ-141 | telemetry-ingest 환경·Secret·S3 권한 정합 | PROJ-138 |
| 5 | PROJ-142 | enrollment-api 독립 서비스 추가, 라우팅은 유지 | 코드: PROJ-138, 실제 배포: PROJ-139~141 |
| 6 | PROJ-143 | 두 앱으로 ALB 전환, `:4318` 차단 | PROJ-139~142 배포와 health 확인 |
| 7 | PROJ-144 | live E2E 뒤 구 binding 분리, 다음 배포에서 구 리소스 삭제 | PROJ-143 실측 성공 |
| 8 | PROJ-145 | 허브 아키텍처·계약을 배포된 현행으로 갱신 | PROJ-144 완료 |

PROJ-139는 현재 열려 있는 PROJ-105의 backend PR #13이 `develop`에 머지될 때까지 시작하지 않는다.
새 서비스의 실제 배포도 PROJ-139의 이미지와 PROJ-141/142의 환경 계약이 준비될 때까지 기다린다.
ECR 선생성과 최초 이미지 준비는 향후 운영자가 별도로 수행하며, 이를 CDK 배포에 숨기지 않는다.
정상 backend workflow는 enrollment-api를 먼저 안정화하고 telemetry-ingest를 이어서 배포한 뒤,
두 ECS 서비스가 모두 stable일 때만 성공으로 끝낸다.

## Alternatives Considered

### 기존 Collector·auth-proxy 토폴로지를 계속 운영

허브 ADR 0004·0005가 확정한 코드 소유권과 실행 단위에 어긋나며, 같은 파이프라인을 두 구현으로
운영하게 되므로 기각한다.

### 새 앱으로 한 번에 교체

이미지·Flyway·환경변수·ALB 경로 중 어느 경계가 실패했는지 분리할 수 없고 구 서비스 롤백 자리를
동시에 없애므로 기각한다.

### telemetry-ingest와 enrollment-api를 한 태스크에 co-locate

두 앱은 독립적으로 배포되고 서로 localhost를 요구하지 않는다. Flyway 실패와 ingest 실패의
수명주기를 묶고 각각의 workflow 안정화 상태를 관측하기 어려워 기각한다.

### 새 앱을 awsvpc로 실행

Cloud Map A 레코드와 태스크 내부 localhost라는 강제 조건이 없다. dev의 제한된 ENI를 소비하고
NAT 없는 awsvpc 태스크의 인터넷 egress 제약까지 가져오므로 기각한다.

### `PULSEMETRY_PUBLIC_BASE_URL`을 context나 고정 문자열로 입력

실제 ALB 교체·재생성 때 값이 갈라지고 운영자가 두 값을 맞춰야 하므로 기각한다. 실제 ALB DNS
토큰을 weak cross-stack reference로 소비한다.

## Consequences/Tradeoffs

### Positive

- dev 배포 단위가 backend의 실제 앱과 일치해 이미지·ECS 서비스·로그·workflow 실패 지점을 앱별로
  추적할 수 있다.
- enrollment-api와 telemetry-ingest가 같은 RDS와 token hash Secret을 사용해 허브 계약 B3를 실제
  배포 경계에서 해소할 수 있다.
- 정확한 OTLP 세 경로만 ingest로 보내고 `:4318`을 닫아 인증 우회 경로를 제거한다.
- 병행 생성, 라우팅 전환, binding 분리, 삭제를 나눠 각 단계에서 이전 경로로 돌아갈 수 있다.

### Negative

- 병행 기간에는 t4g.medium 앱 호스트를 최대 두 대까지 사용해 dev 비용이 일시적으로 늘어난다.
- bridge 동적 host port와 기존 한 대 최종 구성은 교체 중 다운타임을 계속 감수한다.
- weak cross-stack reference는 producer/consumer 결합을 CloudFormation이 강제하지 않으므로 배포 순서를
  운영자가 지켜야 한다.
- 1024 MiB 예약은 실제 Spring heap·off-heap 사용량의 충분성을 증명하지 않는다. live 관측 전에는
  메모리 안정성을 주장할 수 없다.
- 바이너리 공급이 이 작업 밖이라 enrollment URL이 배선돼도 설치 E2E는 바로 완료되지 않을 수 있다.

## Follow-up

- PROJ-143에서 인증 실패·성공, RDS 조회, Raw Signal S3 PUT, ClickHouse insert, enrollment API,
  bootstrap URL과 `:4318` 차단을 실제 ALB 경계에서 확인한다.
- PROJ-144 뒤 앱 ASG를 `maxCapacity: 1`로 되돌리고 최종 예약량·배치·메모리를 관측한다.
- PROJ-145는 전환이 실제로 끝난 뒤 허브 계약의 B3/B4, 인증 주체, 실행 경로와 레포 소유권을
  현행화한다. 목표 상태를 미리 현재 계약으로 쓰지 않는다.
- 바이너리 공급 경로가 준비되면 `/windows`, `/unix`, `/bin/*` 설치 E2E를 별도로 완료한다.
- prod의 Collector·post-processor·api-server·batch-processor, Cognito/TLS와 배포 단위 전환은 별도
  ADR과 작업으로 다룬다.

## Acceptance Criteria

- 최종 dev ECS 서비스가 `telemetry-ingest`, `enrollment-api`, `clickhouse` 세 개로 정의되어 있다.
- ECR·ECS·포트·network mode·메모리·로그·ALB 경로·health check·deregistration delay가 이 ADR의 표와
  일치한다.
- 신규 두 앱이 같은 기존 token hash Secret을 쓰며 Secret 값은 합성 산출물에 나타나지 않는다.
- prod synth 산출물은 기준선과 동일하다.
- 구 서비스는 live E2E 전 삭제되지 않고, binding 분리와 리소스 삭제가 서로 다른 배포로 실행된다.

## References

- 허브 [ADR 0001 — OTLP 인증을 애플리케이션 계층에서 검증한다](../../../docs/adr/0001-otlp-authentication-model.md)
- 허브 [ADR 0004 — 텔레메트리 파이프라인을 backend 레포로 병합한다](../../../docs/adr/0004-telemetry-pipeline-repo-merge.md)
- 허브 [ADR 0005 — 텔레메트리 파이프라인을 단일 Spring 애플리케이션으로 배포한다](../../../docs/adr/0005-single-app-telemetry-topology.md)
- 허브 [`contracts/enrollment-api.md`](../../../docs/contracts/enrollment-api.md)
- 허브 [`contracts/telemetry-ingest.md`](../../../docs/contracts/telemetry-ingest.md)
- [AWS CDK reference strength](https://github.com/aws/aws-cdk/blob/main/packages/aws-cdk-lib/README.md#reference-strength)
