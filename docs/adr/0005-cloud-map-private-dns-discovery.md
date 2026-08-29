# 0005. 서비스 디스커버리 - Cloud Map 프라이빗 DNS

## Status

Accepted

## Context

Fargate 태스크는 awsvpc 네트워크 모드로 동작하며 IP가 유동적이다. 따라서 ClickHouse EC2 태스크의 주소를 Fargate 태스크 쪽에 하드코딩할 수 없다.

## Decision

Cloud Map 프라이빗 네임스페이스(`obs.local`)를 생성하고, ClickHouse 서비스를 A레코드(`clickhouse.obs.local`)로 등록한다. ClickHouse 태스크도 이 A레코드 등록을 위해 awsvpc 네트워크 모드로 실행한다.

등록 대상 목록의 권위는 `lib/common/config.ts`의 상수(`CLICKHOUSE_SERVICE_NAME`·`COLLECTOR_SERVICE_NAME` 등)이며, 이 ADR은 등록 **메커니즘**만 정한다 — 등록 대상은 앞으로도 늘어나는 목록이라 ADR이 들고 있으면 낡는다.

## Alternatives Considered

- **내부 ALB/NLB 도입**: 리소스와 비용이 추가로 발생해 기각.
- **인스턴스 IP를 환경변수로 주입**: 인스턴스가 교체되면 즉시 깨지는 구성이라 기각.
- **bridge 모드 + SRV 레코드**: 클라이언트 쪽 복잡도가 증가해 기각.

## Consequences/Tradeoffs

### Positive

- t4g.small 인스턴스의 ENI 한도(3개) 내에서 ClickHouse 태스크 1개를 awsvpc 모드로 돌리는 것은 문제가 없다.
- Fargate 태스크들은 ClickHouse를 `clickhouse.obs.local:8123`(HTTP) 및 `9000`(네이티브) 포트로 접근한다.

### Negative

- 다만 같은 인스턴스에 태스크를 추가로 배치할 계획이 생기면, ENI 트렁킹 또는 bridge 모드 전환을 재검토해야 한다.

## References

- [ADR 0021](0021-dev-prod-environment-separation.md) 5번 — dev와 prod는 **같은 이름의 서로 다른 네임스페이스**를 쓴다(private DNS는 VPC 스코프라 충돌하지 않고, 그 덕에 `CLICKHOUSE_HTTP_URL`이 양쪽에서 한 값으로 유지된다).
- [ADR 0023](0023-dev-auth-proxy-between-alb-and-collector.md) 1번 — `DevCollectorService`가 `collector.obs.local` A레코드를 등록한다(**dev 전용** — prod `CollectorService`에는 아직 `cloudMapOptions`가 없다).
