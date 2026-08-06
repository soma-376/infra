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

- ADR-0009에 따라 **인프라는 이 레포에서만 관리한다.** 앱 레포(Collector & Processor, Dashboard Backend)의 CI는 이미지 빌드 → ECR push → `ecs update-service --force-new-deployment` 까지만 수행한다. 앱 배포가 `cdk deploy`를 유발하지 않는다.
- 태스크 정의를 바꾸려면 **반드시 이 레포를 경유**해야 한다.
- 대상 region은 **`ap-northeast-2`**다. account는 `CDK_DEFAULT_ACCOUNT`에서만 주입하며 코드와 문서에 기록하지 않는다.
- 설계 근거는 전부 `docs/adr/`에 있다. 코드와 ADR이 어긋나면 ADR이 기준이다.

---

## 2. 스택 구조와 의존 방향

스택은 4개다. 의존 관계는 **`bin/infra.ts`에서 construct 참조를 props로 넘기는 방식**으로만 표현한다. 수동 `Fn::ImportValue`나 SSM 우회 참조를 새로 도입하지 않는다.

```
NetworkStack ──> DataStack ──┐
     │                       ├──> ApplicationStack ──> EdgeStack
     └───────────────────────┘
```

| 스택 | 파일 | 주요 리소스 |
|---|---|---|
| `NetworkStack` | `lib/network-stack.ts` | VPC (2 AZ × 3 티어 = 6 서브넷, NAT 1개), S3 Gateway Endpoint, **SG 5개 전부 + 모든 cross-SG 룰** |
| `DataStack` | `lib/data-stack.ts` | Aurora Serverless v2 PostgreSQL 16.13 (`controlplane` DB, 0.5~2 ACU), Raw Signal S3 버킷 (30일 만료) |
| `ApplicationStack` | `lib/application-stack.ts` | ECS 클러스터, Cloud Map `obs.local`, Fargate 서비스 2개, ClickHouse EC2 (t4g.small + ASG 캐패시티 프로바이더) |
| `EdgeStack` | `lib/edge-stack.ts` | ALB (모드 A/B 분기), Cognito User Pool, CloudFront + 프론트엔드 S3 |

**서비스 구성** (ADR-0004: 태스크 단위 co-location)

| 태스크 | 컨테이너 | 비고 |
|---|---|---|
| `CollectorTask` (Fargate **ARM64**, 512/1024) | `otel-collector` (public image, :4318), `post-processor` (ECR) | |
| `DashboardTask` (Fargate **ARM64**, 512/2048) | `api-server` (ECR, :8080), `batch-processor` (ECR) | Spring Boot 고려. Fargate는 CPU/메모리 조합이 고정이라 512 CPU에는 1024/2048/3072/4096만 쓸 수 있다 (1536은 생성 실패) |
| `ClickhouseTask` (EC2, awsvpc) | `clickhouse` (public image, :8123/:9000) | 호스트 볼륨 `/data/clickhouse` |

---

## 3. 반드시 지켜야 할 불변 규칙

아래는 "개선"처럼 보여서 되돌리기 쉽지만, 되돌리면 실제로 깨지는 것들이다. 바꾸려면 먼저 ADR을 쓴다.

| 규칙 | 왜 |
|---|---|
| **SG 5개와 모든 cross-SG 룰은 `NetworkStack`에만 정의한다** | SG 참조가 스택 내부 참조가 되어 스택 간 순환 의존을 원천 차단한다. 하류 스택은 props로 주입만 받는다. (`lib/network-stack.ts:13-18` 헤더 주석) |
| **ECR 레포를 CDK로 만들지 않는다** | `Repository.fromRepositoryName`으로 참조만 한다. CDK가 만들면 첫 배포에서 "이미지 없는 레포" → 태스크 기동 실패 → 롤백으로 레포까지 삭제되는 순환이 생긴다. (ADR-0007) |
| **ECR 레포 이름은 `soma-376/` 네임스페이스 아래에 둔다** | 네임스페이스는 `COMMON_TAGS.Org`와 같은 값이다. 비용 배분 태그 축과 레지스트리 경로를 같은 식별자로 정렬한다. ECR은 레포 이름 변경이 불가능해 사후 교정에 재생성 + 이미지 재push가 든다. (`lib/config.ts`의 `ECR_NAMESPACE`, ADR-0007) |
| **`batch-processor`는 `essential: false`** | 배치 실패가 같은 태스크의 api-server를 함께 내리면 안 된다. (`lib/application-stack.ts:201`, ADR-0004) |
| **ClickHouse `Ec2Service`는 `minHealthyPercent: 0` / `maxHealthyPercent: 100`** | 인스턴스 1대 + awsvpc ENI 한도상 롤링 배포가 불가능하다. 강제 교체 배포만 가능하다. (`lib/application-stack.ts:306-307`) |
| **`AsgCapacityProvider`의 `enableManagedTerminationProtection: false`** | 단일 인스턴스 교체 배포를 관리형 종료 보호가 막는다. (`lib/application-stack.ts:258`) |
| **DB 시크릿은 참조만 노출한다** | `data.dbSecret`(`ISecret`)을 넘길 뿐, 값을 읽는 코드는 절대 넣지 않는다. 컨테이너에는 `Secret.fromSecretsManager`로 주입한다. (`lib/data-stack.ts`) |
| **Fargate 태스크는 ARM64로 고정한다** | `runtimePlatform`을 빼면 CDK 기본값(미지정)으로 돌아가 x86_64가 된다. 앱 레포도 반드시 `linux/arm64` 이미지를 push해야 하며, amd64를 올리면 synth와 테스트는 통과하지만 런타임에 이미지 pull이 실패한다. ClickHouse EC2(t4g)와 아키텍처를 맞추고 x86 대비 약 20% 저렴하다. (`lib/application-stack.ts`의 `FARGATE_RUNTIME_PLATFORM`, ADR-0015) |
| **Collector 설정은 `config/otel-collector.yaml`에만 둔다** | synth 시점에 파일을 읽어 `OTEL_CONFIG` 환경변수로 주입하고 `--config=env:OTEL_CONFIG`로 기동한다. 파일 경로·환경변수 이름·`command` 세 가지는 한 몸이라 함께 바꿔야 한다. **이 값은 CFN 템플릿과 ECS 콘솔에 평문으로 남으므로 시크릿을 넣으면 안 된다.** (`lib/application-stack.ts`의 `COLLECTOR_CONFIG_PATH`, ADR-0017) |
| **`otel-collector` 컨테이너는 root(`user: '0'`)로 돈다** | 이미지가 `User=10001:10001`인데 UID 10001이 쓸 수 있는 디렉터리가 하나도 없다(scratch 기반이라 `/tmp`도 없다). `file/*` exporter가 `/data`를 만들려면 root가 필요하다. 빼면 `mkdir /data: permission denied`로 기동 직후 exit 1이다. **file exporter와 `user: '0'`은 한 몸이라 함께 없애야 한다** — 이 커플링은 `test/application-stack.test.ts`가 고정한다. `awss3` exporter로 옮기면 root가 필요 없어진다. (ADR-0017) |
| **Collector config는 배포 전 실제로 기동해 봐야 한다** | `cdk synth`·`npm test`는 config를 문자열로만 다루고, `otelcol-contrib validate`조차 컴포넌트를 **해석만** 하고 start하지 않아 파일시스템·권한 실패를 못 잡는다. 최초 배포가 정확히 이 틈으로 빠져나가 죽었다. 관문은 `docker run -d --user 0:0 -e OTEL_CONFIG="$(cat config/otel-collector.yaml)" ... --config=env:OTEL_CONFIG` 후 로그에 `Everything is ready`가 뜨는지 확인하는 것이다. **정리는 컨테이너 ID를 지목한다. `--filter ancestor=...`를 쓰면 같은 이미지를 쓰는 로컬 개발 컨테이너까지 지운다.** (ADR-0017) |
| **DB 이름은 PostgreSQL 키워드 표에 없는 단어여야 한다** | RDS는 `DatabaseName`에 엔진 예약어 검사를 걸고, 그 목록이 PostgreSQL의 reserved 키워드보다 넓다. 실제로 `control`은 non-reserved인데도 400으로 거부됐다. 되돌리면 배포가 통째로 실패한다. (`lib/config.ts`의 `CONTROL_DB_NAME`, ADR-0012) |
| **`maxAzs: 2`는 이중화가 아니라 의도된 하한이다** | 진짜 단일 AZ는 Aurora `DatabaseCluster`(서브넷 ≥2 요구)와 internet-facing ALB(퍼블릭 서브넷 2개 요구)가 막는다. 컴퓨트/데이터는 여전히 사실상 단일 AZ다. (`lib/network-stack.ts:34-35`, ADR-0011) |
| **`RemovalPolicy.DESTROY` / `autoDeleteObjects`는 MVP 한정 의도다** | 실수가 아니다. 프로덕션 전환 시 일괄 재검토 대상이므로, 개별적으로 `RETAIN`으로 바꾸지 말고 ADR로 묶어서 처리한다. |

---

## 4. 설정과 환경 분기

- 계정/리전은 `CDK_DEFAULT_ACCOUNT` / `CDK_DEFAULT_REGION`에서만 온다. 코드에 하드코딩된 계정은 없다.
- `cdk.context.json`은 계정별 조회 결과가 기록되는 로컬 캐시이므로 commit하지 않는다.
- 배포별 가변값은 **CDK context 키 3개뿐**이다: `certificateArn`, `domainName`, `cognitoDomainPrefix` (`lib/config.ts`의 `loadConfig`).
- 공유 상수(`PORTS`, `CLICKHOUSE_HOST`, `SUBNET_GROUP`, `ECR_NAMESPACE`, `ECR_REPOS`, `CONTROL_DB_NAME`, `COMMON_TAGS`)는 **전부 `lib/config.ts`에 있다.** 스택에 리터럴을 새로 박지 말고 여기서 import 한다. 새 상수도 여기에 추가한다.
- 공통 태그 `{ Org: 'soma-376', Env: 'mvp', ManagedBy: 'cdk' }`는 App 스코프에 `applyCommonTags(app)`로 한 번만 적용한다. 스택별로 중복 호출하지 않는다.
- **dev/stg/prod 환경 분리 메커니즘은 없다.** 스택 ID는 리터럴이고 `Env: 'mvp'`는 하드코딩이다. 환경 분리가 필요해지면 그건 새 ADR 대상이다.

### 컨테이너 DB 접속 계약 (앱 레포와의 인터페이스)

DB 접속에 필요한 값은 **두 경로로 나뉘어** 전달된다. 앱은 어느 쪽도 하드코딩하지 않는다.

| 값 | 전달 경로 | 대상 컨테이너 |
|---|---|---|
| host, port, engine, username, password, dbClusterIdentifier | 시크릿 `DB_CREDS` (JSON) | `api-server`, `post-processor` |
| 데이터베이스 이름 | 환경변수 `DB_NAME` | `api-server`, `post-processor` |

**`DB_CREDS`에 `dbname` 키는 없다.** CDK `DatabaseCluster`가 자동 생성하는 시크릿은 `defaultDatabaseName`을 시크릿에 넣지 않기 때문이다. 그래서 DB 이름만 `DB_NAME` 환경변수로 따로 준다. 시크릿에서 `dbname`을 읽으려 하면 `undefined`가 나온다.

`batch-processor`, `otel-collector`, `clickhouse`에는 둘 다 주입하지 않는다. 주입 범위는 `test/application-stack.test.ts`가 양쪽(주입 대상 / 비대상) 모두 검증한다.

`otel-collector`가 받는 환경변수는 `OTEL_CONFIG` 하나뿐이며, 이것은 DB 자격증명이 아니라 collector 설정 본문이다. 아래 표를 참고한다.

| 값 | 전달 경로 | 대상 컨테이너 |
|---|---|---|
| collector 설정 YAML 전문 | 환경변수 `OTEL_CONFIG` (+ `--config=env:OTEL_CONFIG`) | `otel-collector` |

### EdgeStack 모드 A / B

`lib/edge-stack.ts`의 `const isHttps = Boolean(props.edge.certificateArn)` 한 줄이 전체 분기를 결정한다.

| | 모드 A (`-c certificateArn=...` 제공) | 모드 B (기본값) |
|---|---|---|
| 리스너 | 443 HTTPS + 80 → 443 리다이렉트 | 80 HTTP |
| `/v1/*` (OTLP) | `ListenerAction.authenticateJwt` → collector TG | 인증 없이 forward |
| `/api/*` | `AuthenticateCognitoAction` → dashboard TG | 인증 없이 forward |
| 기본 액션 | fixed response 404 | fixed response 404 |
| 기타 | — | synth 시 ADR-0008 폴백 경고 방출 |

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
- **문서 정정이 필요하다.** ADR-0008 Constraints의 마지막 항목 — *"jwt-validation은 비교적 최신 ALB 기능이라 CDK L2 construct에서 아직 지원하지 않을 수 있다. 이 경우 `CfnListenerRule`(L1)로 직접 정의해야 한다"* — 은 이미 무효다. `aws-cdk-lib ^2.261.0`의 L2 `ListenerAction.authenticateJwt`로 구현되어 있다 (`lib/edge-stack.ts`). 이 문장은 삭제한다.

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

### (F) ADR-0018 — 로그 그룹 정책 기록

현재 `ApplicationStack`은 컨테이너별 CloudWatch Logs 로그 그룹 5개를 만들고,
보존 기간을 14일, 삭제 정책을 `RemovalPolicy.DESTROY`로 설정한다. 이 구성은
구현되어 있지만 운영·비용·보안 관점의 결정 근거가 ADR에 없다.

인프라 코드를 변경하기 전에 ADR-0018에서 다음 항목을 결정한다.

- 컨테이너별 로그 그룹을 유지할지 서비스 단위로 통합할지와 로그 그룹 명명 규칙
- 14일 보존 기간의 트래픽·장애 조사·비용 근거와 환경별 보존 기간 필요 여부
- MVP의 `RemovalPolicy.DESTROY`를 프로덕션에서도 유지할지와 전환 조건
- AWS 관리형 암호화 또는 customer managed KMS key 사용 여부와 로그 접근 권한
- 장기 보관·감사 요구가 생길 때 S3 등으로 내보내는 방식과 알람·운영 조회 책임
- 비용 또는 규제 요구가 바뀔 때 정책을 재검토할 조건

ADR이 확정되기 전에는 현재 로그 그룹 구성을 운영 환경의 최종 정책으로 간주하지 않는다.

### (G) 인프라 코드를 추가/수정할 때의 순서

1. 기존 ADR에 걸리는지 먼저 확인한다. 걸리면 **코드보다 ADR을 먼저** 처리한다.
2. 새 결정이면 ADR을 **먼저** 쓰고 `docs/adr/README.md` 인덱스 표에 추가한다. 번호는 다음 미사용 번호(`0018`)를 쓴다.
   템플릿: `Status` / `Context` / `Decision` / `Alternatives Considered` / `Consequences` (+ 필요 시 `Constraints`, `Open Questions`, `Revisit Trigger`).
3. 상수는 `lib/config.ts`에 추가하고 스택에서 import 한다.
4. `test/*.test.ts`에 template assertion을 추가한다. 픽스처는 `test/helpers.ts`의 `buildApp()` / `MODE_A_EDGE`를 재사용한다.
5. `npm test && npx cdk synth` 통과를 확인한다.

### (H) 알려진 잔여 이슈 (여유가 있으면)

- `bin/infra.ts:1` shebang이 `#!/opt/homebrew/opt/node/bin/node` — 로컬 Homebrew 경로 하드코딩. `cdk.json`이 `npx tsx`로 실행하므로 동작에는 무해하지만 비포터블하다.
- `README.md`가 `cdk init` 보일러플레이트 그대로다. ADR-0007이 명시적으로 요구하는 **배포 런북이 어디에도 없다.**
- 빌드/테스트 CI가 없다. GitHub Actions는 PR 제목 자동 채우기와 assignee 지정뿐이고, `npm test` / `cdk synth`를 아무도 돌리지 않는다.
- `EdgeStack` 외에 `CfnOutput`이 없다. 앱 팀이 VPC ID / 클러스터 이름 등을 가져갈 SSM 파라미터 export가 없다.
- `.DS_Store`가 루트 / `.github/` / `docs/`에 존재한다.

---

## 6. 명령어

```bash
npm test              # jest (@swc/jest) — 5 스위트, 41 테스트
npm run build         # tsc --noEmit (순수 타입 체크, 산출물 없음)
npx cdk synth         # cdk.json: `npx tsc && npx tsx bin/infra.ts`
npx cdk diff
npx cdk deploy --all

# 모드 A(HTTPS + ALB 인증)로 synth
npx cdk synth -c certificateArn=arn:aws:acm:ap-northeast-2:<account>:certificate/<id> \
              -c domainName=example.com
```

### 배포 전 필수 선행 절차 (ADR-0007)

**ECR 레포를 먼저 만들고 이미지를 push해야 한다. 안 하면 첫 `cdk deploy`가 롤백된다.**

```bash
for repo in soma-376/post-processor soma-376/api-server soma-376/batch-processor; do
  aws ecr create-repository --repository-name "$repo" --region ap-northeast-2
done
# 각 앱 레포에서 이미지 빌드 후 push → 그 다음에 cdk deploy
```

레포 이름은 `lib/config.ts`의 `ECR_REPOS`와 정확히 일치해야 한다. **앱 레포 CI의 push 대상도 같은 `soma-376/` 네임스페이스를 써야 한다** (ADR-0007). 이 레포에서 강제할 수 없는 규칙이므로 배포 전에 앱 레포 쪽에 전달한다.

**이미지는 반드시 `linux/arm64`로 빌드해야 한다** (ADR-0015). Fargate 태스크가 ARM64이므로 amd64 이미지를 올리면 태스크가 기동하지 못한다.

```bash
# 앱 레포에서 — 플랫폼을 항상 명시한다
docker buildx build --platform linux/arm64 \
  -t <account>.dkr.ecr.ap-northeast-2.amazonaws.com/soma-376/api-server:<tag> \
  --push .
```

플랫폼을 생략하면 빌드 머신에 따라 결과가 갈린다. Apple Silicon에서는 arm64가, x86 CI 러너에서는 amd64가 나온다. 아키텍처 불일치는 `cdk synth`와 `npm test`로는 잡히지 않고(이미지 URI에 아키텍처가 없다) 태스크 기동 시점에 `image Manifest does not contain descriptor matching platform 'linux/arm64'`로만 드러난다. ECS가 이를 재시도하므로 배포가 실패로 끝나지 않고 길게 지연되는 형태가 된다.

이후 앱 배포는 CDK를 거치지 않는다:

```bash
aws ecs update-service --cluster <cluster> --service <service> --force-new-deployment
```

### 운영자 접속 (ADR-0016)

SSH 인그레스도 키페어도 없다. 접속은 전부 SSM 채널을 쓴다. 실행 환경에 따라 수단이 갈린다.

| 대상 | 수단 | 필요한 운영자 IAM 권한 |
|---|---|---|
| `clickhouse` (EC2) | `aws ssm start-session` | `ssm:StartSession` |
| `post-processor`, `api-server` (Fargate) | `aws ecs execute-command` | `ecs:ExecuteCommand` |

두 방식 모두 로컬에 **Session Manager plugin**이 설치되어 있어야 한다. 없으면 명령 자체가 실패한다.

#### ClickHouse EC2

```bash
# 인스턴스 ID 조회
aws ec2 describe-instances --region ap-northeast-2 \
  --filters "Name=tag:Org,Values=soma-376" "Name=instance-state-name,Values=running" \
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

---

## 7. 테스트 작성 규칙

- `aws-cdk-lib/assertions` 기반 **template assertion만** 쓴다. 스냅샷 테스트는 쓰지 않는다.
- **`new App()`을 직접 쓰지 말고 `test/helpers.ts`의 `buildApp()`을 쓴다.**
  bare `App`은 `cdk.json`의 피처 플래그를 읽지 않아 CLI synth와 산출물이 달라진다 (예: ASG가 `LaunchTemplate` 대신 `LaunchConfiguration`을 생성). `buildApp()`이 context 주입과 `applyCommonTags()`를 대신 처리한다.
- 모드 A 테스트는 `MODE_A_EDGE`를, 모드 B는 인자 없이 기본값을 쓴다.
- 고정 env는 `TEST_ENV = { account: '111111111111', region: 'ap-northeast-2' }`다.

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
- 현재 브랜치 `feature/PROJ-22-mvp-infrastructure`는 `origin/main` · `origin/develop`보다 **4커밋 앞서 있고 아직 push되지 않았다.**
- 문서와 코드 주석은 한국어로 작성한다.
