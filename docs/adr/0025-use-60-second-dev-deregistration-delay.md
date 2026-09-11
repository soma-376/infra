# 0025. 개발 MVP의 비-ClickHouse ALB 타깃에 60초 deregistration delay를 적용한다

## Status

Accepted — 부분 대체: [ADR 0026](0026-dev-backend-deployment-units-and-staged-migration.md)이 최종 dev 대상에
`telemetry-ingest`와 `enrollment-api`를 추가하고 collector·auth-proxy·dashboard를 단계적으로 제거한다.
신규 두 앱과 전환 중의 기존 dashboard는 60초를 사용하며 ClickHouse 300초는 그대로 유효하다.

## Context

dev의 auth-proxy, dashboard, collector, ClickHouse 서비스는 모두 ALB 타깃 그룹에
등록되어 있다. 네 서비스는 호스트 용량과 ENI 한도 때문에 `minHealthyPercent: 0`,
`maxHealthyPercent: 100`으로 기존 태스크를 먼저 내리고 새 태스크를 띄우는 교체 배포를
한다(ADR-0022). 이전 타깃은 새 태스크를 띄우기 전에 `draining` 상태를 거쳐
`unused`가 되어야 하고, Application Load Balancer의 deregistration delay 기본값은
300초다.

실제 관측 순서도 **기존 타깃의 connection draining 5분이 먼저 발생하고, 그 뒤에 새
태스크 배치·컨테이너 기동·health check가 진행되는 형태**였다. 두 구간이 직렬로
이어져 전체 배포가 10분을 넘겼다. 즉 새 컨테이너가 먼저 준비된 뒤 draining이 배포
완료 표시만 늦춘 것이 아니라, draining이 새 컨테이너 기동 구간의 시작 자체를
뒤로 밀었다.

앱 레포의 GitHub Actions는 `ecs wait services-stable`을 최대 10분 기다린다. 앞쪽의
connection draining이 이 시간의 절반을 먼저 사용하면서 뒤따르는 새 태스크 기동과
health check가 끝나기 전에 waiter가 만료될 수 있다. 단순히 waiter 제한만 늘리면
오탐은 줄지만 실제 배포 피드백은 계속 느리고, 새 태스크 시작 전의 고정 대기는 남는다.

아직 서비스별 요청 시간, keep-alive 연결 수명, 배포 중 5xx와 실제 draining 시간을
충분히 측정하지 않았다. 따라서 지금 선택하는 값은 트래픽에서 도출한 최적값이나 용량
산정값이 아니며, AWS가 모든 HTTP 서비스에 권장하는 보편값도 아니다. MVP 개발 루프를
개선하기 위한 초기 기준과 이후 관측으로 재조정할 조건이 필요하다.

## Decision

- dev의 auth-proxy, dashboard, collector ALB 타깃 그룹에 deregistration delay 60초를
  적용한다.
- 60초는 MVP 초기 기준값이다. 실관측 최적값이나 AWS 공식 권장값으로 설명하지 않는다.
- ClickHouse는 직접 쿼리 엔드포인트이고 연결 및 요청 수명이 일반 HTTP 서비스와 다를
  수 있으므로 이번 단축에서 제외한다. 명시적으로 값을 덮어쓰지 않아 AWS 기본값
  300초를 유지한다.
- prod 타깃 그룹도 현재 기본값 300초를 유지한다. dev 관측 없이 같은 값을 운영으로
  확대하지 않는다.
- 값은 `lib/dev/config.ts`의 `DEV_DEREGISTRATION_DELAY`에 두고
  `ApplicationTargetGroup.deregistrationDelay` L2 속성으로 적용한다.

## Constraints

- 값 또는 적용 대상을 바꾸기 전에 배포 시간, target health의 `draining`에서
  `unused` 전환, ALB target 5xx와 connection error, 요청 지연을 함께 확인한다.
- ClickHouse나 prod로 적용 범위를 넓히는 변경은 이 ADR의 결정을 재검토한 뒤 진행한다.
- deregistration delay는 새 요청 라우팅을 중단한 뒤 진행 중 요청을 보호하는 최대
  대기 시간이다. 배포 시간만 보고 0초에 가깝게 줄이지 않는다.

## Alternatives Considered

**기본값 300초 유지.** 진행 중 요청을 보호하는 가장 보수적인 선택이지만, 새 태스크를
띄우기 전에 약 5분의 고정 대기를 남기고 10분 waiter가 뒤따르는 기동·health check
완료 전에 만료될 위험을 해결하지 못한다.

**0초 적용.** 배포 완료는 가장 빨라지지만 진행 중 요청과 keep-alive 연결을 보호할
시간이 없어 MVP 초기값으로도 과도하다.

**GitHub Actions waiter만 연장.** 워크플로 오탐은 줄일 수 있지만 ECS 안정화 자체는
빨라지지 않고, 배포 실패를 확인하는 피드백 시간도 함께 늘어난다.

**지금 서비스별 값을 따로 최적화.** 최종적으로 바람직하지만 서비스별 요청 및 연결
수명 데이터가 없어 숫자를 나누는 근거가 없다. 먼저 세 일반 HTTP 서비스에 같은 60초를
적용하고 관측 데이터를 모은다.

## Consequences/Tradeoffs

### Positive

- 새 태스크 기동 전에 발생하던 최대 5분의 draining 대기를 1분으로 줄여 뒤따르는
  태스크 배치·컨테이너 기동·health check를 더 일찍 시작한다.
- 10분 waiter가 정상 배포를 실패로 판정할 가능성을 낮춘다.
- dev와 세 일반 HTTP 서비스에만 제한해 운영 및 ClickHouse로 위험이 전파되지 않는다.

### Negative

- 60초가 넘는 진행 중 요청이나 오래 유지되는 연결은 배포 중 끊기거나 5xx로 끝날 수
  있다.
- 실관측 근거가 없는 잠정값이므로 장기 정책으로 오해하면 서비스별 트래픽 특성을 놓친다.
- dev와 prod의 target group 속성이 달라져 dev 검증 결과를 prod에 그대로 일반화할 수
  없다.

## Follow-up

- dev 배포에서 ECS 서비스 안정화 소요 시간과 target health 전환 시간을 기록한다.
- ALB의 `HTTPCode_Target_5XX_Count`, `TargetConnectionErrorCount`, `TargetResponseTime`과
  애플리케이션 오류 로그를 배포 전후로 비교한다.
- 60초를 넘는 정상 요청이나 배포 중 5xx 증가가 관측되면 값을 늘리거나 서비스별로
  분리한다.
- prod 적용 또는 ClickHouse 단축 전에 위 관측 결과로 이 결정을 재검토한다.

## Acceptance Criteria

- dev의 auth-proxy, dashboard, collector 타깃 그룹만
  `deregistration_delay.timeout_seconds=60`을 합성한다.
- dev ClickHouse와 prod 타깃 그룹에는 새 속성이 생기지 않는다.
- 기존 리소스 logical ID와 스택 경계는 바뀌지 않는다.
- 전체 테스트와 prod/dev/cicd synth가 통과한다.

## References

- [AWS - Edit target group attributes for your Application Load Balancer](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-target-group-attributes.html)
- [AWS - Optimize load balancer connection draining parameters for Amazon ECS](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/load-balancer-connection-draining.html)
- [ADR-0022](0022-dev-infrastructure-topology.md) - dev ECS 교체 배포와 ALB 타깃 구성
- [ADR-0023](0023-dev-auth-proxy-between-alb-and-collector.md) - dev auth-proxy와 Collector 경로
- [ADR-0024](0024-github-actions-oidc-deploy-roles.md) - 앱 레포의 ECS 강제 배포 범위
