# 0021. dev/prod 환경 분리 - 컨텍스트 스위치 단일 앱과 lib/{common,prod,dev} 경계

## Status

Accepted

## Context

`AGENTS.md` 4장은 이 결정을 **명시적으로 예약해 두었다.**

> **dev/stg/prod 환경 분리 메커니즘은 없다.** 스택 ID는 리터럴이고 `Env: 'mvp'`는
> 하드코딩이다. 환경 분리가 필요해지면 그건 새 ADR 대상이다.

[ADR-0007](0007-precreate-ecr-outside-cdk.md)도 같은 문장을 반복한다 - "환경 구분은
계정 경계와 `COMMON_TAGS.Env` 태그가 담당하며, 이 레포에는 애초에 환경 분리 메커니즘이
없다. 환경 분리가 필요해지면 그때 별도 ADR에서 다룬다." 그 시점이 지금이다.

PROJ-37이 **별도 개발용 인프라**를 요구한다. 그리고 이 인프라는 운영과 **같은 계정,
같은 리전(`ap-northeast-2`)**에 공존해야 한다. 계정을 나누는 선택지가 없으므로, 두 환경을
가르는 일은 전부 CDK 코드 안에서 일어난다.

현재 상태는 환경이 하나뿐이라는 전제 위에 세워져 있다.

| 지점 | 현재 값 |
|---|---|
| `lib/` 구조 | `network-stack.ts` / `data-stack.ts` / `application-stack.ts` / `edge-stack.ts` 4개가 평평하게 놓임 |
| 스택 ID | `bin/infra.ts`에 `'NetworkStack'` 등 리터럴 |
| 공통 태그 | `lib/config.ts`의 `COMMON_TAGS = { Org, Env: 'mvp', ManagedBy }` |
| 로그 그룹 | `/ecs/collector`, `/ecs/post-processor`, `/ecs/api-server`, `/ecs/batch`, `/ecs/clickhouse` - **물리 이름 명시** |
| 진입점 | `bin/infra.ts` 하나. `loadConfig(app)`이 context 3개(`certificateArn`, `domainName`, `cognitoDomainPrefix`)만 읽는다 |

여기에 이 ADR이 함께 해결하는 **기존 문제**가 하나 더 있다. `test/helpers.ts`의
`buildApp()`은 `bin/infra.ts`의 스택 조립을 **손으로 복제한 것**이다. 두 파일이 같은
4스택을 같은 props로 엮는 코드를 각각 들고 있다.

```
bin/infra.ts:20-46      new NetworkStack → new DataStack → new ApplicationStack → new EdgeStack
test/helpers.ts:45-71   new NetworkStack → new DataStack → new ApplicationStack → new EdgeStack
```

이건 지금도 갈라질 수 있다. 스택 하나에 prop을 추가하면 두 곳을 함께 고쳐야 하고, 한쪽만
고치면 **테스트가 통과하는 조립과 실제로 배포되는 조립이 달라진다.** 환경이 둘로 늘면 이
복제는 네 곳이 된다. 환경 분리 방식을 정하면서 이 복제를 같이 없앤다.

## Decision

### 1. 컨텍스트 스위치 단일 앱

`bin/infra.ts`는 **`-c env=dev|prod` 하나만 읽고 조립을 위임한다.**

```ts
const app = new App();
const env = (app.node.tryGetContext('env') as string | undefined) ?? 'prod';

if (env === 'dev') {
  synthDev(app);
} else {
  synthProd(app);
}
```

조립 본체는 `lib/prod/app.ts`의 `synthProd(app)`와 `lib/dev/app.ts`의 `synthDev(app)`에
있다. 진입점에는 분기 한 줄만 남는다.

**기본값은 `prod`다.** 무인자 `cdk deploy`가 운영을 대상으로 하는 기존 동작을 그대로
유지하기 위함이다. 기본값을 `dev`로 두면 지금까지의 모든 명령어와 런북이 조용히 다른
대상을 가리키게 된다.

이 형태의 실질적 이득은 **`test/helpers.ts`의 복제가 사라진다**는 점이다. 테스트
픽스처도 진입점도 같은 `synthProd`/`synthDev`를 호출하므로, 조립이 갈라질 자리가 없다.

### 2. 폴더 경계 `lib/{common,prod,dev}`

```
lib/
├── common/     환경 무관 계약 상수와 순수 헬퍼
├── prod/       기존 4스택 (로직 변경 없이 이동) + app.ts
└── dev/        신규 4스택 + app.ts
```

**`common/`** 에는 "이 값이 dev에서 달라야 할 이유가 없다"가 참인 것만 둔다.

`PORTS`, `ECR_NAMESPACE`, `ECR_REPOS`, `CLOUD_MAP_NAMESPACE`, `CLICKHOUSE_SERVICE_NAME`,
`CLICKHOUSE_HOST`, `CLICKHOUSE_HTTP_URL`, `CLICKHOUSE_DEFAULT_DB`, `CLICKHOUSE_IMAGE`,
`CLICKHOUSE_CONTAINER_ENV`, `CONTROL_DB_NAME`, `CONTROL_DB_SSLMODE`, `ENRICHMENT_ENV`,
`LibpqDsnParts`, `buildLibpqDsn`, `applyCommonTags`, 그리고 ClickHouse EC2 user data
생성 함수.

이 목록의 대부분은 **앱 컨테이너와의 런타임 계약**이다
([ADR-0018](0018-post-processor-runtime-contract-via-derived-dsn-secret.md),
[ADR-0019](0019-clickhouse-container-runtime-contract.md)). 계약이 환경마다 갈리면
"dev에서 검증했다"는 말의 의미가 사라진다. 같은 이미지가 같은 이름의 환경변수를 읽고 같은
호스트명으로 ClickHouse에 붙는 것이 dev를 두는 목적이다.

**`prod/`** 에는 기존 4스택을 **로직 변경 없이** 옮긴다. 함께 가는 값은 `COMMON_TAGS`,
`PRIMARY_AZ_INDEX`, `SUBNET_GROUP`, `EdgeConfig`, `loadConfig`,
`DEFAULT_COGNITO_DOMAIN_PREFIX`다. 전부 운영 토폴로지에만 의미가 있다 -
`PRIMARY_AZ_INDEX`는 [ADR-0011](0011-single-az-topology.md)의 단일 AZ 고정,
`SUBNET_GROUP`은 public/app/db 3티어, `EdgeConfig`는 모드 A/B 분기
([ADR-0008](0008-dual-auth-alb-cognito-and-otlp-token.md))에 묶여 있고 dev에는 셋 다 없다.

**`dev/`** 에는 신규 4스택과 `loadDevConfig`를 둔다.

의존 방향은 **`prod → common`, `dev → common` 단방향**이다. **`prod ↔ dev` 참조는
금지한다.** 이 규칙 하나가 "dev를 고치다가 운영이 깨진다"는 사고 경로를 컴파일 타임에
차단한다. dev에서 필요한 값이 `prod/`에 있으면 `common/`으로 올리거나 `dev/`에 복제하는
것이지, `prod/`에서 import하지 않는다.

### 3. 스택 ID 접두사

dev 스택은 `Dev` 접두사를 쓴다 - `DevNetworkStack`, `DevDataStack`,
`DevApplicationStack`, `DevEdgeStack`.

CDK는 스택 ID를 CloudFormation 스택 이름으로 그대로 쓴다. **같은 계정·같은 리전에서
스택 이름은 유일해야 하므로, 이 접두사가 두 환경이 서로를 덮어쓰지 않게 하는 유일한
장치다.** 접두사를 빼면 `cdk deploy -c env=dev`가 운영 `NetworkStack`을 dev 템플릿으로
업데이트한다. 실수가 아니라 CloudFormation의 정상 동작이며, 그래서 더 위험하다.

### 4. `Env` 태그 - 운영은 `mvp`를 그대로 둔다

| 환경 | `Env` 태그 |
|---|---|
| prod | `mvp` (**변경 없음**) |
| dev | `dev` |

`Env: 'mvp'`를 `'prod'`로 정정하고 싶은 충동이 들지만 **하지 않는다.** 공통 태그는
`applyCommonTags(app)`로 App 스코프에 붙어 하위 **모든** 태그 지원 리소스에 전파된다
(`lib/config.ts`). 값을 바꾸면 VPC, 서브넷, SG, ECS 서비스, 로그 그룹, Aurora, S3까지
전 리소스에 태그 diff가 생기고, 태그 변경이 일부 리소스에서 교체를 유발할 수 있다.
환경을 하나 추가하는 작업이 운영 전체를 건드리는 작업으로 번진다.

따라서 이 레포에서 **`Env` 태그 값은 환경 식별자가 아니다.** 그 스택이 만들어진 시점에
붙인 이름일 뿐이며, 환경 정합성은 **스택 ID 접두사**가 담당한다. 이 불일치는 의도된
것이고, 나중에 "왜 prod인데 `Env=mvp`인가"를 다시 묻지 않도록 여기 기록해 둔다.
Cost Explorer에서 환경별로 비용을 쪼갤 때도 `Env=mvp` = 운영, `Env=dev` = 개발로 읽는다.

### 5. 공유하는 것 - ECR 레포와 Cloud Map 네임스페이스

**ECR 레포([ADR-0007](0007-precreate-ecr-outside-cdk.md))는 dev/prod가 같은 레포를
공유한다.** ADR-0007이 이미 `soma-376/<env>/<service>` 안을 "환경별로 별도 push가
필요해져 이미지 승격(promote) 없이 레포 수가 3배가 된다"는 이유로 기각했고, 그 판단은
지금도 유효하다. 분리는 태그로만 한다 - dev의 기본 태그는 `latest`이며
`-c devImageTag=<tag>`로 갈아탈 수 있다.

**Cloud Map 네임스페이스 `obs.local`([ADR-0005](0005-cloud-map-private-dns-discovery.md))도
같은 이름을 쓴다.** private DNS 네임스페이스는 **VPC 스코프**라 같은 계정에 동명이 둘
존재해도 충돌하지 않는다. 각 네임스페이스는 자신이 연결된 VPC 안에서만 해석된다.

이건 우연한 편의가 아니라 **의도한 결과를 얻기 위한 선택**이다. 네임스페이스 이름이 같은
덕에 `CLICKHOUSE_HTTP_URL = http://clickhouse.obs.local:8123`이 dev와 prod에서 **한
값으로 유지되고**, 그래서 `ENRICHMENT_CH_URL` 계약(ADR-0018)이 갈라지지 않는다. 앱
컨테이너는 자기가 어느 환경에서 도는지 몰라도 된다. 위 2번에서 `CLICKHOUSE_HOST`를
`common/`에 둘 수 있는 근거가 이것이다.

### 6. `bin/infra.ts`의 shebang 제거

`bin/infra.ts:1`의 `#!/opt/homebrew/opt/node/bin/node`를 지운다. 로컬 Homebrew 경로
하드코딩이고, `cdk.json`이 `npx tsx bin/infra.ts`로 실행하므로 동작에는 무해하지만
비포터블하다(`AGENTS.md` 5장 (H)). 어차피 이 파일을 통째로 고치는 김에 함께 처리한다.

## Constraints

두 환경이 **같은 계정·같은 리전**을 쓴다. 따라서 **전역 유일 이름을 가진 리소스는 전부
분리해야 한다.** 하나라도 빠뜨리면 dev 첫 배포가 실패하거나, 더 나쁘게는 운영 리소스를
가져간다.

| 리소스 | 유일성 범위 | 분리 방식 |
|---|---|---|
| CloudFormation 스택 이름 | 계정 + 리전 | `Dev` 접두사 (위 3번) |
| CloudWatch 로그 그룹 | 계정 + 리전 | dev는 `/ecs/dev/` 접두 |
| S3 버킷 | 전역 | CDK 자동 생성 이름 - 스택명에서 유도되어 **자동 분리** |
| Cognito 도메인 prefix | 리전 | dev는 Cognito를 만들지 않아 **해당 없음** |

**로그 그룹이 가장 위험한 항목이다.** 운영 `ApplicationStack`은 `logGroupName`에
`/ecs/collector` 같은 **물리 이름을 명시**한다(`lib/application-stack.ts`의
`makeLogGroup`). CDK가 이름을 자동 생성하는 리소스와 달리 물리 이름은 스택명에서 유도되지
않으므로, dev가 접두사 없이 같은 이름을 쓰면 **첫 `cdk deploy`가
`Resource of type 'AWS::Logs::LogGroup' with identifier '/ecs/collector' already exists`로
실패한다.**

S3 버킷은 반대로 안전하다. `DataStack`이 `bucketName`을 주지 않아 CDK가
`<스택명>-<논리ID>-<해시>` 형태로 만들고, 스택명이 다르므로 버킷 이름도 자동으로 갈린다.

## Alternatives Considered

**별도 레포로 분리.** dev 인프라를 새 레포에 두면 경계가 가장 선명하다. 그러나
[ADR-0009](0009-single-infra-repo-stack-boundary.md)(단일 인프라 레포)를 정면으로 뒤집게
되고, 위 2번의 `common/` 상수 - 즉 앱과의 런타임 계약 - 를 두 레포에서 손으로 동기화해야
한다. ADR-0018이 보여준 대로 이 계약이 어긋나면 **synth도 테스트도 배포도 전부 통과하고
런타임에만 죽는다.** 동기화 지점을 하나 더 만들 이유가 없어 기각.

**`cdk.json`의 다중 app 엔트리(별도 `bin/dev.ts`).** 진입점을 둘로 나누면 분기가 아예
없어져 깔끔해 보인다. 그러나 `test/helpers.ts` 복제 문제가 **두 배가 되고**(prod용 픽스처
+ dev용 픽스처가 각각 진입점을 다시 베낀다), 공통 상수의 import 경로가 두 진입점에서
갈라진다. 게다가 조립 본체를 `lib/*/app.ts`로 빼고 나면 진입점이 하나든 둘이든 차이가
없어진다 - 분기 한 줄이 어디 있느냐의 문제일 뿐이다. 기각.

**환경별 config 객체만 두고 스택 클래스를 공유.** 가장 DRY해 보이는 안이고, 환경 차이가
파라미터 수준이라면 옳다. 문제는 dev와 prod의 차이가 **토폴로지 차이**라는 점이다 -
Fargate vs ECS on EC2, private vs public 서브넷, awsvpc vs bridge 네트워크 모드
([ADR-0022](0022-dev-infrastructure-topology.md)). 이 차이를 파라미터로 표현하면
`if (config.isDev)`가 스택 코드 전체에 크로스컷으로 퍼진다. 그러면 한쪽을 고치는 변경이
다른 쪽 분기를 조용히 지나가고, **운영 스택의 회귀가 dev 작업 도중에 발생한다.** 아래
Positive의 "운영 템플릿 diff 0"이라는 회귀 게이트도 성립하지 않게 된다. 기각.

**`Env: 'mvp'`를 `'prod'`로 정정.** 이름이 맞아떨어져 읽기 좋아지지만 전 리소스 태그
diff를 유발한다(위 4번). 얻는 것이 가독성뿐이라 기각.

## Consequences/Tradeoffs

### Positive

- **운영 스택은 로직 변경 없는 이동이므로 `cdk synth` 산출물 diff가 0이어야 한다.**
  이것이 이 리팩터링의 **회귀 게이트**다. 이동 전 템플릿을 저장해 두고 이동 후와
  비교해서 한 글자라도 다르면 이동이 아니라 변경이 섞인 것이다. 파일 경로가 대규모로
  바뀌는 작업에서 이만큼 값싸고 강한 검증은 드물다.
- **진입점과 테스트 픽스처가 같은 `synthProd`/`synthDev`를 호출한다.** `bin/infra.ts`와
  `test/helpers.ts`가 조립을 각각 들고 있던 기존 드리프트 위험이 사라진다. 스택에 prop을
  추가할 때 고칠 곳이 한 곳이 된다.
- **dev 실험이 운영 템플릿에 영향을 주지 않는다.** `dev/`만 고치는 변경은 `prod/`의
  합성 결과를 바꿀 수 없다 - 단방향 의존이 이를 구조적으로 보장한다.

### Negative

- **완료** — **파일 경로가 전부 바뀐다.** ADR 6건(0007·0015·0017·0018·0019·0022)의 낡은 경로
  인용 9곳을 PROJ-80 에서 치환했다. 원문: `lib/config.ts` → `lib/common/*` + `lib/prod/config.ts`,
  `lib/network-stack.ts` → `lib/prod/network-stack.ts` 식이다. 기존 ADR과 `AGENTS.md`가
  본문에서 파일 경로를 다수 인용하고 있으므로(예: `lib/application-stack.ts:201`) 함께
  고쳐야 한다. 이 문서 갱신을 빠뜨리면 다음 사람이 없는 파일을 찾는다.
- **`lib/common`이 커지면 "환경 무관"의 경계가 흐려진다.** 지금은 앱 계약과 순수 헬퍼만
  있어 기준이 명확하지만, 애매한 값을 하나씩 올리다 보면 예전 `config.ts`가 그대로
  재현된다. 새 상수를 `common/`에 넣기 전에 **"이 값이 dev에서 달라야 할 이유가 정말
  없는가"**를 매번 물어야 한다.
- **dev/prod가 같은 ECR 레포를 공유하므로 dev용 이미지 push가 운영 태그를 덮어쓸 여지가
  남는다.** 특히 dev 기본 태그가 `latest`인데 운영이 같은 태그를 쓰면 dev 빌드가 곧
  운영 이미지가 된다. 방어선은 인프라가 아니라 **태그 규율**뿐이며, 이 레포는 앱 레포의
  CI를 강제할 수 없다(ADR-0007, ADR-0009와 같은 종류의 레포 경계 문제다).
- **`Env` 태그와 실제 환경이 어긋난 채로 남는다.** 이 문서를 읽지 않은 사람에게는 계속
  버그로 보인다.

## Follow-up

- **`Env` 태그 값 정합화(`mvp` → `prod`)** 는 전 리소스 태그 diff를 감수할 시점에 별도로
  결정한다. `AGENTS.md`의 `RemovalPolicy.DESTROY` 일괄 재검토처럼, 프로덕션 전환 시점에
  묶어서 처리하는 것이 자연스럽다.
- **dev/prod ECR 레포 완전 분리가 필요해지면 ADR-0007을 갱신한다.** 트리거는 태그 규율이
  실제로 깨져 dev 이미지가 운영에 올라가는 사고가 나거나, dev 이미지 수가 늘어 운영 레포의
  lifecycle policy와 충돌할 때다.
- `stg` 환경이 필요해질 때 → `lib/stg/`를 추가하는 것으로 끝나는지, 아니면 세 벌 복제가
  과해져 위 Alternatives의 "config 객체 공유"로 돌아가야 하는지 재판단한다.

## References

- `AGENTS.md` 4장 (설정과 환경 분기) - 이 결정을 예약한 문장
- [ADR-0005](0005-cloud-map-private-dns-discovery.md) - Cloud Map 프라이빗 DNS 네임스페이스
- [ADR-0007](0007-precreate-ecr-outside-cdk.md) - ECR 네임스페이스 컨벤션과 환경 미포함 결정
- [ADR-0009](0009-single-infra-repo-stack-boundary.md) - 단일 인프라 레포 경계
- [ADR-0018](0018-post-processor-runtime-contract-via-derived-dsn-secret.md) - 환경 무관이어야 하는 앱 런타임 계약
- [ADR-0022](0022-dev-infrastructure-topology.md) - 이 경계 위에 올라가는 dev 토폴로지
