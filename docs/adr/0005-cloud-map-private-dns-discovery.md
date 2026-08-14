# 0005. 서비스 디스커버리 - Cloud Map 프라이빗 DNS

## Status

Accepted

## Context

Fargate 태스크는 awsvpc 네트워크 모드로 동작하며 IP가 유동적이다. 따라서 ClickHouse EC2 태스크의 주소를 Fargate 태스크 쪽에 하드코딩할 수 없다.

## Decision

Cloud Map 프라이빗 네임스페이스(`obs.local`)를 생성하고, ClickHouse 서비스를 A레코드(`clickhouse.obs.local`)로 등록한다. ClickHouse 태스크도 이 A레코드 등록을 위해 awsvpc 네트워크 모드로 실행한다.

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
