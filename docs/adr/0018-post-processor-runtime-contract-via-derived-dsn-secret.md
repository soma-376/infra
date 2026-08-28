# 0018. post-processor 런타임 계약을 앱 환경변수에 맞추고 PG DSN을 파생 시크릿으로 주입

## Status

Accepted

## Context

`ApplicationStack`이 `post-processor` 컨테이너에 넣던 환경변수와, 앱
(`ai-telemetry-pipeline`)이 실제로 읽는 환경변수의 **교집합이 0이었다.**

| 인프라가 주입 (`lib/prod/application-stack.ts`) | 앱이 읽는 것 |
|---|---|
| `CLICKHOUSE_HOST` = `clickhouse.obs.local` | — |
| `RAW_BUCKET` = 버킷 이름 | — |
| `DB_NAME` = `controlplane` | — |
| 시크릿 `DB_CREDS` = Aurora 마스터 시크릿 JSON | — |
| — | `ENRICHMENT_CH_URL` (`apps/telemetry-processor/enrichment/sink_clickhouse.py:44`) |
| — | `ENRICHMENT_CH_DB` (`apps/telemetry-processor/enrichment/sink_clickhouse.py:48`) |
| — | `ENRICHMENT_PG_DSN` (`apps/telemetry-processor/enrichment/providers/org.py:33`) |

앱은 `os.environ.get(name, DEFAULT)` 형태로만 읽지만 **폴백 거동이 둘로 갈린다.**
`ENRICHMENT_CH_URL`·`ENRICHMENT_CH_DB` 는 이름이 없으면 예외 없이 in-code 기본값
(`http://clickhouse:8123` · `default`)으로 **조용히 폴백**한다. 반면 `ENRICHMENT_PG_DSN` 의
in-code 기본값은 **빈 문자열**이라 폴백이 아니라 org provider 조회 시점의 **즉시 연결 실패**다
(compose 의 `host=postgres … dbname=enrichment` DSN 은 `docker-compose.dev.yml` 이 주입하는
값이지 앱의 폴백이 아니다). 장애 증상도 다르다 — ClickHouse 쪽은 "컨테이너는 RUNNING 인데
모든 적재가 503", PG 쪽은 조회 시점의 연결 예외다.
ECS 태스크 안에는 `clickhouse`도 `postgres`도 없다. ClickHouse 쪽 결과는 이렇게 이어진다.

1. 기동 시 `ensure_schema()`가 ClickHouse에 닿지 못해 5회 재시도 후 포기한다
   (`apps/telemetry-processor/otlp_receiver.py`). 이건 non-fatal이라 **컨테이너는 정상으로 보인다.**
2. 이후 들어오는 모든 push가 `BackendUnavailable` → **HTTP 503**.
3. collector의 `otlphttp` exporter는 503을 재시도 대상으로 보고 무한히 다시 보낸다.

즉 배포된 `post-processor`는 기능이 0인 채로 살아 있었다. ECS 서비스는 RUNNING이고,
ALB 타깃도 healthy고(애초에 `post-processor`는 타깃 그룹에 없다), 로그에는 503만 쌓인다.

**이 장애가 `cdk synth`·`npm test`·`cdk deploy`를 전부 통과한 이유**는 구조적이다.
인프라 테스트는 "값을 넣었는가"만 검사할 수 있고 "앱이 그 이름을 읽는가"는
**원리적으로 검사할 수 없다.** 앱 소스가 다른 레포에 있기 때문이다
([ADR-0009](0009-single-infra-repo-stack-boundary.md)). 합성 산출물은 완전히 옳았고
런타임 계약만 틀렸다 — [ADR-0017](0017-inject-collector-config-via-env-provider.md)에서
`otelcol validate`가 `mkdir /data: permission denied`를 못 잡은 것과 같은 계열의 틈이다.

이 결정을 지금 내리는 이유는, 이름만 맞추는 것으로 끝나지 않기 때문이다.
`ENRICHMENT_PG_DSN`은 host·user·password를 **하나의 문자열 안에 품은 단일 값**이라,
주입 경로를 함께 정하지 않으면 DB 비밀번호가 태스크 정의에 평문으로 박힌다.

## Decision

네 가지를 함께 결정한다.

**1. 대상은 `post-processor` 하나뿐이다.**

`batch-processor`(`CLICKHOUSE_HOST`)와 `api-server`(`DB_CREDS`/`DB_NAME`)는 소스 코드를
확보하지 못했다. 실제로 무엇을 읽는지 모르는 채로 함께 "정리"하면 멀쩡한 계약을 깨뜨린다.
`post-processor`를 고쳤다는 이유만으로 나머지를 건드리지 않는다.

**2. 환경변수 이름을 앱에 맞춘다.**

```ts
environment: {
  ENRICHMENT_CH_URL: CLICKHOUSE_HTTP_URL,   // http://clickhouse.obs.local:8123
  ENRICHMENT_CH_DB:  CLICKHOUSE_DEFAULT_DB, // default
  RAW_BUCKET:        props.rawSignalBucket.bucketName,
},
```

`CLICKHOUSE_HTTP_URL`은 `CLICKHOUSE_HOST`(Cloud Map A레코드,
[ADR-0005](0005-cloud-map-private-dns-discovery.md))와 `PORTS.clickhouseHttp`에서 조립한다.
`CLICKHOUSE_HOST`가 호스트명만 담고 포트도 스킴도 없었던 것이 이 불일치의 절반이다.

`RAW_BUCKET`은 **앱이 읽지 않지만 의도적으로 남긴다.** ADR-0017이 예고한 collector의
`awss3` exporter 전환 대비이며, 태스크 역할의 `rawSignalBucket.grantReadWrite`와 한 몸이다.
지금 지우면 전환 시점에 둘 다 되살려야 한다.

**3. `ENRICHMENT_PG_DSN`은 `DataStack`의 파생 시크릿으로 주고 ECS `secrets`로 주입한다.**

`DataStack`이 Aurora 엔드포인트와 마스터 시크릿에서 libpq keyword/value DSN을 조립해
별도 시크릿에 담는다.

```ts
const pgDsn = buildLibpqDsn({
  host: this.aurora.clusterEndpoint.hostname,
  port: PORTS.aurora,
  dbname: CONTROL_DB_NAME,
  user: this.dbSecret.secretValueFromJson('username').unsafeUnwrap(),
  password: this.dbSecret.secretValueFromJson('password').unsafeUnwrap(),
  sslmode: CONTROL_DB_SSLMODE,
});

this.postProcessorPgDsnSecret = new Secret(this, 'PostProcessorPgDsn', {
  secretStringValue: SecretValue.unsafePlainText(pgDsn),
});
```

**`unsafeUnwrap()`은 평문을 꺼내는 함수가 아니다.** `cdk.json`의
`@aws-cdk/core:checkSecretUsage: true`가 건 합성 가드를 해제할 뿐이고(호출하지 않으면
`Resolution error: Synthing a secret value ...`로 synth가 실패한다), 반환값은
`{{resolve:secretsmanager:<arn>:SecretString:password::}}` 형태의 **토큰 문자열**이다.
실제 합성 결과는 이렇다.

```json
"SecretString": { "Fn::Join": ["", [
  "host=",
  { "Fn::GetAtt": ["Aurora...", "Endpoint.Address"] },
  " port=5432 dbname=controlplane user={{resolve:secretsmanager:",
  { "Ref": "AuroraSecretAttachment..." },
  ":SecretString:username::}} password={{resolve:secretsmanager:",
  { "Ref": "AuroraSecretAttachment..." },
  ":SecretString:password::}} sslmode=require"
]]}
```

템플릿에는 참조만 남는다. 값의 해석은 CloudFormation이 배포 시점에 수행하고, 해석된
평문은 암호화된 Secrets Manager 안에만 존재한다.

**파생 시크릿을 `ApplicationStack`이 아니라 `DataStack`에 두는 이유**는 DSN의 내용이
`DataStack` 소유의 두 값(`aurora.clusterEndpoint.hostname`, `aurora.secret`)만의 함수이기
때문이다. `ApplicationStack`에서 만들면 엔드포인트 호스트명을 prop으로 하나 더 내보내야
하고, `RemovalPolicy.DESTROY`인 클러스터가 지워질 때 비밀번호를 담은 시크릿만 남는다.
`ApplicationStack`은 계속 `ISecret` 핸들만 받는다.

**컨테이너에 `secrets`로 넣는 이유**는 `environment`에 넣으면
`aws ecs describe-task-definition`과 ECS 콘솔에 DSN이 통째로 — 즉 DB 비밀번호가 —
평문으로 드러나기 때문이다. ADR-0017이 `OTEL_CONFIG`에 대해 명시한 "config에 시크릿을
넣을 수 없다"는 제약과 같은 이유다.

**4. DB는 `controlplane`을 `api-server`와 공유한다.**

별도 데이터베이스를 만들지 않는다. MVP 범위에서 DB를 하나 더 만드는 것은 생성 주체
(CDK는 `defaultDatabaseName` 하나만 만든다)와 마이그레이션 주체가 모두 미정이기 때문이다.

## Constraints

- **libpq DSN 값을 따옴표로 감싸지 않는다.** 합성 시점에 user/password는 토큰이라
  이스케이프할 방법이 없다. 대신 Aurora 자동 생성 비밀번호가 따옴표 없는 keyword/value
  DSN을 깨뜨릴 수 있는 문자 넷(공백, `'`, `"`, `\`)을 전부 제외한다는 사실에 의존한다
  (`aws-cdk-lib/aws-rds`의 `DEFAULT_PASSWORD_EXCLUDE_CHARS`).
  **이건 우연히 성립하는 커플링이다.** 라이브러리 업그레이드로 조용히 깨질 수 있고,
  깨지면 배포는 성공하고 `post-processor`만 런타임에 죽는다.
  `DEFAULT_PASSWORD_EXCLUDE_CHARS`는 `aws-rds/lib/private/util`에만 있고 공개
  엔트리포인트에서 export되지 않으므로, **회귀 테스트는 상수 import가 아니라 합성 템플릿의
  `ExcludeCharacters` 문자열을 검사한다**(`test/prod/data-stack.test.ts`).
- **`sslmode=require`는 서버 요구사항이 아니다.** Aurora PostgreSQL 16은 TLS를 강제하지
  않는다 — `rds.force_ssl` 기본값은 PG 17 이상에서 1, 16 이하에서 0이다. 이건 클라이언트
  측 하드닝 선택이다. `require`는 CA 검증을 하지 않으므로 컨테이너에 RDS CA 번들이 필요
  없다. `verify-full`은 이미지 변경을 요구하므로 앱 레포 몫이다.
- **포트는 `PORTS.aurora` 리터럴을 쓴다.** `aurora.clusterEndpoint.port`는 number 토큰이라
  템플릿 리터럴에 넣으면 인코딩된 double 문자열이 낀다. `PORTS.aurora`는 이미
  `lib/prod/network-stack.ts`의 Aurora ingress 룰이 쓰는 값이고, `DatabaseCluster`에 `port`를
  주지 않았으므로 엔진 기본값과 일치한다. 두 곳이 갈라지지 않게 단일 소스를 유지한다.
- **보안 그룹은 건드리지 않는다.** `lib/prod/network-stack.ts`가 collector SG → ClickHouse
  8123/9000, collector SG → Aurora 5432 인그레스를 이미 열어 뒀다. **SG는 NetworkStack
  밖에서 만들지 않는다**는 불변 규칙이 있다.
- **IAM은 자동이다.** `addContainer`의 `secrets` 경로가
  `secret.grantRead(obtainExecutionRole())`를 호출한다. 손으로 쓸 정책이 없다.
- **`CLICKHOUSE_HTTP_URL`은 끝에 슬래시를 붙이지 않는다.** 앱이 이 값 뒤에
  `/?query=...&database=...`를 그대로 이어붙이므로 슬래시가 있으면 `//?query=`가 되어
  ClickHouse가 404를 돌려준다.

## Alternatives Considered

- **앱이 `DB_CREDS` JSON을 파싱해 DSN을 조립하게 고친다.** 코드 8줄이면 되고 보안·로테이션
  양쪽에서 우월한 **최종 목표**다. 마스터 시크릿이 회전해도 앱이 매번 최신 값을 받는다.
  그러나 앱 레포 변경이 필요해 인프라 단독 배포가 불가능해지고(ADR-0009), compose 개발
  경험(같은 DSN 형식)이 갈라진다. 이번 범위 밖이며 아래 Follow-up이 이 전환 시점을
  규정한다.
- **DSN을 `environment`에 동적 참조로 직접 넣는다.** AWS 문서상 `{{resolve:secretsmanager:...}}`는
  "can be used in all resource properties"지만 같은 문단이 경고한다 — "the secret value may
  show up in the service whose resource it's being used in." ECS 태스크 정의의 `Environment`는
  `describe-task-definition`으로 누구나 읽는다. 기각.
- **조각(host/user/password)을 각각 `secrets`로 주고 컨테이너 entrypoint에서 조립.**
  이미지 변경이 필요한데 ECR 이미지는 앱 레포 소유다(ADR-0007, ADR-0009). 앱 기동 커맨드에
  인프라가 결합되는 것도 나쁘다.
- **Aurora 마스터 시크릿 JSON에 `dsn` 키를 추가.** 시크릿의 생성과 회전을
  `DatabaseCluster`가 소유하므로 CDK에서 키를 끼워 넣을 수 없다.
- **런타임에 앱이 boto3로 Secrets Manager를 조회하거나 RDS IAM 인증을 쓴다.**
  둘 다 앱 코드 변경이 필요하고 MVP 범위 밖이다. `requirements.txt`에 boto3도 없다.
- **DSN 값을 작은따옴표로 감싼다.** 공백에는 강해지지만 `'`와 `\`에는 여전히 취약해
  `ExcludeCharacters` 의존이 그대로 남는다. 복잡도만 늘고 보장은 늘지 않는다.
- **ECS에서 짧은 이름 `clickhouse`를 쓰도록 인프라를 맞춘다.** 불가능하다. Cloud Map은
  FQDN만 제공하고, 짧은 이름을 풀려면 DNS 검색 도메인이나 `/etc/hosts` 주입이 필요한데
  둘 다 막혀 있다 — `extraHosts`는 "isn't supported for tasks that use the `awsvpc` network
  mode"이고(게다가 리터럴 IP가 필요한데 ClickHouse ENI 주소는 합성 시점에 알 수 없다),
  `dnsSearchDomains`는 Fargate 태스크 정의 파라미터 목록에 아예 없다.

## Consequences/Tradeoffs

### Positive

- **`post-processor`가 실제로 동작한다.** `/ecs/post-processor` 로그에
  `clickhouse schema ensured`가 뜨고 503이 사라진다. 이것이 이 ADR의 전부다.
- **태스크 정의에 평문 자격증명이 없다.** `secrets[].valueFrom`에 시크릿 ARN만 남는다.
- **collector 태스크의 execution role이 읽는 시크릿이 좁아진다.** 마스터 시크릿이 아니라
  파생 DSN 시크릿만 읽는다. `api-server`와 서로 다른 시크릿을 읽게 되어 최소권한에
  가까워진다 — 다만 아래 항목이 이 개선의 한계를 규정한다.

### Negative

- **DSN 안에는 여전히 마스터 비밀번호가 들어 있다.** 실질적인 권한 축소가 아니라 **주입
  형식의 정합화**다. runtime DB user 분리는 별도 과제로 남는다.
- **파생 시크릿은 `cdk deploy` 시점의 스냅샷이다.** 소스 시크릿이 회전해도 CloudFormation이
  파생 시크릿을 자동 갱신하지 않는다. 더 나쁜 건 `cdk deploy`로도 안 고쳐진다는 점이다 —
  `Fn::Join`의 구조가 바이트 단위로 동일하면 CFN이 그 리소스에 업데이트를 아예 내지 않는다.
  실패가 조용하지는 않다(연결이 즉시 깨진다). 임시 탈출구는 `put-secret-value` 수동 갱신.
  **로테이션을 켜는 순간 이 설계는 위 Alternatives의 첫 항목으로 교체해야 한다.**
  현재 레포 전체에 `addRotation*`/`manageMasterUserPassword` 호출이 없다.
- **Secrets Manager 시크릿이 하나 늘어난다** (월 약 $0.40).
- **`unsafeUnwrap()`이 이 레포에 처음 등장한다.** `lib/prod/data-stack.ts`의 "시크릿은 참조만
  노출한다. 값을 읽는 코드는 절대 두지 않는다"는 불변 규칙을 좁혀야 한다 — 금지 대상은
  **합성 시점에 평문을 읽는 것**이지 동적 참조 조립이 아니다. `AGENTS.md` §3에 반영한다.
- **인프라 테스트는 이 종류의 버그를 다시 잡지 못한다.** `ENRICHMENT_CH_URL`이라는 이름이
  앱과 일치하는지는 원리적으로 검증 불가다. 유일한 방어선은 `lib/common/config.ts`의
  `ENRICHMENT_ENV`에 앱 소스 위치를 주석으로 고정하고 `AGENTS.md` §3에 불변 규칙으로
  남기는 것뿐이다. **앱이 읽는 이름이 바뀌면 두 레포를 같은 PR로 함께 바꾼다.**
- **`batch-processor`의 `CLICKHOUSE_HOST`는 여전히 죽은 계약일 가능성이 있다.**
  `batch-processor` 는 소스 미확보가 아니라 **미존재**다 — `pulsemetry-backend` 에 대응 모듈이 없다
  (ADR-0024 Follow-up). 모듈이 생기면 같은 계약 점검을 반복해야 한다. 이 ADR은 그것을 확인하지 않았다.

## Follow-up

- **RDS `enrollment` 스키마의 부트스트랩** — 앱은 ClickHouse DDL만 기동 시 멱등 적용하고,
  PostgreSQL 조회 대상인 `enrollment.installations`·`enrollment.team_memberships`·`enrollment.teams`
  (`org.py` 의 `_MEMBERSHIP_SQL`. 옛 `company`/`department`/`employee` 계열은 PROJ-40·41 에서
  교체되어 어느 레포에도 없다)는 compose의 `/docker-entrypoint-initdb.d` 마운트에 의존한다.
  ECS에는 그 메커니즘이 없다 → **접속은 성공하고 첫 조회에서
  `relation "enrollment.installations" does not exist`로 깨진다.**
  **부트스트랩 주체는 `pulsemetry-backend` 의 Flyway 로 확정됐다**(그 레포 ADR 0004·0009).
  남은 결정은 그 마이그레이션을 **ECS 에서 실행할 자리**이며 `AGENTS.md` 5장 (D)가 소유한다.
  dev 배포 전까지는 backend 명세 §9.4 의 로컬 `bootRun` 절차(공식 잠정 절차)로 마이그레이션을 태운다.
- `controlplane`을 `api-server`(JPA)와 공유하는 것이 옳은가. 테이블 이름 충돌 가능성이
  있다(`company`, `employee`는 흔한 이름이다). 별도 DB 또는 스키마 분리는 후속 결정.
- ClickHouse가 무인증 HTTP로 노출된다. 컨테이너에 user/password 환경변수가 없고 앱 sink에
  인증 헤더가 없다. 현재는 SG로만 막고 있다.
- **마스터 시크릿 로테이션을 켜는 시점** → 파생 시크릿 설계를 폐기하고 앱이 `DB_CREDS`
  JSON을 파싱하는 방식으로 전환한다. 이 둘은 양립하지 않는다.
- runtime DB user를 분리하는 시점 → DSN 조립 대상이 마스터에서 그 user로 바뀐다.
- 앱이 읽는 환경변수 이름이 바뀌는 시점 → `lib/common/config.ts`의 `ENRICHMENT_ENV`와 앱을
  같은 PR로 함께 바꾼다.
- `aws-cdk-lib` 업그레이드로 `ExcludeCharacters` 회귀 테스트가 깨질 때 → 따옴표 없는 DSN의
  전제가 무너진 것이므로 즉시 인용 전략을 재설계한다.
- `batch-processor`/`api-server` 의 대응 모듈이 실제로 만들어질 때(현재 **미존재**) → 같은 계약 점검을 반복한다.
- `awss3` exporter로 전환해 `RAW_BUCKET`이 실제로 쓰이거나 완전히 불필요해질 때 (ADR-0017).

## References

- [ADR-0004](0004-task-level-colocation.md), [ADR-0005](0005-cloud-map-private-dns-discovery.md),
  [ADR-0007](0007-precreate-ecr-outside-cdk.md), [ADR-0009](0009-single-infra-repo-stack-boundary.md),
  [ADR-0012](0012-aurora-postgresql-for-control-plane.md), [ADR-0017](0017-inject-collector-config-via-env-provider.md)
- 앱 레포 `ai-telemetry-pipeline`: `apps/telemetry-processor/enrichment/sink_clickhouse.py`,
  `apps/telemetry-processor/enrichment/providers/org.py`, `apps/telemetry-processor/otlp_receiver.py`
- [PostgreSQL libpq — Connection Strings (Keyword/Value)](https://www.postgresql.org/docs/current/libpq-connect.html#LIBPQ-CONNSTRING-KEYWORD-VALUE)
- [Amazon ECS task definition parameters](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters.html)
- [AWS CloudFormation — Retrieve a Secrets Manager secret](https://docs.aws.amazon.com/secretsmanager/latest/userguide/cfn-example_reference-secret.html)
