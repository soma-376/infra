# ADR-0019: ClickHouse 컨테이너 런타임 계약 - compose와 동일한 사용자 설정 + 이미지 태그 고정

- **Status**: Accepted
- **Date**: 2026-08-03

## Context

배포된 `post-processor`가 ClickHouse 적재 시 **인증 실패**로 죽었다.
[ADR-0018](0018-post-processor-runtime-contract-via-derived-dsn-secret.md)이 환경변수
이름을 맞춘 뒤라 DNS는 풀리고 TCP 연결도 성립했지만, ClickHouse가 HTTP 403 +
`Code: 516. DB::Exception: default: Authentication failed: password is incorrect,
or there is no user with such name`을 돌려줬다.

원인은 앱이 아니라 **인프라가 ClickHouse 컨테이너에 환경변수를 하나도 주지 않은 것**이다.

`clickhouse/clickhouse-server` 이미지의 entrypoint는 `CLICKHOUSE_USER` /
`CLICKHOUSE_PASSWORD` / `CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT` 세 값을 보고
`/etc/clickhouse-server/users.d/default-user.xml`을 세 갈래로 갈라 쓴다.

```sh
CLICKHOUSE_USER="${CLICKHOUSE_USER:-default}"
CLICKHOUSE_PASSWORD="${CLICKHOUSE_PASSWORD:-}"
CLICKHOUSE_ACCESS_MANAGEMENT="${CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT:-0}"
CLICKHOUSE_SKIP_USER_SETUP="${CLICKHOUSE_SKIP_USER_SETUP:-0}"

if [ "$CLICKHOUSE_SKIP_USER_SETUP" == "1" ]; then
    # 스톡 users.xml 을 그대로 둔다
elif [ -n "$CLICKHOUSE_USER" ] && [ "$CLICKHOUSE_USER" != "default" ] \
     || [ -n "$CLICKHOUSE_PASSWORD" ] || [ "$CLICKHOUSE_ACCESS_MANAGEMENT" != "0" ]; then
    # 유저를 <ip>::/0</ip> 로 (재)생성
else
    # ← 우리가 여기로 떨어졌다
fi
```

세 값이 모두 비어 있으면 마지막 `else`가 실행된다.

```
$0: neither CLICKHOUSE_USER nor CLICKHOUSE_PASSWORD is set,
disabling network access for user 'default'
```

```xml
<default>
  <networks><ip>::1</ip><ip>127.0.0.1</ip></networks>
</default>
```

`default` 유저가 **루프백 전용**이 된다. `post-processor`는 awsvpc ENI의 다른 IP에서
오므로 거부되고, ClickHouse는 네트워크 거부를 인증 실패로 보고한다.
`src/enrichment/sink_clickhouse.py:59-61`이 이 4xx를 `BackendUnavailable`로 감싸므로
리시버는 503을 뱉고, collector는 그 배치를 무한히 재시도한다 - ADR-0018이 고친 것과
증상이 같고 원인만 다른 두 번째 층이다.

compose(`ai-telemetry-pipeline/docker-compose.dev.yml`)는
`CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT: "1"`을 주기 때문에 두 번째 분기를 타고 `default`를
`<ip>::/0</ip>` + 빈 비밀번호로 재생성한다. **로컬만 동작하고 ECS만 죽은 이유가 이것이다.**

여기에 제약이 하나 더 겹친다. **앱은 자격증명을 아예 보내지 않는다.**
`sink_clickhouse.py:50-58`의 `execute()`는 `query`와 `database` 쿼리 파라미터만 붙일 뿐
`X-ClickHouse-User` 헤더도 basic auth도 없다. 따라서 비밀번호 있는 유저를 만드는 해법은
앱 레포 변경 없이는 성립하지 않는다.

마지막으로 이미지가 **태그 없이** `ContainerImage.fromRegistry('clickhouse/clickhouse-server')`
로 참조되어 있었다. 실질적으로 `latest`이므로 태스크가 재기동될 때마다 메이저 버전이 바뀔 수
있고, 위 entrypoint 분기 로직 자체가 버전에 따라 변한다. 저장소 엔진의 버전이 배포 시점에
따라 달라지는 것은 그 자체로 결함이다.

## Decision

세 가지를 함께 결정한다.

**1. ClickHouse 컨테이너에 compose와 동일한 환경변수 4개를 준다.**

```ts
export const CLICKHOUSE_CONTAINER_ENV: Readonly<Record<string, string>> = {
  CLICKHOUSE_DB: CLICKHOUSE_DEFAULT_DB,          // default
  CLICKHOUSE_USER: 'default',
  CLICKHOUSE_PASSWORD: '',
  CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT: '1',
};
```

**실제로 동작을 바꾸는 값은 `CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT: '1'` 하나다.**
위 조건식에서 `CLICKHOUSE_USER='default'`는 `!= "default"` 검사에 걸려 탈락하고
`CLICKHOUSE_PASSWORD=''`는 `-n` 검사에 걸려 탈락한다. 세 번째 항만 참이 된다.
나머지 셋은 compose와의 문서적 정합성을 위해 남기는 것이며 지워도 동작은 같지만,
`DEFAULT_ACCESS_MANAGEMENT`를 지우면 **즉시 이 장애로 회귀한다.**

접근 통제의 실체는 유저 비밀번호가 아니라 `NetworkStack`의 `clickhouseSecurityGroup`이다 -
Collector/Dashboard SG에서 오는 8123/9000만 인바운드로 허용하고 그 외에는 경로가 없다
([ADR-0014](0014-keep-clickhouse-in-app-subnet-for-mvp.md)).

**2. 이미지 태그를 `24.8-alpine`으로 고정한다.**

```ts
export const CLICKHOUSE_IMAGE = 'clickhouse/clickhouse-server:24.8-alpine';
```

compose가 쓰는 태그와 같은 값이다. 로컬에서 검증한 동작이 ECS에서 그대로 재현되는 것이
동기화의 목적이므로 버전도 함께 맞춘다. 이 태그의 매니페스트는 `linux/arm64`를 포함하므로
t4g(Graviton) 인스턴스에서 pull된다 ([ADR-0015](0015-arm64-fargate-for-cost-savings.md)).

**3. 두 값 모두 `lib/config.ts`에 두고 스택은 import만 한다.**

`CLICKHOUSE_HTTP_URL` / `ENRICHMENT_ENV`와 같은 자리다. 컨테이너 계약에 해당하는 값이
스택 파일에 리터럴로 흩어지면 `post-processor`와 ClickHouse 양쪽의 계약을 한눈에 볼 수 없다.

## Alternatives Considered

**`CLICKHOUSE_SKIP_USER_SETUP=1` 하나만 주기.**
entrypoint가 스톡 `users.xml`을 그대로 두므로 `default`가 무비밀번호 + `::/0`으로 남고,
access management 권한을 주지 않는 최소 권한안이다. 기각한 이유는 compose와 설정이
갈라지기 때문이다 - 로컬은 "유저를 재생성"하고 ECS는 "스톡을 유지"하는 서로 다른 경로를
타게 되어, 이 ADR이 없애려는 로컬/배포 동작 차이를 다른 형태로 다시 만든다.
access management 권한이 실제 문제로 떠오르면 이 안으로 전환한다.

**비밀번호 있는 전용 유저 + Secrets Manager.**
가장 정석이지만 **앱이 자격증명을 보내지 않으므로 불가능하다.** 채택하려면 앱 레포에서
`sink_clickhouse.execute()`에 인증 헤더를 추가하고 compose까지 함께 바꿔야 한다.
인프라 단독으로 끝나는 결정이 아니므로 이 ADR의 범위 밖이다.

**`users.d/*.xml`을 직접 주입 (호스트 볼륨 마운트 또는 커스텀 이미지).**
설정을 완전히 통제할 수 있지만 관리 지점이 하나 더 늘고, compose(환경변수)와 ECS(XML 파일)의
형태가 달라진다. 커스텀 이미지는 ECR 레포와 빌드 파이프라인까지 필요해 MVP 대비 과하다.

**이미지 태그를 `latest`로 두고 env만 고치기.**
당장의 인증 실패는 사라지지만, entrypoint 분기 로직이 바뀌는 메이저 업그레이드가
재기동만으로 유입되는 경로가 남는다. 이 ADR이 문서화한 동작의 유효기간을 보장할 수 없다.

## Consequences

- `post-processor`의 적재가 성공한다. 기동 로그에 `clickhouse schema ensured`가 뜨고
  503이 사라진다.
- **`default` 유저는 비밀번호가 없고 `access_management=1`을 가진다.** VPC 안에서
  8123에 닿을 수 있는 주체는 ClickHouse에 대해 사실상 관리자다. 유일한 방어선이
  security group이라는 뜻이며, 이는 MVP 한정 수용이다. 실 운영 전환 시
  `CLICKHOUSE_SKIP_USER_SETUP` 안 또는 앱 레포의 인증 헤더 지원과 함께 재검토한다.
- 태스크 정의가 바뀌므로 ClickHouse 태스크가 교체된다. `minHealthyPercent: 0`이라
  교체 중 짧은 다운타임이 발생하고, 그동안의 적재는 503 - collector 재시도 큐가 흡수한다.
- **ClickHouse는 다운그레이드를 지원하지 않는다.** 기존 `/data/clickhouse`가 더 높은
  버전(태그 미고정 시절의 `latest`)으로 초기화되어 있으면 24.8 컨테이너가 기동에 실패한다.
  MVP에서는 [ADR-0006](0006-accept-local-ebs-durability-for-mvp.md)이 이미 로컬 EBS
  데이터 유실을 수용하고 있으므로, 충돌 시 서비스를 0으로 내리고 SSM으로 접속해
  ([ADR-0016](0016-ssm-based-operator-access.md)) `/data/clickhouse` 내용을 비운 뒤
  재배포한다. 스키마는 `post-processor`가 기동 시 `ensure_schema()`로 멱등 재적용한다.
- 앞으로 ClickHouse 버전 업그레이드는 `CLICKHOUSE_IMAGE` 한 줄을 바꾸는 **명시적 결정**이
  된다. 데이터 디렉터리 호환성을 그 시점에 함께 확인해야 한다.
- 합성 템플릿이 이미지 태그와 환경변수 4개를 갖는지는 `test/application-stack.test.ts`가,
  `DEFAULT_ACCESS_MANAGEMENT`가 `'0'`이 아니라는 불변식은 `test/config.test.ts`가 고정한다.
  다만 인프라 테스트는 "ClickHouse가 실제로 그 값을 어떻게 해석하는가"를 검사할 수 없다.
  ADR-0017·ADR-0018과 같은 계열의 틈이며, 최종 관문은 배포 후 `/ecs/clickhouse` 로그에
  `disabling network access for user 'default'`가 **없는지** 확인하는 것이다.

## References

- 앱 레포 `ai-telemetry-pipeline`: `src/enrichment/sink_clickhouse.py`,
  `docker-compose.dev.yml`
- `clickhouse/clickhouse-server` 이미지의 `docker/server/entrypoint.sh`
- [ADR-0018](0018-post-processor-runtime-contract-via-derived-dsn-secret.md) -
  같은 파이프라인의 첫 번째 런타임 계약 불일치
