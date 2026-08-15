# AGENTS.md

이 레포에서 작업하는 코딩 에이전트를 위한 핸드오프 문서다. 코드를 수정하기 전에 **3장(불변 규칙)** 과 **5장(남은 작업)** 을 반드시 읽는다.

문서와 주석은 **한국어**로 작성한다. AWS/CDK 용어와 명령어는 영문 원문을 유지한다.

---

## 1. 이 레포는 무엇인가

AWS CDK v2 (TypeScript) 로 작성된 **단일 인프라 레포**다. MVP 관측성(observability) 플랫폼의 AWS 리소스를 정의한다.

```
AI Tool / 브라우저 → ALB → OTel Collector → ClickHouse (분석)
                          → Spring Boot API → Aurora PostgreSQL (컨트롤 플레인)
```

- ADR-0009에 따라 **인프라는 이 레포에서만 관리한다.** 앱 레포(Collector & Processor, Dashboard Backend)의 CI는 이미지 빌드 → ECR push → `ecs update-service --force-new-deployment` 까지만 수행한다. 앱 배포가 `cdk deploy`를 유발하지 않는다. **그 두 동작에 필요한 AWS 권한은 `lib/cicd/`의 배포 역할 4개가 준다** (ADR-0024).
- 태스크 정의를 바꾸려면 **반드시 이 레포를 경유**해야 한다.
- 대상 region은 **`ap-northeast-2`**다. account는 `CDK_DEFAULT_ACCOUNT`에서만 주입하며 코드와 문서에 기록하지 않는다.
- **환경은 셋이다** — 운영(`lib/prod/`)과 개발(`lib/dev/`)이 **같은 계정·같은 리전**에 공존하고, 여기에 배포 역할만 담는 `lib/cicd/`가 더해진다. 진입점 `bin/infra.ts`는 `-c env=dev|prod|cicd` 컨텍스트 하나만 읽고 `synthProd()` / `synthDev()` / `synthCicd()`로 조립을 위임한다. **기본값은 `prod`**이므로 무인자 `cdk deploy`는 여전히 운영을 대상으로 한다. (ADR-0021, ADR-0022, ADR-0024)
- 설계 근거는 전부 `docs/adr/`에 있다. 코드와 ADR이 어긋나면 ADR이 기준이다.

---

## 2. 스택 구조와 의존 방향

앱 환경(prod/dev)마다 스택이 4개고, `cicd`는 1개다. 의존 관계는 **`lib/prod/app.ts`의 `synthProd()` / `lib/dev/app.ts`의 `synthDev()` / `lib/cicd/app.ts`의 `synthCicd()`에서 construct 참조를 props로 넘기는 방식**으로만 표현한다. 수동 `Fn::ImportValue`나 SSM 우회 참조를 새로 도입하지 않는다.

```
lib/
├── common/   환경 무관 계약 상수 + 순수 헬퍼 (config.ts, clickhouse-user-data.ts, deploy-targets.ts)
├── prod/     운영 4스택 + app.ts(synthProd) + config.ts
├── dev/      dev 4스택 + app.ts(synthDev) + config.ts
└── cicd/     DeployStack 1개 + app.ts(synthCicd) + config.ts
test/
├── prod/     운영 스위트 6개
├── dev/      dev 스위트 5개
├── cicd/     cicd 스위트 2개
└── helpers.ts   buildApp() / buildDevApp() / buildCicdApp() / MODE_A_EDGE / TEST_ENV
```

폴더 간 의존 방향은 **`prod → common`, `dev → common`, `cicd → common` 단방향**이다 (ADR-0021 2번, ADR-0024 1번). **`cicd`도 `prod`·`dev` 어느 쪽도 import 하지 않는다** — 거기서 양쪽을 끌어오면 `prod ↔ dev` 금지 규칙이 `cicd`를 경유해 우회된다. 스택 간 의존 형태는 두 앱 환경이 같다.

```
NetworkStack ──> DataStack ──┐
     │                       ├──> ApplicationStack ──> EdgeStack
     └───────────────────────┘
```

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

스택 ID는 `Dev` 접두사를 쓴다. **같은 계정·같은 리전에서 CloudFormation 스택 이름이 유일해야 하므로, 이 접두사가 두 환경이 서로를 덮어쓰지 않게 하는 유일한 장치다** (ADR-0021 3번).

| 스택 | 파일 | 주요 리소스 |
|---|---|---|
| `DevNetworkStack` | `lib/dev/network-stack.ts` | 전용 VPC (`10.1.0.0/16`, 2 AZ × public 1 티어, **NAT 0개**), S3 Gateway Endpoint, **SG 5개 전부 + 모든 cross-SG 룰** |
| `DevDataStack` | `lib/dev/data-stack.ts` | RDS PostgreSQL 16.13 `db.t4g.micro` (`controlplane` DB, gp3 20GB, **`publiclyAccessible`**), 시크릿 4개 (마스터 + post-processor 파생 DSN + auth-proxy 파생 URI + 토큰 해시 키), Raw Signal S3 버킷 (7일 만료) |
| `DevApplicationStack` | `lib/dev/application-stack.ts` | ECS 클러스터, Cloud Map `obs.local`, ASG 2개 (앱 `t4g.medium` / ClickHouse `t4g.small`) + 캐패시티 프로바이더 2개, `Ec2Service` 4개 |
| `DevEdgeStack` | `lib/dev/edge-stack.ts` | internet-facing ALB (:80, :4318, :8123), `CfnOutput` 8개. **Cognito·CloudFront·프론트엔드 S3는 만들지 않는다** |

**dev 태스크 구성** — 태스크마다 네트워크 모드가 다르다. ADR-0022 4번이 **awsvpc를 강제하는 조건을 둘만 인정**하고(태스크 내 `localhost` 의존 / Cloud Map A 레코드 등록 대상), 나머지는 bridge로 두어 인터넷 egress와 ENI 여유를 얻는다는 규칙이다 (ADR-0023 2번).

| 태스크 | 컨테이너 | 네트워크 모드 | 그 모드여야 하는 이유 |
|---|---|---|---|
| `DevCollectorTask` | `otel-collector` (:4318), `post-processor` | **awsvpc** | `config/otel-collector.yaml`의 `http://localhost:8080` exporter는 태스크 내 네트워크 네임스페이스 공유가 전제다 |
| `DevAuthProxyTask` | `auth-proxy` (:4316, 동적 호스트 포트) | **bridge** | 단일 컨테이너라 localhost 의존이 없고, 디스커버리의 **클라이언트**라 Cloud Map 등록 대상도 아니다. 강제 조건이 없으므로 ENI 여유와 egress를 취한다 (ADR-0023 2번) |
| `DevDashboardTask` | `api-server` (:8080, 동적 호스트 포트), `batch-processor` | **bridge** | 두 컨테이너 사이에 localhost 의존이 없다. 호스트 ENI를 타므로 인터넷 egress와 ECS Exec이 살아난다 |
| `DevClickhouseTask` | `clickhouse` (:8123/:9000) | **awsvpc** | Cloud Map A 레코드(`clickhouse.obs.local`) 등록에는 태스크 전용 IP가 필요하다. bridge면 SRV만 등록된다 |

네 서비스 모두 `desiredCount: 1` + `minHealthyPercent: 0` / `maxHealthyPercent: 100` 교체 배포다 (t4g의 인스턴스당 ENI 한도 3, ADR-0022 Constraints). ALB 타깃 타입도 네트워크 모드의 귀결이다 — awsvpc는 `ip`, bridge는 `instance`.

**호스트 배치.** auth-proxy는 새 ASG를 만들지 않고 기존 `DevAppAsg`(t4g.medium 1대)에 얹힌다. 그 호스트는 collector 태스크(awsvpc, ENI 1개) + dashboard·auth-proxy(bridge, ENI 0개)를 함께 돌리므로 **ENI는 3 중 2를 쓴다.** `memoryReservation` 합계는 2304 MiB로 전부 소프트 예약이다.

**OTLP 경로에 인증이 생겼다** (ADR-0023). ALB `:80`의 `/v1/*`는 auth-proxy를 거치고, auth-proxy가 `collector.obs.local`(Cloud Map A 레코드)로 Collector에 전달한다. 인증 없이 Collector로 직행하는 기존 경로는 **`:4318` 디버그 리스너**로 남아 있다 — 프록시 장애와 파이프라인 장애를 가르는 용도이며, ALB는 forward 시 URL을 재작성하지 않으므로 경로가 아니라 포트로 나눈다.

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
| **SG 5개와 모든 cross-SG 룰은 `NetworkStack`에만 정의한다** | SG 참조가 스택 내부 참조가 되어 스택 간 순환 의존을 원천 차단한다. 하류 스택은 props로 주입만 받는다. (`lib/prod/network-stack.ts`의 클래스 헤더 주석. `DevNetworkStack`이 같은 규칙을 그대로 계승한다 - ADR-0022 2번) |
| **ECR 레포를 CDK로 만들지 않는다** | `Repository.fromRepositoryName`으로 참조만 한다. CDK가 만들면 첫 배포에서 "이미지 없는 레포" → 태스크 기동 실패 → 롤백으로 레포까지 삭제되는 순환이 생긴다. (ADR-0007) |
| **ECR 레포 이름은 `soma-376/` 네임스페이스 아래에 둔다** | 네임스페이스는 `COMMON_TAGS.Org`와 같은 값이다. 비용 배분 태그 축과 레지스트리 경로를 같은 식별자로 정렬한다. ECR은 레포 이름 변경이 불가능해 사후 교정에 재생성 + 이미지 재push가 든다. (`lib/common/config.ts`의 `ECR_NAMESPACE`, ADR-0007) |
| **`batch-processor`는 `essential: false`** | 배치 실패가 같은 태스크의 api-server를 함께 내리면 안 된다. (`lib/prod/application-stack.ts:279`, dev는 `lib/dev/application-stack.ts:462`, ADR-0004) |
| **ClickHouse `Ec2Service`는 `minHealthyPercent: 0` / `maxHealthyPercent: 100`** | 인스턴스 1대 + awsvpc ENI 한도상 롤링 배포가 불가능하다. 강제 교체 배포만 가능하다. (`lib/prod/application-stack.ts:397-398`. dev는 네 서비스 전부 같은 값이며 `lib/dev/application-stack.ts`의 `REPLACEMENT_DEPLOYMENT` 상수가 이를 강제한다 - ADR-0022 Constraints) |
| **`AsgCapacityProvider`의 `enableManagedTerminationProtection: false`** | 단일 인스턴스 교체 배포를 관리형 종료 보호가 막는다. (`lib/prod/application-stack.ts:346`, dev는 `lib/dev/application-stack.ts`의 `addCapacityProvider`) |
| **DB 시크릿은 참조만 노출한다** | `data.dbSecret`(`ISecret`)을 넘길 뿐, **합성 시점에 값을 평문으로 읽는 코드**는 절대 넣지 않는다. 컨테이너에는 `Secret.fromSecretsManager`로 주입한다. **예외는 `DataStack`의 `PostProcessorPgDsn` 파생 시크릿 하나뿐이며**, 거기서도 `unsafeUnwrap()`이 돌려주는 건 평문이 아니라 `{{resolve:secretsmanager:...}}` 동적 참조 토큰이다(합성 산출물은 `Fn::Join` + `Ref`뿐). 새 예외를 만들려면 ADR-0018을 먼저 갱신한다. (`lib/prod/data-stack.ts`, dev는 `lib/dev/data-stack.ts`의 `DevPostProcessorPgDsn`, ADR-0018) |
| **`post-processor`의 환경변수 이름은 앱 소스가 권위다** | 앱은 `ENRICHMENT_CH_URL` / `ENRICHMENT_CH_DB` / `ENRICHMENT_PG_DSN` **세 개만** 읽는다 (`ai-telemetry-pipeline`의 `src/enrichment/sink_clickhouse.py:43,47`, `src/enrichment/rds.py:21`). 이름이 하나라도 틀리면 앱은 예외 없이 compose 전용 기본값으로 **조용히 폴백**하고, ECS에서는 DNS가 안 풀려 모든 insert가 `BackendUnavailable` → HTTP 503이 된다. **synth도 테스트도 배포도 전부 통과한다** — 인프라 테스트는 "앱이 그 이름을 읽는가"를 원리적으로 검증할 수 없다. 죽은 계약(`CLICKHOUSE_HOST`·`DB_CREDS`·`DB_NAME`)을 다시 넣지 않는다. **dev도 같은 이름을 쓴다** - 계약이 환경마다 갈리면 "dev에서 검증했다"는 말의 의미가 사라진다. (`lib/common/config.ts`의 `ENRICHMENT_ENV`, ADR-0018, ADR-0021 2번) |
| **ClickHouse 컨테이너의 `CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT: '1'`과 고정 태그를 지우지 않는다** | 이미지 entrypoint는 `CLICKHOUSE_USER`/`CLICKHOUSE_PASSWORD`/`CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT`가 전부 비면 `default` 유저를 **루프백 전용**으로 잠근다(`disabling network access for user 'default'`). 그러면 `post-processor`의 모든 적재가 403 `Code: 516 ... Authentication failed`로 죽고 앱이 그걸 `BackendUnavailable`→503으로 바꾼다. **synth도 테스트도 배포도 전부 통과한다** — 실제로 이렇게 깨졌다. 조건식상 `USER='default'`와 `PASSWORD=''`는 분기를 못 열고 **`DEFAULT_ACCESS_MANAGEMENT`만 연다**(나머지 셋은 compose 정합성용). 태그를 빼면 `latest`가 되어 재기동마다 이 entrypoint 로직 자체가 바뀔 수 있다. 비밀번호가 없는 것도 의도다 — 앱이 자격증명을 아예 보내지 않으므로 접근 통제는 `clickhouseSecurityGroup`이 담당한다. (`lib/common/config.ts`의 `CLICKHOUSE_IMAGE`·`CLICKHOUSE_CONTAINER_ENV` - dev/prod가 같은 상수를 전개한다, ADR-0019) |
| **Aurora 자동 생성 비밀번호의 `ExcludeCharacters`와 따옴표 없는 libpq DSN은 한 몸이다** | `buildLibpqDsn()`은 값을 따옴표로 감싸지 않는다 — 합성 시점에 user/password는 토큰이라 감쌀 방법이 없다. aws-rds의 `DEFAULT_PASSWORD_EXCLUDE_CHARS`가 공백·`'`·`"`·`\` 넷을 전부 빼주기 때문에만 성립하는 **우연한 커플링**이다. 깨지면 배포는 성공하고 `post-processor`만 런타임에 죽는다. 그 상수는 공개 export가 아니므로 `test/prod/data-stack.test.ts`가 **합성 템플릿의 `ExcludeCharacters`** 로 고정한다. dev의 `DatabaseInstance`도 같은 상수에 기대므로 `test/dev/data-stack.test.ts`가 같은 어서션을 갖는다. (ADR-0018, ADR-0022 7번) |
| **`batch-processor`·`api-server`의 계약과 `RAW_BUCKET`은 건드리지 않는다** | 두 컨테이너는 소스 코드가 확보되지 않아 실제로 무엇을 읽는지 알 수 없다. `post-processor`를 고쳤다는 이유로 함께 "정리"하면 멀쩡한 계약을 깨뜨린다. `post-processor`의 `RAW_BUCKET`도 같은 이유로 남긴다 — ADR-0017의 `awss3` exporter 전환용이며 태스크 역할의 `grantReadWrite`와 한 몸이다. (ADR-0018) |
| **Fargate 태스크는 ARM64로 고정한다** | `runtimePlatform`을 빼면 CDK 기본값(미지정)으로 돌아가 x86_64가 된다. 앱 레포도 반드시 `linux/arm64` 이미지를 push해야 하며, amd64를 올리면 synth와 테스트는 통과하지만 런타임에 이미지 pull이 실패한다. ClickHouse EC2(t4g)와 아키텍처를 맞추고 x86 대비 약 20% 저렴하다. dev도 같은 이유로 ARM64에 고정한다 - 호스트 ASG가 `EcsOptimizedImage.amazonLinux2023(AmiHardwareType.ARM)`이므로 `linux/arm64` 요구가 그대로 따라온다. (`lib/prod/application-stack.ts`의 `FARGATE_RUNTIME_PLATFORM`, ADR-0015) |
| **Collector 설정은 `config/otel-collector.yaml`에만 둔다** | synth 시점에 파일을 읽어 `OTEL_CONFIG` 환경변수로 주입하고 `--config=env:OTEL_CONFIG`로 기동한다. 파일 경로·환경변수 이름·`command` 세 가지는 한 몸이라 함께 바꿔야 한다. **이 값은 CFN 템플릿과 ECS 콘솔에 평문으로 남으므로 시크릿을 넣으면 안 된다.** **dev도 같은 파일을 읽는다** - dev용으로 포크하면 collector 동작이 갈라져 dev의 검증 가치가 사라진다. (`lib/prod/application-stack.ts`·`lib/dev/application-stack.ts`의 `COLLECTOR_CONFIG_PATH`, ADR-0017, ADR-0022 4번) |
| **`otel-collector` 컨테이너는 root(`user: '0'`)로 돈다** | 이미지가 `User=10001:10001`인데 UID 10001이 쓸 수 있는 디렉터리가 하나도 없다(scratch 기반이라 `/tmp`도 없다). `file/*` exporter가 `/data`를 만들려면 root가 필요하다. 빼면 `mkdir /data: permission denied`로 기동 직후 exit 1이다. **file exporter와 `user: '0'`은 한 몸이라 함께 없애야 한다** — 이 커플링은 `test/prod/application-stack.test.ts`와 `test/dev/application-stack.test.ts`가 각각 고정한다. `awss3` exporter로 옮기면 root가 필요 없어진다. (ADR-0017) |
| **Collector config는 배포 전 실제로 기동해 봐야 한다** | `cdk synth`·`npm test`는 config를 문자열로만 다루고, `otelcol-contrib validate`조차 컴포넌트를 **해석만** 하고 start하지 않아 파일시스템·권한 실패를 못 잡는다. 최초 배포가 정확히 이 틈으로 빠져나가 죽었다. 관문은 `docker run -d --user 0:0 -e OTEL_CONFIG="$(cat config/otel-collector.yaml)" ... --config=env:OTEL_CONFIG` 후 로그에 `Everything is ready`가 뜨는지 확인하는 것이다. **정리는 컨테이너 ID를 지목한다. `--filter ancestor=...`를 쓰면 같은 이미지를 쓰는 로컬 개발 컨테이너까지 지운다.** (ADR-0017) |
| **DB 이름은 PostgreSQL 키워드 표에 없는 단어여야 한다** | RDS는 `DatabaseName`에 엔진 예약어 검사를 걸고, 그 목록이 PostgreSQL의 reserved 키워드보다 넓다. 실제로 `control`은 non-reserved인데도 400으로 거부됐다. 되돌리면 배포가 통째로 실패한다. (`lib/common/config.ts`의 `CONTROL_DB_NAME` - dev RDS도 같은 상수를 쓴다, ADR-0012) |
| **`maxAzs: 2`는 이중화가 아니라 의도된 하한이다** | 진짜 단일 AZ는 Aurora `DatabaseCluster`(서브넷 ≥2 요구)와 internet-facing ALB(퍼블릭 서브넷 2개 요구)가 막는다. 컴퓨트/데이터는 여전히 사실상 단일 AZ다. (`lib/prod/network-stack.ts:35-36`. dev도 같은 이유로 `maxAzs: 2`다 - internet-facing ALB와 RDS DB subnet group이 각각 2 AZ를 요구한다) |
| **`RemovalPolicy.DESTROY` / `autoDeleteObjects`는 MVP 한정 의도다** | 실수가 아니다. 프로덕션 전환 시 일괄 재검토 대상이므로, 개별적으로 `RETAIN`으로 바꾸지 말고 ADR로 묶어서 처리한다. |
| **ECS 클러스터/서비스 이름의 단일 출처는 `lib/common/deploy-targets.ts`다** | 이 값은 앱 레포 워크플로와의 계약이자 `DeployStack`이 IAM 서비스 ARN을 조립하는 조각이다. **CloudFormation은 IAM 정책에 적힌 리소스 ARN의 실존을 검증하지 않으므로**, 한쪽만 고치면 네 스택이 전부 배포에 성공하고 GitHub Actions만 `AccessDenied`로 죽는다. `test/cicd/deploy-stack.test.ts`의 크로스 스택 어서션이 유일한 방어선이다. 이름 변경은 클러스터·서비스 **교체**를 유발하므로 6장 런북을 따른다. (ADR-0024 6번) |
| **신뢰 정책의 `sub` 조건에 와일드카드를 쓰지 않는다** | `StringLike` + `repo:org/repo:*`는 GitHub 문서의 기본 예시지만, PR 헤드 브랜치와 태그를 포함한 **모든 ref**에 그 역할을 연다. 그러면 "PR을 열 수 있는 사람 = 운영에 배포할 수 있는 사람"이 되고 develop→dev / main→prod 분리가 사라진다. `StringEquals` 완전 일치만 쓴다. (`lib/cicd/deploy-stack.ts`, ADR-0024 2번) |
| **배포 역할에 `iam:PassRole` / `ecs:RegisterTaskDefinition`을 주지 않는다** | `--force-new-deployment`는 기존 태스크 정의 리비전을 그대로 재사용하므로 둘 다 필요 없다. 주는 순간 CI가 태스크 정의를 갈아끼우고 임의 역할을 붙일 수 있어 계정 안에서 사실상 권한 상승 경로가 되고, ADR-0009(태스크 정의는 이 레포 경유)도 무너진다. (ADR-0024 5번) |
| **prod 파이프라인 역할에 auth-proxy를 넣지 않는다** | auth-proxy는 **dev에만 존재한다**(ADR-0023). 없는 서비스의 ARN을 넣으면 아무도 소비하지 않는 `prod` 태그 이미지를 밀 권한이 생기고, 다음 사람이 그 ARN을 보고 "prod에 auth-proxy가 있다"고 오독한다. 위 죽은 계약 금지와 같은 종류다. prod 이관 시 `DEPLOY_TARGETS`에 함께 추가한다. |
| **GitHub OIDC 공급자는 계정당 1개이고 `RETAIN`이다** | URL당 하나만 존재할 수 있어 이미 있는 계정에서 새로 만들면 `EntityAlreadyExists`로 스택이 통째로 롤백된다. 배포 전에 `aws iam list-open-id-connect-providers`로 확인하고, 있으면 `-c githubOidcProviderArn=<arn>`으로 참조 모드를 쓴다. `RETAIN`이므로 `DeployStack`을 destroy한 뒤 재배포할 때도 이 키가 필요하다. **`thumbprints`는 주지 않는다** — 지문을 박아 두면 GitHub 인증서 회전 시 인프라는 멀쩡한 채 Actions만 죽는다. (ADR-0024 3번) |
| **IAM `Description`은 영문으로 쓴다** | 이 레포는 주석과 문서를 한국어로 쓰지만 IAM의 `Description`은 Latin-1 밖의 문자를 거부한다. 한국어를 넣으면 `cdk synth`는 경고만 내고 통과한 뒤 `cdk deploy`가 실패한다. (`lib/cicd/deploy-stack.ts`) |

### dev 환경 전용 규칙

| 규칙 | 왜 |
|---|---|
| **`lib/prod/`와 `lib/dev/`는 서로 import 하지 않는다** | 의존은 `prod → common`, `dev → common` 단방향뿐이다. 이 규칙 하나가 "dev를 고치다 운영이 깨진다"는 경로를 **컴파일 타임에** 차단한다. dev에 필요한 값이 `prod/`에 있으면 `common/`으로 올리거나 `dev/`에 복제한다. (ADR-0021 2번) |
| **dev 태스크 4개의 네트워크 모드를 바꾸지 않는다** (awsvpc / bridge / bridge / awsvpc) | collector가 bridge가 되면 `config/otel-collector.yaml`의 `http://localhost:8080` exporter 계약이 깨진다(컨테이너마다 네임스페이스가 갈려 localhost가 자기 자신을 가리킨다). clickhouse가 bridge가 되면 Cloud Map이 A 레코드 대신 **SRV만** 등록해 `ENRICHMENT_CH_URL`이 깨진다. **둘 다 synth·test·deploy가 전부 통과하고 런타임에만 죽는다** - 앱은 이름이 안 풀려도 예외 없이 compose 기본값으로 조용히 폴백한다. `test/dev/application-stack.test.ts`의 `NetworkMode` 어서션이 유일한 방어선이다. (ADR-0022 4번) |
| **auth-proxy의 `DATABASE_URL`에 libpq DSN을 넣지 않는다** | `pg`의 파서는 URI 전용이라 keyword/value 문자열은 공백이 `%20`으로 인코딩되며 망가진다. 그리고 URI 쿼리의 **`uselibpqcompat=true`를 빼면** `sslmode=require`가 `verify-full`의 별칭이 되어 RDS 기본 CA 검증에 실패한다 — 두 경우 다 배포는 성공하고 auth-proxy만 런타임에 죽는다. `buildLibpqDsn`과 `buildPostgresUri`가 나란히 있는 것이 중복이 아닌 이유다. (`lib/common/config.ts`, ADR-0023) |
| **`DevCollectorService`의 `cloudMapOptions`를 지우지 않는다** | auth-proxy가 Collector를 찾는 유일한 수단이다(`collector.obs.local`). **A 레코드여야 하며** bridge/host면 Cloud Map이 SRV만 등록해 HTTP 클라이언트가 해석하지 못한다. 지우면 ALB 헬스체크(`/health`)는 계속 통과하고 전달만 `upstream_unreachable`로 죽는다. (`lib/dev/application-stack.ts`, ADR-0005, ADR-0023 1번) |
| **`DevCollectorSg` ← `DevAppHostSg` : 4318 룰을 지우지 않는다** | auth-proxy가 bridge라 아웃바운드가 호스트 ENI를 타므로 출발 SG가 태스크 SG가 아니라 호스트 SG다. `batch-processor` → ClickHouse 룰과 같은 사정이며, "아무도 안 쓰는 것 같다"고 지우면 auth-proxy만 조용히 타임아웃으로 죽는다. (`lib/dev/network-stack.ts`, ADR-0022 4번, ADR-0023 2번) |
| **dev 로그 그룹의 `/ecs/dev/` 접두사를 빼지 않는다** | 운영 `ApplicationStack`이 `logGroupName`에 `/ecs/collector` 같은 **물리 이름을 명시**하고, 로그 그룹 이름은 계정 + 리전에서 유일하다. 접두사를 빼면 첫 `cdk deploy`가 `Resource of type 'AWS::Logs::LogGroup' with identifier '/ecs/collector' already exists`로 스택째 롤백된다. (`lib/dev/config.ts`의 `DEV_LOG_GROUP_PREFIX`, ADR-0021 Constraints, ADR-0022 10번) |
| **dev ALB 리스너의 `open: false`를 지우지 않는다** | CDK `addListener`의 기본값 `open: true`가 리스너 포트를 `0.0.0.0/0`에 여는 인그레스를 ALB SG에 자동 추가한다. 운영에서는 `NetworkStack`이 이미 anyIpv4 룰을 갖고 있어 dedup되지만, dev는 CIDR을 좁히는 것이 목적이라 그 자동 룰이 좁힌 룰 옆에 남아 **`devAllowedCidr` 제한을 통째로 무력화한다.** **이번 구현에서 실제로 발생했던 버그다.** `test/dev/network-stack.test.ts`의 "전면 공개 인그레스가 어디에도 남지 않는다"가 이를 고정한다. (`lib/dev/edge-stack.ts`, ADR-0022 2번/9번) |
| **`applyCommonTags`는 태그 맵을 인자로 받는다** | prod는 `COMMON_TAGS`(`Env: 'mvp'` **유지**), dev는 `DEV_COMMON_TAGS`(`Env: 'dev'`)다. 태그는 App 스코프에서 전 리소스로 전파되므로, prod의 `Env`를 `'prod'`로 "정정"하면 VPC·서브넷·SG·ECS·로그 그룹·Aurora·S3까지 전 리소스에 태그 diff가 생기고 일부는 교체될 수 있다. **이 레포에서 환경 식별자는 태그가 아니라 스택 ID 접두사다.** (`lib/common/config.ts`의 `applyCommonTags`, ADR-0021 4번) |
| **`bin/infra.ts`와 `test/helpers.ts`는 직접 스택을 조립하지 않는다** | 양쪽 다 `synthProd`/`synthDev`를 거쳐야 테스트 픽스처와 실제 배포 조립이 갈라지지 않는다. 예전에는 두 파일이 4스택 조립을 각각 손으로 들고 있었고, 한쪽만 고치면 통과하는 조립과 배포되는 조립이 달라졌다. (ADR-0021 1번) |

---

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

새 상수를 넣기 전에 **"이 값이 dev에서 달라야 할 이유가 있는가"**를 먼저 묻는다. 없으면 `common/`, 있으면 각 환경 폴더다. 스택에 리터럴을 새로 박지 말고 아래에서 import 한다.

| 파일 | 성격 | 내용 |
|---|---|---|
| `lib/common/config.ts` | **환경 무관 계약** | `PORTS`, `CLOUD_MAP_NAMESPACE`, `CLICKHOUSE_SERVICE_NAME`, `CLICKHOUSE_HOST`, `CLICKHOUSE_HTTP_URL`, `CLICKHOUSE_DEFAULT_DB`, `CLICKHOUSE_IMAGE`, `CLICKHOUSE_CONTAINER_ENV`, `ENRICHMENT_ENV`, `ECR_NAMESPACE`, `ECR_REPOS`, `CONTROL_DB_NAME`, `CONTROL_DB_SSLMODE`, `LibpqDsnParts`, `buildLibpqDsn`, `applyCommonTags` |
| `lib/common/clickhouse-user-data.ts` | 환경 무관 | `/dev/xvdb` 포맷 + `/data/clickhouse` 마운트 user data (dev/prod 공용) |
| `lib/common/deploy-targets.ts` | **환경별 값이지만 매핑은 환경 무관** | `DeployEnv`, `DEPLOY_ENVS`, `ECS_CLUSTER_NAMES`, `ECS_SERVICE_NAMES` |
| `lib/prod/config.ts` | 운영 전용 | `COMMON_TAGS`, `PROD_IMAGE_TAG`, `PRIMARY_AZ_INDEX`, `SUBNET_GROUP`, `EdgeConfig`, `InfraConfig`, `loadConfig`, `DEFAULT_COGNITO_DOMAIN_PREFIX` |
| `lib/dev/config.ts` | dev 전용 | `DEV_COMMON_TAGS`, `DEV_VPC_CIDR`, `DEV_SUBNET_GROUP`, `DEV_LOG_GROUP_PREFIX`, 인스턴스 타입/볼륨 상수, `DEV_OPEN_CIDR`, `DevConfig`, `loadDevConfig`, `warnOnOpenIngress` |
| `lib/cicd/config.ts` | cicd 전용 | `CICD_COMMON_TAGS`, `GITHUB_OIDC_URL`/`_DOMAIN`/`_AUDIENCE`, `GITHUB_ORG`, `GITHUB_REPOS`, `DEPLOY_BRANCHES`, `ECR_PUSH_ACTIONS`, `ECS_DEPLOY_ACTIONS`, `DeployTarget`, `DEPLOY_TARGETS`, `CicdConfig`, `loadCicdConfig` |

**`deploy-targets.ts`는 배치 규칙의 명시적 예외다.** 클러스터 이름은 환경별 값이라 규칙만 보면 각 환경 폴더 행이지만, **소비자가 셋(prod 스택 / dev 스택 / cicd 스택)이라서** 각 환경 폴더에 두면 `lib/cicd/`가 `lib/prod/`와 `lib/dev/`를 둘 다 import 해야 한다 — 그게 바로 규칙이 막으려던 커플링이다. "값은 환경별이되 **환경 → 값 매핑은 환경 무관 계약**"이라는 근거로 `common/`에 두되, `config.ts`에 섞지 않고 별도 파일로 격리한다. 반대로 GitHub org·레포·브랜치·`DEPLOY_TARGETS`는 소비자가 `lib/cicd/` 하나뿐이라 `common/`에 두지 않는다. (ADR-0024 6번)

`common/`이 커지면 "환경 무관"의 경계가 흐려져 예전 `lib/config.ts`가 그대로 재현된다. 애매하면 `common/`이 아니라 각 환경 폴더에 둔다 (ADR-0021 Negative).

### 배포별 가변값 (CDK context 키)

| 환경 | 키 | 기본값 | 비고 |
|---|---|---|---|
| prod | `certificateArn` | 없음 | 있으면 모드 A(HTTPS + ALB 인증), 없으면 모드 B |
| prod | `domainName` | 없음 | Cognito callback URL 기준 주소와 일치해야 한다 |
| prod | `cognitoDomainPrefix` | `soma-376-mvp-auth` | 리전 내 전역 유일 |
| dev | `devAllowedCidr` | **`0.0.0.0/0`** | ALB(80/4318/8123)와 RDS(5432)의 인바운드 소스. 쉼표로 여러 개 가능. **미지정(또는 명시)이면 synth 경고 `infra:dev-open-ingress`** |
| dev | `devAppAsgMaxCapacity` | `1` | 앱 호스트 ASG 최대 용량. 부하 테스트 확장 손잡이. 1 미만이거나 정수가 아니면 즉시 throw |
| dev | `devImageTag` | **`dev`** | dev/prod가 같은 ECR 레포를 공유하고 태그로만 갈린다. `pr-42` 같은 실험 태그로 갈아탈 때 쓴다 |
| cicd | `githubOidcProviderArn` | 없음 | 주면 OIDC 공급자를 만들지 않고 참조만 한다. 계정당 1개뿐이라 이미 있으면 필수다. **형식이 틀리면 즉시 throw** |

prod는 `lib/prod/config.ts`의 `loadConfig`, dev는 `lib/dev/config.ts`의 `loadDevConfig`, cicd는 `lib/cicd/config.ts`의 `loadCicdConfig`가 읽는다.

**운영 이미지 태그에는 대응되는 context 키가 없다.** `PROD_IMAGE_TAG`는 `lib/prod/config.ts`에 고정이다 — CLI 인자로 바꿀 수 있게 하면 "지금 운영에 어떤 이미지가 있는가"의 답이 코드가 아니라 누군가의 셸 히스토리로 옮겨간다. 운영 이미지 승격도 롤백도 ECR에서 `prod` 태그를 옮겨 붙이고 force-new-deployment 하는 절차다 (ADR-0024 7번).

### 앱 레포 배포 계약 (PROJ-65)

앱 레포 워크플로가 알아야 할 값의 전부다. 이 표와 코드가 어긋나면 **워크플로만 `AccessDenied`로 죽고 인프라 쪽에는 아무 신호도 남지 않는다.**

| 항목 | 값 |
|---|---|
| 역할 이름 | `github-deploy-<레포>-<env>` — `github-deploy-ai-telemetry-pipeline-dev` 등 4개. ARN은 `DeployStack`의 `CfnOutput` |
| 신뢰 조건 | `aud` = `sts.amazonaws.com`, `sub` = `repo:soma-376/<레포>:ref:refs/heads/<브랜치>` (**완전 일치**) |
| 브랜치 | `develop` → dev, `main` → prod |
| 클러스터 | `soma-376-dev` / `soma-376-prod` |
| 서비스 | `collector`, `dashboard`, `auth-proxy`(dev 전용). `clickhouse`는 배포 대상 아님 |
| 이미지 태그 | dev는 `dev`, prod는 `prod`. **`linux/arm64` 필수** (ADR-0015) |
| 워크플로 요구사항 | `permissions: id-token: write`. **GitHub Environment를 쓰지 않는다** — `sub`가 `...:environment:<name>`으로 바뀌어 신뢰 조건과 불일치한다. PR·태그 트리거도 같은 이유로 배포 잡에 쓸 수 없다 |
| 주의 | `ecs describe-services`에 **권한 없는 서비스를 섞으면 호출 전체가 거부된다.** 그 역할에 부여된 서비스만 한 호출에 넣는다 |
| 알려진 스위치 | `docker buildx --cache-from type=registry`를 쓰려면 `ecr:BatchGetImage`·`ecr:GetDownloadUrlForLayer`를 `ECR_PUSH_ACTIONS`에 추가해야 한다. 기본값에는 없다 |

### 컨테이너 런타임 계약 (앱 레포와의 인터페이스)

**이 절은 dev/prod 공통이다.** 같은 이미지, 같은 환경변수 이름, 같은 `clickhouse.obs.local` — 계약이 환경마다 갈리면 "dev에서 검증했다"는 말의 의미가 사라진다. **이게 dev를 두는 목적이다** (ADR-0021 2번/5번).

**컨테이너마다 계약이 다르다.** 앱이 실제로 읽는 이름이 권위이며, 앱은 어느 값도 하드코딩하지 않는다. 주입 범위(대상 / 비대상)는 `test/prod/application-stack.test.ts`와 `test/dev/application-stack.test.ts`가 양쪽 모두 검증한다.

#### `api-server` (Spring Boot — 소스 미확보)

| 값 | 전달 경로 |
|---|---|
| host, port, engine, username, password, dbClusterIdentifier | 시크릿 `DB_CREDS` (JSON) |
| 데이터베이스 이름 | 환경변수 `DB_NAME` |

**`DB_CREDS`에 `dbname` 키는 없다.** CDK `DatabaseCluster`가 자동 생성하는 시크릿은 `defaultDatabaseName`을 시크릿에 넣지 않기 때문이다. 그래서 DB 이름만 `DB_NAME` 환경변수로 따로 준다. 시크릿에서 `dbname`을 읽으려 하면 `undefined`가 나온다.

#### `post-processor` (`ai-telemetry-pipeline`, Python — ADR-0018)

앱은 아래 **세 개만** 읽는다. 그 외에는 무엇을 넣어도 무시된다.

| 값 | 전달 경로 | 앱 소스 |
|---|---|---|
| ClickHouse HTTP URL (`http://clickhouse.obs.local:8123`) | 환경변수 `ENRICHMENT_CH_URL` | `src/enrichment/sink_clickhouse.py:43` |
| ClickHouse DB 이름 (`default`) | 환경변수 `ENRICHMENT_CH_DB` | `src/enrichment/sink_clickhouse.py:47` |
| libpq keyword/value DSN 한 줄 | **시크릿** `ENRICHMENT_PG_DSN` | `src/enrichment/rds.py:21` |

`post-processor`는 `DB_CREDS` JSON을 파싱하지 않는다. 그래서 `DataStack`이 `aurora.clusterEndpoint.hostname`과 마스터 시크릿에서 DSN을 조립한 **파생 시크릿**(`PostProcessorPgDsn`)을 만들고 ECS `secrets`로 넣는다 — `environment`에 넣으면 `aws ecs describe-task-definition`에 DB 비밀번호가 평문으로 드러난다.

DSN 형식: `host=… port=5432 dbname=controlplane user=… password=… sslmode=require`
DB는 `api-server`와 같은 `controlplane`을 공유한다.

`RAW_BUCKET`(버킷 이름)도 함께 주입되지만 **현재 앱은 읽지 않는다.** ADR-0017이 예고한 collector의 `awss3` exporter 전환에 대비해 태스크 역할의 S3 권한과 함께 남겨둔 것이다.

#### `auth-proxy` (`ai-telemetry-pipeline`의 `apps/auth-proxy`, Node/TypeScript — ADR-0023)

**현재 dev에만 있다.** 권위 소스는 `apps/auth-proxy/src/config/env.ts`다.

| 값 | 전달 경로 | 비고 |
|---|---|---|
| Collector OTLP 주소 (`http://collector.obs.local:4318`) | 환경변수 `COLLECTOR_BASE_URL` | 뒤에 `/v1/traces` 등을 이어붙인다. **끝 슬래시 금지** |
| Postgres 접속 문자열 | **시크릿** `DATABASE_URL` | **URI 형식** |
| Bearer 토큰 HMAC-SHA256 키 | **시크릿** `TOKEN_HASH_SECRET` | enrollment 서버와 공유 |
| 로그 레벨 | 환경변수 `LOG_LEVEL` | dev는 `debug`. PROJ-51이 앱 쪽에 도입 중 |

`PORT`(기본 4316)와 `MAX_OTLP_BODY_SIZE`(기본 10MiB)는 기본값을 쓰므로 주입하지 않는다.

**`DATABASE_URL`은 `post-processor`의 `ENRICHMENT_PG_DSN`과 형식이 다르다. 재사용하면 안 된다.** psycopg는 libpq keyword/value를 읽지만 `pg`의 파서(`pg-connection-string`)는 `new URL()` 기반의 **URI 전용**이다. keyword/value를 넣으면 공백이 `%20`으로 인코딩되어 통째로 망가진다. 그래서 `lib/common/config.ts`에 `buildLibpqDsn()`과 `buildPostgresUri()`가 나란히 있다 — 중복이 아니라 두 앱이 다른 형식을 요구한다는 사실이다.

**URI 쿼리의 `uselibpqcompat=true`를 빼면 안 된다.** `pg-connection-string`은 이 플래그가 없으면 `sslmode=require`를 **`verify-full`의 별칭**으로 취급한다(라이브러리가 직접 경고를 낸다). 그러면 `rejectUnauthorized`가 켜지고 RDS 기본 CA는 Node 기본 CA 번들에 없으므로 **접속 자체가 실패한다.** `CONTROL_DB_SSLMODE = 'require'`의 "CA 검증을 하지 않는다"는 주석은 libpq에서만 참이다.

**`TOKEN_HASH_SECRET`은 회전할 수 없다.** 키가 바뀌면 이미 발급된 모든 토큰의 `token_hash`가 매칭 불가가 되어 전 클라이언트가 401을 받는다. 회전하려면 토큰 전량 재발급이나 이중 키 검증이 선행되어야 한다.

**앱은 필수 값이 비면 즉시 throw하고 기동에 실패한다.** `post-processor`와 달리 조용한 폴백이 없어, 이름 오타는 태스크 재시작 루프와 `/ecs/dev/auth-proxy` 로그로 드러난다.

#### `batch-processor` / `otel-collector` / `clickhouse`

| 값 | 전달 경로 | 대상 |
|---|---|---|
| ClickHouse 호스트명 | 환경변수 `CLICKHOUSE_HOST` | `batch-processor` (소스 미확보 — 손대지 않는다) |
| collector 설정 YAML 전문 | 환경변수 `OTEL_CONFIG` (+ `--config=env:OTEL_CONFIG`) | `otel-collector` |
| `CLICKHOUSE_DB` / `CLICKHOUSE_USER` / `CLICKHOUSE_PASSWORD` / `CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT` | 환경변수 (`lib/common/config.ts`의 `CLICKHOUSE_CONTAINER_ENV`) | `clickhouse` (이미지 entrypoint — ADR-0019) |

`OTEL_CONFIG`는 DB 자격증명이 아니라 collector 설정 본문이다.

### EdgeStack 모드 A / B

`lib/prod/edge-stack.ts`의 `const isHttps = Boolean(props.edge.certificateArn)` 한 줄이 전체 분기를 결정한다.

| | 모드 A (`-c certificateArn=...` 제공) | 모드 B (기본값) |
|---|---|---|
| 리스너 | 443 HTTPS + 80 → 443 리다이렉트 | 80 HTTP |
| `/v1/*` (OTLP) | `ListenerAction.authenticateJwt` → collector TG | 인증 없이 forward |
| `/api/*` | `AuthenticateCognitoAction` → dashboard TG | 인증 없이 forward |
| 기본 액션 | fixed response 404 | fixed response 404 |
| 기타 | — | synth 시 ADR-0008 폴백 경고 방출 |

**`DevEdgeStack`에는 이 분기가 없다.** HTTP 전용이며(:80 + :4318 + :8123), Cognito도 CloudFront도 만들지 않는다. `:80`의 `/v1/*`만 auth-proxy가 인증하고 나머지 경로의 방어선은 `devAllowedCidr` 하나뿐이다 (ADR-0022 8번/9번, ADR-0023 3번).

---

## 5. 지금 남은 작업

### (A) ADR-0008 — 인증 이원화 확정 `Proposed` · 최우선

`docs/adr/0008-dual-auth-alb-cognito-and-otlp-token.md`

- **막힌 지점: 도메인 / ACM 인증서 확보 여부가 미정이다.** `authenticate-cognito`와 `jwt-validation` 둘 다 HTTPS 리스너를 필수로 요구하므로, 이게 정해지지 않으면 모드 A를 실전 검증할 수 없다.
- 코드는 **이미 모드 A / 모드 B 양쪽 다 구현되어 있고 테스트도 통과한다.** 즉 병목은 코드 작성이 아니라 **결정**이다.
- 도메인 확보 시 → Status를 `Accepted`로 올리고, 모드 A로 실제 배포 검증한 뒤 사용한 context 값을 문서화한다.
- 도메인 확보 후에는 다음 순서로 리소스를 연결하고 검증한다.
  1. DNS를 Route 53에서 관리할지 외부 DNS 공급자를 유지할지 결정하고, ALB에 연결할 API/OTLP 도메인 또는 subdomain을 확정한다.
  2. `ap-northeast-2`에서 해당 도메인의 ACM 인증서를 발급·검증하고, DNS에 ALB를 가리키는 Alias 또는 CNAME 레코드를 만든다.
  3. `certificateArn`, `domainName`, `cognitoDomainPrefix` context 값을 확정한다. `domainName`은 Cognito callback URL의 `/oauth2/idpresponse` 기준 주소와 일치해야 한다.
  4. CloudFront 프론트엔드에도 custom domain을 사용할지 별도로 결정한다. 사용한다면 CloudFront용 인증서와 DNS Alias를 추가하는 설계를 먼저 ADR에 반영한다.
  5. 모드 A로 배포해 HTTP→HTTPS 리다이렉트, `/api/*` Cognito 인증, `/v1/*` JWT 검증을 확인하고 실제 context 값과 DNS·인증서 연결 절차를 배포 런북에 기록한다.
- 도메인 무산 시 → ADR-0008에 적힌 폴백(Spring Security + Cognito JWT 검증, Collector auth extension)으로 전환한다. 이건 **인프라가 아니라 앱 레이어 변경**이므로 별도 ADR(그 시점의 다음 번호)로 분리해 기록한다.
- **문서 정정이 필요하다.** ADR-0008 Constraints의 마지막 항목 — *"jwt-validation은 비교적 최신 ALB 기능이라 CDK L2 construct에서 아직 지원하지 않을 수 있다. 이 경우 `CfnListenerRule`(L1)로 직접 정의해야 한다"* — 은 이미 무효다. `aws-cdk-lib ^2.261.0`의 L2 `ListenerAction.authenticateJwt`로 구현되어 있다 (`lib/prod/edge-stack.ts`). 이 문장은 삭제한다.

### (B) ADR-0009 — 스택 경계 확정 `Proposed`

`docs/adr/0009-single-infra-repo-stack-boundary.md`

- 실질적으로 이미 코드로 실행되어 있다 (단일 `ApplicationStack`). 남은 건 팀 합의 후 Status를 `Accepted`로 올리는 것뿐이다.
- Revisit Trigger("앱 팀의 인프라 레포 수정 부담이 실제 병목이 되면 스택 분리")는 그대로 유지한다.

### (C) ADR-0012 — 컨트롤 플레인 DB 엔진으로 PostgreSQL 검토 `Proposed`

`docs/adr/0012-aurora-postgresql-for-control-plane.md`

- 현재 유력 후보는 PostgreSQL이다. 엔진 수준의 멀티 테넌시 격리에 RLS를 활용할 가능성과 JSONB·전문 검색 등에 GIN을 활용할 가능성이 주요 근거다.
- 둘 다 실제 컨트롤 플레인 스키마와 쿼리로 검증되지 않았다. shared schema 여부, tenant context 전달 방식, GIN 대상 컬럼과 쿼리를 먼저 확정해야 한다.
- Aurora MySQL, RDS PostgreSQL, DynamoDB, ClickHouse 통합 대안과 비교해야 한다.
- 멘토의 MySQL 경험과 Microsoft SQL Server DBA 전문성은 서로 다른 후보에 활용할 수 있다. 팀원 중 한 명에게 PostgreSQL 프로젝트 경험이 없다는 점까지 포함해 학습 계획과 운영 책임자를 정해야 한다.
- 같은 Spring Data JPA 대표 워크플로를 PostgreSQL과 MySQL에서 비교하고 RLS connection pool 격리와 GIN 실행계획을 검증한 뒤 `Accepted` 전환 여부를 결정한다.
- 이 ADR은 DB 엔진 선택과 마이너 버전 고정만 다룬다. 버전은 16 계열의 최신 마이너(`VER_16_13`)로 고정하고 `autoMinorVersionUpgrade` 기본값 `true`를 유지하기로 ADR-0012 안에서 결정했다. Aurora Serverless v2, `0.5~2 ACU`, `RemovalPolicy.DESTROY`의 근거는 별도 결정으로 남아 있다.

### (D) DB 자격 증명 분리 설계

현재 `post-processor`와 `api-server`에는 Aurora PostgreSQL의 master secret이 주입된다. 이는 운영용 최종 설계가 아니며, master credential은 DB 초기화와 관리 작업에만 제한하는 것을 목표로 한다.

구현을 변경하기 전에 다음 항목을 새 ADR로 결정해야 한다.

- 마이그레이션 실행 시점과 주체: one-off ECS task, Data API/Lambda, 애플리케이션 시작 시 Flyway 등
- master, migration, runtime DB user의 권한과 수명주기
- runtime DB user를 서비스별로 분리할지 공유할지
- secret rotation과 ECS 재배포 및 마이그레이션 실행을 조정하는 방식

위 결정이 끝나기 전에는 현재 master secret 주입 방식을 운영 환경의 확정 구성으로 간주하지 않는다.

ADR-0018이 `post-processor`용 파생 DSN 시크릿을 도입했지만, **그 DSN 안에 든 것은 여전히 마스터 자격 증명이다.** 실질적인 권한 축소가 아니라 주입 형식의 정합화일 뿐이다. 또한 파생 시크릿은 `cdk deploy` 시점의 스냅샷이라 마스터 시크릿이 회전해도 자동 갱신되지 않는다(회전은 현재 설정하지 않았다). 따라서 이 항목의 ADR은 runtime DB user 분리와 함께 **파생 시크릿의 재생성·회전 방식까지** 결정해야 한다. 회전을 켜는 순간 파생 시크릿 방식은 "앱이 `DB_CREDS` JSON을 파싱"으로 교체해야 한다.

### (E) ADR-0014 — MVP ClickHouse 전용 subnet 분리 보류 `Proposed`

`docs/adr/0014-keep-clickhouse-in-app-subnet-for-mvp.md`

- 현재 ClickHouse ASG와 ECS 서비스는 primary AZ의 app subnet을 사용하고,
  전용 보안 그룹이 Collector와 Dashboard의 8123/9000 접근만 허용한다.
- 같은 NAT Gateway와 기본 Network ACL을 사용하는 별도 private subnet은
  MVP에서 즉시 얻는 격리 효과가 제한적이므로 현재 구성을 유지하는 안이다.
- 팀 합의 후 `Accepted`로 전환한다. 전용 egress, Network ACL, VPC endpoint,
  IP 용량 또는 규제상 경계가 필요하면 전용 subnet을 다시 검토한다.
- subnet 이동은 ClickHouse EC2 교체와 로컬 EBS 데이터 유실 가능성이 있으므로,
  전환 시 최근 Raw Signal 재처리와 배포 절차를 함께 준비해야 한다.

### (F) ADR-0020 — 로그 그룹 정책 기록

현재 `ApplicationStack`은 컨테이너별 CloudWatch Logs 로그 그룹 5개를 만들고,
보존 기간을 14일, 삭제 정책을 `RemovalPolicy.DESTROY`로 설정한다. 이 구성은
구현되어 있지만 운영·비용·보안 관점의 결정 근거가 ADR에 없다.

**`DevApplicationStack`도 같은 정책(14일, `RemovalPolicy.DESTROY`)을 쓰며
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
2. 새 결정이면 ADR을 **먼저** 쓰고 `docs/adr/README.md` 인덱스 표에 추가한다. 번호는 다음 미사용 번호(**`0025`**)를 쓴다. `0018`·`0019`는 런타임 계약, `0021`은 dev/prod 환경 분리, `0022`는 dev 인프라 토폴로지, `0023`은 dev auth-proxy, `0024`는 배포 역할과 ECS 물리 이름으로 이미 쓰였고, `0020`은 위 (F)의 로그 그룹 정책용으로 여전히 예약되어 있다.
   형식은 `docs/adr/0000-adr-template.md`를 따른다.
3. 상수는 **"이 값이 dev에서 달라야 할 이유가 있는가"**로 위치를 정한다 — 없으면 `lib/common/config.ts`, 운영 전용이면 `lib/prod/config.ts`, dev 전용이면 `lib/dev/config.ts`. 스택에서는 import만 한다 (4장).
4. `test/prod/*.test.ts` / `test/dev/*.test.ts` / `test/cicd/*.test.ts`에 template assertion을 추가한다. 픽스처는 `test/helpers.ts`의 `buildApp()` / `MODE_A_EDGE`(prod), `buildDevApp()`(dev), `buildCicdApp()`(cicd)를 재사용한다.
5. `npm test && npx cdk synth --all && npx cdk synth --all -c env=dev && npx cdk synth --all -c env=cicd` 통과를 확인한다.

### (H) 알려진 잔여 이슈 (여유가 있으면)

- **auth-proxy의 `enrollment` 스키마도 아무도 부트스트랩하지 않는다.** 아래 항목과 같은 문제다. 접속은 성공하고 첫 인증 요청에서 `relation "enrollment.telemetry_tokens" does not exist`로 깨진다. dev에서는 `publiclyAccessible` RDS에 `psql`로 직접 넣어 우회한다. (ADR-0023 Follow-up)
- **enrollment 서버(PROJ-43)가 dev 인프라에 없다.** 토큰 발급 주체가 없으므로 당분간 토큰을 손으로 넣어야 하고, 그쪽이 배포될 때 `TOKEN_HASH_SECRET`(`TokenHashSecretArn` 출력)을 같은 값으로 공유하는 방법을 확정해야 한다.
- **`:4318` 디버그 리스너는 인증 우회 경로다.** 의도적으로 남긴 것이지만 `devAllowedCidr` 기본값이 `0.0.0.0/0`이면 인증 없는 OTLP 수신구가 인터넷에 열린다. `infra:dev-open-ingress` 경고가 이를 함께 알린다.
- **RDS 조직 스키마를 아무도 부트스트랩하지 않는다.** `post-processor`는 ClickHouse DDL만 기동 시 멱등 적용하고(`ensure_schema`), PostgreSQL의 `company` / `department` / `employee` / `employee_department_assignment`는 compose의 `/docker-entrypoint-initdb.d` 마운트에 의존한다. ECS에는 그 메커니즘이 없다 → **접속은 성공하고 첫 조회에서 `relation "employee" does not exist`로 깨진다.** ADR-0018이 이 문제를 드러냈지만 해결하지는 않았다. 해결 주체는 위 (D)의 마이그레이션 ADR이다.
- `README.md`가 `cdk init` 보일러플레이트 그대로다. ADR-0007이 명시적으로 요구하는 **배포 런북이 어디에도 없다** (6장이 그 자리를 임시로 메우고 있다).
- **이 레포 자체의 빌드/테스트 CI가 없다.** GitHub Actions는 `pull_request_auto_fill.yml`과 `pull_request_auto_assign.yml` 둘뿐이고, `npm test` / `cdk synth`를 아무도 돌리지 않는다. ADR-0024가 만든 것은 **앱 레포**가 쓸 배포 역할이며 이 레포의 검증 CI와는 별개다 — 혼동하지 않는다.
- `EdgeStack` / `DevEdgeStack` 외에 `CfnOutput`이 없다. 앱 팀이 VPC ID / 클러스터 이름 등을 가져갈 SSM 파라미터 export가 없다.
- `.DS_Store`가 루트 / `.github/` / `docs/`에 존재한다.
- **`DevDashboardTask`를 bridge로 둔 것은 소스 미확보 상태의 추정이다.** `api-server`와 `batch-processor`가 서로를 localhost로 부르지 않는다고 단정할 수 없다. **배포 후 로그로 확인하고, 틀렸다면 awsvpc로 바꾼다** — 그 경우 인터넷 egress와 ECS Exec을 함께 잃는다. (ADR-0022 Follow-up)
- **awsvpc 태스크(collector/clickhouse)에 인터넷 egress가 없다.** 태스크 ENI에는 퍼블릭 IP가 붙지 않고(EC2 launch type에는 `assignPublicIp` 옵션 자체가 없다) NAT도 없다. 외부 API를 부르는 코드가 들어오면 **synth·test·deploy가 전부 통과하고 기동도 성공한 뒤 그 코드 경로에서만 타임아웃으로 죽는다.** (ADR-0022 5(a))
- **`devAllowedCidr` 기본값이 `0.0.0.0/0`이라 무인자 dev 배포는 인증 없는 Collector(4318), ClickHouse(8123), RDS(5432)를 인터넷에 공개한다.** ClickHouse `default` 유저는 비밀번호가 없고 `access_management=1`이므로 8123에 닿는 주체는 사실상 관리자다. synth 경고가 유일한 방어선이다. (ADR-0022 9번, ADR-0023 3번)
- **dev RDS와 운영 Aurora 둘 다 `StorageEncrypted`를 설정하지 않는다.** CFN 검증기가 경고를 낸다. 프로덕션 전환 시 `RemovalPolicy.DESTROY` 일괄 재검토와 함께 묶어서 다룬다.

---

## 6. 명령어

```bash
npm test              # jest (@swc/jest) — 13 스위트, 233 테스트
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

**ECR 레포를 먼저 만들고 이미지를 push해야 한다. 안 하면 첫 `cdk deploy`가 롤백된다.**

```bash
for repo in soma-376/post-processor soma-376/auth-proxy soma-376/api-server soma-376/batch-processor; do
  aws ecr create-repository --repository-name "$repo" --region ap-northeast-2
done
# 각 앱 레포에서 이미지 빌드 후 push → 그 다음에 cdk deploy
```

레포 이름은 `lib/common/config.ts`의 `ECR_REPOS`와 정확히 일치해야 한다. **앱 레포 CI의 push 대상도 같은 `soma-376/` 네임스페이스를 써야 한다** (ADR-0007). 이 레포에서 강제할 수 없는 규칙이므로 배포 전에 앱 레포 쪽에 전달한다.

**이 선행 절차는 dev에도 그대로 적용된다.** dev/prod가 **같은 ECR 레포를 공유**하고 태그로만 갈리므로(ADR-0021 5번) 레포는 한 번만 만들면 되지만, **dev는 `:dev`, prod는 `:prod` 태그를 읽으므로**(ADR-0024 7번) 그 태그에 이미지가 없으면 첫 배포가 같은 방식으로 실패한다. dev에서 태그를 갈아타려면 `-c devImageTag=<tag>`다.

기존 이미지를 새 태그로 옮겨 붙이려면 재빌드 없이 매니페스트만 다시 태깅하면 된다:

```bash
for repo in soma-376/post-processor soma-376/auth-proxy soma-376/api-server soma-376/batch-processor; do
  MANIFEST=$(aws ecr batch-get-image --repository-name "$repo" --image-ids imageTag=latest \
    --query 'images[0].imageManifest' --output text --region ap-northeast-2)
  aws ecr put-image --repository-name "$repo" --image-tag dev \
    --image-manifest "$MANIFEST" --region ap-northeast-2
done
# prod 는 --image-tag prod 로, auth-proxy 를 뺀 3개 레포에 대해 같은 절차를 돈다
```

**이미지는 반드시 `linux/arm64`로 빌드해야 한다** (ADR-0015). Fargate 태스크가 ARM64이고 **dev의 EC2 호스트도 t4g(Graviton) + ARM AMI**이므로, amd64 이미지를 올리면 양쪽 다 태스크가 기동하지 못한다.

```bash
# 앱 레포에서 — 플랫폼을 항상 명시한다
docker buildx build --platform linux/arm64 \
  -t <account>.dkr.ecr.ap-northeast-2.amazonaws.com/soma-376/api-server:<tag> \
  --push .
```

플랫폼을 생략하면 빌드 머신에 따라 결과가 갈린다. Apple Silicon에서는 arm64가, x86 CI 러너에서는 amd64가 나온다. 아키텍처 불일치는 `cdk synth`와 `npm test`로는 잡히지 않고(이미지 URI에 아키텍처가 없다) 태스크 기동 시점에 `image Manifest does not contain descriptor matching platform 'linux/arm64'`로만 드러난다. ECS가 이를 재시도하므로 배포가 실패로 끝나지 않고 길게 지연되는 형태가 된다.

이후 앱 배포는 CDK를 거치지 않는다:

```bash
aws ecs update-service --cluster soma-376-prod --service collector --force-new-deployment
aws ecs wait services-stable --cluster soma-376-prod --services collector
```

클러스터는 `soma-376-dev` / `soma-376-prod`, 서비스는 `collector` / `dashboard` / `auth-proxy`(dev 전용)다. 이름의 단일 출처는 `lib/common/deploy-targets.ts`이며, GitHub Actions가 이 명령을 돌릴 권한은 `DeployStack`의 배포 역할이 준다 (ADR-0024).

### 배포 역할 배포 (ADR-0024)

앱 인프라와 독립이라 언제든 따로 배포할 수 있다. **먼저 계정에 GitHub OIDC 공급자가 이미 있는지 확인한다** — URL당 하나뿐이라 중복 생성은 `EntityAlreadyExists`로 스택을 통째로 롤백시킨다.

```bash
aws iam list-open-id-connect-providers

# 없으면 그대로
npm run deploy:cicd

# 이미 있으면 그 ARN 을 넘겨 참조 모드로
npx cdk deploy --all -c env=cicd \
  -c githubOidcProviderArn=arn:aws:iam::<account>:oidc-provider/token.actions.githubusercontent.com

# 사후 확인 - 신뢰 정책의 sub 와 인라인 정책의 리소스 ARN 을 눈으로 본다
aws iam get-role --role-name github-deploy-ai-telemetry-pipeline-dev \
  --query 'Role.AssumeRolePolicyDocument'
aws iam list-role-policies --role-name github-deploy-ai-telemetry-pipeline-dev
```

배포 후 역할 ARN 4개는 `DeployStack`의 `CfnOutput`에 있다. 앱 레포에 넘길 값은 4장의 "앱 레포 배포 계약" 표가 전부다.

### ECS 물리 이름 도입 교체 런북 (ADR-0024)

`clusterName` / `serviceName`은 **교체 유발 속성**이다. 이미 배포된 스택에 이름을 추가하는 최초 1회에만 필요한 절차이며, 이후 배포는 평범한 업데이트다.

**in-place 업데이트를 시도하지 않는다.** ASG 런치 템플릿 user data에 클러스터 이름이 박혀 있어(`>> /etc/ecs/ecs.config`), 클러스터가 교체되면 새 클러스터에 컨테이너 인스턴스가 0대인 상태가 된다. EC2 launch type 서비스가 steady state에 도달하지 못해 CFN이 대기하다 실패하고, 등록된 인스턴스가 있는 구 클러스터는 삭제도 거부되어 `UPDATE_ROLLBACK_FAILED`로 갇히기 쉽다.

**파괴 범위는 `ApplicationStack` 하나로 끝난다.** 합성 매니페스트상 의존은 `ApplicationStack → EdgeStack`이고(ECS 서비스가 `Fn::GetStackOutput`으로 타깃 그룹을 참조한다) 크로스 스택 참조가 `weak`라 Export 잠금이 없다. 따라서 **ALB DNS 이름이 보존되고** `NetworkStack`·`DataStack`(VPC·RDS·시크릿)도 그대로다.

```bash
# ── dev 에서 먼저 리허설한다 ──────────────────────────────
# 0) :dev 태그 이미지를 먼저 올린다 (위 재태깅 스니펫). 없으면 재배포가 기동에서 죽는다.
npx cdk diff --all -c env=dev -c devAllowedCidr=<내 IP>/32   # Replacement 표시를 눈으로 확인
npx cdk destroy DevApplicationStack -c env=dev
npx cdk deploy  DevApplicationStack -c env=dev -c devAllowedCidr=<내 IP>/32

# 이름과 ARN 형식을 함께 확인한다. IAM 정책이 장문 ARN 을 전제하므로
# arn:...:service/soma-376-dev/collector 형태여야 한다.
aws ecs describe-services --cluster soma-376-dev \
  --services collector auth-proxy dashboard clickhouse --region ap-northeast-2 \
  --query 'services[].{name:serviceName,arn:serviceArn,running:runningCount}'

# ── prod (유지보수 창) ───────────────────────────────────
# :prod 태그 push 선행 → 그 다음
npx cdk diff --all
npx cdk destroy ApplicationStack
npx cdk deploy  ApplicationStack
aws elbv2 describe-target-health --target-group-arn <collector TG>
```

**함께 잃는 것**: ClickHouse `/data/clickhouse`(호스트 EBS와 함께 소멸 — ADR-0006이 수용한 리스크), 로그 그룹(`RemovalPolicy.DESTROY`), Cloud Map `obs.local` 네임스페이스(같은 이름으로 재생성). prod는 collector/dashboard/clickhouse가 파괴~기동 완료까지 내려가는 **계획된 전면 중단**이다.

네임스페이스 삭제가 걸리면 deregister되지 못한 Cloud Map 인스턴스가 남은 것이다 — `aws servicediscovery list-services` / `list-instances`로 확인하고 수동 deregister 후 재시도한다.

### dev 배포 런북 (ADR-0022)

**ADR-0017의 배포 전 게이트가 dev에도 그대로 적용된다.** dev가 운영과 **같은 `config/otel-collector.yaml`을 읽으므로**, collector config를 로컬 `docker run`으로 실제 기동해 `Everything is ready`를 확인하기 전에는 dev 배포도 하지 않는다. 정리할 때는 컨테이너 ID를 지목한다(`--filter ancestor=...`는 로컬 개발 컨테이너까지 지운다).

```bash
# dev 합성 — devAllowedCidr 를 안 주면 infra:dev-open-ingress 경고가 뜬다
npx cdk synth --all -c env=dev
npx cdk deploy --all -c env=dev -c devAllowedCidr=<내 IP>/32

# 스택 목록이 섞이지 않는지
npx cdk list                 # NetworkStack DataStack ApplicationStack EdgeStack
npx cdk list -c env=dev      # DevNetworkStack DevDataStack DevApplicationStack DevEdgeStack
```

배포 후 검증은 아래 경로를 각각 밟는다. 엔드포인트는 `DevEdgeStack`의 `CfnOutput`(`AlbDnsName`, `OtlpEndpoint`, `OtlpDebugEndpoint`, `ApiEndpoint`, `ClickhouseDebugUrl`, `RdsEndpoint`, `RdsSecretArn`, `TokenHashSecretArn`)에서 가져온다.

**선행 조건 — `enrollment` 스키마를 먼저 넣어야 한다.** auth-proxy는 `enrollment.telemetry_tokens` / `installations` / `members` / `tenants`를 조회하는데 아무도 이를 부트스트랩하지 않는다(5장 (H)). 스키마가 없으면 접속은 성공하고 첫 인증에서 `relation "enrollment.telemetry_tokens" does not exist`로 깨진다. 아래 4)의 `psql`로 직접 넣는다.

```bash
# 1) 인증 — 토큰 없이 던지면 401 이어야 한다. 이게 ADR-0023 의 목적이다
curl -i -X POST "http://<alb-dns>/v1/traces" \
  -H 'Content-Type: application/json' -d '{"resourceSpans":[]}'

# 2) OTLP 파이프라인 — ALB :80 /v1/* → auth-proxy → collector.obs.local:4318
#    → localhost:8080 → post-processor
curl -i -X POST "http://<alb-dns>/v1/traces" -H "Authorization: Bearer <token>" \
  -H 'Content-Type: application/json' -d '{"resourceSpans":[]}'
aws logs tail /ecs/dev/auth-proxy --follow --region ap-northeast-2
aws logs tail /ecs/dev/post-processor --follow --region ap-northeast-2

# 2-1) 인증을 건너뛰고 collector 만 검증 — :4318 디버그 리스너 (ADR-0023 3번)
curl -i -X POST "http://<alb-dns>:4318/v1/traces" \
  -H 'Content-Type: application/json' -d '{"resourceSpans":[]}'

# 3) ClickHouse 직접 쿼리 — ALB :8123 리스너 (EC2 퍼블릭 IP는 인스턴스 교체마다 바뀐다)
curl "http://<alb-dns>:8123/?query=SELECT%201"

# 4) RDS 직접 접속 — publiclyAccessible + devAllowedCidr 가 이걸 위한 구성이다
psql "host=<rds-endpoint> port=5432 dbname=controlplane user=postgres sslmode=require"

# 5) 컨테이너 진입 — 호스트 SSM 후 docker
aws ssm start-session --target <instance-id> --region ap-northeast-2
sudo docker ps
sudo docker exec -it <container-id> /bin/sh
```

**auth-proxy가 401 대신 502/503을 준다면** Collector 도달 실패를 먼저 의심한다 — ALB 헬스체크는 `/health`만 보므로 타깃은 계속 healthy로 남는다. `docker exec`으로 들어가 `collector.obs.local`이 A 레코드로 풀리는지, `DevCollectorSg` ← `DevAppHostSg` : 4318 룰이 살아 있는지 확인한다.

### 운영자 접속 (ADR-0016)

SSH 인그레스도 키페어도 없다. 접속은 전부 SSM 채널을 쓴다. **환경에 따라 수단이 갈린다.**

| 환경 / 대상 | 수단 | 필요한 운영자 IAM 권한 |
|---|---|---|
| prod `clickhouse` (EC2) | `aws ssm start-session` | `ssm:StartSession` |
| prod `post-processor`, `api-server` (Fargate) | `aws ecs execute-command` | `ecs:ExecuteCommand` |
| **dev — 전 컨테이너** | 호스트 `aws ssm start-session` + `sudo docker exec` | `ssm:StartSession` |

**dev에는 ECS Exec이 없다.** 네 서비스 모두 `enableExecuteCommand`를 켜지 않았고, 켜도 awsvpc 태스크(collector/clickhouse)는 `ssmmessages` 엔드포인트에 도달할 경로가 없어 동작하지 않는다. **이건 결함이 아니라 티켓의 전제다** — 호스트에 SSM으로 붙으면 네트워크 모드와 무관하게 **모든** 컨테이너에 `docker exec`으로 들어갈 수 있고, `docker logs`·`docker inspect`·호스트에서의 `curl`까지 열린다 (ADR-0022 5(b), ADR-0016).

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

테스트는 `test/prod/`(6 스위트), `test/dev/`(5 스위트), `test/cicd/`(2 스위트)로 나뉘고, 픽스처 `helpers.ts`만 루트에 둔다.

- `aws-cdk-lib/assertions` 기반 **template assertion만** 쓴다. 스냅샷 테스트는 쓰지 않는다.
  - 예외: `lib/common/config.ts`의 **순수 함수**(예: `buildLibpqDsn`)와 `lib/dev/config.ts`의 `loadDevConfig` 파싱 로직은 CDK 리소스를 만들지 않으므로 `test/prod/config.test.ts` / `test/dev/config.test.ts`에서 일반 단위 테스트로 검증한다. 스택을 합성하는 테스트는 여전히 template assertion만 쓴다.
- **`new App()`을 직접 쓰지 말고 `test/helpers.ts`의 `buildApp()`(prod) / `buildDevApp()`(dev) / `buildCicdApp()`(cicd)을 쓴다.**
  bare `App`은 `cdk.json`의 피처 플래그를 읽지 않아 CLI synth와 산출물이 달라진다 (예: ASG가 `LaunchTemplate` 대신 `LaunchConfiguration`을 생성). **dev도 ASG를 쓰므로 같은 함정이 그대로 적용된다** — `test/dev/application-stack.test.ts`가 `LaunchConfiguration` 0개를 어서션한다.
  두 팩토리 모두 진입점과 **같은 `synthProd` / `synthDev`를 거치므로** 픽스처 조립과 실제 배포 조립이 갈라질 수 없다 (ADR-0021 1번).
- 모드 A 테스트는 `MODE_A_EDGE`를, 모드 B는 인자 없이 기본값을 쓴다. dev context 키는 `buildDevApp({ devAllowedCidr: '203.0.113.10/32' })`처럼 객체로 주입한다 — CLI의 `-c key=value`와 같은 자리다.
- 고정 env는 `TEST_ENV = { account: '111111111111', region: 'ap-northeast-2' }`다.

**dev 테스트가 고정하는 핵심 계약** — 전부 "synth·test·deploy는 통과하고 런타임에만 죽는" 종류라 어서션이 유일한 방어선이다.

| 계약 | 스위트 |
|---|---|
| 태스크 `NetworkMode` 4종 (awsvpc / bridge / bridge / awsvpc) | `test/dev/application-stack.test.ts` |
| 리스너 `open: false` — 좁힌 CIDR 옆에 `0.0.0.0/0` 인그레스가 남지 않는다 | `test/dev/network-stack.test.ts` |
| 로그 그룹 6개의 `/ecs/dev/` 접두 (그리고 운영 이름을 하나도 쓰지 않음) | `test/dev/application-stack.test.ts` |
| 자동 생성 비밀번호의 `ExcludeCharacters` (따옴표 없는 libpq DSN **과 URI** 의 전제) | `test/dev/data-stack.test.ts` |
| auth-proxy가 읽는 환경변수·시크릿 이름 4개와 `COLLECTOR_BASE_URL` 값 | `test/dev/application-stack.test.ts` |
| collector 서비스의 Cloud Map **A** 레코드 등록 | `test/dev/application-stack.test.ts` |
| `DevCollectorSg` ← `DevAppHostSg` : 4318 (bridge auth-proxy의 유일한 통로) | `test/dev/network-stack.test.ts` |
| `/v1/*`가 auth-proxy TG로, `:4318`이 collector TG로 간다 | `test/dev/edge-stack.test.ts` |
| auth-proxy URI DSN의 `uselibpqcompat=true` (없으면 TLS 검증이 켜져 접속 실패) | `test/dev/data-stack.test.ts` |

**cicd 테스트가 고정하는 핵심 계약** — 전부 "배포는 전부 성공하고 GitHub Actions만 죽는" 종류다. IAM은 리소스 ARN의 실존을 검증하지 않으므로 어서션이 유일한 방어선이다.

| 계약 | 왜 |
|---|---|
| 신뢰 조건 `sub`가 브랜치까지 `StringEquals` 완전 일치 | `StringLike` + `*`로 "완화"하면 PR 헤드 브랜치가 운영 역할을 가져간다 |
| **교차 환경 부정** — dev 역할에 `soma-376-prod`가 없고 그 반대도 | 역할을 환경별로 나눈 이유 자체 |
| **교차 레포 부정** — 파이프라인 역할에 `api-server`/`batch-processor`가 없고 그 반대도 | 한 팀이 다른 팀 이미지를 밀 수 있으면 레포별 분리가 무의미 |
| prod 파이프라인 역할에 `auth-proxy`가 없음 | 운영에 없는 서비스 = 죽은 계약 (ADR-0023) |
| `iam:PassRole` / `ecs:RegisterTaskDefinition` 부재, `*`로 끝나는 액션 부재 | 권한 상승 경로 차단 |
| `Resource: '*'`인 statement가 `GetAuthorizationToken` 하나뿐 | 그 statement에 다른 액션이 얹히면 계정 전역이 된다 |
| **IAM 서비스 ARN ↔ 실제 `ClusterName`/`ServiceName` 교차 검증** | `deploy-targets.ts`와 application-stack이 갈라지는 것을 잡는 유일한 지점 |
| `ThumbprintList` 부재, OIDC 공급자 `Retain`, Lambda 0개 | 인증서 회전 사고 / 신뢰 앵커 유실 / 커스텀 리소스 회귀 |

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
- 커밋 / PR 제목: `<KEY> <type>: <summary>` — 예) `PROJ-22 docs: 핸드오프 문서 추가`
- PR 대상 브랜치는 `develop`이다. `.github/workflows/pull_request_auto_fill.yml`이 브랜치명에서 Jira 키를 파싱해 제목을 재작성하고 본문에 링크를 넣는다. (`feature`는 `feat`으로 정규화된다.)
- **현재 브랜치명(`PROJ-37-development-environment`)은 위 규칙에 맞지 않는다.** 타입 접두사가 없어 `pull_request_auto_fill.yml`의 Jira 키 파싱이 실패한다. PR을 올리기 전에 `feat/PROJ-37-...` 형태로 정리하거나, 워크플로가 제목을 재작성하지 못한다는 점을 감안한다. (브랜치가 origin보다 얼마나 앞서는지는 금방 낡으므로 여기 적지 않는다 — `git log --oneline origin/main..HEAD`로 확인한다.)
- 문서와 코드 주석은 한국어로 작성한다.
