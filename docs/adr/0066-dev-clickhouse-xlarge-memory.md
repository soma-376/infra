# 0066. dev ClickHouse를 m7g.xlarge 노드와 13Gi 메모리로 키운다

## Status

Proposed (PROJ-339; [ADR 0063](0063-dev-pipeline-resource-sizing.md)의 ClickHouse 노드 타입·메모리·CPU 예산만 부분 대체한다. 실제 dev 반영·재측정은 별도다.)

ADR 0063의 Gateway·ingest 사양과 anti-affinity, apps NodePool(`t4g.large`, CPU 예산 8),
ClickHouse CPU request 1500m·CPU 제한 없음·단일 Pod StatefulSet 순차 교체·AZ·taint·PVC는 그대로 유효하다.

## Context

2026-11-20 dev 파이프라인 부하 시험([PROJ-192](https://team376.atlassian.net/browse/PROJ-192),
[ADR 0064](0064-dev-pipeline-loadtest.md))에서 ingest concurrency를 6으로 올린 뒤
50 RPS부터 ClickHouse가 `Memory limit (total) exceeded … maximum 5.40 GiB`(Code 241)로 INSERT를 거부했다.
ingest 소비는 약 45 레코드/초에서 평평해졌고 90 RPS 단계에서 시험을 멈췄다. 재시도로 데이터 손실은 없었다.

- ClickHouse 자체 상한은 컨테이너 메모리 한도의 90%(`max_server_memory_usage_to_ram_ratio`)라 6Gi에서 5.40GiB다.
- 메모리는 outdated part(merge로 대체된 뒤 `old_parts_lifetime` 480초 동안 남는 part) 수에 비례했다.
  part당 약 70~80KB, 소비 45/초에서 새 part 91/초, outdated 약 55,000개에서 5.4GiB였다.
- ClickHouse CPU는 80 RPS에서 약 1.8 core로 `m7g.large`(2 vCPU)에 가까웠다.
- `m7g.large`(할당 가능 약 6.9GiB)에서는 컨테이너 한도를 더 올릴 여유가 없다.

## Decision

| 대상 | 노드 | CPU request | 메모리 request | CPU limit | 메모리 limit | NodePool CPU 예산 |
|---|---|---:|---:|---:|---:|---:|
| ClickHouse | `m7g.xlarge`(4 vCPU·16GiB) | 1500m | 13Gi | 없음 | 13Gi | 8 |

- ClickHouse NodePool은 `m7g.xlarge`만 허용한다. 인스턴스 타입은 platform base values의 풀별 `instanceType`으로 둔다.
- CPU 예산 8은 정상 1대(4)와 교체 중 옛 노드(2 또는 4)를 함께 수용하기 위한 값이다.
- 메모리 13Gi는 노드 할당 가능량(약 14GiB)에서 시스템·DaemonSet 여유를 뺀 값이다. ClickHouse 자체 상한은 약 11.7GiB가 된다.
- 공식 runtime 입력과 chart 스키마의 허용 조합에 1500m/13Gi(CPU 제한 없음)를 더한다. 6Gi 조합은 되돌림용으로 남긴다.

## Alternatives Considered

- **`old_parts_lifetime` 단축(예: 60초):** 같은 부하에서 outdated part가 약 1/8로 줄어 메모리 원인을 직접 줄인다.
  갑작스런 재시작 때 fsync되지 않은 merge 결과를 지키는 구간이 짧아진다. 이번에는 사양 여유를 먼저 확인하고 별도로 다룬다.
- **ingest 일괄 INSERT:** part 수 자체를 줄이는 근본 대책이다. backend ADR 0024의 fence·`async_insert = 0` 제약 안에서 설계가 필요해 이번 범위 밖이다.
- **m7g.large 유지·한도 7Gi:** 할당 가능량을 넘겨 배치되지 않는다.

## Consequences/Tradeoffs

### Positive

- 같은 원인에서 ClickHouse 메모리 여유가 약 2배(5.40 → 약 11.7GiB), CPU가 2배(2 → 4 vCPU)가 된다.
- 다음 부하 시험에서 ClickHouse 다음 병목을 볼 수 있다.

### Negative

- ClickHouse 노드 비용이 약 2배(약 +$82/월)다.
- 반영 때 ClickHouse 노드가 교체되며 몇 분 중단된다. 그 사이 ingest 재시도가 소진된 dev 레코드는 ClickHouse 적재가 빠질 수 있다(원본은 S3 아카이브).
- outdated part 누적은 그대로라 부하가 더 오르면 다시 상한에 닿는다.

## Follow-up

- `old_parts_lifetime` 단축과 일괄 INSERT 중 근본 대책을 정한다.
- system 로그 테이블(`text_log`·`trace_log`·`metric_log` 등)에 TTL이 없어 디스크가 계속 는다. 보존 정책을 정한다.

## References

- [ADR 0063](0063-dev-pipeline-resource-sizing.md), [ADR 0064](0064-dev-pipeline-loadtest.md)
- [부하 시험 런북](../runbooks/dev-pipeline-loadtest.md) §10
