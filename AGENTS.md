# AGENTS.md

> 이 문서는 PROJ-144와 PROJ-159의 로컬 구현·정책을 반영한다. AWS 배포와 live E2E는 수행하지 않았으므로 아래 구성은
> 배포된 dev 현행을 증명하지 않는다.

이 레포에서 작업하는 코딩 에이전트를 위한 핸드오프 문서다. 코드를 수정하기 전에 **3장(불변 규칙)** 과 **5장(남은 작업)** 을 반드시 읽는다.

문서와 주석은 **한국어**로 작성한다. AWS/CDK 용어와 명령어는 영문 원문을 유지한다.

---

## 0. 중앙 허브와 공통 규칙

Pulsemetry는 Claude Code·Codex 등 개발 AI 도구의 사용량과 비용을 조직 → 팀 → 구성원 축으로 모아 보여주는
사내 통합·가시화 플랫폼이다. 이 레포는 그 AWS 인프라를 담당한다.

- 제품·아키텍처·**레포 간 계약**의 단일 출처는 `soma-376/docs`다. 형제 체크아웃 `../docs`를 우선 참조한다.
- 기능 작업 전에는 `spec` 스킬, 설계 관련 작업 전에는 `adr` 스킬을 쓴다.
- git 작업은 `CONVENTION.md`를 따른다 (`conventions` 스킬).
- 스킬이 보이지 않으면 형제 `../agent-skills` 클론 여부를 확인하고, 없으면 사용자에게 클론을 안내한다.
- **사용자의 명시 요청 없이 `git push` 하지 않는다.**

**이 장은 1장 이하의 규칙을 대체하지 않는다.** 코드를 만지기 전에 3장(불변 규칙)과 5장(남은 작업)을 읽는 것은 그대로다.

**ADR 우선 원칙은 이 레포의 기존 규칙과 같다** — 1장의 "코드와 ADR이 어긋나면 ADR이 기준이다"가
전 레포 공통 규칙이며, 크로스레포 결정만 `../docs/adr/`가 소유한다. 스코프 판정은 `adr-new` 스킬이 안내한다.
단일 레포 구현 ADR은 지금처럼 `docs/adr/`에 남는다. 새 ADR은 `0028`부터이고 **`0020`은 예약**이다(5장 (F)).

**ADR 본문에서 타 레포 소스를 인용할 때는 행 번호 대신 함수·상수 이름으로 앵커한다**
(예: `sink_clickhouse.py` 의 `execute()`). 행 번호 정합은 검증할 방법이 없어 반드시 낡는다 —
ADR-0018·0019가 같은 이유로 두 번 낡았다. 기존 문서의 일괄 치환은 하지 않고, 손대는 문서부터 적용한다.

**이 레포가 소유한 계약 지점**: `config/otel-collector.yaml`은 **prod** ECS가 기동하는 collector 설정이다.
dev는 OTel Collector를 배포하지 않고 `pulsemetry-backend/apps/telemetry-ingest`가 수집부터 적재까지 맡는다.

---

## 1. 이 레포는 무엇인가

AWS CDK v2 (TypeScript) 로 작성된 **단일 인프라 레포**다. MVP 관측성(observability) 플랫폼의 AWS 리소스를 정의한다.

```
dev:  AI Tool → ALB → telemetry-ingest → S3 / ClickHouse
      사용자  → ALB → enrollment-api  → RDS PostgreSQL
prod: AI Tool → ALB → OTel Collector + post-processor → ClickHouse
      브라우저 → ALB → api-server + batch-processor → Aurora PostgreSQL
```

- ADR-0009에 따라 **인프라는 이 레포에서만 관리한다.** 앱 레포 CI는 이미지 빌드 → ECR push →
  `ecs update-service --force-new-deployment`까지만 수행하고 `cdk deploy`를 유발하지 않는다.
  `lib/cicd/`의 배포 역할은 4개를 유지하지만 cleanup 뒤 `ai-telemetry-pipeline` dev 역할은 trust와 ARN
  output만 남고 permission은 0개다(ADR-0024·0026).
- 태스크 정의를 바꾸려면 **반드시 이 레포를 경유**해야 한다.
- 대상 region은 **`ap-northeast-2`**다. account는 `CDK_DEFAULT_ACCOUNT`에서만 주입하며 코드와 문서에 기록하지 않는다.
- **환경은 셋이다** — 운영(`lib/prod/`)과 개발(`lib/dev/`)이 **같은 계정·같은 리전**에 공존하고, 여기에 배포 역할만 담는 `lib/cicd/`가 더해진다. 진입점 `bin/infra.ts`는 `-c env=dev|prod|cicd` 컨텍스트 하나만 읽고 `synthProd()` / `synthDev()` / `synthCicd()`로 조립을 위임한다. **기본값은 `prod`**이므로 무인자 `cdk deploy`는 여전히 운영을 대상으로 한다. (ADR-0021, ADR-0022, ADR-0024)
- 설계 근거는 전부 `docs/adr/`에 있다. 코드와 ADR이 어긋나면 ADR이 기준이다.

---

## 2. 스택 구조와 의존 방향

앱 환경(prod/dev)마다 스택이 4개고, `cicd`는 1개다. 코드의 props 전달은
`lib/prod/app.ts`의 `synthProd()`, `lib/dev/app.ts`의 `synthDev()`, `lib/cicd/app.ts`의
`synthCicd()`에서 construct 참조를 넘기는 방식으로만 표현한다. 수동 `Fn::ImportValue`나 SSM 우회
참조를 새로 도입하지 않는다. **construct 생성·props 전달 순서와 합성 manifest의 실제 배포 의존은
같은 개념이 아니다.**

```
lib/
├── common/   환경 무관 계약 상수 + 순수 헬퍼 (config.ts, clickhouse-user-data.ts, deploy-targets.ts)
├── prod/     운영 4스택 + app.ts(synthProd) + config.ts
├── dev/      dev 4스택 + app.ts(synthDev) + config.ts
└── cicd/     DeployStack 1개 + app.ts(synthCicd) + config.ts
test/
├── prod/     운영 스위트 6개
├── dev/      dev 스위트 6개
├── cicd/     cicd 스위트 2개
└── helpers.ts   buildApp() / buildDevApp() / buildCicdApp() / MODE_A_EDGE / TEST_ENV
```

폴더 간 의존 방향은 **`prod → common`, `dev → common`, `cicd → common` 단방향**이다 (ADR-0021 2번,
ADR-0024 1번). `cicd`도 `prod`·`dev` 어느 쪽도 import 하지 않는다.

prod의 일반 props 흐름은 아래와 같다.

```
NetworkStack ──> DataStack ──┐
     │                       ├──> ApplicationStack ──> EdgeStack
     └───────────────────────┘
```

dev는 enrollment-api의 `PULSEMETRY_PUBLIC_BASE_URL`을 실제 ALB DNS로 late binding하는 예외가 있다.
코드 조립은 Network/Data로 Application을 만들고, Application service와 Network/Data로 Edge를 만든 뒤,
`Edge.publicBaseUrl`을 Application container definition에 되돌려 연결한다. weak reference를 반영한 실제
합성 manifest에서는 **DevApplicationStack이 DevNetworkStack·DevDataStack·DevEdgeStack에 의존하고,
DevEdgeStack은 DevNetworkStack·DevDataStack에 의존한다.** 그러므로 전체 dev 배포는
Network/Data/Edge 뒤 Application 순서가 될 수 있다. PROJ-144 delete에서 Application만
`--exclusively`로 먼저 배포하는 이유가 이 실제 의존 순서를 의도적으로 우회해 구 task·ENI를 먼저
없애기 위해서다.

### 운영 스택 (prod)

| 스택 | 파일 | 주요 리소스 |
|---|---|---|
| `NetworkStack` | `lib/prod/network-stack.ts` | VPC (2 AZ × 3 티어 = 6 서브넷, NAT 1개), S3 Gateway Endpoint, **SG 5개 전부 + 모든 cross-SG 룰** |
| `DataStack` | `lib/prod/data-stack.ts` | Aurora Serverless v2 PostgreSQL 16.13 (`controlplane` DB, 0.5~2 ACU), Raw Signal S3 버킷 (30일 만료) |
| `ApplicationStack` | `lib/prod/application-stack.ts` | ECS 클러스터, Cloud Map `obs.local`, Fargate 서비스 2개, ClickHouse EC2 (t4g.small + ASG 캐패시티 프로바이더) |
| `EdgeStack` | `lib/prod/edge-stack.ts` | ALB (모드 A/B 분기), Cognito User Pool, CloudFront + 프론트엔드 S3 |

**서비스 구성** (ADR-0004: 태스크 단위 co-location)

| 태스크 | 컨테이너 | 비고 |
|---|---|---|
| `CollectorTask` (Fargate **ARM64**, 512/1024) | `otel-collector` (public image, :4318), `post-processor` (ECR) | |
| `DashboardTask` (Fargate **ARM64**, 512/2048) | `api-server` (ECR, :8080), `batch-processor` (ECR) | Spring Boot 고려. Fargate는 CPU/메모리 조합이 고정이라 512 CPU에는 1024/2048/3072/4096만 쓸 수 있다 (1536은 생성 실패) |
| `ClickhouseTask` (EC2, awsvpc) | `clickhouse` (public image **`:24.8-alpine` 고정**, :8123/:9000) | 호스트 볼륨 `/data/clickhouse` |

### dev 스택

스택 ID는 `Dev` 접두사를 쓴다. 같은 계정·같은 리전에서 CloudFormation 스택 이름이 유일하므로 이
접두사가 두 환경의 스택 충돌을 막는다 (ADR-0021 3번).

| 스택 | 파일 | 주요 리소스 |
|---|---|---|
| `DevNetworkStack` | `lib/dev/network-stack.ts` | 전용 VPC (`10.1.0.0/16`, 2 AZ × public 1 티어, NAT 0개), S3 Gateway Endpoint, **ALB/AppHost/ClickHouse/RDS SG 4개 + 모든 cross-SG 룰** |
| `DevDataStack` | `lib/dev/data-stack.ts` | RDS PostgreSQL 16.13 `db.t4g.micro` (`controlplane`, gp3 20GB, `publiclyAccessible`), 실제 Secret 3개(마스터, 공유 token hash, 관리자 토큰), Raw Signal S3(7일 만료) |
| `DevApplicationStack` | `lib/dev/application-stack.ts` | ECS 클러스터, Cloud Map `obs.local`, 앱/ClickHouse ASG와 capacity provider, `Ec2Service` 3개 |
| `DevEdgeStack` | `lib/dev/edge-stack.ts` | internet-facing ALB (`:80`, `:8123`), 신규 앱 target group 2개, dev REGIONAL WAF와 탐지 로그, `AlbDnsName`·`OtlpEndpoint`·`ClickhouseDebugUrl`·`RdsEndpoint`·`RdsSecretArn`·`TokenHashSecretArn`·`AdminApiTokenSecretArn` output 7개. Cognito·CloudFront·프론트엔드 S3 없음 |

| ECS 서비스 | 컨테이너 포트 | 네트워크 모드 | 호스트/예약 |
|---|---:|---|---|
| `telemetry-ingest` | 4316, 동적 host port | **bridge** | 앱 ASG, 1024 MiB |
| `enrollment-api` | 8080, 동적 host port | **bridge** | 앱 ASG, 1024 MiB |
| `clickhouse` | 8123/9000 | **awsvpc** | ClickHouse ASG, 1024 MiB |

세 서비스 모두 `desiredCount: 1`, `minHealthyPercent: 0`, `maxHealthyPercent: 100` 교체 배포다. 두 Spring
서비스는 태스크 내 localhost 의존과 Cloud Map A 레코드 요구가 없어 bridge/instance target을 쓴다.
ClickHouse만 `clickhouse.obs.local` A 레코드를 위해 awsvpc/ip target을 유지한다. 최종 앱 ASG는
`maxCapacity: 1`이고 두 Spring 컨테이너의 소프트 예약 합계는 2048 MiB다. 이 값은 배치 계산이며
실제 메모리 안정성은 배포 관측으로 확인한다.

`telemetry-ingest`는 Spring Security에서 인증하고 `SecurityContextHolder`의 principal을
`SecurityContextIdentitySource`가 읽어 `IdentityStamper`로 전달한다. 두 앱은 같은 token hash Secret을
사용한다. `enrollment-api`의 public base URL은 실제 ALB DNS에서 late binding하고 binaries directory는
`/app/binaries`다. 이 레포는 URL과 라우팅만 제공하며 실제 바이너리 공급은 별도 작업이다.

dev `:80` 리스너의 default는 404다. priority 1의 정확한 `/v1/traces`, `/v1/metrics`, `/v1/logs`만
telemetry-ingest로 보내고, priority 3의 `/api/v1/enroll`, `/api/v1/installations/*`, `/api/v1/invitations*`, `/api/v1/auth/*`, `/api/v1/manifest`와
priority 4의 `/windows`, `/unix`, `/bin/*`, priority 5의 조직 관리·문의·업데이트 확인 경로를 같은 enrollment target group으로 보낸다. `/api/v1/healthz`는
두 새 target group의 200 health check 전용이며 public rule이 아니다. 두 새 target group은 60초 deregistration delay를,
ClickHouse는 300초를 쓴다. ingest 서비스만 240초 health check grace를 사용하며 정상 healthy 판정은
즉시 반영된다. `:4318`, 무제한 `/api/*` 규칙, 구 target group과 서비스는 최종 상태에 없다.

현재 ALB는 HTTP만 제공한다. `PULSEMETRY_PUBLIC_BASE_URL=http://<ALB DNS>`는 bootstrap 주소이고,
manifest의 OTLP endpoint와 같은 계약이 아니다. backend·telemetryctl·JSON Schema는 원격 endpoint에
HTTPS를 요구하므로 HTTP curl 경계 검증은 가능하지만 CLI enrollment → manifest → OTLP forward E2E는
별도 HTTPS 선행 과제가 완료되기 전에는 불가능하다. 계약을 HTTP 허용으로 완화하거나 이 작업에 TLS
listener·certificate를 추가하지 않는다. prod의 기존 Fargate 서비스와 Collector 구성은 그대로다.

dev WAF는 ALB 전체의 REGIONAL Web ACL이며 기본 Allow다(ADR-0027). 국가 CN·RU·KP·IR, 악성 IP,
URI·헤더 공격은 OTLP에도 Block한다. 정확한 OTLP 세 경로의 본문·rate는 Count, query는 Block이고,
앱 경로 밖의 SQL 본문·query는 Count다. WAF는 실제 listener port를 직접 구분하지 않으므로 `:8123`에
앱 URI를 쓰면 같은 앱 정책이 적용된다. Host 기반 전면 Allow를 만들지 않는다. 탐지 로그는
`aws-waf-logs-soma-376-dev`에 14일 보존하며, 지정 인증 헤더·query 마스킹과 샘플링 비활성화를 적용한다.

### CI/CD 스택 (cicd)

| 스택 | 파일 | 주요 리소스 |
|---|---|---|
| `DeployStack` | `lib/cicd/deploy-stack.ts` | GitHub OIDC 공급자 1개(**RETAIN**), 배포 역할 4개(레포 × 환경), 역할 ARN `CfnOutput` 4개 |

앱 인프라를 전혀 참조하지 않으므로 **언제든 따로 배포할 수 있다.** `cdk deploy --all`(무인자 = prod)은 이 스택을 앱 트리에 담지 않으므로 건드리지 않고, `-c env=cicd`로 `--all`을 돌려도 운영 4스택은 조립되지 않는다. IAM 변경과 앱 인프라 변경이 서로 다른 배포에 속하는 것이 이 분리의 목적이다 (ADR-0024 1번).

**ECS 클러스터/서비스의 물리 이름이 이 스택의 전제다.** 자동 생성 이름으로는 IAM 리소스 ARN을 좁힐 수도, 워크플로우가 `--cluster`/`--service`에 넣을 값을 알 수도 없다. 이름의 단일 출처는 `lib/common/deploy-targets.ts`다.

---

## 3. 반드시 지켜야 할 불변 규칙

아래는 "개선"처럼 보여서 되돌리기 쉽지만, 되돌리면 실제로 깨지는 것들이다. 바꾸려면 먼저 ADR을 쓴다.

| 규칙 | 왜 |
|---|---|
| **prod SG 5개와 dev SG 4개 및 모든 cross-SG 룰은 각 `NetworkStack`에만 정의한다** | SG 참조가 스택 내부 참조가 되어 스택 간 순환 의존을 원천 차단한다. 하류 스택은 props로 주입만 받는다. (`lib/prod/network-stack.ts`의 클래스 헤더 주석. `DevNetworkStack`이 같은 규칙을 그대로 계승한다 - ADR-0022 2번) |
| **ECR 레포를 CDK로 만들지 않는다** | `Repository.fromRepositoryName`으로 참조만 한다. CDK가 만들면 첫 배포에서 "이미지 없는 레포" → 태스크 기동 실패 → 롤백으로 레포까지 삭제되는 순환이 생긴다. (ADR-0007) |
| **ECR 레포 이름은 `soma-376/` 네임스페이스 아래에 둔다** | 네임스페이스는 `COMMON_TAGS.Org`와 같은 값이다. 비용 배분 태그 축과 레지스트리 경로를 같은 식별자로 정렬한다. ECR은 레포 이름 변경이 불가능해 사후 교정에 재생성 + 이미지 재push가 든다. (`lib/common/config.ts`의 `ECR_NAMESPACE`, ADR-0007) |
| **prod `batch-processor`는 `essential: false`** | 배치 실패가 같은 태스크의 api-server를 함께 내리면 안 된다. dev 최종 구성에는 두 컨테이너가 없다. (`lib/prod/application-stack.ts`, ADR-0004, ADR-0026) |
| **ClickHouse `Ec2Service`는 `minHealthyPercent: 0` / `maxHealthyPercent: 100`** | 인스턴스 1대 + awsvpc ENI 한도상 롤링 배포가 불가능하다. 강제 교체 배포만 가능하다. (`lib/prod/application-stack.ts:397-398`. dev는 최종 세 서비스 모두 같은 값이며 `lib/dev/application-stack.ts`의 배포 설정이 이를 강제한다 - ADR-0022 Constraints) |
| **`AsgCapacityProvider`의 `enableManagedTerminationProtection: false`** | 단일 인스턴스 교체 배포를 관리형 종료 보호가 막는다. (`lib/prod/application-stack.ts:346`, dev는 `lib/dev/application-stack.ts`의 `addCapacityProvider`) |
| **DB 시크릿은 참조만 노출한다** | `data.dbSecret`(`ISecret`)을 넘길 뿐, **합성 시점에 값을 평문으로 읽는 코드**는 절대 넣지 않는다. 컨테이너에는 `Secret.fromSecretsManager`로 주입한다. **prod의 예외는 `DataStack`의 `PostProcessorPgDsn` 파생 시크릿 하나뿐이며**, 거기서도 `unsafeUnwrap()`이 돌려주는 건 평문이 아니라 `{{resolve:secretsmanager:...}}` 동적 참조 토큰이다(합성 산출물은 `Fn::Join` + `Ref`뿐). 새 예외를 만들려면 ADR-0018을 먼저 갱신한다. dev는 파생 Secret 없이 마스터 Secret의 필드를 ECS secret으로 직접 주입한다. (`lib/prod/data-stack.ts`, ADR-0018, ADR-0026) |
| **`post-processor`의 환경변수 이름은 앱 소스가 권위다** | 앱은 `ENRICHMENT_CH_URL` / `ENRICHMENT_CH_DB` / `ENRICHMENT_PG_DSN` **세 개만** 읽는다 (`ai-telemetry-pipeline`의 `apps/telemetry-processor/enrichment/sink_clickhouse.py`, `apps/telemetry-processor/enrichment/providers/org.py`의 `OrgProvider`). 이름이 틀리면 CH 두 개는 예외 없이 compose 전용 기본값으로 **조용히 폴백**하고(ECS에서는 DNS가 안 풀려 모든 insert가 `BackendUnavailable` → HTTP 503), `ENRICHMENT_PG_DSN`은 기본값이 빈 문자열이라 **조회 시점의 즉시 연결 실패**다(장애 증상이 다르다 — ADR-0018). **synth도 테스트도 배포도 전부 통과한다** — 인프라 테스트는 "앱이 그 이름을 읽는가"를 원리적으로 검증할 수 없다. 죽은 계약(`CLICKHOUSE_HOST`·`DB_CREDS`·`DB_NAME`)을 다시 넣지 않는다. **이 계약은 prod에만 남는다.** dev는 telemetry-ingest의 `PULSEMETRY_*` 계약을 쓴다. (`lib/common/config.ts`의 `ENRICHMENT_ENV`, ADR-0018, ADR-0026) |
| **dev `enrollment-api`와 `telemetry-ingest`는 각 앱의 `PULSEMETRY_*` 계약을 따른다** | RDS 마스터 Secret의 `username`/`password`와 공유 token hash는 두 앱에 각각 `PULSEMETRY_DB_USERNAME` / `PULSEMETRY_DB_PASSWORD` / `PULSEMETRY_TOKEN_HASH_SECRET`으로 넣는다. 관리자 Secret의 JSON `token`은 enrollment-api에만 `PULSEMETRY_ADMIN_API_TOKEN`으로 넣고 telemetry-ingest에는 주입하지 않는다. 모두 ECS `secrets`를 사용하며 `DB_CREDS`/`DB_NAME`을 되살리거나 토큰 값을 `environment`/`CfnOutput`에 넣지 않는다. (backend `application.yaml`, ADR-0026) |
| **ClickHouse 컨테이너의 `CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT: '1'`과 고정 태그를 지우지 않는다** | 이미지 entrypoint는 `CLICKHOUSE_USER`/`CLICKHOUSE_PASSWORD`/`CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT`가 전부 비면 `default` 유저를 루프백 전용으로 잠근다. 그러면 prod `post-processor`와 dev `telemetry-ingest`의 적재가 인증 실패한다. 비밀번호 없는 default user의 접근 통제는 `clickhouseSecurityGroup`이 담당하며 이미지 태그 `:24.8-alpine`을 고정한다. (`lib/common/config.ts`, ADR-0019) |
| **Aurora 자동 생성 비밀번호의 `ExcludeCharacters`와 따옴표 없는 libpq DSN은 한 몸이다** | `buildLibpqDsn()`은 값을 따옴표로 감싸지 않는다 — 합성 시점에 user/password는 토큰이라 감쌀 방법이 없다. aws-rds의 `DEFAULT_PASSWORD_EXCLUDE_CHARS`가 공백·`'`·`"`·`\` 넷을 전부 빼주기 때문에만 성립하는 **우연한 커플링**이다. 깨지면 배포는 성공하고 `post-processor`만 런타임에 죽는다. 그 상수는 공개 export가 아니므로 `test/prod/data-stack.test.ts`가 **합성 템플릿의 `ExcludeCharacters`** 로 고정한다. dev 앱은 파생 libpq DSN을 만들지 않지만 DatabaseInstance의 생성 비밀번호 제한은 합성 테스트로 별도 고정한다. (ADR-0018, ADR-0022 7번) |
| **prod `batch-processor` 계약과 `post-processor`의 `RAW_BUCKET`은 건드리지 않는다** | 두 컨테이너는 prod에 남는다. `batch-processor` 대응 모듈은 없어 계약을 추정하지 않고, `RAW_BUCKET`은 ADR-0017의 `awss3` exporter 전환용 권한과 함께 유지한다. dev cleanup을 이유로 prod 상수나 권한을 삭제하지 않는다. (ADR-0018, ADR-0026) |
| **prod Fargate 태스크와 dev 앱 이미지는 ARM64로 고정한다** | `runtimePlatform`을 빼면 CDK 기본값(미지정)으로 돌아가 x86_64가 된다. 앱 레포도 반드시 `linux/arm64` 이미지를 push해야 하며, amd64를 올리면 synth와 테스트는 통과하지만 런타임에 이미지 pull이 실패한다. ClickHouse EC2(t4g)와 아키텍처를 맞추고 x86 대비 약 20% 저렴하다. dev Spring 이미지도 호스트 ASG가 `EcsOptimizedImage.amazonLinux2023(AmiHardwareType.ARM)`이므로 `linux/arm64` 요구가 그대로 따라온다. (`lib/prod/application-stack.ts`의 `FARGATE_RUNTIME_PLATFORM`, ADR-0015) |
| **prod Collector 설정은 `config/otel-collector.yaml`에만 둔다** | synth 시점에 파일을 읽어 `OTEL_CONFIG` 환경변수로 주입하고 `--config=env:OTEL_CONFIG`로 기동한다. 파일 경로·환경변수 이름·`command` 세 가지는 한 몸이라 함께 바꿔야 한다. **이 값은 CFN 템플릿과 ECS 콘솔에 평문으로 남으므로 시크릿을 넣으면 안 된다.** dev 최종 구성은 Collector를 실행하지 않지만 prod 파일은 삭제하지 않는다. (`lib/prod/application-stack.ts`의 `COLLECTOR_CONFIG_PATH`, ADR-0017, ADR-0026) |
| **prod `otel-collector` 컨테이너는 root(`user: '0'`)로 돈다** | 이미지가 `User=10001:10001`인데 UID 10001이 쓸 수 있는 디렉터리가 하나도 없다(scratch 기반이라 `/tmp`도 없다). `file/*` exporter가 `/data`를 만들려면 root가 필요하다. 빼면 `mkdir /data: permission denied`로 기동 직후 exit 1이다. **file exporter와 `user: '0'`은 한 몸이라 함께 없애야 한다** — 이 커플링은 `test/prod/application-stack.test.ts`가 고정한다. `awss3` exporter로 옮기면 root가 필요 없어진다. (ADR-0017) |
| **prod Collector config는 배포 전 실제로 기동해 봐야 한다** | `cdk synth`·`npm test`는 config를 문자열로만 다루고, `otelcol-contrib validate`조차 컴포넌트를 **해석만** 하고 start하지 않아 파일시스템·권한 실패를 못 잡는다. 최초 배포가 정확히 이 틈으로 빠져나가 죽었다. 관문은 `docker run -d --user 0:0 -e OTEL_CONFIG="$(cat config/otel-collector.yaml)" ... --config=env:OTEL_CONFIG` 후 로그에 `Everything is ready`가 뜨는지 확인하는 것이다. **정리는 컨테이너 ID를 지목한다. `--filter ancestor=...`를 쓰면 같은 이미지를 쓰는 로컬 개발 컨테이너까지 지운다.** (ADR-0017) |
| **DB 이름은 PostgreSQL 키워드 표에 없는 단어여야 한다** | RDS는 `DatabaseName`에 엔진 예약어 검사를 걸고, 그 목록이 PostgreSQL의 reserved 키워드보다 넓다. 실제로 `control`은 non-reserved인데도 400으로 거부됐다. 되돌리면 배포가 통째로 실패한다. (`lib/common/config.ts`의 `CONTROL_DB_NAME` - dev RDS도 같은 상수를 쓴다, ADR-0012) |
| **`maxAzs: 2`는 이중화가 아니라 의도된 하한이다** | 진짜 단일 AZ는 Aurora `DatabaseCluster`(서브넷 ≥2 요구)와 internet-facing ALB(퍼블릭 서브넷 2개 요구)가 막는다. 컴퓨트/데이터는 여전히 사실상 단일 AZ다. (`lib/prod/network-stack.ts:35-36`. dev도 같은 이유로 `maxAzs: 2`다 - internet-facing ALB와 RDS DB subnet group이 각각 2 AZ를 요구한다) |
| **`RemovalPolicy.DESTROY` / `autoDeleteObjects`는 MVP 한정 의도다** | 실수가 아니다. 프로덕션 전환 시 일괄 재검토 대상이므로, 개별적으로 `RETAIN`으로 바꾸지 말고 ADR로 묶어서 처리한다. |
| **ECS 클러스터/서비스 이름의 단일 출처는 `lib/common/deploy-targets.ts`다** | 이 값은 앱 레포 워크플로와의 계약이자 `DeployStack`이 IAM 서비스 ARN을 조립하는 조각이다. **CloudFormation은 IAM 정책에 적힌 리소스 ARN의 실존을 검증하지 않으므로**, 한쪽만 고치면 네 스택이 전부 배포에 성공하고 GitHub Actions만 `AccessDenied`로 죽는다. `test/cicd/deploy-stack.test.ts`의 크로스 스택 어서션이 유일한 방어선이다. 이름 변경은 클러스터·서비스 **교체**를 유발하므로 6장 런북을 따른다. (ADR-0024 6번) |
| **신뢰 정책의 `sub`는 immutable ID와 브랜치까지 완전 일치시킨다** | 2026-07-15 이후 생성된 GitHub 저장소는 `repo:org@org-id/repo@repo-id:...` 형식을 쓴다. name-only 형식은 synth·test·배포가 통과한 뒤 Actions만 `AssumeRoleWithWebIdentity`에서 죽는다. 반대로 `StringLike` + `*`는 PR 헤드와 태그를 포함한 모든 ref에 역할을 열어 develop→dev / main→prod 분리를 없앤다. `GITHUB_ORG`/`GITHUB_REPOS`의 ID와 `StringEquals` 완전 일치를 유지한다. (`lib/cicd/config.ts`, `lib/cicd/deploy-stack.ts`, ADR-0024 2번) |
| **배포 역할에 `iam:PassRole` / `ecs:RegisterTaskDefinition`을 주지 않는다** | `--force-new-deployment`는 기존 태스크 정의 리비전을 그대로 재사용하므로 둘 다 필요 없다. 주는 순간 CI가 태스크 정의를 갈아끼우고 임의 역할을 붙일 수 있어 계정 안에서 사실상 권한 상승 경로가 되고, ADR-0009(태스크 정의는 이 레포 경유)도 무너진다. (ADR-0024 5번) |
| **prod 파이프라인 역할에 dev 전용 또는 제거된 서비스를 넣지 않는다** | prod 역할은 현재 prod `collector`만 대상으로 한다. dev에서 제거된 auth-proxy 이름을 prod 계약에 추가하지 않는다. |
| **GitHub OIDC 공급자는 계정당 1개이고 `RETAIN`이다** | URL당 하나만 존재할 수 있어 이미 있는 계정에서 새로 만들면 `EntityAlreadyExists`로 스택이 통째로 롤백된다. 배포 전에 `aws iam list-open-id-connect-providers`로 확인하고, 있으면 `-c githubOidcProviderArn=<arn>`으로 참조 모드를 쓴다. `RETAIN`이므로 `DeployStack`을 destroy한 뒤 재배포할 때도 이 키가 필요하다. **`thumbprints`는 주지 않는다** — 지문을 박아 두면 GitHub 인증서 회전 시 인프라는 멀쩡한 채 Actions만 죽는다. (ADR-0024 3번) |
| **IAM `Description`은 영문으로 쓴다** | 이 레포는 주석과 문서를 한국어로 쓰지만 IAM의 `Description`은 Latin-1 밖의 문자를 거부한다. 한국어를 넣으면 `cdk synth`는 경고만 내고 통과한 뒤 `cdk deploy`가 실패한다. (`lib/cicd/deploy-stack.ts`) |

### dev 환경 전용 규칙

| 규칙 | 왜 |
|---|---|
| **`lib/prod/`와 `lib/dev/`는 서로 import 하지 않는다** | 의존은 `prod → common`, `dev → common` 단방향뿐이다. dev에 필요한 값이 prod에 있으면 common으로 올리거나 dev에 둔다. (ADR-0021) |
| **dev 네트워크 모드는 bridge / bridge / awsvpc다** | telemetry-ingest와 enrollment-api는 dynamic host port를 쓰는 instance target이다. ClickHouse만 A 레코드 등록을 위해 awsvpc/ip target을 쓴다. |
| **두 Spring 이미지는 `linux/arm64`다** | 앱 호스트가 `AmiHardwareType.ARM`인 t4g라 amd64 이미지는 pull 뒤 실행되지 않는다. synth와 template assertion만으로 이미지 manifest architecture를 증명할 수 없다. |
| **dev에는 실제 Secret 3개만 둔다** | RDS master, 관리자 API token, 공유 token hash다. 파생 libpq DSN·Postgres URI Secret은 없다. username/password와 token은 ECS `secrets`로 주입하고 합성 산출물이나 output에 값을 노출하지 않는다. 공유 hash Secret의 construct ID `DevAuthProxyTokenHashSecret`은 기존 물리 Secret 연속성을 위해 유지한 이름일 뿐이며, 최종 런타임 소비자는 telemetry-ingest와 enrollment-api다. |
| **두 앱은 기존 token hash Secret 하나를 공유한다** | telemetry-ingest의 인증과 enrollment-api의 token 발급/검증이 같은 HMAC key를 써야 한다. 새 Secret을 만들거나 header로 legacy identity를 전파하지 않는다. |
| **public base URL은 ALB DNS에서 late binding한다** | `PULSEMETRY_PUBLIC_BASE_URL=http://<ALB DNS>`를 수동 context나 고정값으로 복제하지 않는다. weak reference는 export 잠금만 완화하므로 배포 순서는 별도 런북을 따른다. |
| **`PULSEMETRY_BINARIES_DIR=/app/binaries`를 유지한다** | `/windows`, `/unix`, `/bin/*`는 enrollment-api로 라우팅한다. 이 레포는 URL/라우팅만 제공하며 이미지 안 실제 바이너리 공급은 별도 책임이다. |
| **dev 로그 그룹은 `/ecs/dev/` 접두를 쓴다** | prod 물리 이름과 충돌하지 않으며 최종 앱 로그는 `/ecs/dev/telemetry-ingest`, `/ecs/dev/enrollment-api`, `/ecs/dev/clickhouse`다. |
| **dev ALB listener는 모두 `open: false`다** | CDK 기본 `open: true`가 `0.0.0.0/0` ingress를 자동 추가해 `devAllowedCidr` 제한을 무력화하는 것을 막는다. |
| **`:80`은 명시한 경로만 전달한다** | OTLP 정확한 세 경로는 ingest, `/api/v1`의 enrollment·인증·조직 관리·문의·업데이트 경로와 bootstrap 경로는 enrollment-api로 보낸다. default는 404이고 `/api/v1/healthz` public rule, 무제한 `/api/*`, `:4318`은 없다. |
| **dev WAF의 개별 Count 예외와 경로별 exact-label Block을 함께 유지한다** | OTLP 본문·앱 경로 밖 SQL 본문/query는 Count지만 국가·악성 IP·URI·헤더 Block은 ingest에도 남는다. `/bin/` 확장자 예외는 `RestrictedExtensions_URIPATH` 한 규칙뿐이다. 앱 경로는 ALB와 공유하며 Host 기반 전면 Allow로 바꾸지 않는다. 앱의 인증·압축 전후 크기·압축 해제·JSON/protobuf·OTLP 구조 검증을 WAF가 대신하지 않는다. (ADR-0027) |
| **WAF 앱 내용 검사와 등록 rate 범위는 구별한다** | PROJ-200의 `/api/v1` 인증·manifest·조직 관리·문의·업데이트 경로도 본문/query Block에 포함한다. 300건/300초는 `/api/v1/enroll`·`/api/v1/installations/*`·`/api/v1/invitations*` 세 조건만 합산하고, 추가된 앱 경로는 나머지 1,000건/300초에 포함한다. `/api/v1/*` 전체를 앱 경로나 등록 rate로 넓히지 않는다. (ADR-0027) |
| **WAF 관리형 버전·override 이름·label을 함께 갱신한다** | Common `Version_1.23`, KnownBadInputs `Version_1.26`, SQLi `Version_2.4`를 고정한다. WAF 요청 로그에는 관리형 룰셋 버전이 직접 기록되지 않고 `formatVersion`은 로그 형식 버전이다. 과거 요청 분석은 당시 CDK·commit·배포 기록과 대조하며 갱신·만료 전 룰/label을 재검증한다. IP 목록은 비버전 그룹이다. (ADR-0027) |
| **WAF 로그 redaction·data protection·sampling을 별도 계약으로 고정한다** | 기본 DROP에서 `BLOCK`·`COUNT`·`EXCLUDED_AS_COUNT`만 KEEP한다. Authorization·Cookie·X-Admin-Token과 전체 query를 `RedactedFields` 및 `DataProtectionConfig`의 SUBSTITUTION으로 보호하고 match/rate 상세도 포함한다. 요청 sampling은 전부 끄며, redaction만으로 sample 보호를 가정하지 않는다. (ADR-0027) |
| **새 앱 target group만 60초 deregistration delay를 쓴다** | telemetry-ingest와 enrollment-api는 교체 배포 시간을 줄이기 위한 dev 초기값 60초다. ClickHouse와 prod는 300초를 유지한다. (ADR-0025, ADR-0026) |
| **telemetry-ingest만 240초 health grace를 쓴다** | ClickHouse schema startup 5회와 30초 응답 헤더 timeout, 2초 backoff를 합친 약 160초에 Spring/RDS/host 여유를 둔 초기값이다. 정상 healthy 판정은 지연하지 않으며 본문 무기한 대기는 막지 못한다. enrollment-api는 CDK 기본 60초다. |
| **`applyCommonTags`는 태그 맵을 인자로 받는다** | prod는 `Env=mvp`, dev는 `Env=dev`, cicd는 `Env=cicd`다. prod의 값을 임의로 바꾸면 전 리소스 diff가 생긴다. |
| **`bin/infra.ts`와 `test/helpers.ts`는 직접 스택을 조립하지 않는다** | 둘 다 `synthProd`/`synthDev`/`synthCicd`를 거쳐 실제 배포와 테스트 조립이 갈라지지 않게 한다. |

## 4. 설정과 환경 분기

- 계정/리전은 `CDK_DEFAULT_ACCOUNT` / `CDK_DEFAULT_REGION`에서만 온다. 코드에 하드코딩된 계정은 없다.
- `cdk.context.json`은 계정별 조회 결과가 기록되는 로컬 캐시이므로 commit하지 않는다.
- 공통 태그는 App 스코프에 `applyCommonTags(app, <태그 맵>)`로 한 번만 적용한다. 스택별로 중복 호출하지 않는다. prod는 `{ Org: 'soma-376', Env: 'mvp', ManagedBy: 'cdk' }`, dev는 `Env: 'dev'`만 다르다.

### 환경 분리 메커니즘 (ADR-0021, ADR-0022)

이전 판의 "dev/stg/prod 환경 분리 메커니즘은 없다"는 문장은 **ADR-0021/0022로 해결되었다.** 두 환경은 같은 계정·같은 리전에 공존하며, 가르는 일은 전부 CDK 코드 안에서 일어난다.

| 축 | 메커니즘 |
|---|---|
| 진입점 | `bin/infra.ts`가 `-c env=dev\|prod\|cicd` 하나만 읽고 `synthDev()` / `synthProd()` / `synthCicd()`로 위임한다. 기본값 `prod` |
| 코드 경계 | `lib/{common,prod,dev,cicd}` 폴더 + `prod ↔ dev` import 금지, `cicd`도 양쪽 모두 import 금지 |
| 리소스 이름 충돌 | 스택 ID의 `Dev` 접두사(스택 이름은 계정 + 리전 유일), 로그 그룹의 `/ecs/dev/` 접두, **ECS 클러스터 이름 `soma-376-dev` / `soma-376-prod`**. S3 버킷은 스택명 유도라 자동 분리, Cognito는 dev가 만들지 않아 해당 없음. **ECS 서비스 이름은 유일성 스코프가 클러스터 안이라 두 환경이 같은 이름을 쓴다** |
| 비용 축 | `Env` 태그 — **prod는 `mvp`, dev는 `dev`, cicd는 `cicd`.** 이 불일치는 의도된 것이다(위 3장). Cost Explorer에서 `Env=mvp` = 운영으로 읽는다 |
| 이미지 태그 | **dev는 `dev`, prod는 `prod`** (ADR-0024 7번). 같은 ECR 레포를 공유하므로 태그가 두 환경을 가르는 유일한 축이다 |
| 공유하는 것 | ECR 레포(태그로만 분리), Cloud Map 네임스페이스 `obs.local`(VPC 스코프라 충돌 없음), GitHub OIDC 공급자(계정 전역, `DeployStack` 소유) |

### 상수는 어디에 두는가

새 상수는 dev에서 달라야 할 이유가 없으면 `common/`, 있으면 환경 폴더에 둔다. `prod → common`,
`dev → common`, `cicd → common`만 허용한다. `lib/common/config.ts`의 `ENROLLMENT_ENV`·`INGEST_ENV`와
`ECR_REPOS`, `lib/common/deploy-targets.ts`의 `ECS_CLUSTER_NAMES`·`ECS_SERVICE_NAMES`는 앱 스택,
DeployStack, 앱 workflow가 공유한다. prod의 `ENRICHMENT_ENV`와 Collector·legacy ECR 상수는 운영 계약으로
남긴다. dev 고유값은 `lib/dev/config.ts`의 `DEV_TELEMETRY_INGEST_HEALTH_CHECK_GRACE`,
`DEV_TELEMETRY_ARCHIVE_PREFIX`, `DEV_ENROLLMENT_BINARIES_DIR` 등에서 관리한다.

### 배포별 가변값 (CDK context 키)

| 환경 | 키 | 기본값 | 의미 |
|---|---|---|---|
| prod | `edgeMode` | `B` | `A`이면 Cognito JWT + TLS/CloudFront, `B`이면 인증 없는 HTTP MVP |
| prod | `certificateArn` | 없음 | 모드 A의 ACM 인증서 |
| prod | `customDomain` | 없음 | 모드 A의 도메인 |
| dev | `devAllowedCidr` | `0.0.0.0/0` | ALB `80/8123`과 RDS `5432` ingress source. 미지정/전면 공개면 `infra:dev-open-ingress` 경고 |
| dev | `devAppAsgMaxCapacity` | `1` | 앱 ASG 최대 호스트 수. 병행 단계에서만 명시적으로 `2`를 쓰고 cleanup 뒤 기본값 `1`로 복귀 |
| dev | `devImageTag` | `dev` | dev ECS task가 참조하는 앱 이미지 태그 |
| cicd | `githubOidcProviderArn` | 없음 | 기존 GitHub OIDC provider 참조. 없으면 새 provider를 만들고 RETAIN |

`cdk.json`의 `@aws-cdk/core:enableRefactorFeatureFlag=true`와
`@aws-cdk/core:stackRelativeExports=true`는 weak cross-stack reference 동작을 포함한 합성 계약이다.
끄거나 `cdk.json`을 읽지 않는 bare `App` 테스트를 만들지 않는다.

### 앱 레포 배포 계약

| 항목 | 계약 |
|---|---|
| 이미지 URI | `<account>.dkr.ecr.ap-northeast-2.amazonaws.com/soma-376/<app>:<tag>` |
| 이미지 태그 | dev=`dev`, prod=`prod`; workflow는 같은 immutable commit SHA tag도 함께 push |
| 역할 | backend-dev는 `telemetry-ingest`, `enrollment-api` ECR push와 두 ECS service 재배포. pipeline-dev는 trust와 ARN output만 유지하고 permission statement 0개 |
| prod 역할 | pipeline-prod는 `collector`, backend-prod는 `dashboard`; prod 대상은 이 전환에서 불변 |
| 금지 권한 | `iam:PassRole`, `ecs:RegisterTaskDefinition` |
| ECS 이름 | cluster `soma-376-dev` / `soma-376-prod`; service 이름은 `lib/common/deploy-targets.ts`가 단일 출처 |

pipeline-dev의 0개 권한에는 `ecr:GetAuthorizationToken`도 포함한다. 빈 resource policy를 만들지 않는다.
역할 자체, immutable GitHub OIDC trust, `CfnOutput`은 PROJ-106의 레포 archive 결정까지 유지한다.

### 컨테이너 런타임 계약

#### dev `telemetry-ingest`

일반 환경변수는 `PULSEMETRY_INGEST_PORT=4316`, `PULSEMETRY_DB_URL` JDBC URL,
`PULSEMETRY_CLICKHOUSE_URL=http://clickhouse.obs.local:8123`, ClickHouse database,
`PULSEMETRY_ARCHIVE_TYPE=s3`, Raw Signal bucket과 archive prefix다. prefix는 빈 문자열이어도 앱이
`<product>/<signal>/year=...` key를 만든다. RDS `username`/`password`와 공유 token hash는 각각
`PULSEMETRY_DB_USERNAME`, `PULSEMETRY_DB_PASSWORD`, `PULSEMETRY_TOKEN_HASH_SECRET` ECS secret이다.
Task role에는 Raw Signal S3 read/write가 필요하다.

인증은 Spring Security가 수행한다. `SecurityContextHolder` → `SecurityContextIdentitySource` →
`IdentityStamper` 경로로 인증된 tenant/member/installation identity를 기록한다. legacy identity header를
전파하지 않으며 같은 key가 payload에 여러 번 있어도 모두 인증된 값으로 덮어쓴다.

#### dev `enrollment-api`

일반 환경변수는 `PULSEMETRY_DB_URL`, `PULSEMETRY_PUBLIC_BASE_URL=http://<ALB DNS>`,
`PULSEMETRY_BINARIES_DIR=/app/binaries`다. RDS `username`/`password`, 관리자 token, 공유 token hash는
각각 `PULSEMETRY_DB_USERNAME`, `PULSEMETRY_DB_PASSWORD`, `PULSEMETRY_ADMIN_API_TOKEN`,
`PULSEMETRY_TOKEN_HASH_SECRET` ECS secret이다. public base URL은 EdgeStack의 실제 ALB DNS를 late
binding하며 Secret 값은 환경변수나 output에 두지 않는다.

`/windows`, `/unix`, `/bin/*` 라우팅은 설치 URL만 제공한다. `/app/binaries`에 실제 산출물을 넣는 일은
이미지 공급 작업이다. 또한 public base URL은 bootstrap 주소일 뿐 manifest OTLP endpoint가 아니다.
원격 endpoint는 backend와 telemetryctl 계약상 HTTPS여야 한다. 현재 dev에는 TLS listener/certificate가
없으므로 CLI enrollment → manifest → OTLP forward E2E는 별도 HTTPS 선행 과제가 끝날 때까지 막힌다.

#### prod legacy 앱과 공통 ClickHouse

prod `post-processor`는 `ENRICHMENT_CH_URL`, `ENRICHMENT_CH_DB`, `ENRICHMENT_PG_DSN`만 읽고
`PostProcessorPgDsn` 파생 Secret을 사용한다. prod `api-server`/`batch-processor`, Collector의
`OTEL_CONFIG`, `user: '0'`, `config/otel-collector.yaml` 계약은 그대로다. 최종 dev에는 이 컨테이너와
파생 Secret이 없다. ClickHouse는 두 환경 모두 고정 `:24.8-alpine`,
`CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1`, 비밀번호 없는 default user를 유지하고 SG로 접근을 제한한다.

### EdgeStack

prod의 모드 A/B, Cognito, CloudFront, TLS 계약은 바꾸지 않는다. dev는 HTTP `:80`의 정확한 OTLP 세
경로와 `/api/v1` enrollment·인증·조직 관리·문의·업데이트, bootstrap 경로만 두 새 instance target group으로 전달하고 default 404를 쓴다.
`:8123` ClickHouse ip target은 유지한다. `:4318`, 무제한 `/api/*`, 구 target group/output은 최종 상태에 없다.
모든 listener는 `open: false`이고 `devAllowedCidr`가 유일한 network boundary다.

## 5. 지금 남은 작업

### (A) 도메인 / ACM 인증서 확보 — 모드 A(TLS 종단) 전환 `미결`

`docs/adr/0008-dual-auth-alb-cognito-and-otlp-token.md`

- **ADR-0008 은 허브 ADR 0001 로 대체됐다(`Superseded by`, PROJ-79).** ALB 단 인증
  (`authenticate-cognito`·`jwt-validation`)은 양 경로 모두 채택하지 않는다 — ALB 는 TLS 종단만 담당하고,
  토큰 인증은 앱 계층이 한다(dev는 telemetry-ingest Spring Security, prod 전환은 별도 작업이며 Cognito와 무관).
  모드 A/모드 B 의 현행 정의는 **TLS 종단 유무**다(ADR-0008 의 "대체 후의 모드 정의" 블록).
- 남은 미결은 **도메인·ACM 인증서 확보(TLS 종단)** 하나다. 확보 시 순서:
  1. DNS를 Route 53에서 관리할지 외부 DNS 공급자를 유지할지 결정하고, ALB에 연결할 도메인을 확정한다.
  2. `ap-northeast-2`에서 ACM 인증서를 발급·검증하고, DNS에 ALB Alias/CNAME 레코드를 만든다.
  3. `certificateArn`, `domainName` context 값을 확정하고 모드 A로 배포해 HTTP→HTTPS 리다이렉트를
     확인한 뒤 배포 런북에 기록한다.
- `lib/prod/edge-stack.ts` 의 Cognito 구축 코드(User Pool·`AuthenticateCognitoAction`·`authenticateJwt`)는
  **의도적 잔존**이다 — Spring Security 이관 시 함께 걷어낸다. 결함으로 오독하지 않는다.

### (B) ADR-0009 — 스택 경계 확정 — **완료 (`Accepted`)**

`docs/adr/0009-single-infra-repo-stack-boundary.md`

- PROJ-79에서 `Accepted`로 전환했다. 단일 `ApplicationStack` 경계가 확정 결정이다.
- Revisit Trigger 둘 — "앱 팀의 인프라 레포 수정 부담이 실제 병목이 되면 스택 분리",
  그리고 "backend로 수집 파이프라인을 이관하면 ADR-0017의 Collector config 소유권 재검토"다.
  허브 ADR 0004·0005가 Accepted가 되어 dev는 ADR-0026으로 Collector를 제거했다. prod의 ADR-0017 계약은 별도 전환 결정 전까지 유지한다.

### (C) ADR-0012 — 컨트롤 플레인 DB 엔진으로 PostgreSQL 검토 `Proposed`

`docs/adr/0012-aurora-postgresql-for-control-plane.md`

- 현재 유력 후보는 PostgreSQL이다. 엔진 수준의 멀티 테넌시 격리에 RLS를 활용할 가능성과 JSONB·전문 검색 등에 GIN을 활용할 가능성이 주요 근거다.
- 둘 다 실제 컨트롤 플레인 스키마와 쿼리로 검증되지 않았다. shared schema 여부, tenant context 전달 방식, GIN 대상 컬럼과 쿼리를 먼저 확정해야 한다.
- Aurora MySQL, RDS PostgreSQL, DynamoDB, ClickHouse 통합 대안과 비교해야 한다.
- 멘토의 MySQL 경험과 Microsoft SQL Server DBA 전문성은 서로 다른 후보에 활용할 수 있다. 팀원 중 한 명에게 PostgreSQL 프로젝트 경험이 없다는 점까지 포함해 학습 계획과 운영 책임자를 정해야 한다.
- 같은 Spring Data JPA 대표 워크플로를 PostgreSQL과 MySQL에서 비교하고 RLS connection pool 격리와 GIN 실행계획을 검증한 뒤 `Accepted` 전환 여부를 결정한다.
- 이 ADR은 DB 엔진 선택과 마이너 버전 고정만 다룬다. 버전은 16 계열의 최신 마이너(`VER_16_13`)로 고정하고 `autoMinorVersionUpgrade` 기본값 `true`를 유지하기로 ADR-0012 안에서 결정했다. Aurora Serverless v2, `0.5~2 ACU`, `RemovalPolicy.DESTROY`의 근거는 별도 결정으로 남아 있다.

### (D) DB 자격 증명 분리 설계

prod `post-processor`와 `api-server`, dev `telemetry-ingest`와 `enrollment-api`에는 각 환경 PostgreSQL master secret이 주입된다. 이는 운영용 최종 설계가 아니며, master credential은 DB 초기화와 관리 작업에만 제한하는 것을 목표로 한다.

**`enrollment` 스키마의 부트스트랩 주체는 backend Flyway로 확정됐다**(backend ADR 0009 —
주체는 더 이상 이 ADR의 결정 대상이 아니다). 현재 dev 구현에서는 enrollment-api가 시작할 때
Flyway를 실행하고 telemetry-ingest는 Flyway를 비활성화한다. PROJ-139에서 구현할 workflow의 승인된
순서는 enrollment-api를 먼저 배포해 stable 상태를 확인한 뒤 telemetry-ingest를 배포하는 것이다.
앞으로 결정할 범위는 **prod에서 마이그레이션을 실행할 자리**와 DB 자격 증명 분리다.

구현을 변경하기 전에 다음 항목을 새 ADR로 결정해야 한다.

- prod 마이그레이션 실행 자리: one-off ECS task, 애플리케이션 시작 시 Flyway 등 (수동 `psql`은 제외 — 쓰지 않기로 확정)
- master, migration, runtime DB user의 권한과 수명주기
- runtime DB user를 서비스별로 분리할지 공유할지
- secret rotation과 ECS 재배포 및 마이그레이션 실행을 조정하는 방식

위 결정이 끝나기 전에는 현재 master secret 주입 방식을 운영 환경의 확정 구성으로 간주하지 않는다.

ADR-0018이 `post-processor`용 파생 DSN 시크릿을 도입했지만, **그 DSN 안에 든 것은 여전히 마스터 자격 증명이다.** 실질적인 권한 축소가 아니라 주입 형식의 정합화일 뿐이다. 또한 파생 시크릿은 `cdk deploy` 시점의 스냅샷이라 마스터 시크릿이 회전해도 자동 갱신되지 않는다(회전은 현재 설정하지 않았다). 따라서 이 항목의 ADR은 runtime DB user 분리와 함께 **파생 시크릿의 재생성·회전 방식까지** 결정해야 한다. 회전을 켜는 순간 파생 시크릿 방식은 "앱이 `DB_CREDS` JSON을 파싱"으로 교체해야 한다.

### (E) ADR-0014 — MVP ClickHouse 전용 subnet 분리 보류 `Proposed`

`docs/adr/0014-keep-clickhouse-in-app-subnet-for-mvp.md`

- 현재 ClickHouse ASG와 ECS 서비스는 primary AZ의 app subnet을 사용하고,
  전용 보안 그룹이 prod Collector/Dashboard와 dev app host의 8123/9000 접근만 허용한다.
- 같은 NAT Gateway와 기본 Network ACL을 사용하는 별도 private subnet은
  MVP에서 즉시 얻는 격리 효과가 제한적이므로 현재 구성을 유지하는 안이다.
- 팀 합의 후 `Accepted`로 전환한다. 전용 egress, Network ACL, VPC endpoint,
  IP 용량 또는 규제상 경계가 필요하면 전용 subnet을 다시 검토한다.
- subnet 이동은 ClickHouse EC2 교체와 로컬 EBS 데이터 유실 가능성이 있으므로,
  전환 시 최근 Raw Signal 재처리와 배포 절차를 함께 준비해야 한다.

### (F) ADR-0020 — 로그 그룹 정책 기록

현재 prod `ApplicationStack`은 컨테이너별 CloudWatch Logs 로그 그룹 5개를 만들고,
보존 기간을 14일, 삭제 정책을 `RemovalPolicy.DESTROY`로 설정한다. 이 구성은
구현되어 있지만 운영·비용·보안 관점의 결정 근거가 ADR에 없다.

**`DevApplicationStack`은 최종 세 컨테이너 로그 그룹에 같은 정책(14일, `RemovalPolicy.DESTROY`)을 쓰며
`/ecs/dev/` 접두사만 다르다.** ADR-0022 10번이 이를 명시적으로 ADR-0020에
위임했으므로, 아래 항목을 정할 때 **환경별 차등 여부**도 함께 결정한다.

인프라 코드를 변경하기 전에 ADR-0020에서 다음 항목을 결정한다.

- 컨테이너별 로그 그룹을 유지할지 서비스 단위로 통합할지와 로그 그룹 명명 규칙
- 14일 보존 기간의 트래픽·장애 조사·비용 근거와 환경별 보존 기간 필요 여부
- MVP의 `RemovalPolicy.DESTROY`를 프로덕션에서도 유지할지와 전환 조건
- AWS 관리형 암호화 또는 customer managed KMS key 사용 여부와 로그 접근 권한
- 장기 보관·감사 요구가 생길 때 S3 등으로 내보내는 방식과 알람·운영 조회 책임
- 비용 또는 규제 요구가 바뀔 때 정책을 재검토할 조건

ADR이 확정되기 전에는 현재 로그 그룹 구성을 운영 환경의 최종 정책으로 간주하지 않는다.

### (G) 인프라 코드를 추가/수정할 때의 순서

1. 기존 ADR에 걸리는지 먼저 확인한다. 걸리면 **코드보다 ADR을 먼저** 처리한다.
2. 새 결정이면 ADR을 **먼저** 쓰고 `docs/adr/README.md` 인덱스 표에 추가한다. 번호는 다음 미사용 번호(**`0028`**)를 쓴다. `0018`·`0019`는 런타임 계약, `0021`은 dev/prod 환경 분리, `0022`는 dev 인프라 토폴로지, `0023`은 dev auth-proxy(ADR-0026으로 대체), `0024`는 배포 역할과 ECS 물리 이름, `0025`는 dev ALB deregistration delay, `0026`은 dev 백엔드 3서비스 전환, `0027`은 dev ALB WAF로 이미 쓰였고, `0020`은 위 (F)의 로그 그룹 정책용으로 여전히 예약되어 있다.
   형식은 `docs/adr/0000-adr-template.md`를 따른다.
3. 상수는 **"이 값이 dev에서 달라야 할 이유가 있는가"**로 위치를 정한다 — 없으면 `lib/common/config.ts`, 운영 전용이면 `lib/prod/config.ts`, dev 전용이면 `lib/dev/config.ts`. 스택에서는 import만 한다 (4장).
4. `test/prod/*.test.ts` / `test/dev/*.test.ts` / `test/cicd/*.test.ts`에 template assertion을 추가한다. 픽스처는 `test/helpers.ts`의 `buildApp()` / `MODE_A_EDGE`(prod), `buildDevApp()`(dev), `buildCicdApp()`(cicd)를 재사용한다.
5. `npm test && npx cdk synth --all && npx cdk synth --all -c env=dev && npx cdk synth --all -c env=cicd` 통과를 확인한다.

### (H) 알려진 잔여 이슈 (여유가 있으면)

- `README.md`는 여전히 `cdk init` 보일러플레이트이며 이 장의 배포 런북을 정식 문서로 옮겨야 한다.
- 이 레포 자체의 `npm test`/`cdk synth` CI가 없다. DeployStack은 앱 레포 배포 권한이며 infra 검증 CI가 아니다.
- `.DS_Store`가 루트, `.github/`, `docs/`에 남아 있다.
- dev에서 인터넷 egress가 없는 awsvpc 태스크는 ClickHouse뿐이다. 외부 API 호출을 넣으면 런타임에서만 타임아웃날 수 있다.
- `devAllowedCidr=0.0.0.0/0`이면 비밀번호 없는 ClickHouse `:8123`과 RDS `:5432`가 인터넷에 열린다. synth 경고를 무시하지 않는다.
- dev RDS와 prod Aurora 모두 `StorageEncrypted`를 명시하지 않는다. prod 전환 때 removal policy와 함께 검토한다.
- `/app/binaries`의 실제 설치 파일 공급은 이 레포 범위가 아니다. URL과 rule만 있어도 설치 E2E는 완료되지 않는다.
- dev 원격 OTLP endpoint에 필요한 HTTPS listener/certificate/domain이 없다. backend·telemetryctl·Schema 계약을 HTTP 허용으로 낮추지 않고 별도 선행 과제로 해결한다.

### (I) ADR-0026 dev 백엔드 전환 `Accepted, 배포 증거 대기`

- 최종 문서 상태는 `telemetry-ingest`, `enrollment-api`, `clickhouse` 세 서비스와 앱 SG 4개, 실제 Secret 3개다. prod는 불변이다.
- PROJ-143 라우팅은 `6c11f19`에서 전체 279 tests, PROJ-144 detach는 `f08c207`에서 전체 280 tests로
  로컬 검증됐다. 두 단계 모두 AWS에는 배포하지 않았으며 live target health와 service event는 미확인이다.
- PROJ-144 delete는 `d45df19`에서 전체 254 tests, build와 prod mode A/B·dev·cicd fixture synth를
  통과했다. prod template/IAM과 기존 cluster·ALB·RDS·Raw Signal bucket·실제 Secret·ClickHouse
  properties는 기준선과 같고, ApplicationStack의 cross-stack reference 31개는 detach producer output과
  이름·값이 일치한다. 이 역시 로컬 합성 증거이며 AWS 배포 증거가 아니다.
- HTTP ALB에서는 인증 실패/성공, S3 PUT, ClickHouse insert, enrollment/bootstrap을 각각 검증한다. CLI enrollment → manifest → OTLP forward는 HTTPS 선행 과제 전에는 완료할 수 없다.
- PROJ-144는 먼저 구 세 서비스의 `AWS::ECS::Service.LoadBalancers: []`를 L1 override로 합성해 binding만 분리하고 구 target group을 유지한다. test가 정확한 빈 배열을 고정한다.
- 삭제 commit 배포 전에는 detach 배포 완료, 구 binding 부재, 새 target group·ALB DNS·DB 실제 Secret·S3 output 존재를 확인한다. `DevApplicationStack --exclusively`로 구 service/task를 먼저 제거하고 구 task/ENI/SG 미사용을 읽기 확인한 뒤 dev `--all`, 마지막 cicd 권한 회수 순서로 배포한다. weak reference는 물리 ECS/ENI/SG 종속성을 없애지 않는다.
- pipeline-dev 역할은 trust와 ARN output을 유지하며 ECR login을 포함한 permission statement가 0개다. 역할 삭제는 PROJ-106에서 결정한다.
- `config/otel-collector.yaml`, `ENRICHMENT_ENV`, prod ECR 상수와 prod 파생 DSN은 삭제하지 않는다.
- 로컬 구현은 `buildTelemetryIngestService()`·`buildEnrollmentApiService()`·`buildClickhouseService()`, dev SG construct 4개, 실제 Secret 3개와 Edge output 7개로 대조했다. 실제 배포가 끝나기 전에는 live 상태 증거로 쓰지 않는다.

### (J) ADR-0027 dev ALB WAF `Accepted, 배포 증거 대기`

- PROJ-197은 정책·ADR·핸드오프, PROJ-198은 dev Web ACL·association·Block/Count·rate,
  PROJ-199는 로그·마스킹·로컬 회귀 검증을 맡는다. AWS 배포와 실트래픽 검증은 이번 완료 범위가 아니다.
- PROJ-200(PR #18)의 `/api/v1` 앱 경로 전체를 본문/query Block에 포함한다. OTLP 세 경로와
  bootstrap 경로는 유지하고 `/api/v1/healthz`는 public 앱 경로에 포함하지 않는다.
- IP별 300초 기준으로 정확한 OTLP 세 경로 10,000건 Count, 등록·토큰·초대 세 조건만 300건 Block,
  추가된 인증·manifest·조직 관리·문의·업데이트와 bootstrap·다운로드·SQL 디버깅 등 나머지 합계
  1,000건 Block이다. Block rate는 429와
  `Retry-After: 60`을 쓰며 정확한 차단 해제 시간을 보장하지 않는다. 값은 실측·AWS 권장값이 아닌
  dev 초기값이고 공유 NAT·동시 설치·재시도, 나머지 경로 합산 및 요청 건수 기준의 한계를 관측한다.
- 서울 리전의 선택 버전 가용성·실제 룰·label은 AWS 세션 만료로 미확인이다. 배포 전
  `ListAvailableManagedRuleGroupVersions`·버전을 지정한 `DescribeManagedRuleGroup`으로 확인한다.
  버전 만료·변경 때는 override·label·예외를 다시 검증하고 CDK·commit·배포 시각을 남긴다.
- WAF는 `NONE`으로 URI 원문을 비교하며 ALB normalization 정합 증거는 canonical·trailing slash·prefix
  합성 조건에 한정한다. 배포 전 `curl --path-as-is`로 percent encoding·dot segment·중복 slash의
  ALB/WAF 분류를 확인하고 앱 라우팅이 디버깅 Count에 들어가면 정책을 보완한다.
- 인프라 배포 principal의 WAF logging configuration·CloudWatch Logs delivery/resource policy
  권한과 실제 로그 전달을 확인한다. 앱 GitHub 배포 역할에 이 권한을 추가하지 않는다.
- OTLP Count는 앱의 인증·압축 전후 크기 제한·압축 해제·JSON/protobuf 파싱·OTLP 구조 검증 확인이
  필요하다는 뜻이다. 이번 작업으로 앱 검사 구현 완료나 안전성을 주장하지 않는다.
- 정상 요청 오탐 차단 목표는 0건이며 관찰 기간·표본·담당자는 미정이다. template assertion과 synth는
  정책 조건만 증명하고 실제 signature 실행·차단·로그 마스킹·오탐 0건은 배포 후 별도로 검증한다.
- PROJ-198 배포에서 `OR_STATEMENT` nested statement 오류가 보고돼 나머지 rate 범위의
  `NOT(OR(OR3, OR3))`를 같은 의미의 `NOT(OR6)`로 평탄화했다. 일반적인 OR 중첩 금지나
  서비스 깊이 한도가 문서로 확인된 것은 아니다. 배포 전 합성 Rules를 `CheckCapacity`로 확인한다.
- PROJ-200 반영 전 OR 평탄화 수정은 전체 330 tests·build·prod A/B·dev·cicd fixture synth를
  통과했고, 당시 템플릿 변경은
  `RemainingRateBlock`의 OR 구조 한 곳에 한정됐다. AWS 세션 만료로 수정 전후 `CheckCapacity`
  대조는 수행하지 못했으며 실제 오류 해소는 서비스 검증·재배포로 확인해야 한다.
- PROJ-200(PR #18, `8836ef9`) 위로 PROJ-197 → 198을 누적한 구현은 전체 365 tests(14 suites,
  snapshot 없음), build와 prod A/B·dev·cicd fixture synth를 통과했다. PR #18 대비 기존 리소스와
  다른 환경 템플릿은 동일하고 dev Edge에 Web ACL·association 두 리소스만 추가된다. 새 앱
  내용 검사와 기존 등록 rate 세 조건을 구별하며 `RemainingRateBlock`의 여섯 leaf를 유지한다.

---

## 6. 명령어

```bash
npm test              # jest (@swc/jest); 정확한 suite/test 수는 현재 checkout 결과를 따른다
npm run build         # tsc (tsconfig의 noEmit: true — 순수 타입 체크)

npm run synth         # = cdk synth --all       (prod. cdk.json: `npx tsc && npx tsx bin/infra.ts`)
npm run diff          # = cdk diff --all
npm run deploy        # = cdk deploy --all

npm run synth:dev     # = cdk synth --all -c env=dev
npm run diff:dev      # = cdk diff --all -c env=dev
npm run deploy:dev    # = cdk deploy --all -c env=dev

npm run synth:cicd    # = cdk synth --all -c env=cicd   (DeployStack 하나뿐)
npm run diff:cicd     # = cdk diff --all -c env=cicd
npm run deploy:cicd   # = cdk deploy --all -c env=cicd

# 모드 A(HTTPS + ALB 인증)로 synth
npx cdk synth --all -c certificateArn=arn:aws:acm:ap-northeast-2:<account>:certificate/<id> \
                    -c domainName=example.com
```

### 배포 전 필수 선행 절차 (ADR-0007)

ECR repository는 CDK 밖에서 먼저 만들고 `linux/arm64` 이미지를 push한다. 최종 dev 자체 빌드 대상은
`soma-376/telemetry-ingest`, `soma-376/enrollment-api`이고 tag는 `dev`와 immutable commit SHA 두 개다.
prod 기존 repository와 `prod` tag 계약은 바꾸지 않는다. image architecture는 synth로 검증할 수 없으므로
ECR manifest와 실제 task start를 확인한다.

앱 workflow는 CDK를 실행하지 않고 해당 ECS service에 `--force-new-deployment`한 뒤 두 서비스가 모두
stable일 때 성공한다. enrollment-api를 먼저 안정화하고 telemetry-ingest를 뒤이어 배포한다.

### 배포 역할 배포 (ADR-0024)

GitHub OIDC provider는 account당 하나이며 RETAIN이다. 기존 provider가 있으면
`-c githubOidcProviderArn=<arn>`으로 참조한다. 최종 pipeline-dev role은 trust와 ARN output만 유지하고
inline/attached permission statement가 없어야 한다. backend-dev role만 새 ECR/service 두 개를 대상으로
한다. prod 역할과 대상은 기준선 그대로인지 synth diff로 확인한다.

```bash
aws iam list-open-id-connect-providers
npm run synth:cicd
npx cdk deploy --all -c env=cicd -c githubOidcProviderArn=<existing-provider-arn>
```

실제 배포는 사용자 승인을 받은 운영 단계에서만 수행한다.

### dev 최종 배포·검증 런북 (ADR-0026)

```bash
npm test
npm run build
npx cdk synth --all -c env=dev
npx cdk diff --all -c env=dev -c devAllowedCidr=<내 IP>/32
```

배포 전 `telemetry-ingest`, `enrollment-api`, `clickhouse` 세 service, 두 새 instance target group, dev SG 4개,
실제 Secret 3개, 앱 ASG `maxCapacity: 1`, ingest grace 240초, enrollment grace 60초 기본값을 template에서
확인한다. Edge output은 `AlbDnsName`, `OtlpEndpoint`, `ClickhouseDebugUrl`, `RdsEndpoint`, `RdsSecretArn`,
`TokenHashSecretArn`, `AdminApiTokenSecretArn` 7개여야 하고 prod template은 기준선과 같아야 한다.

HTTP ALB 경계 검증은 다음을 각각 확인한다.

```bash
# OTLP 인증 실패와 성공
curl -i -X POST 'http://<alb-dns>/v1/traces'   -H 'Content-Type: application/json' -d '{"resourceSpans":[]}'
curl -i -X POST 'http://<alb-dns>/v1/traces'   -H 'Authorization: Bearer <token>'   -H 'Content-Type: application/json' -d '{"resourceSpans":[]}'

# 신규 앱 health는 TG가 직접 호출한다. public listener rule은 없어야 한다.
aws elbv2 describe-target-health --target-group-arn <telemetry-ingest-tg>
aws elbv2 describe-target-health --target-group-arn <enrollment-api-tg>

# ClickHouse 직접 경계는 기존 :8123
curl 'http://<alb-dns>:8123/?query=SELECT%201'

# 제거 경계
curl -i 'http://<alb-dns>:4318/v1/traces'
curl -i 'http://<alb-dns>/api/'
```

유효 token 요청 뒤 Raw Signal S3 PUT과 ClickHouse insert를 실제 데이터로 확인하고 enrollment/bootstrap
HTTP route를 검증한다. `/app/binaries`에 파일이 없으면 설치 download E2E는 미완료다.
`PULSEMETRY_PUBLIC_BASE_URL`은 HTTP bootstrap URL이고 manifest OTLP endpoint가 아니다. 원격 endpoint는
HTTPS여야 하므로 CLI enrollment → manifest → OTLP forward는 별도 TLS listener/certificate/domain 작업
후에만 검증한다.

### PROJ-144 detach·delete 배포 순서

1. detach commit은 구 collector/auth-proxy/dashboard service의 L1 `CfnService`에
   `LoadBalancers: []` property override를 명시한다. CDK `BaseService`가 빈 target 목록을 `undefined`로
   생략하므로 `addTarget` 제거만으로는 attachment 제거 update가 되지 않는다. 합성 테스트는 세 서비스의
   정확한 빈 배열과 구 target group 유지를 고정한다. CloudFormation 계약은
   [`AWS::ECS::Service.LoadBalancers`](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-ecs-service.html#cfn-ecs-service-loadbalancers)를 따른다.
2. detach 배포가 끝나 실제 구 service attachment가 없음을 확인한다. delete commit 배포 전에는 새 target
   group, ALB DNS, DB 실제 Secret, Raw Signal S3 output이 현재 배포에 존재해야 한다.
   PROJ-143 뒤 구 target group과 ECS resource properties가 남아 있어도 listener action이 없으면 ALB는
   target을 `unused`/`Target.NotInUse`로 보고 health check를 수행하지 않는다. 따라서 구 경로는 healthy
   warm standby가 아니다. rollback할 때는 이전 Edge listener template을 명시적으로 다시 배포한 뒤 구
   target의 initial health check 통과를 확인한다. multi-stack 배포에서 나중의 ApplicationStack이
   실패해도 먼저 완료된 EdgeStack은 자동으로 이전 template로 돌아가지 않는다.
3. delete commit에서는 먼저 CDK CLI의
   [`--exclusively`](https://docs.aws.amazon.com/cdk/v2/guide/ref-cli-cmd-deploy.html)를 사용해
   ApplicationStack만 배포하고 구 service/task를 제거한다.

```bash
npx cdk deploy DevApplicationStack --exclusively -c env=dev \
  -c devAllowedCidr=<내 IP>/32
```

4. `aws ecs list-tasks`/`describe-tasks`와 EC2 ENI/SG 읽기 조회로 구 collector running task와 task ENI가
   없고 `DevCollectorSg`가 사용 중이 아님을 확인한다. weak reference는 ECS/ENI/SG 물리 종속성을 없애지
   않는다.
5. 그 뒤 `npx cdk deploy --all -c env=dev -c devAllowedCidr=<내 IP>/32`로 Network/Data/Edge의 구 SG,
   derived Secret, target group, listener/output를 정리한다. manifest 순서상 Network/Data/Edge가 App보다
   앞이므로 처음부터 `--all`하면 SG가 사용 중인 상태에서 EC2
   [`DeleteSecurityGroup`의 `DependencyViolation`](https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_DeleteSecurityGroup.html)이
   날 수 있다.
6. 마지막으로 cicd stack을 배포해 pipeline-dev 권한을 0개로 회수한다. 최종 delete commit에서는 구
   service와 함께 임시 `LoadBalancers: []` override도 제거한다.

이 런북은 명령과 검증 순서만 기록하며 문서 작성 중에는 실제 AWS 배포를 수행하지 않는다.
ALB target 상태와 ECS service attachment 의미는
[ALB target health](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/target-group-health-checks.html)와
[ECS service definition parameters](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service_definition_parameters.html)를
따른다.

### 운영자 접속 (ADR-0016)

SSH 인그레스도 키페어도 없다. 접속은 전부 SSM 채널을 쓴다. **환경에 따라 수단이 갈린다.**

| 환경 / 대상 | 수단 | 필요한 운영자 IAM 권한 |
|---|---|---|
| prod `clickhouse` (EC2) | `aws ssm start-session` | `ssm:StartSession` |
| prod `post-processor`, `api-server` (Fargate) | `aws ecs execute-command` | `ecs:ExecuteCommand` |
| **dev — 전 컨테이너** | 호스트 `aws ssm start-session` + `sudo docker exec` | `ssm:StartSession` |

**dev에는 ECS Exec이 없다.** 최종 세 서비스는 호스트 SSM 뒤 `docker exec`으로 진입한다. awsvpc인 ClickHouse는 NAT나 `ssmmessages` VPC endpoint가 없고, 두 bridge 앱도 ECS Exec을 켜지 않는다. 호스트에서 `docker logs`·`docker inspect`·`curl`을 사용한다 (ADR-0022 5(b), ADR-0016, ADR-0026).

dev 인스턴스는 `Env` 태그로 찾는다.

```bash
aws ec2 describe-instances --region ap-northeast-2 \
  --filters "Name=tag:Env,Values=dev" "Name=instance-state-name,Values=running" \
  --query 'Reservations[].Instances[].[InstanceId,InstanceType,PublicIpAddress]' --output table
```

두 방식 모두 로컬에 **Session Manager plugin**이 설치되어 있어야 한다. 없으면 명령 자체가 실패한다.

#### ClickHouse EC2

```bash
# 인스턴스 ID 조회 — Org 태그는 dev 호스트에도 붙으므로 Env=mvp 로 운영만 좁힌다
aws ec2 describe-instances --region ap-northeast-2 \
  --filters "Name=tag:Org,Values=soma-376" "Name=tag:Env,Values=mvp" \
            "Name=instance-state-name,Values=running" \
  --query 'Reservations[].Instances[].InstanceId' --output text

# 접속
aws ssm start-session --target <instance-id> --region ap-northeast-2
```

주의할 점 두 가지.

- **접근 통제는 인스턴스가 아니라 운영자 IAM에 있다.** 인스턴스 역할의 `AmazonSSMManagedInstanceCore`는 "SSM에 관리될 수 있다"만 정한다. 실제로 누가 들어올 수 있는지는 `ssm:StartSession` 권한이 결정하며, 그 정책은 이 레포가 관리하지 않는다.
- **기본 세션 사용자 `ssm-user`는 passwordless sudo를 가진다.** 접속하면 사실상 root다.

인스턴스가 목록에 안 뜨면 SSM Agent가 없거나 죽은 것이다. 먼저 확인한다.

```bash
aws ssm describe-instance-information --region ap-northeast-2 \
  --query 'InstanceInformationList[].[InstanceId,PingStatus,AgentVersion]' --output table
```

#### Fargate 컨테이너 (ECS Exec)

`CollectorService`와 `DashboardService`에만 `enableExecuteCommand: true`가 켜져 있다. ClickHouse는 위의 EC2 접속으로 대신한다.

```bash
# 태스크 ID 조회
aws ecs list-tasks --cluster <cluster> --service-name <service> --region ap-northeast-2

# 접속
aws ecs execute-command --cluster <cluster> \
  --task <task-id> --container api-server \
  --interactive --command "/bin/sh" --region ap-northeast-2
```

**컨테이너 이미지에 셸이 없으면 실패한다.** distroless나 JRE-slim 기반이면 `/bin/sh`가 없어 권한과 무관하게 접속되지 않는다. 이건 인프라가 아니라 앱 레포의 Dockerfile이 결정하는 부분이다.

### 운영 스택 리팩터링 회귀 검증

운영 스택을 옮기거나 정리할 때는 **합성 템플릿이 바이트 단위로 같은지**를 게이트로 쓴다. ADR-0021의 `lib/prod/` 이동이 이 방식으로 검증됐고, 앞으로도 같은 종류의 작업에 그대로 쓸 수 있다.

```bash
git stash && npx cdk synth --all -q -o /tmp/before
git stash pop && npx cdk synth --all -q -o /tmp/after
diff /tmp/before/NetworkStack.template.json /tmp/after/NetworkStack.template.json  # 4개 모두
```

**`*.template.json`만 비교하면 된다.** `*.metadata.json`은 CDK construct의 스택 트레이스 문자열을 담고 있어 파일 경로가 바뀌면 필연적으로 달라진다 — 그 차이는 회귀가 아니다. 템플릿이 한 글자라도 다르면 "이동"이 아니라 변경이 섞인 것이다.

---

## 7. 테스트 작성 규칙

테스트는 `test/prod/`(6 스위트), `test/dev/`(6 스위트), `test/cicd/`(2 스위트)로 나뉘고, 픽스처 `helpers.ts`만 루트에 둔다.

- `aws-cdk-lib/assertions` 기반 **template assertion만** 쓴다. 스냅샷 테스트는 쓰지 않는다.
  - 예외: `lib/common/config.ts`의 **순수 함수**(예: `buildLibpqDsn`)와 `lib/dev/config.ts`의 `loadDevConfig`, `lib/cicd/config.ts`의 `loadCicdConfig` 파싱 로직은 CDK 리소스를 만들지 않으므로 `test/prod/config.test.ts` / `test/dev/config.test.ts` / `test/cicd/config.test.ts`에서 일반 단위 테스트로 검증한다. 이 파싱 테스트는 context 입력용 `new App()`을 직접 써도 되지만, 스택을 합성하는 테스트는 여전히 template assertion과 아래 팩토리만 쓴다.
- **`new App()`을 직접 쓰지 말고 `test/helpers.ts`의 `buildApp()`(prod) / `buildDevApp()`(dev) / `buildCicdApp()`(cicd)을 쓴다.**
  bare `App`은 `cdk.json`의 피처 플래그를 읽지 않아 CLI synth와 산출물이 달라진다 (예: ASG가 `LaunchTemplate` 대신 `LaunchConfiguration`을 생성). **dev도 ASG를 쓰므로 같은 함정이 그대로 적용된다** — `test/dev/application-stack.test.ts`가 `LaunchConfiguration` 0개를 어서션한다.
  세 팩토리 모두 진입점과 **같은 `synthProd` / `synthDev` / `synthCicd`를 거치므로** 픽스처 조립과 실제 배포 조립이 갈라질 수 없다 (ADR-0021 1번, ADR-0024 1번).
- 모드 A 테스트는 `MODE_A_EDGE`를, 모드 B는 인자 없이 기본값을 쓴다. dev context 키는 `buildDevApp({ devAllowedCidr: '203.0.113.10/32' })`처럼 객체로 주입한다 — CLI의 `-c key=value`와 같은 자리다.
- 고정 env는 `TEST_ENV = { account: '111111111111', region: 'ap-northeast-2' }`다.

**dev 테스트가 고정하는 핵심 계약**

| 계약 | 스위트 |
|---|---|
| ECS service 3개와 network mode bridge / bridge / awsvpc, 서비스 물리 이름 | `test/dev/application-stack.test.ts` |
| telemetry-ingest/enrollment-api 각각 1024 MiB, 앱 ASG 최종 `maxCapacity: 1` | `test/dev/application-stack.test.ts` |
| telemetry-ingest 환경·Secret·S3 권한과 enrollment-api 환경·Secret | `test/dev/application-stack.test.ts` |
| 두 앱이 같은 token hash Secret을 쓰고 실제 Secret은 총 3개, 파생 DSN/URI 없음 | `test/dev/data-stack.test.ts`, `test/dev/application-stack.test.ts` |
| 로그 그룹 3개와 `/ecs/dev/` 접두 | `test/dev/application-stack.test.ts` |
| SG 4개, `open: false`, `80/8123/5432`만 CIDR ingress, `4318` 없음 | `test/dev/network-stack.test.ts`, `test/dev/edge-stack.test.ts` |
| `:80` default 404와 priority 1/3/4/5의 명시한 paths, `/api/v1/healthz` public rule 없음 | `test/dev/edge-stack.test.ts` |
| 신규 target group 2개는 instance/60초, ClickHouse는 ip/300초 | `test/dev/edge-stack.test.ts` |
| telemetry-ingest만 health grace 240초, enrollment-api는 60초 기본값 | `test/dev/application-stack.test.ts` |
| ALB DNS late binding public base URL과 `/app/binaries` | `test/dev/application-stack.test.ts` |
| WAF ALB 연결·버전·국가·개별 Count·exact-label·경로 경계·IP별 rate/429 | `test/dev/waf.test.ts` |
| WAF 탐지 로그 14일·DROP/KEEP·header/query redaction·data protection·sampling 비활성화 | `test/dev/waf.test.ts` |
| 구 collector/auth-proxy/dashboard/service/TG/Cloud Map binding/derived Secret/output가 없음 | dev 세 스위트 |
| detach 단계에서는 구 세 `AWS::ECS::Service.LoadBalancers`가 정확히 `[]`이고 구 TG 유지 | PROJ-144 detach 전용 합성 test; 최종 delete에서 override/test 제거 |

**cicd 테스트가 고정하는 핵심 계약**

| 계약 | 왜 |
|---|---|
| trust `sub`가 immutable org/repo ID와 branch까지 `StringEquals` | wildcard나 name-only subject를 막는다 |
| backend-dev가 신규 ECR/service 두 개만 대상으로 함 | 물리 이름과 workflow 계약 drift를 잡는다 |
| pipeline-dev role의 permission statement 0개, trust/output 유지 | ECR login 포함 권한 회수를 보장한다 |
| prod 역할의 ECR/service policy가 기준선과 같음 | dev cleanup이 prod 권한을 바꾸지 않게 한다 |
| `iam:PassRole`, `ecs:RegisterTaskDefinition`, wildcard action 부재 | 권한 상승 경로를 막는다 |
| OIDC provider `Retain`, `ThumbprintList`/Lambda 없음 | provider 수명과 인증서 회전 계약을 지킨다 |

```ts
import { Template } from 'aws-cdk-lib/assertions';
import { buildApp, MODE_A_EDGE } from './helpers';

const { edge } = buildApp(MODE_A_EDGE);
Template.fromStack(edge).hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
  Protocol: 'HTTPS',
});
```

---

## 8. 커밋 / PR 규칙

- 브랜치명: `^(feat|feature|fix|docs|refactor|chore|test|style|perf|build|ci)/(PROJ-\d+)-.*$`
- 커밋 제목: `[<KEY>] <type>: <summary>` — 예) `[PROJ-22] docs: 핸드오프 문서 추가`
- PR 제목: `[<KEY>] <type>: <summary>` — 워크플로가 Jira 요약으로 자동으로 채운다. 직접 쓰지 않는다.
- PR 대상 브랜치는 `develop`이다. `.github/workflows/pull_request_auto_fill.yml`이 브랜치명에서 Jira 키를 파싱해 제목을 재작성하고 본문에 링크를 넣는다. (`feature`는 `feat`으로 정규화된다.)
- 브랜치명이 위 규칙에 맞지 않으면(타입 접두사 누락 등) `pull_request_auto_fill.yml`의 Jira 키 파싱이 실패해 제목이 재작성되지 않는다. PR을 올리기 전에 브랜치명을 규칙에 맞춘다. (브랜치가 origin보다 얼마나 앞서는지는 금방 낡으므로 여기 적지 않는다 — `git log --oneline origin/main..HEAD`로 확인한다.)
- 문서와 코드 주석은 한국어로 작성한다.
