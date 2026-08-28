# 0022. 개발 인프라 토폴로지 - 퍼블릭 서브넷 전용, ECS on EC2, 혼합 네트워크 모드

## Status

Accepted — 부분 대체: [ADR 0023](0023-dev-auth-proxy-between-alb-and-collector.md) 이 8번의 "인증 없는 엣지" 와 4번의 태스크 3개 구성을 대체한다(auth-proxy 태스크 추가, `/v1/*` 는 인증 경유, `:4318` 은 디버그 직행). 네트워크·컴퓨트·데이터·확장 경로 결정은 그대로 유효하다.

## Context

PROJ-37 티켓이 dev 인프라에 **두 가지 제약을 명시**했다.

1. **Fargate 대신 EC2를 적극 사용한다** - 개별 인스턴스에 접속할 수 있어야 한다.
2. **프라이빗 서브넷 대신 퍼블릭 서브넷을 쓰고 NAT를 설치하지 않는다.**

둘 다 운영 토폴로지의 정확한 반대편이다. 운영은 app 서브넷이 `PRIVATE_WITH_EGRESS`이고
앱 워크로드가 Fargate이며, 접근 경로가 SSM 하나로 좁혀져 있다
([ADR-0014](0014-keep-clickhouse-in-app-subnet-for-mvp.md),
[ADR-0003](0003-hybrid-launch-type-ec2-clickhouse-fargate-apps.md),
[ADR-0016](0016-ssm-based-operator-access.md)). 그 좁음은 운영에서는 미덕이지만 디버깅
중에는 그대로 비용이다 - Fargate 태스크에는 들어갈 호스트가 없고, `docker logs`도
`docker inspect`도 쓸 수 없으며, 네트워크가 의심스러울 때 `curl` 한 번 던져볼 자리가 없다.

dev에 요구되는 성질은 세 가지다.

- **운영과 격리**: dev의 어떤 실수도 운영 트래픽·데이터·리소스에 닿지 않는다.
- **낮은 비용**: 상시 구동이지만 MVP 개발 예산 안에 들어와야 한다.
- **부하 테스트로 확장 가능**: 지금은 최소 구성이되, 나중에 규모를 키우는 데 재설계가
  필요하면 안 된다.

환경 분리의 **메커니즘**(폴더 경계, 스택 ID 접두사, 공유 범위)은
[ADR-0021](0021-dev-prod-environment-separation.md)이 정한다. 이 ADR은 그 위에 올라가는
**dev 쪽 토폴로지**를 정한다.

## Decision

### 1. 네트워크 - 전용 VPC, 퍼블릭 서브넷 하나, NAT 없음

```ts
new Vpc(this, 'Vpc', {
  ipAddresses: IpAddresses.cidr('10.1.0.0/16'),
  maxAzs: 2,
  natGateways: 0,
  subnetConfiguration: [
    { name: 'public', subnetType: SubnetType.PUBLIC, cidrMask: 24 },
  ],
});
```

**CIDR `10.1.0.0/16`.** 운영 VPC는 CDK 기본값 `10.0.0.0/16`을 쓴다
(`lib/prod/network-stack.ts`가 `ipAddresses`를 주지 않는다). dev에 같은 대역을 쓰면 두 VPC를
peering하거나 같은 VPN에 물릴 여지가 영구히 사라진다. 지금 필요하지 않더라도 겹치지 않게
두는 비용이 0이므로 겹치지 않게 둔다.

**`natGateways: 0`이 서브넷 구성을 결정한다.** NAT가 없으면 `PRIVATE_WITH_EGRESS`
서브넷은 **애초에 만들 수 없다** - egress 경로가 없는 "egress 있는 프라이빗 서브넷"은
정의상 성립하지 않고, CDK도 NAT 없이 이 타입을 요청하면 실패한다. 티켓의 두 제약("퍼블릭
서브넷", "NAT 없음")은 사실 하나의 제약이며, 결과적으로 서브넷 타입은 `PUBLIC` 하나만
남는다.

**S3 게이트웨이 엔드포인트는 유지한다.** 게이트웨이 엔드포인트는 요금이 없고, 아래 5번에서
보듯 **awsvpc 태스크가 S3에 닿는 유일한 경로**다.

**`maxAzs: 2`는 [ADR-0011](0011-single-az-topology.md)과 정확히 같은 이유다.** 이중화가
아니라 하드 제약이다 - internet-facing ALB가 최소 2개 AZ의 퍼블릭 서브넷을 요구하고,
RDS DB subnet group도 2 AZ를 요구한다. 워크로드는 여전히 사실상 1 AZ에 몰린다.

### 2. SG 전량을 `DevNetworkStack`에 둔다

`AGENTS.md` 3장의 불변 규칙 - **"SG와 모든 cross-SG 룰은 `NetworkStack`에만 정의한다"** -
을 dev에도 그대로 계승한다. SG 참조가 스택 내부 참조가 되어 **스택 간 순환 의존을 원천
차단**하기 때문이며, 이 성질은 환경과 무관하다. 하류 스택(`DevDataStack`,
`DevApplicationStack`, `DevEdgeStack`)은 props로 주입만 받는다.

### 3. 컴퓨트 - ECS on EC2, ASG 2개로 인스턴스 분리

| ASG | 인스턴스 | 용도 | 스토리지 |
|---|---|---|---|
| 앱용 | `t4g.medium` × 1 | collector 태스크, dashboard 태스크 | 루트만 |
| ClickHouse용 | `t4g.small` × 1 | ClickHouse 태스크 | 루트 + `/dev/xvdb` 50GB gp3 |

**ARM64로 고정한다**([ADR-0015](0015-arm64-fargate-for-cost-savings.md)). t4g는 Graviton
이고, `EcsOptimizedImage.amazonLinux2023(AmiHardwareType.ARM)`을 쓴다. 이유는 비용이
아니라 **운영과 같은 이미지를 쓰기 위해서**다. dev가 x86이면 앱 레포가 두 아키텍처를
빌드해야 하고, 그러면 "dev에서 검증했다"가 운영에 대해 아무것도 보장하지 못한다.

**ASG를 둘로 나누는 이유는 두 가지다.** 첫째, ClickHouse의 메모리 사용이 앱 컨테이너를
밀어내지 않게 한다 - ClickHouse는 쿼리 하나로 가용 메모리를 크게 잡아먹을 수 있고, 같은
호스트라면 ECS가 앱 태스크를 재배치하거나 OOM으로 죽인다. 둘째, **인스턴스 단위로
재시작·교체할 수 있다.** ClickHouse 데이터 디렉터리를 비우고 싶을 때(ADR-0019가 기술한
버전 충돌 복구 절차) 앱 호스트를 함께 내리지 않아도 된다.

`/dev/xvdb` 포맷과 `/data/clickhouse` 마운트 user data는 운영과 **같은 함수를
공유한다**(ADR-0021의 `lib/common`).

### 4. 네트워크 모드를 태스크별로 나눈다

**이 ADR의 핵심이다.** 태스크가 서로 다른 이유로 서로 다른 모드를 요구한다.

| 태스크 | 네트워크 모드 | 강제하는 것 |
|---|---|---|
| `DevCollectorTask` | **awsvpc** | collector config의 `http://localhost:8080` |
| `DevClickhouseTask` | **awsvpc** | Cloud Map A 레코드 |
| `DevDashboardTask` | **bridge** | 인터넷 egress + ECS Exec |
| `DevAuthProxyTask` | **bridge** | 강제 조건 없음 — ENI 여유와 egress ([ADR 0023](0023-dev-auth-proxy-between-alb-and-collector.md) 2번이 추가) |

#### `DevCollectorTask` = awsvpc

`config/otel-collector.yaml`의 exporter가 이렇게 되어 있다.

```yaml
otlphttp/telemetry_pipeline:
  endpoint: http://localhost:8080
  encoding: json
```

같은 태스크의 `post-processor`를 **localhost로** 부른다. 이건 awsvpc에서 태스크 내
컨테이너가 **네트워크 네임스페이스를 공유**하기 때문에만 성립한다
([ADR-0004](0004-task-level-colocation.md)의 co-location이 주는 직접적 이득이며
[ADR-0017](0017-inject-collector-config-via-env-provider.md)이 문서화한 전제다).

**bridge 모드에서는 컨테이너마다 네임스페이스가 갈린다.** collector 컨테이너의
`localhost:8080`은 자기 자신을 가리키고, 거기엔 아무도 없다. 그리고 이 실패는
**조용하다** - `cdk synth`도 `npm test`도 `cdk deploy`도 전부 통과한다. 문자열
`http://localhost:8080`은 어느 단계에서도 검증되지 않는다. 드러나는 곳은 런타임의
connection refused뿐이고, collector는 그 배치를 무한히 재시도한다. ADR-0017·ADR-0018·
ADR-0019가 모두 같은 계열의 틈에서 나왔다.

또 하나. dev용으로 config 파일을 **포크하지 않기 위해서도** awsvpc여야 한다. dev가
`http://<다른 주소>:8080`을 쓰려면 별도 config가 필요하고, 그러면 운영과 dev의 collector
동작이 갈라져 dev의 검증 가치가 사라진다.

#### `DevClickhouseTask` = awsvpc

Cloud Map에 **A 레코드**(`clickhouse.obs.local`)를 등록하려면 awsvpc가 필요하다
([ADR-0005](0005-cloud-map-private-dns-discovery.md)). bridge나 host 모드에서는 태스크에
전용 IP가 없으므로 Cloud Map이 **SRV 레코드만** 등록한다. SRV는 호스트와 포트를 함께
돌려주는 레코드라 일반 HTTP 클라이언트가 해석하지 못한다.

그러면 `ENRICHMENT_CH_URL = http://clickhouse.obs.local:8123` 계약(ADR-0018)이 dev에서만
깨진다. 앱은 이름이 안 풀리면 예외를 던지지 않고 compose 기본값으로 조용히 폴백하므로,
증상은 또다시 "컨테이너는 RUNNING인데 모든 적재가 503"이다.

#### `DevDashboardTask` = bridge

`api-server`와 `batch-processor` 사이에는 **localhost 의존이 없다.** 인프라가 주입하는
값은 `api-server`의 `DB_CREDS`/`DB_NAME`과 `batch-processor`의 `CLICKHOUSE_HOST`뿐이고,
셋 다 태스크 밖을 향한다.

그래서 이 태스크는 bridge로 둘 수 있고, 그러면 **인터넷 egress와 ECS Exec가 살아난다** -
bridge 태스크는 호스트의 ENI를 타는데, 그 ENI에는 퍼블릭 IP가 있다(아래 5번 참조).
두 컨테이너는 이 레포가 소스를 확보하지 못한 것들이므로(`AGENTS.md` 3장) 관측 수단을
줄일 이유가 없다. Spring Boot가 외부 API를 부를 수도 있고, 컨테이너에 들어가 볼 일이 가장
많은 것도 이쪽이다.

`hostPort`를 지정하지 않아 **동적 포트**를 쓴다. 포트 충돌 없이 같은 호스트에 여러 개를
띄울 수 있고, ALB 타깃 그룹이 인스턴스 + 동적 포트 등록을 자동으로 처리한다.

### 5. awsvpc + NAT 없음이 만드는 두 제약

두 제약은 설계의 결함이 아니라 **위 선택들의 직접적 귀결**이다. 나중에 "왜 안 되지"를
다시 파헤치지 않도록 명시해 둔다.

#### (a) awsvpc 태스크에는 인터넷 egress가 없다

awsvpc 태스크는 자기 ENI를 받는데, **그 ENI에는 퍼블릭 IP가 붙지 않는다.** Fargate에는
`assignPublicIp` 옵션이 있지만 **EC2 launch type에는 그 옵션 자체가 없다** - 퍼블릭 IP
할당은 launch template의 인스턴스 ENI 설정이지 태스크 ENI 설정이 아니기 때문이다. NAT도
없으므로 collector와 ClickHouse 태스크는 인터넷으로 나갈 경로가 전혀 없다.

**그런데 태스크는 정상 기동한다.** 기동에 필요한 세 가지가 전부 태스크 ENI가 아니라
**호스트 ENI**를 경유하기 때문이다.

| 동작 | 수행 주체 | 경로 |
|---|---|---|
| 이미지 pull | EC2 인스턴스의 Docker 데몬 | 호스트 ENI (퍼블릭 IP 보유) |
| CloudWatch Logs 전송 | 호스트의 awslogs 로그 드라이버 | 호스트 ENI |
| Secrets Manager 조회 | ECS agent (execution role) | 호스트 ENI |
| S3 접근 | 태스크 ENI | **S3 게이트웨이 엔드포인트** |

즉 인터넷 egress가 없는 것은 **컨테이너 프로세스가 직접 여는 아웃바운드 연결**뿐이다.
collector와 post-processor, ClickHouse는 현재 VPC 내부(ClickHouse, RDS)와만 통신하므로
문제되지 않는다. **다만 이건 "지금은"이다** - 아래 Negative와 Follow-up이 이 조건이
깨지는 시점을 규정한다.

#### (b) awsvpc 태스크에서는 ECS Exec가 안 된다

ECS Exec은 태스크 안의 SSM 에이전트가 `ssmmessages` 엔드포인트에 도달해야 성립한다.
awsvpc 태스크에는 인터넷 경로가 없고 인터페이스 VPC 엔드포인트도 두지 않으므로 실패한다.

**이건 문제가 아니라 티켓의 전제다.** 티켓이 EC2를 요구한 이유가 정확히 이것이다 - EC2
호스트에 **SSM Session Manager로 붙어 `sudo docker exec`**하면 네트워크 모드와 무관하게
**모든** 컨테이너에 들어갈 수 있다([ADR-0016](0016-ssm-based-operator-access.md)이 이미
ClickHouse `Ec2Service`를 ECS Exec 대상에서 제외한 것과 같은 논리다 - "SSM으로 호스트에
들어가면 `docker exec`으로 컨테이너에 접근할 수 있어 경로가 중복된다").

따라서 **dev 서비스에는 `enableExecuteCommand`를 켜지 않는다.** 켜면 awsvpc 태스크에서는
어차피 동작하지 않으면서 태스크 역할에 `ssmmessages:*` 권한만 붙는다. 호스트 ASG의
인스턴스 역할에는 `AmazonSSMManagedInstanceCore`를 붙인다.

### 6. 데이터 - RDS `DatabaseInstance` 단일 인스턴스

Aurora Serverless v2 대신 일반 RDS 단일 인스턴스를 쓴다.

| 항목 | 값 |
|---|---|
| 엔진 | PostgreSQL 16 |
| 인스턴스 | `db.t4g.micro` |
| 스토리지 | gp3 20GB |
| 배치 | 퍼블릭 서브넷 + `publiclyAccessible: true` |
| 백업 | `backupRetention: 0` |
| 삭제 | `deletionProtection: false`, `RemovalPolicy.DESTROY` |

**엔진·DB 이름(`controlplane`)·`sslmode`는 운영과 같게 둔다**
([ADR-0012](0012-aurora-postgresql-for-control-plane.md)). 앱이 보는 계약이 갈라지면 안
되기 때문이다. `controlplane`이라는 이름 자체가 RDS 예약어 검사를 통과한 값이라는 사실도
같이 상속된다(`AGENTS.md` 3장).

**`publiclyAccessible: true`가 이 선택의 목적이다.** 로컬에서 `psql`로 직접 붙어 스키마를
만들고 데이터를 확인할 수 있어야 한다. `AGENTS.md` 5장 (H)가 지적한 "RDS 조직 스키마를
아무도 부트스트랩하지 않는다" 문제를 dev에서 손으로 해결할 수 있는 유일한 경로이기도 하다.

### 7. 파생 DSN 시크릿을 운영과 동일 구조로 재현한다

`DevDataStack`도 `buildLibpqDsn()` + `secretValueFromJson().unsafeUnwrap()` +
`SecretValue.unsafePlainText()` 조합으로 `ENRICHMENT_PG_DSN`용 파생 시크릿을 만든다
(ADR-0018). 형식이 갈리면 post-processor가 dev에서만 다르게 동작한다.

여기에 `AGENTS.md` 3장이 기록한 **우연한 커플링**이 그대로 따라온다 - 자동 생성 비밀번호의
`ExcludeCharacters`가 공백·`'`·`"`·`\` 넷을 전부 제외해 주기 때문에만 따옴표 없는
keyword/value DSN이 안전하다. `DatabaseInstance`도 `DatabaseCluster`와 같은
`DEFAULT_PASSWORD_EXCLUDE_CHARS`를 쓰지만, **그 상수는 공개 export가 아니므로 상수
import로는 검증할 수 없다.** 운영과 같은 방식으로 **`test/dev/data-stack.test.ts`가 합성
템플릿의 `ExcludeCharacters` 문자열을 고정한다.**

### 8. 엣지 - internet-facing ALB, 인증 없음

리스너는 둘이다.

| 리스너 | 규칙 | 타깃 그룹 |
|---|---|---|
| **:80** | 기본: fixed-response 404 | - |
| | `/v1/*` | **auth-proxy TG** - target type **instance**, 동적 포트 ([ADR 0023](0023-dev-auth-proxy-between-alb-and-collector.md)이 collector 직행을 대체) |
| | `/api/*` | dashboard TG - target type **instance**, 동적 포트 |
| **:4318** | 기본: forward | collector TG - target type **ip**, 포트 4318 — **인증 우회 디버그 직행** (ADR 0023 3번) |
| **:8123** | 기본: forward | ClickHouse TG - target type **ip**, 포트 8123, healthCheck `/ping` |

target type이 갈리는 것은 네트워크 모드의 귀결이다 - awsvpc 태스크는 자기 IP로,
bridge 태스크는 호스트 + 동적 포트로 등록된다.

**8123 리스너를 두는 이유**는 EC2 인스턴스의 퍼블릭 IP가 **인스턴스 교체마다 바뀌기**
때문이다([ADR-0010](0010-no-static-eip.md)이 운영에서 EIP를 두지 않기로 한 것과 같은
사정이다). ALB DNS 이름은 고정이므로, 이 리스너가 **안정적인 ClickHouse 직접 쿼리
주소**를 제공한다. 로컬에서 `curl "http://<alb>:8123/?query=SELECT ..."`로 바로 확인할 수
있다.

**Cognito / CloudFront / 프론트엔드 S3는 만들지 않는다.** 의도적 생략이다. dev
프론트엔드는 **로컬에서 띄워 ALB를 향하게** 한다 - 프론트 개발 중에는 어차피 로컬
dev server를 쓰고, CloudFront 배포는 캐시 무효화까지 붙어 개발 루프를 느리게 만든다.
Cognito를 만들지 않는 덕에 [ADR-0021](0021-dev-prod-environment-separation.md)의
Constraints에서 "Cognito 도메인 prefix 충돌"이 애초에 발생하지 않는다.

### 9. 접근 통제는 `devAllowedCidr` 컨텍스트 하나에 모은다

ALB(80, 8123), RDS(5432)의 인바운드 소스를 **컨텍스트 키 하나**로 통제한다. 쉼표로 구분해
여러 CIDR을 줄 수 있다.

```bash
npx cdk deploy -c env=dev -c devAllowedCidr=203.0.113.10/32,198.51.100.0/24
```

**미지정 시 기본값은 `0.0.0.0/0`이고, synth 시 경고를 낸다.**

```ts
Annotations.of(scope).addWarningV2(
  'infra:dev-open-ingress',
  'devAllowedCidr 미지정 - ClickHouse(8123)와 RDS(5432)가 인터넷에 전면 공개된다.',
);
```

이 기본값은 **편의를 위해 사용자가 선택한 것**이다. 팀원의 IP가 유동적이고 카페·집·회사를
오가는 개발 단계에서 CIDR을 매번 갱신하는 마찰을 피하려는 것이며, 그 대가로 **경고가
유일한 방어선**이 된다. 안전한 기본값이 아니라는 사실을 여기 명시해 둔다.
[ADR-0008](0008-dual-auth-alb-cognito-and-otlp-token.md)의 모드 B 폴백 경고와 같은
메커니즘(`addWarningV2`)을 쓴다.

### 10. 로그 그룹 접두사 `/ecs/dev/`

`/ecs/dev/collector`, `/ecs/dev/post-processor`, `/ecs/dev/auth-proxy`([ADR 0023](0023-dev-auth-proxy-between-alb-and-collector.md)이 추가),
`/ecs/dev/api-server`, `/ecs/dev/batch`, `/ecs/dev/clickhouse` — 태스크 4개, 컨테이너 6개, 로그 그룹 6개.

운영이 `logGroupName`에 물리 이름을 명시하므로, 접두를 붙이지 않으면 dev 첫 배포가
`already exists`로 실패한다(ADR-0021의 Constraints). 로그 그룹 자체의 보존 기간·삭제
정책은 예약된 ADR-0020의 몫이므로 여기서 결정하지 않고 운영과 같은 값(14일,
`RemovalPolicy.DESTROY`)을 따른다.

### 11. 확장 경로

지금은 전부 호스트 1대 / 태스크 1개지만, 부하 테스트로 키우는 경로가 이미 열려 있다.

- **호스트**: `-c devAppAsgMaxCapacity=N`으로 앱 ASG의 최대 용량을 늘린다.
- **태스크**: `service.autoScaleTaskCount()` + `scaleOnCpuUtilization`으로 태스크 수를
  늘린다.
- **ALB**: 타깃 그룹과 리스너 규칙은 이미 있으므로 **손댈 필요가 없다.** 늘어난 태스크가
  자동으로 등록된다.

**단, awsvpc인 collector를 한 호스트에 여러 개 띄우려면 계정 레벨 옵트인이 필요하다.**
awsvpc 태스크는 태스크마다 ENI를 하나씩 잡고 인스턴스당 ENI 한도가 낮기 때문이다.

```bash
aws ecs put-account-setting-default --name awsvpcTrunking --value enabled
```

bridge인 dashboard는 동적 포트를 쓰므로 **옵트인 없이 즉시 다중 배치가 가능하다.** 위
4번의 모드 선택이 확장 경로에서도 갈라지는 지점이다.

## Constraints

- **t4g 계열의 인스턴스당 ENI 한도는 3(프라이머리 포함)이다.** awsvpc 태스크는 태스크당
  ENI 하나를 잡으므로 롤링 배포 여유가 없다. 세 서비스 모두 `desiredCount: 1`,
  **`minHealthyPercent: 0` / `maxHealthyPercent: 100`** 으로 교체 배포(먼저 내리고 새로
  띄움)를 강제한다. 운영 ClickHouse `Ec2Service`와 정확히 같은 패턴이며(`AGENTS.md` 3장
  불변 규칙), 같은 이유로 **`AsgCapacityProvider`의
  `enableManagedTerminationProtection: false`** 도 계승한다 - 관리형 종료 보호가 단일
  인스턴스 교체를 막는다. 교체 중에는 짧은 다운타임이 발생한다.
- **배포 전 게이트(ADR-0017)는 dev에도 그대로 적용된다.** collector config는 `cdk synth`
  로도 `npm test`로도 검증되지 않고, `otelcol-contrib validate`조차 컴포넌트를 해석만 하고
  start하지 않아 런타임 실패를 못 잡는다. 배포 전에 로컬 `docker run`으로 기동해
  `Everything is ready`를 먼저 확인한다. **dev가 운영과 같은 config 파일을 쓰기 때문에**
  이 게이트는 dev 배포에서도 생략할 수 없다. 정리할 때는 컨테이너 ID를 지목한다 -
  `--filter ancestor=...`를 쓰면 같은 이미지를 쓰는 로컬 개발 컨테이너까지 지운다.

## Alternatives Considered

**세 태스크 모두 bridge.** 가장 단순하고 ENI 한도 걱정도 없다. 그러나 collector의
`localhost:8080` 계약과 ClickHouse의 A 레코드 등록이 **동시에** 깨진다. 살리려면
`config/otel-collector.yaml`을 dev용으로 포크해야 하고, 그러면 운영과 dev의 collector
동작이 갈라져 dev에서 검증한 파이프라인이 운영을 보장하지 못한다. dev를 두는 목적 자체를
훼손하므로 기각.

**세 태스크 모두 awsvpc.** 일관성이 있고 운영과 모드가 완전히 같아진다는 장점이 크다.
그러나 dashboard가 인터넷 egress와 ECS Exec을 함께 잃는다. `api-server`와
`batch-processor`는 **소스를 확보하지 못한 컨테이너**라 무엇을 호출하는지 모르는 상태이고,
그런 대상에 대해 관측 수단을 줄일 이유가 없다. 기각.

**NAT Gateway 설치.** awsvpc 태스크의 egress 문제와 ECS Exec 문제를 한 번에 없앤다.
그러나 티켓이 명시적으로 금지했고, ap-northeast-2 기준 시간당 요금만으로 **월 약 $35**가
든다(데이터 처리 요금 별도). dev 예산에서 단일 항목으로는 가장 크다.

**NAT 인스턴스(t4g.nano).** NAT Gateway의 1/10 비용으로 같은 기능을 얻는다. 그러나
티켓의 "NAT 없음" 취지에서 벗어나고, 소스/대상 확인 비활성화와 라우팅 테이블 관리, 그리고
그 인스턴스 자체의 장애 처리까지 **관리 대상이 하나 늘어난다.** awsvpc 태스크의 인터넷
egress가 실제로 필요해지면 그때 별도로 결정한다(Follow-up 참조).

**인터페이스 VPC 엔드포인트로 ECS Exec 확보.** `ssmmessages` 엔드포인트를 두면 awsvpc
태스크에서도 ECS Exec이 동작한다. 그러나 엔드포인트당 시간 요금이 발생하고, **호스트 SSM +
`docker exec`으로 같은 목적을 무료로 달성할 수 있다.** ADR-0016이 운영에서 같은 이유로
(ADR-0014와의 충돌까지 겹쳐) 이미 기각한 안이다.

**Aurora Serverless v2 재사용.** 운영과 완전히 같은 엔진 구성을 얻는다. 그러나 최소
0.5 ACU가 **상시 과금**되어 개발용으로는 과하고, 무엇보다 이 선택의 목적인
`publiclyAccessible` 직접 접속에는 `DatabaseInstance`가 더 단순하다. 앱이 보는 계약
(PostgreSQL 16, `controlplane`, `sslmode=require`)은 어느 쪽이든 같으므로 잃는 것이 없다.
기각.

**운영 VPC 안에 dev 서브넷 추가.** VPC를 하나 아끼고 두 환경 간 통신이 쉬워진다. 그러나
**블라스트 반경이 공유된다** - 라우팅 테이블, Network ACL, VPC 자체의 변경이 양쪽에
동시에 닿고, SG 규칙을 하나 잘못 열면 그 경로가 운영 리소스까지 이어진다. dev의 존재
이유가 "운영과 격리된 실험 공간"인데 격리를 첫 줄부터 깨는 구성이다. 기각.

## Consequences/Tradeoffs

### Positive

- **모든 컨테이너에 진입할 수 있다.** 호스트에 SSM Session Manager로 붙어 `docker exec`
  하면 네트워크 모드와 무관하다. `docker logs`, `docker inspect`, 호스트에서의 `curl`까지
  전부 열린다 - 운영에서는 불가능한 것들이다.
- **NAT 없음으로 월 약 $35를 절감한다.** dev 총비용에서 가장 큰 단일 절감이다.
- **ALB, RDS, ClickHouse에 로컬에서 직접 접근할 수 있다.** `psql`로 스키마를 만들고,
  ALB :8123으로 ClickHouse를 쿼리하고, :80으로 OTLP를 밀어 넣는 루프가 전부 로컬에서
  돈다.
- **운영 VPC와 완전히 격리된다.** CIDR도, VPC도, 라우팅도, SG도 공유하지 않는다.
- **컨텍스트 값만 바꿔 부하 테스트로 확장할 수 있다.** ALB 구성은 그대로 두고 ASG 용량과
  태스크 수만 올린다(위 11번).

### Negative

- **기본값 `0.0.0.0/0`이면 ClickHouse와 RDS가 인터넷에 공개된다.** ClickHouse의 `default`
  유저는 비밀번호가 없고 `access_management=1`을 가진다(ADR-0019) - 8123에 닿을 수 있는
  주체는 사실상 관리자다. 운영에서는 SG가 그 유일한 방어선이었는데
  ([ADR-0014](0014-keep-clickhouse-in-app-subnet-for-mvp.md)), dev 기본값에서는 그 방어선이
  `0.0.0.0/0`이다. RDS도 마찬가지로 마스터 자격증명 무차별 대입에 노출된다.
  **`devAllowedCidr`을 지정하는 것이 사실상 필수이며, synth 경고가 그것을 상기시키는
  유일한 장치다.**
- **awsvpc 태스크에 인터넷 egress가 없다.** collector나 post-processor에 외부 API를
  호출하는 코드가 들어오면 **런타임에만 드러난다** - synth·test·deploy는 전부 통과하고
  기동도 성공하며, 그 코드 경로가 실행되는 순간 타임아웃으로 죽는다. ADR-0017·0018·0019가
  겪은 것과 같은 계열의 조용한 실패다.
- **dev와 prod의 네트워크 모드가 다르다.** dashboard가 dev에서는 bridge, 운영에서는
  Fargate awsvpc다. 따라서 **dev에서 통과한 것이 prod에서 통과한다는 보장이 완전하지
  않다** - 특히 컨테이너 간 통신 가정이 다르다. 다만 **collector는 양쪽 다 awsvpc**이므로
  `localhost:8080`이라는 가장 깨지기 쉬운 계약은 보존된다. 이건 우연이 아니라 위 4번에서
  의도적으로 그렇게 고른 결과다.
- **월 약 $78이 증가한다** (ap-northeast-2 기준 개략치).

  | 항목 | 월 |
  |---|---|
  | `t4g.medium` × 1 | 약 $24 |
  | `t4g.small` × 1 | 약 $12 |
  | EBS gp3 110GB (30+30+50) | 약 $9 |
  | RDS `db.t4g.micro` + 20GB | 약 $14 |
  | ALB | 약 $18 |
  | **합계** | **약 $78** |

  NAT를 두었다면 약 $113이었을 것이다.
- **데이터가 유실된다.** ClickHouse는 로컬 EBS에 있고
  ([ADR-0006](0006-accept-local-ebs-durability-for-mvp.md)과 같은 구조), RDS는
  `backupRetention: 0`이다. 인스턴스 교체·스택 삭제 시 둘 다 사라진다. dev이므로
  **의도된 선택**이지만, dev에 재현하기 어려운 데이터를 쌓아두면 안 된다는 뜻이기도 하다.

## Follow-up

- **awsvpc 태스크에 인터넷 egress가 실제로 필요해질 때** → NAT 인스턴스(t4g.nano)와
  인터페이스 엔드포인트 중 하나를 별도 ADR로 결정한다. 트리거는 collector 또는
  post-processor가 VPC 밖을 호출하기 시작하는 시점이다.
- **dev 부하 테스트를 시작할 때** → `awsvpcTrunking` 계정 설정 옵트인과 오토스케일링
  정책(임계값, 쿨다운, 최대 태스크 수)을 별도로 기록한다. 계정 레벨 설정이라 이 레포의
  CDK 코드로는 표현되지 않으므로 런북에 남겨야 한다.
- **`DevDashboardTask`의 bridge 전제 - 컨테이너 간 localhost 의존이 없다 - 는 소스 미확보
  상태의 추정이다.** `api-server`와 `batch-processor`의 소스를 확보하지 못했으므로
  (`AGENTS.md` 3장) 실제로 서로를 localhost로 부르지 않는다고 단정할 수 없다. **배포 후
  로그로 확인하고, 틀렸다면 awsvpc로 전환한다** - 그 경우 인터넷 egress와 ECS Exec을 함께
  잃는다. 소스를 확보하면 ADR-0018이 `post-processor`에 했던 것과 같은 계약 점검을
  반복해야 한다.
- dev의 로그 그룹 보존 기간과 삭제 정책은 예약된 ADR-0020(로그 그룹 정책)이 환경별 차등을
  다룰 때 함께 정한다.

## Acceptance Criteria

- `npx cdk list -c env=dev`가 `DevNetworkStack` / `DevDataStack` / `DevApplicationStack` /
  `DevEdgeStack` **네 개만** 출력한다(운영 스택이 섞여 나오지 않는다).
- `npx cdk synth -c env=dev`의 산출물에 **NAT gateway가 0개**이고 서브넷 타입은
  **public 하나만** 있다.
- 태스크 정의 4개의 `NetworkMode`가 각각 **`awsvpc` / `bridge` / `bridge` / `awsvpc`** 로 고정되어
  있고, 테스트가 이를 어서션한다.
- `devAllowedCidr` 미지정 시 synth 경고 `infra:dev-open-ingress`가 뜨고, 지정 시 뜨지
  않는다.
- `test/dev/data-stack.test.ts`가 합성 템플릿의 `ExcludeCharacters`를 어서션한다
  (따옴표 없는 libpq DSN의 전제, ADR-0018).

## References

- [ADR-0004](0004-task-level-colocation.md) - 태스크 단위 co-location과 localhost 통신
- [ADR-0005](0005-cloud-map-private-dns-discovery.md) - Cloud Map A 레코드가 awsvpc를 요구
- [ADR-0011](0011-single-az-topology.md) - `maxAzs: 2`가 이중화가 아닌 하드 제약인 이유
- [ADR-0012](0012-aurora-postgresql-for-control-plane.md) - PostgreSQL 엔진과 `controlplane` DB 이름
- [ADR-0015](0015-arm64-fargate-for-cost-savings.md) - ARM64 통일
- [ADR-0016](0016-ssm-based-operator-access.md) - 호스트 SSM + `docker exec` 경로
- [ADR-0017](0017-inject-collector-config-via-env-provider.md) - collector config 주입과 배포 전 기동 게이트
- [ADR-0018](0018-post-processor-runtime-contract-via-derived-dsn-secret.md) - 파생 DSN 시크릿과 `ExcludeCharacters` 커플링
- [ADR-0019](0019-clickhouse-container-runtime-contract.md) - ClickHouse 컨테이너 환경변수와 고정 태그
- [ADR-0021](0021-dev-prod-environment-separation.md) - 이 토폴로지가 올라가는 환경 분리 경계
