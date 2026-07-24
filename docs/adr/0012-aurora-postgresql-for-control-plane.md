# ADR-0012: 컨트롤 플레인 DB 엔진으로 PostgreSQL 검토

- **Status**: Proposed
- **Date**: 2026-07-26

## Context

현재 `DataStack`은 Aurora Serverless v2 PostgreSQL 16.6으로 `control` 데이터베이스를 생성한다. 이 구성은 CDK 구현 과정에서 먼저 만들어졌으며, PostgreSQL 엔진을 선택한 근거를 실제 컨트롤 플레인 스키마와 워크로드로 검증하지 않았다. ADR-0002와 ADR-0011도 Aurora PostgreSQL을 이미 정해진 전제처럼 참조하지만 엔진 선택 자체를 결정하지는 않는다.

현재 PostgreSQL을 유력 후보로 보는 주요 이유는 다음 두 가지다.

- **Row-Level Security(RLS)**: 테이블의 행 조회와 변경을 정책으로 제한해 애플리케이션의 조건절뿐 아니라 DB 엔진에서도 테넌트 경계를 통제할 수 있다. 다만 shared schema 여부와 tenant context 전달 방식은 아직 정해지지 않았다.
- **GIN(Generalized Inverted Index)**: JSONB나 전문 검색처럼 하나의 값에 여러 검색 키가 포함되는 쿼리를 인덱싱할 수 있다. 하지만 컨트롤 플레인의 실제 GIN 적용 대상과 쿼리는 아직 정해지지 않았다.

기술 기능 외에 팀의 경험도 결정을 어렵게 한다.

- 멘토는 MySQL을 사용한 경험이 있어 Aurora MySQL을 선택할 때의 도입 위험을 낮출 수 있다.
- 멘토는 Microsoft MVP 경력을 가진 Microsoft SQL Server DBA 전문가다. 인덱스 설계, 실행계획, 잠금과 동시성, 제약조건 등 일부 전문성은 PostgreSQL에도 이전할 수 있지만 PostgreSQL 고유의 운영 경험을 완전히 대체하지는 않는다.
- 팀원 중 한 명은 PostgreSQL을 프로젝트에서 사용한 경험이 없다. 초기 학습 비용과 운영 소유권을 누가 맡을지 확인해야 한다.

## Decision

컨트롤 플레인 DB 엔진의 현재 유력 후보로 PostgreSQL을 제안한다. RLS를 통한 엔진 수준의 테넌트 격리 가능성과 GIN을 통한 유연한 검색 가능성을 주요 검토 근거로 삼는다.

이 결정은 아직 확정하지 않는다. 멀티 테넌시 모델과 GIN 사용처가 미정이고, 실제 스키마와 워크로드 검증 및 팀의 운영 준비가 끝나지 않았으므로 `Proposed` 상태를 유지한다.

이 ADR의 범위는 PostgreSQL 엔진 선택에 한정한다. Aurora Serverless v2와 RDS PostgreSQL 중 어떤 배포 모델을 사용할지, PostgreSQL 16.6을 유지할지, `serverlessV2MinCapacity: 0.5`와 `serverlessV2MaxCapacity: 2`가 적절한지, `RemovalPolicy.DESTROY`를 유지할지는 별도 결정이다.

## Alternatives Considered

- **Aurora MySQL**: 멘토의 MySQL 경험을 직접 활용할 수 있고 Spring Data JPA 기반의 일반적인 CRUD를 구현하는 데 충분한 후보다. PostgreSQL RLS와 GIN을 실제 워크로드에서 사용할 가치가 확인되지 않는다면 MySQL이 팀의 학습 부담을 낮출 수 있으므로 추가 비교가 필요하다.
- **RDS PostgreSQL (non-Aurora)**: PostgreSQL 엔진의 장점은 유지하면서 Aurora Serverless v2보다 단순하고 저렴할 가능성이 있다. 이는 엔진 대안이 아니라 배포 모델과 비용 선택이므로 별도 검토 대상으로 남긴다.
- **DynamoDB**: 운영 부담과 자동 확장 측면의 장점이 있지만 컨트롤 플레인 데이터의 관계, 트랜잭션, 접근 패턴이 확정되지 않아 적합성을 판단할 수 없다.
- **ClickHouse로 통합**: 데이터 저장소를 하나로 줄일 수 있지만 트랜잭션 컨트롤 플레인과 텔레메트리 플레인을 분리하는 ADR-0002의 원칙을 포기해야 한다.

## Consequences

- 현재 `DataStack` 구현은 유력 후보와 일치하므로 조사 기간에는 코드를 유지할 수 있다.
- PostgreSQL 고유 기능을 사용하면 RLS 정책, GIN 인덱스, 쿼리와 마이그레이션이 엔진에 종속된다.
- PostgreSQL 경험이 없는 팀원의 학습과 운영 준비가 필요하다.
- 검증 결과 RLS와 GIN의 실질적 이점이 작거나 MySQL의 팀 적합성이 더 높다면 현재 구현을 Aurora MySQL 등으로 교체할 수 있다.
- 이 ADR은 현재 Aurora Serverless v2 구성의 비용, 용량, 버전, 삭제 정책을 정당화하지 않는다.

## Open Questions

- 컨트롤 플레인은 사용자, 조직, 프로젝트, API 토큰, 대시보드 설정 중 무엇을 저장하며 관계와 트랜잭션 경계는 어떻게 되는가?
- shared schema 기반 멀티 테넌시가 필요한가? 필요하다면 connection pool에서 tenant context를 안전하게 설정하고 RLS 우회 권한을 차단할 수 있는가?
- GIN이 필요한 실제 컬럼과 쿼리는 무엇이며, 쓰기 비용과 인덱스 크기를 포함해 일반 인덱스보다 유리한가?
- 같은 Spring Data JPA 워크플로를 PostgreSQL과 MySQL에서 실행했을 때 정확성, 구현 복잡도, 동시성, 마이그레이션, 성능 차이는 무엇인가?
- PostgreSQL의 스키마 변경, 백업과 복구, VACUUM과 autovacuum, 실행계획 분석을 누가 책임질 것인가?
- 멘토가 MySQL과 PostgreSQL 후보 검토 및 운영 설계에 어느 범위까지 참여할 수 있는가?

## Acceptance Criteria

다음 조건을 모두 확인한 뒤 `Accepted` 전환 여부를 결정한다.

- 실제 컨트롤 플레인 스키마와 대표 워크로드를 정의한다.
- RLS가 필요한 경우 connection pool을 포함한 테넌트 격리 테스트를 통과한다.
- 실제 GIN 후보 쿼리를 `EXPLAIN (ANALYZE, BUFFERS)`로 검증한다.
- 동일한 대표 워크플로를 PostgreSQL과 MySQL에서 공정하게 비교한다.
- 팀의 PostgreSQL 학습 계획과 운영 책임자를 정한다.
- Aurora Serverless v2와 RDS PostgreSQL의 MVP 비용 및 운영 부담은 별도 결정으로 기록한다.

## References

- [PostgreSQL 16 - Row Security Policies](https://www.postgresql.org/docs/16/ddl-rowsecurity.html)
- [PostgreSQL 16 - Index Types](https://www.postgresql.org/docs/16/indexes-types.html)
- [PostgreSQL 16 - JSONB Indexing](https://www.postgresql.org/docs/16/datatype-json.html#JSON-INDEXING)
- [Amazon Aurora - Aurora Serverless v2 작동 방식](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2.how-it-works.html)
