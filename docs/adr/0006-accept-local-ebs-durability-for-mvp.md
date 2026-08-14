# 0006. ClickHouse 데이터 내구성 - MVP에서는 로컬 EBS 수용

## Status

Accepted (스냅샷 정책은 다음 단계)

## Context

ClickHouse 데이터는 인스턴스 로컬 EBS 볼륨(`/data/clickhouse`, `/dev/xvdb`)에 저장된다. Auto Scaling Group이 이 인스턴스를 교체하면 해당 볼륨과 함께 데이터가 유실된다.

## Decision

MVP 단계에서는 이 데이터 유실 리스크를 그대로 수용한다. DLM(Data Lifecycle Manager) 스냅샷 정책이나 인스턴스와 독립적으로 재연결 가능한 볼륨 도입은 정식 운영 전 단계에서 진행한다.

## Alternatives Considered

Decision이 "정식 운영 전 단계에서 진행한다"고 미뤄 둔 두 가지가 이 시점의 대안이었다.

- **DLM(Data Lifecycle Manager) 스냅샷 정책**: EBS 볼륨을 주기적으로 스냅샷해 복구 지점을 남기는 방안. 스냅샷 주기와 복구 절차를 함께 설계해야 해서, MVP 시점에는 도입하지 않고 정식 운영 전 단계로 미뤘다.
- **인스턴스와 독립적으로 재연결 가능한 볼륨**: Auto Scaling Group이 인스턴스를 교체해도 같은 볼륨을 다시 붙이는 구성. 같은 이유로 정식 운영 전 단계로 미뤘다.

## Consequences/Tradeoffs

### Positive

- 시연·개발 단계의 데이터는 재수집이 가능하다는 전제를 둔다.

### Negative

- 인스턴스 교체나 장애로 ClickHouse 데이터가 유실되어도 MVP 목적(고객사 사내 시연·검증)에는 치명적이지 않다고 판단한다.

## Follow-up

- 운영 전환 시점에는 반드시 이 결정을 재방문해야 한다.
- 정식 운영 전 DLM 스냅샷 정책 또는 인스턴스 독립 볼륨 도입.
