# 0041. dev dashboard 조회 권한 복구는 검증된 명시 허용목록으로 분리한다

## Status

Accepted (PROJ-262의 수동 복구 준비·로컬 검증 범위. dev 적용은 별도 승인 후 실행)

[ADR-0031](0031-manage-dev-dashboard-and-jwt-secrets-with-cdk.md)의 DB 계정·비밀 수명과 운영자 수동 적용 책임을 유지한다.
일반 배포·앱 시작·CDK가 DB grant를 변경하지 않는다.

## Context

기존 dev dashboard 역할에 `enrollment` USAGE와 reader SELECT가 없어 인증·조회와 알림 평가가 실패했다.
Secret과 앱 배포가 성공해도 별도 DB 권한 준비는 보장되지 않는다. 기존 런북의 넓은 default privileges와
`vendor_connections` 테이블 SELECT 예시를 그대로 적용하면 필요 없는 미래 테이블·암호문 열도 열 수 있다.

## Decision

- 이미 존재하는 source/cache 역할의 누락된 USAGE·SELECT만 복구한다. 계정·암호·소유자·DDL은 바꾸지 않는다.
- backend `42316d6d8b85365639c928de80dd4f8e0879b721` reader에 근거한 29개 테이블과
  `vendor_connections`의 비밀 아닌 18개 열만 source에 허용한다. 선택 목록뿐 아니라 WHERE의 `deleted_at`도 포함한다.
- cache는 원천에서 `telemetry_ops.tenant_retention_boundary`만 읽는다. enrollment runtime은
  `dashboard_cache.alerts`만 추가로 읽는다. 이미 유효한 권한은 중복 부여하지 않는다.
- 미래 테이블에 대한 default privileges는 만들지 않는다. migration으로 reader가 바뀌면 허용목록을 함께 리뷰한다.
- 자격증명 테이블·암호문 열, 원천 쓰기, 원천 schema CREATE, 광범위 role membership으로 우회하지 않는다.
  이미 과다 권한이 있으면 준비 도구는 중단하며 자동 REVOKE하지 않는다.
- 추적된 도구는 읽기 전용 catalog 검사와 검토 가능한 SQL 생성만 한다. 적용은 운영자가 명시적으로 실행한다.
  사전 catalog 상태를 SQL에 고정하고, 검증 후 관측된 ACL 추가분만 회수하는 복구 SQL을 만든다.
  동시 권한 변경이나 대상 교체가 있으면 적용·복구를 중단하고 새 증빙으로 다시 준비한다.

## Alternatives Considered

- 모든 테이블·미래 테이블 SELECT: 비밀·추가 기능 데이터까지 접근하므로 채택하지 않는다.
- master credential을 dashboard에 공유: source/cache 분리를 무너뜨리므로 채택하지 않는다.
- 앱 migration 또는 CDK에서 자동 grant: 운영자 승인·권한 수명 경계를 바꾸므로 채택하지 않는다.

## Consequences/Tradeoffs

### Positive

- 허용목록에 명시한 테이블·열의 필요한 읽기 권한만 복구한다. 암호문 열·자격증명 테이블·미래 테이블은 제외한다.

### Negative

- 조회 계약이 바뀌면 허용목록과 로컬 실제 API 검증도 갱신해야 한다.
- 권한 상태에 종속된 생성 SQL은 재사용 가능한 배포 원본이 아니며 추적된 도구와 계약이 원본이다.
- 복구하면 원래 조회 장애가 다시 나타날 수 있다.

## Acceptance Criteria

로컬 PostgreSQL에서 누락 오류, 복구 후 조회, source 쓰기·암호문 조회 거부, 중복 준비의 무변경,
권한 drift 차단, 복구 후 기존 ACL 보존을 확인한다. 별도로 실제 dashboard 로그인·API 시나리오를 검증한다.
ClickHouse 설정·앱 이미지·조회 한도·기존 데이터는 이 변경 대상이 아니다.
