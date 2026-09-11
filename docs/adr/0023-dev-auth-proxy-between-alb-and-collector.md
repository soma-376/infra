# 0023. dev 인증 프록시 - ALB와 Collector 사이에 auth-proxy 태스크 삽입

## Status

Superseded by [ADR 0026](0026-dev-backend-deployment-units-and-staged-migration.md). dev OTLP 인증과 처리
전체가 backend `telemetry-ingest`로 이동하므로 auth-proxy·Collector·`:4318` 직행 경로와 이 ADR의
네트워크·Secret·ALB 결정은 단계적으로 제거한다.

## Context

[ADR-0008](0008-dual-auth-alb-cognito-and-otlp-token.md)은 OTLP 경로의 인증을 ALB의
`jwt-validation`으로 처리하기로 했다. 그러나 이 액션과 `authenticate-cognito`는 **둘 다
HTTPS 리스너를 필수로 요구**하고, HTTPS 리스너에는 ACM 인증서가 필요하며, 인증서 발급에는
도메인이 필요하다. **팀에 도메인이 없다.** 그래서 ADR-0008은 당시 아직 `Proposed`였고
(이후 [허브 ADR 0001](../../../docs/adr/0001-otlp-authentication-model.md)로 `Superseded by` — Follow-up 참조),
`AGENTS.md` 5장 (A)가 "병목은 코드 작성이 아니라 결정"이라고 적어둔 상태였다.

그동안 dev ALB의 `:80` 리스너는 `/v1/*`를 **인증 없이** Collector 태스크로 그대로 흘린다
(`lib/dev/edge-stack.ts`의 `DevOtlpForward`). 실질적인 방어선은 `devAllowedCidr` 하나뿐이고
그 기본값은 `0.0.0.0/0`이다([ADR-0022](0022-dev-infrastructure-topology.md) 9번).

도메인·인증서 확보를 기다리는 대신, 인증을 **애플리케이션 레이어로 내린다.** 앱 레포
(`ai-telemetry-pipeline`)의 `apps/auth-proxy`가 Bearer 토큰을 HMAC-SHA256으로 해시해
`enrollment.telemetry_tokens`에서 조회하고, 유효할 때만 Collector로 중계한다.
이 ADR은 그 컨테이너를 **dev 인프라에만** 배치하는 방법을 정한다.

운영 인프라(`lib/prod/`)는 이번에 건드리지 않는다. dev에서 동작을 검증한 뒤 별도 결정으로
이관한다.

## Decision

### 1. 별도 태스크로 두고 Cloud Map A 레코드로 Collector를 찾는다

auth-proxy를 `DevCollectorTask`에 컨테이너로 합치지 않고 **독립한 `Ec2Service`** 로 둔다.
`DevCollectorService`에 `cloudMapOptions`를 추가해 `collector.obs.local` A 레코드를
등록하고, auth-proxy는 `COLLECTOR_BASE_URL=http://collector.obs.local:4318`로 부른다.

[ADR-0005](0005-cloud-map-private-dns-discovery.md)가 이미 세운 디스커버리 메커니즘을
그대로 재사용하는 것이며, `DevClickhouseService`의 `cloudMapOptions`와 형태가 같다.
Collector가 이미 awsvpc이므로(아래 2번) A 레코드 등록 요건은 이미 충족되어 있고,
**`DevCollectorTask` 태스크 정의는 한 줄도 바뀌지 않는다.** 그 태스크에는 ADR-0004·0017·
0018·0019·0022가 건 불변 규칙이 겹겹이 쌓여 있어, 건드리지 않는 것 자체가 이득이다.

`COLLECTOR_SERVICE_NAME` / `COLLECTOR_HOST` / `COLLECTOR_OTLP_URL` 상수는
`lib/common/config.ts`에 둔다 - 이 값이 dev에서 달라야 할 이유가 없기 때문이다
([ADR-0021](0021-dev-prod-environment-separation.md) 2번). 다만 **등록은 dev만 한다.**
prod에 auth-proxy를 도입할 때 prod `CollectorService`에도 `cloudMapOptions`를 추가해야
이 이름이 유효해진다. 상수 주석에 이 사실을 명시해 죽은 계약이 되지 않게 한다.

### 2. auth-proxy 태스크는 bridge다

ADR-0022 4번이 세운 기준을 그대로 적용한 결과다. 그 ADR은 awsvpc를 **강제하는 조건 두
가지**만 인정한다.

| 강제 조건 | auth-proxy | 판정 |
|---|---|---|
| 태스크 내 컨테이너 간 `localhost` 의존 | 단일 컨테이너이고 `COLLECTOR_BASE_URL`·`DATABASE_URL`이 전부 태스크 밖을 향한다 | 해당 없음 |
| Cloud Map A 레코드 등록 대상 | 디스커버리의 **클라이언트**이며 앞에 ALB가 있어 이름으로 찾아올 주체가 없다 | 해당 없음 |

둘 다 아니므로 `DevDashboardTask`와 같은 판정이 나온다. bridge가 얻는 것은 네 가지다.

- **호스트 ENI 여유 유지.** t4g 계열 인스턴스당 ENI 한도는 프라이머리 포함 3이고, 앱
  호스트는 이미 프라이머리 + `DevCollectorTask`로 2를 쓰고 있다. bridge는 태스크 ENI를
  잡지 않으므로 한 자리가 남는다. awsvpc였다면 3/3이 되어 이후 awsvpc 태스크를 하나라도
  더 붙일 때 `awsvpcTrunking` 계정 옵트인이 선행되어야 한다.
- **인터넷 egress.** bridge 태스크는 호스트 ENI를 타고 그 ENI에는 퍼블릭 IP가 있다
  (ADR-0022 5(a)). 지금 auth-proxy가 부르는 것은 VPC 안의 RDS와 Collector뿐이라 당장은
  필요 없지만, **ADR-0008대로 도메인 확보 후 JWKS 검증이 들어오면 awsvpc는 그 경로에서만
  조용히 타임아웃으로 죽는다.** prod Fargate는 NAT가 있어 egress가 살아 있으므로,
  dev를 bridge로 두는 쪽이 오히려 prod와 동작이 일치한다.
  (대체됨 — ALB/JWKS 검증 복귀는 허브 ADR 0001로 채택되지 않는다. "외부 API 호출이 생기면 egress가 필요하다"는 일반 논거로만 읽는다.)
- **SG 룰 재사용.** bridge라 아웃바운드의 출발 SG가 `DevAppHostSg`이고, RDS 5432 인그레스
  룰이 이미 그 SG를 peer로 갖고 있다. `DATABASE_URL` 접속에 새 룰이 필요 없다.
- **확장 경로.** 동적 포트를 쓰므로 계정 설정 변경 없이 즉시 다중 배치가 가능하다
  (ADR-0022 11번). auth-proxy는 OTLP 트래픽 전량이 통과하는 지점이라 부하 테스트에서
  가장 먼저 늘려야 할 후보다.

배치 위치는 **기존 `DevAppAsg`** 다. 새 ASG를 만들지 않는다 - ADR-0022 3번이 ASG를 둘로
나눈 근거(ClickHouse 쿼리의 메모리 격리, 데이터 볼륨 정리 시 앱 호스트 유지)는 auth-proxy에
해당하지 않는다. 소프트 메모리 예약 합계는 2048 → 2304 MiB가 되어 t4g.medium(4 GiB)에
충분하다.

### 3. Collector 직행 경로를 `:4318` 리스너로 유지한다

`/v1/*`는 auth-proxy로 보내되, 인증을 거치지 않고 Collector만 분리 검증할 수 있는 경로를
남긴다. auth-proxy 장애 시 "프록시가 죽은 것인지 파이프라인이 죽은 것인지"를 가르는 데
필요하다.

**경로(path)가 아니라 리스너 포트로 나눈다.** ALB의 forward 액션은 URL을 재작성하지
않으므로 `/debug/v1/*` 같은 prefix를 쓰면 Collector가 `/debug/v1/traces`를 그대로 받고
OTLP 리시버가 404를 낸다. `:4318` 리스너를 추가하면 경로가 `/v1/traces` 그대로 유지되며,
이것은 ClickHouse 직접 쿼리용 `:8123` 리스너(ADR-0022 8번)와 정확히 같은 패턴이다.

이 리스너에도 `open: false`를 준다. 인바운드는 전부 `DevNetworkStack`이 정한다
(ADR-0022 2번/9번).

### 4. `TOKEN_HASH_SECRET`은 CDK가 Secrets Manager에 생성한다

`generateSecretString`으로 랜덤 값을 만들고 ECS `secrets`로 주입한다. 값이 코드·CFN
템플릿·CDK context 어디에도 남지 않는다. enrollment 서버(별도 레포)는 같은 시크릿을
읽어 써야 하므로 ARN을 `DevEdgeStack`의 `CfnOutput`으로 노출한다.

환경변수 `LOG_LEVEL`(dev 는 `debug`)도 함께 주입하지만 **현재 auth-proxy 앱은 이 이름을 읽지
않는다**(PROJ-51 이 앱 쪽에 도입 대기 중. auth-proxy 자체가 backend Spring Security 로 이관
예정이라 이관 확정 시 주입 제거로 전환한다 — `lib/common/config.ts` 의 `AUTH_PROXY_ENV` 주석).

`DATABASE_URL`도 [ADR-0018](0018-post-processor-runtime-contract-via-derived-dsn-secret.md)의
파생 시크릿 패턴을 그대로 따른다 - `environment`에 넣으면 DB 비밀번호가
`aws ecs describe-task-definition`과 ECS 콘솔에 평문으로 드러난다.

## Constraints

### `DATABASE_URL`은 libpq DSN이 아니다 - `buildLibpqDsn()`을 재사용할 수 없다

`post-processor`(Python/psycopg)는 `host=… port=… dbname=… sslmode=require` 형식의
**keyword/value** DSN을 읽는다(ADR-0018). auth-proxy는 `pg`의 `Pool({ connectionString })`을
쓰고, 그 파서(`pg-connection-string`)는 `new URL(str, 'postgres://base')` 기반의
**URI 전용**이다. keyword/value 문자열을 넣으면 공백이 `%20`으로 인코딩되어 통째로 망가진다.

따라서 `lib/common/config.ts`에 `buildPostgresUri()`를 따로 둔다. 두 함수가 나란히 있는
것은 중복이 아니라 **두 앱이 서로 다른 형식을 요구한다는 사실**의 반영이다.

### `pg`에서 `sslmode=require`는 libpq와 뜻이 다르다

`pg-connection-string` 2.14.0은 다음 경고를 낸다.

```text
SECURITY WARNING: The SSL modes 'prefer', 'require', and 'verify-ca' are treated as
aliases for 'verify-full'.
...
- If you want libpq compatibility now, use 'uselibpqcompat=true&sslmode=require'
```

즉 `?sslmode=require`만 주면 `rejectUnauthorized`가 켜진 **전체 인증서 검증**이 된다.
RDS 기본 CA(`rds-ca-rsa2048-g1`)는 Node 기본 CA 번들에 없으므로 접속 자체가 실패한다.
`CONTROL_DB_SSLMODE = 'require'`의 주석("`require`는 CA 검증을 하지 않으므로 컨테이너에
RDS CA 번들이 필요 없다")은 **libpq에서만 참**이다.

그래서 URI에 **`?uselibpqcompat=true&sslmode=require`** 를 넣어 post-processor와 의미를
맞춘다. 이 값을 지우거나 `sslmode`만 남기면 배포는 성공하고 auth-proxy만 런타임에 죽는다.

### 따옴표 없는 URI 조립은 자동 생성 비밀번호의 제외 문자에 의존한다

`buildPostgresUri()`는 값을 퍼센트 인코딩하지 않는다 - 합성 시점에 user/password는
CloudFormation 토큰이라 인코딩할 방법이 없다. 이것이 성립하는 이유는 aws-rds의
`DEFAULT_PASSWORD_EXCLUDE_CHARS`가 URI를 깨뜨리는 문자(`@` `/` `?` `#` `%` `:` `[` `]`)를
**전부 제외**하기 때문이다.

ADR-0018의 `buildLibpqDsn`과 정확히 같은 종류의 **우연한 커플링**이며, 라이브러리
업그레이드로 조용히 깨질 수 있다. 그 상수는 공개 export가 아니므로
`test/dev/data-stack.test.ts`가 **합성 템플릿의 `ExcludeCharacters`** 를 권위 소스로 삼아
고정한다.

### 배포 전 ECR 레포를 먼저 만들어야 한다

`soma-376/auth-proxy`를 CDK 밖에서 선생성하고 `linux/arm64` 이미지를 push해야 한다
([ADR-0007](0007-precreate-ecr-outside-cdk.md), [ADR-0015](0015-arm64-fargate-for-cost-savings.md)).
앱 호스트 ASG가 t4g(Graviton) + ARM AMI이므로 amd64 이미지는 synth·test·deploy를 전부
통과한 뒤 이미지 pull에서만 실패한다.

## Alternatives Considered

**같은 태스크에 컨테이너로 합치기 (co-location).** `DevCollectorTask`에 3번째 컨테이너로
넣으면 `COLLECTOR_BASE_URL=http://localhost:4318`이 되어 DNS도 SG도 필요 없고, ADR-0004의
선례와도 맞는다. Collector의 4318이 태스크 ENI에만 열리므로 우회도 구조적으로 막힌다.
채택하지 않은 이유는 **배포 결합**이다. auth-proxy는 별도 레포에서 독립적으로 릴리스되는데,
합치면 프록시를 고칠 때마다 collector와 post-processor가 함께 재시작한다. 인증 프록시는
도메인 확보 전까지의 한시적 구성이라(ADR-0008) 변경 빈도가 높을 것으로 본다.

**ECS Service Connect.** 클러스터 네임스페이스 기반 가상 DNS(`http://collector:4318`)와
클라이언트 사이드 로드밸런싱·outlier detection·재시도·요청 단위 메트릭을 ECS가 관리해 준다.
채택하지 않은 이유는 비용 대비 실익이다. AWS 문서상 Service Connect는 **태스크 정의에
task-level memory limit을 요구**하고 포트 매핑에 `name`이 필요하다. 즉 위 1번에서 건드리지
않기로 한 `DevCollectorTask`를 고쳐야 하고, 지금 dev 태스크들이 쓰지 않는 하드 메모리
리밋을 t4g.medium 한 대 위에서 새로 도입해야 한다. 반면 실익인 라운드로빈·outlier
detection은 **타깃 태스크가 여러 개일 때** 의미가 있는데 dev는 세 서비스 모두
`desiredCount: 1`이다. 태스크마다 Envoy 사이드카(권장 +256 CPU / +64 MiB)도 붙는다.
또 ADR-0005가 세운 Cloud Map 옆에 두 번째 디스커버리 메커니즘이 같은 `obs.local`
네임스페이스에 공존하게 된다.

**내부 전용 ALB를 Collector 앞에 두기.** 헬스체크 기반의 안정 주소를 얻지만, ALB는
`DevEdgeStack`에 있고 태스크 정의는 `DevApplicationStack`에 있어 기존 ALB를 재사용하면
스택 간 순환 의존이 생긴다. 별도 내부 ALB를 만들면 시간당 요금과 LCU, 홉 하나가 추가된다.
dev 규모에 과하다.

**auth-proxy를 awsvpc로 두기.** 전용 SG(`DevAuthProxySg`)를 가질 수 있어 Collector의 4318
인바운드를 auth-proxy만으로 정확히 좁힐 수 있고, prod(Fargate awsvpc)와 모드가 같아진다.
채택하지 않은 이유는 위 2번의 네 가지 이득을 전부 잃기 때문이다. 특히 ENI 3/3 소진과
egress 부재는 되돌리는 비용이 크다.

**auth-proxy 전용 ASG 분리.** SG 입도를 정확히 좁힐 수 있지만 t4g 인스턴스가 한 대 늘고
ASG·캐패시티 프로바이더가 3쌍이 된다. ADR-0022 3번이 ASG를 나눈 근거가 auth-proxy에는
해당하지 않으므로 비용만 남는다.

## Consequences/Tradeoffs

### Positive

- **dev의 OTLP 경로에 인증이 생긴다.** 도메인·인증서 없이도 ADR-0008이 목표한 "OTLP는
  토큰으로 인증"을 달성한다. `devAllowedCidr`이 유일한 방어선이던 상태에서 벗어난다.
- **`DevCollectorTask` 태스크 정의가 그대로다.** 불변 규칙이 가장 많이 걸린 객체를
  건드리지 않으므로 회귀 위험이 낮다. 바뀌는 것은 서비스의 `cloudMapOptions` 하나다.
- **새 메커니즘을 도입하지 않는다.** Cloud Map A 레코드, bridge 동적 포트, 파생 시크릿,
  `open: false` 리스너 - 전부 이 레포에 이미 있는 패턴의 재사용이다.
- **인스턴스가 늘지 않는다.** 기존 앱 호스트에 태스크 하나가 얹히고 ENI 여유도 남는다.
- **독립 배포.** auth-proxy 릴리스가 collector·post-processor를 재시작시키지 않는다.

### Negative

- **Collector `:4318` 인바운드를 호스트 SG 입도로만 좁힐 수 있다.** bridge 태스크는 자기
  ENI가 없어 아웃바운드가 호스트 ENI를 타므로, 출발 SG가 `DevAppHostSg`(앱 ASG + ClickHouse
  ASG 공용)가 된다. 결과적으로 같은 호스트의 `DevDashboardTask` 컨테이너도 4318에 닿을 수
  있다. `batch-processor` → ClickHouse 트래픽이 이미 정확히 같은 이유로 `DevAppHostSg`를
  출발 SG로 쓰고 있어(ADR-0022 4번) 기존 패턴과 일관되며, 아래 `:4318` 디버그 리스너를
  유지하기로 한 이상 VPC 내부 우회 경로가 새 노출 범주는 아니다.
- **`:4318` 디버그 리스너는 인증을 우회하는 경로다.** 의도적으로 남긴 것이지만,
  `devAllowedCidr` 기본값이 `0.0.0.0/0`이면 인증 없는 OTLP 수신구가 인터넷에 공개된다.
  기존 `infra:dev-open-ingress` 경고가 이 리스너까지 함께 커버한다(ADR-0022 9번).
- **dev와 prod의 네트워크 모드가 또 갈린다.** prod에 이관하면 Fargate awsvpc가 된다.
  다만 auth-proxy는 단일 컨테이너라 ADR-0022 Negative가 지적한 "컨테이너 간 통신 가정"
  항목은 성립하지 않고, egress 유무는 오히려 bridge 쪽이 prod와 같다.
- **`TOKEN_HASH_SECRET` 회전은 드롭인이 아니다.** HMAC 키가 바뀌면 이미 발급된 모든 토큰의
  `token_hash`가 매칭 불가가 되어 전 클라이언트가 401을 받는다. 회전하려면 토큰 전량
  재발급 또는 이중 키 검증이 필요하다. 그래서 이 시크릿에는 회전을 설정하지 않는다.
- **교체 배포 중 `collector.obs.local`이 잠깐 낡는다.** Cloud Map A 레코드 TTL만큼
  이전 IP가 남는다. 세 서비스 모두 `minHealthyPercent: 0` 교체 배포라 어차피 짧은
  다운타임이 있으므로(ADR-0022 Constraints) 새 실패 범주는 아니다.
- **관리 대상이 하나 늘어난다.** 태스크 4개, 컨테이너 6개, 로그 그룹 6개가 된다.

## Follow-up

- **`enrollment` 스키마의 부트스트랩 주체는 `pulsemetry-backend` 의 Flyway 다**(그 레포
  ADR 0004·0009). 스키마가 없으면 접속은 성공하고 첫 조회에서
  `relation "enrollment.telemetry_tokens" does not exist`로 깨진다.
  enrollment 서버가 dev 에 배포되기 전까지는 backend 명세 §9.4 의 **로컬 `bootRun` 절차(공식
  잠정 절차)** 로 마이그레이션을 태운다 — `psql` 로 DDL 을 직접 넣는 우회는 쓰지 않는다.
  **남은 결정은 그 마이그레이션을 ECS 에서 실행할 자리**이며 `AGENTS.md` 5장 (D)가 소유한다.
- **토큰 발급 주체는 `pulsemetry-backend` 의 `:apps:enrollment-api` 다 — 이 서비스를 dev
  인프라에 배치하는 결정이 아직 없다.** ECR 레포·태스크 정의·ECS 서비스가 모두 부재하며,
  배치 시 `TOKEN_HASH_SECRET`(`TokenHashSecretArn` 출력) 공유 방법을 함께 정한다. **새 ADR
  대상이다**(번호는 작성 시점에 정한다). collector 이관(backend ADR-0007)이 진행되면
  `:apps:telemetry-ingest` 가 배포 단위로 추가된다는 점도 함께 다룬다.
- **auth-proxy 는 한시적 구성이라는 것이 이 ADR 의 전제이며, 그 전제는 확정됐다** —
  OTLP 토큰 검증은 `pulsemetry-backend` 의 Spring Security 계층으로 이관된다(backend ADR-0007).
  ALB 단 인증(모드 A 복귀)은 채택하지 않는다 — ALB 는 TLS 종단만 담당하고 검증 지점은 앱
  계층 한 곳이다. 인증 모델의 소유는 [허브 ADR 0001](../../../docs/adr/0001-otlp-authentication-model.md) 이다
  (`TOKEN_HASH_SECRET` 회전 불가 제약도 그쪽이 담는다). **이관이 끝나면 [ADR 0022](0022-dev-infrastructure-topology.md) 의 4번·8번·10번
  (auth-proxy 태스크·리스너 규칙·로그 그룹)을 다시 정리한다.**
- **운영 인프라 이관은 별도 결정이다.** 그때 prod `CollectorService`에도
  `cloudMapOptions`를 추가해야 `COLLECTOR_HOST` 상수가 prod에서 유효해진다.
- **시크릿 암호화·회전 정책이 이 레포에 없다.** `DevAuthProxyTokenHashSecret`과
  `DevAuthProxyDatabaseUrl`은 기존 `DevPostProcessorPgDsn`의 선례를 따라 AWS 관리형 암호화와
  회전 없음으로 둔다. 전용 KMS CMK와 회전은 `AGENTS.md` 5장 (D)의 자격 증명 분리 ADR에서
  함께 다룬다.
- **auth-proxy를 늘려야 할 때** → `desiredCount`를 올리고, 필요하면
  `service.autoScaleTaskCount()`를 붙인다. bridge라 계정 설정 변경은 필요 없다.

## Acceptance Criteria

- 토큰 없이 `POST http://<alb-dns>/v1/traces` → **401**
- 유효한 토큰으로 같은 요청 → 2xx이고 `/ecs/dev/post-processor` 로그에 도달
- `POST http://<alb-dns>:4318/v1/traces` → 인증 없이 Collector 직행 성공
- auth-proxy 컨테이너에서 `collector.obs.local`이 A 레코드로 해석된다
- `npm test`, `npx cdk synth --all`, `npx cdk synth --all -c env=dev` 통과
- **운영 4스택의 합성 템플릿이 바이트 단위로 불변**이다

## References

- [ADR-0004](0004-task-level-colocation.md) - 태스크 단위 co-location (대안으로 검토)
- [ADR-0005](0005-cloud-map-private-dns-discovery.md) - Cloud Map A 레코드가 awsvpc를 요구
- [ADR-0007](0007-precreate-ecr-outside-cdk.md) - ECR 레포 선생성
- [ADR-0008](0008-dual-auth-alb-cognito-and-otlp-token.md) - 이 ADR이 우회하는 도메인 제약
- [ADR-0015](0015-arm64-fargate-for-cost-savings.md) - `linux/arm64` 요구
- [ADR-0018](0018-post-processor-runtime-contract-via-derived-dsn-secret.md) - 파생 시크릿 패턴과 우연한 커플링
- [ADR-0021](0021-dev-prod-environment-separation.md) - 상수 배치 규칙과 계약 일치 원칙
- [ADR-0022](0022-dev-infrastructure-topology.md) - 네트워크 모드 선택 기준, ENI 한도, 리스너 `open: false`
