# ADR-0013: Raw Signal 보존 정책 - MVP에서는 최근 30일만 복구

- **Status**: Proposed
- **Date**: 2026-07-26

## Context

Raw Signal S3 버킷은 [ADR-0006](0006-accept-local-ebs-durability-for-mvp.md)에서 수용한 ClickHouse 데이터 유실이나 처리 오류가 발생했을 때 신호를 다시 처리하기 위한 복구 원본이다. 현재 버킷은 객체를 30일 동안 보관한 뒤 만료시키며, 다른 S3 스토리지 클래스로 전환하는 lifecycle 규칙은 두지 않는다.

장기 아카이빙은 S3 Standard보다 낮은 저장 단가를 제공할 수 있지만 비용이 없어지는 것은 아니다. 스토리지 클래스 전환 요청, 최소 보관기간, 복구 요청과 대기시간, 복구 절차 및 모니터링까지 관리해야 한다. 고객사 사내 시연과 검증이 목적인 MVP에서 이 운영 범위를 미리 도입하면 현재 가치에 비해 관리 부담이 커진다.

## Decision

MVP에서는 Raw Signal을 S3 Standard에 30일 동안 보관한 뒤 영구 만료시킨다. S3 Standard-IA, S3 Intelligent-Tiering, S3 Glacier 계열로 전환하거나 별도의 장기 아카이브를 만들지 않는다.

이에 따라 ClickHouse 장애 또는 처리 오류 시 보장하는 재처리 범위는 최근 30일로 제한한다. 30일이 지난 Raw Signal과 그 신호에서 생성된 ClickHouse 데이터는 복구할 수 없다는 위험을 수용한다.

이 결정은 평상시 lifecycle 보존 정책만 다룬다. CloudFormation 스택 삭제 시 적용되는 `autoDeleteObjects`와 `RemovalPolicy.DESTROY`는 이 ADR의 범위에 포함하지 않는다.

## Alternatives Considered

- **S3 Standard에 장기 보관**: 복구 절차는 단순하지만 데이터가 계속 누적되어 저장 비용이 증가하므로 기각.
- **S3 Standard-IA 또는 S3 Intelligent-Tiering으로 전환**: 접근 빈도가 낮을 때 저장 비용을 줄일 수 있지만 Standard-IA의 최소 보관기간과 전환 요청, Intelligent-Tiering의 객체별 모니터링, 공통적인 정책 관리가 추가된다. 30일 복구 범위만 요구하는 MVP에서는 실익이 작아 기각.
- **S3 Glacier 계열에 장기 아카이빙**: 장기 저장 단가는 낮출 수 있지만 최소 보관기간, 복구 비용과 대기시간, 별도의 복구 운영 절차가 필요하므로 기각.
- **30일보다 짧게 보관하거나 즉시 삭제**: 비용과 보관 부담은 줄지만 ClickHouse 장애와 처리 오류를 발견하고 재처리할 시간을 충분히 확보하기 어려워 기각.

## Consequences

- lifecycle 정책과 복구 절차를 단순하게 유지할 수 있다.
- Raw Signal 저장량은 최근 30일 범위로 제한된다.
- 최근 30일의 Raw Signal이 남아 있는 경우에만 ClickHouse 데이터를 재처리할 수 있다.
- 30일을 초과한 데이터에 대한 복구, 감사, 고객 보존 요구는 충족하지 못한다.
- 아카이빙을 도입하지 않으므로 아카이브 스토리지 비용, 전환 요청, 복구 운영 부담이 발생하지 않는다.

## Open Questions

- 애플리케이션의 재처리 경로가 Raw Signal만으로 ClickHouse 데이터를 재구성할 수 있는지 실제로 검증해야 한다.
- 예상 객체 크기, 객체 수, 월간 수집량을 측정해 30일 보존 비용이 MVP 예산에 적합한지 확인해야 한다.
- 최근 30일이라는 복구 범위를 팀과 이해관계자가 수용하는지 확인해야 한다.

## Revisit Trigger

정식 운영 전환, 고객의 보존 또는 감사 요구 발생, 30일을 초과하는 복구 요구 발생, 실제 S3 비용이 MVP 예산에서 유의미한 부담이 되는 시점에 보존 기간과 아카이빙 도입을 재검토한다.
