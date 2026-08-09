# 0000. Use ClickHouse for Analytics

## Status
Accepted

## Context
우리 서비스는 사용자 행동 이벤트를 시간 기준으로 집계하고,
팀/프로젝트/모델별 사용량을 빠르게 조회해야 한다.

## Decision
분석용 저장소로 ClickHouse를 사용한다.

## Alternatives Considered
- PostgreSQL
- Elasticsearch
- BigQuery

## Consequences/Tradeoffs
### Positive
- 대량 이벤트 분석 쿼리에 적합하다.
- 시간 기반 집계와 dashboard query에 유리하다.

### Negative
- 운영 복잡도가 증가한다.
- OLTP성 업데이트에는 적합하지 않다.

## Follow-up
MVP에서는 raw event table과 daily aggregate table만 운영한다.