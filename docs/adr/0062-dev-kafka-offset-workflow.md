# 0062. dev Kafka offset 작업은 기존 operator 권한의 수동 workflow로 실행한다

## Status

Accepted (PROJ-288; 코드·로컬 검증과 실제 권한 배포·Job 실행은 구분한다)

## Context

dev Kafka는 Strimzi가 관리하며 topic은 `KafkaTopic`이 소유한다. 기존
`telemetry-kafka-admin` chart는 consumer group이 비었을 때 offset 계획과 실행을 수행하지만,
운영자가 매번 접속·values 준비·Job 생성·로그 확인을 직접 해야 한다.

Argo CD는 이 수동 Job을 관리하지 않는다. PROJ-288은 현재 dev main의 offset 작업을 GitHub Actions에서
명시적으로 실행할 경로만 추가한다. Kafka 로직이나 자동 복구 절차는 늘리지 않는다.

## Decision

1. `develop`의 `workflow_dispatch`로만 실행하고 기존 `infra-dev-deploy` Environment 승인과
   `CDK_DEPLOY_ROLE_ARN`을 사용한다. 대상은 dev Strimzi main 한 곳이다.
2. 입력은 `mode`(`plan` 기본값 또는 `execute`)와 `partition`·`toOffset` 쌍 또는 `toDatetime`이다.
   계획을 검토한 운영자가 같은 입력으로 `execute`를 별도 실행한다. 자동 실행·자동 재시도는 하지 않는다.
3. 기존 infra deploy 역할이 기존 EKS operator 역할을 assume하도록 허용한다. operator의 private EKS·SSM
   접근과 cluster-admin 권한을 재사용하며 별도 실행 역할·Kubernetes RBAC는 만들지 않는다.
   ADR 0056의 일반 publisher는 계속 Kubernetes에 쓰지 않으며, 이 권한은 명시적 수동 운영 workflow에서 사용한다.
4. `DevEksStack` output과 `DescribeCluster`로 대상·endpoint·CA를 확인하고 기존 SSM 터널을 연다.
   Strimzi CA와 main 사용자 4개의 metadata만 읽어 기존 파서로 TLS revision을 계산한다.
   bootstrap·stage·topic·group·TLS 참조로 admin values를 만들며 private values 저장소는 조회하지 않는다.
5. 고정 Helm 3.22.0으로 기존 chart를 렌더한다. `telemetry-kafka-offsets` ServiceAccount와 offset Job만
   선택하고 나머지 리소스는 적용하지 않는다. ServiceAccount는 없을 때만 생성하고 기존 객체는 변경하지 않는다.
   Job의 이름을 제거하고 `telemetry-offsets-<mode>-` generateName으로 한 번 생성한다.
   Pod label·Secret mount·고정 이미지·10분 deadline·재시도 0회·24시간 TTL은 chart 값을 유지한다.
6. 생성한 Job의 완료를 기다리고 그 Job의 로그만 출력한다. 실패나 timeout에도 로그를 확인하고 실패로 종료한다.
   Secret 원문·임시 자격증명·kubeconfig를 로그나 artifact로 남기지 않는다.
7. Argo 자동화 중지·진행 operation 종료 확인, consumer 중지, 작업 후 consumer 재개·기능 확인·자동화 복원은
   운영자가 수행한다. 기존 Job의 활성 group 거부·오류 출력 검사·실행 후 committed offset 대조를 그대로 사용한다.

## Alternatives Considered

- Argo hook으로 실행: 일반 sync가 offset을 바꾸지 않도록 수동 실행 경계를 유지한다.
- private generated values 조회: 별도 Git 인증과 revision 선택을 추가하지 않고 현재 AWS output과 metadata로 필요한 값만 만든다.
- 전용 IAM 역할과 Kubernetes RBAC: 최소 구동을 위해 이미 운영에 사용하는 operator 권한을 재사용한다.
- chart 전체를 Helm release로 설치: 고정 ServiceAccount의 기존 Helm 소유권과 충돌할 수 있어 필요한 두 객체만 생성한다.

## Consequences/Tradeoffs

### Positive

기존 Kafka 검사와 chart를 재사용하고 추가 상태 저장소·배포 컨트롤러 없이 수동 계획과 실행을 제공한다.
Argo 선언과 Helm release 소유권을 바꾸지 않는다.

### Negative

infra deploy 역할은 operator를 assume해 cluster-admin을 사용할 수 있다. GitHub Environment 승인·branch 보호가
실행 경계이며 최소 권한의 전용 Job 역할을 제공하는 것은 아니다. consumer와 Argo 자동화의 중지·복원은 여전히
운영자 책임이다. 서로 다른 실행의 plan과 execute가 같은 Kafka 보존 상태를 보장하지 않는다.

## Acceptance Criteria

- 입력 조합과 dev main 대상만 허용하며 chart에서 offset ServiceAccount·Job만 선택한다.
- 기존 ServiceAccount는 변경하지 않고 Job은 고유 이름으로 생성한다. 실패 시 로그 확인 후 실패를 유지한다.
- 역할 trust와 assume 대상이 기존 infra deploy·operator로 제한되고 다른 환경·일반 publisher 동작을 바꾸지 않는다.
- 로컬 테스트 통과와 별도로 역할 배포, Environment 설정, 실제 plan·execute 결과를 운영 기록으로 남긴다.

## References

- [ADR 0034: private EKS와 SSM 접근](0034-dev-eks-private-api-via-ssm-relay.md)
- [ADR 0049: Strimzi와 수동 offset 작업](0049-dev-strimzi-kafka-and-staged-msk-retirement.md)
- [ADR 0056: Argo 관리와 수동 운영 경계](0056-dev-argocd-gitops-operations.md)
- [dev Strimzi 운영 런북](../runbooks/dev-strimzi-kafka.md)
