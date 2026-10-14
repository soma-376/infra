# 0030. dev 사용자 JWT 키는 별도 Secrets Manager 원본에서 버전을 지정해 파일로 공급한다

## Status

Accepted (공급 결정 채택, 초기화 도구·CDK·Helm 구현과 AWS 배포·기능 검증은 후속 작업)

[ADR-0028](0028-dev-eks-auto-mode-transition.md)의 기존 Secret 3개만 참조하는 목록과
[ADR-0029](0029-dev-dashboard-api-ecs-and-eks-deployment.md)의 공개키 이미지 포함 또는 mount 선택을
JWT 공급 범위에서 부분 대체한다. 기존 DB·HMAC·관리자 Secret, prod, EKS 기반 구성과 배포 소유 경계는 유지한다.
키 생성·형식·수명·교체 공통 계약은 [허브 ADR-0022](../../../docs/adr/0022-user-jwt-key-provisioning.md)가 소유한다.

## Context

backend `UserAuthConfig.userJwt()`와 `SecurityConfig.dashboardAuthenticator()`는 기동 시 파일을 읽는다.
enrollment는 개인키로 RS256 JWT를 발급하고 공개키로 검증하며 dashboard는 공개키만으로 검증한다.
`UserJwt`는 PKCS8 개인키·X.509 공개키, RSA 2048bit 이상과 활성 `kid` 공개키의 존재·개인키 modulus 일치를 요구한다.
완전한 키쌍 검증은 초기화 단계의 시험 서명·검증으로 별도 확인한다.
저장소 값이나 mount 파일이 바뀌어도 이미 기동한 앱이 키를 자동으로 다시 읽지는 않는다.

현재 문서 브랜치의 `DevDataStack`은 기존 실제 Secret 3개만 생성하고, `DevApplicationStack`은
JWT 키 파일 공급을 구현하지 않는다. PROJ-207~211 누적 EKS 코드의 ASCP/configtree도 기존 두 앱 설정용이다.
문서 결정 채택을 해당 코드·Secret·배포의 존재 증거로 사용하지 않는다.

## Decision

### 1. 원본과 수명

환경마다 개인키와 공개키의 고정 Secret ARN 두 개를 사용하고 값은 버전으로 관리한다.
dev ECS/EKS는 동일 원본을 소비한다. 암호화는 AWS 관리형 `aws/secretsmanager`를 사용하며
이 결정에서 customer managed KMS key나 자동 회전을 추가하지 않는다.

개인키 SecretString은 PKCS8 PEM이고, 공개키 SecretString은 `kid → X.509 PEM` JSON 키링이다.
개인키와 공개키를 같은 Secret의 JSON 필드로 합치지 않는다. 필드별 mount는 Secret 전체 조회 권한을 분리하지 못한다.
enrollment는 두 ARN, dashboard는 공개키 ARN만 읽으며 ingest에는 JWT Secret 권한·mount를 추가하지 않는다.

최초 키쌍은 명시적인 초기화 작업에서 한 번 생성·검증·등록한다. `GenerateSecretString`의 임의 문자열을
RSA 키로 사용하거나 앱 시작·일반 재배포·CDK synth에서 키를 생성하지 않는다.
등록한 두 VersionId와 키쌍·`active-kid` 검증이 완료되기 전에는 배포 참조를 확정하지 않는다.
두 Secret 쓰기는 원자적 작업이 아니다. 한쪽 등록 실패 시 준비한 같은 키쌍과 작업 식별자로 복구하며,
새 키쌍을 자동 생성해 이미 등록한 값과 섞지 않는다.

초기화·버전 등록·label 보존·삭제는 운영자가 별도 관리하고 CDK는 ARN 참조·IAM·전달 구성만 소유한다.
앱 stack destroy나 이미지 교체가 키 원본 삭제를 유발하지 않게 한다. 같은 이름으로 Secret을 삭제·재생성해도
ARN은 유지되지 않으므로 고정 ARN 원본을 보존한다. 향후 IaC로 원본을 관리한다면 별도 보존 결정이 선행해야 한다.

### 2. 재현 가능한 배포 입력

릴리스마다 다음 참조를 하나의 배포 기록으로 묶어 검토한다. 저장소 문서·예시·공유 증거에는 실제 계정 ID를
적지 않고 ARN의 account 부분을 placeholder로 표시한다. 실제 ARN은 승인된 접근 제한 배포 입력에서 확정한다.
Secret 원문·JWT는 어느 배포 기록에도 남기지 않는다.

| 입력 | 소비·검사 |
|---|---|
| 개인키 ARN·VersionId | enrollment writer 또는 CSI만 조회 |
| 공개키 ARN·VersionId | 모든 enrollment·dashboard verifier가 지정 버전 소비 |
| `active-kid` | enrollment signer의 활성 키, 공개키 JSON과 파일 맵에 존재 |
| `kid → 파일 경로` 맵 | 지정 공개키 버전의 모든 필요한 `kid`와 추출 alias 대조 |
| issuer·audience·이미지 digest·배포 revision | ECS/EKS 간 인증 조건과 복구 참조 대조 |

VersionId를 지정한 배포는 이동 가능한 `AWSCURRENT`만으로 키를 선택하지 않는다.
writer의 VersionStage나 SPC의 `objectVersionLabel`에 이동하는 label을 VersionId와 함께 지정하지 않는다.
VersionId를 기록하는 것만으로 버전 보존은 보장되지 않는다. 운영자는 활성·교체 중·롤백용 버전에
staging label을 유지하고, 관련 배포와 rollback 지원 기간이 끝나기 전에는 label을 제거하지 않는다.
두 Secret의 label 이름이 같아도 원자적 일괄 전환을 뜻하지 않는다. 배포 기록의 VersionId 조합으로 정합을 판단한다.

`PULSEMETRY_USER_AUTH_PRIVATE_KEY_FILE`은 enrollment 개인키 파일 경로다.
`PULSEMETRY_USER_AUTH_PUBLIC_KEY_FILE`은 기존 `local` 공개키 맵의 경로만 바꾼다.
임의 `kid` 또는 복수 키에는 `pulsemetry.user-auth.public-key-files`의 명시적 파일 맵을 제공한다.
PEM 원문을 환경변수·configtree 설정값·values·CloudFormation output에 넣지 않는다.

### 3. ECS EC2: 일회성 writer와 공유 volume

enrollment와 dashboard 각 task에 SDK로 지정 ARN·VersionId를 읽는 일회성 writer를 추가한다.
writer는 `essential: false`이고 앱은 writer의 `SUCCESS` 의존성을 사용한다. `START`나 `COMPLETE`만으로
앱을 시작하지 않는다. 조회·JSON/PEM 해석·맵 검증·파일 쓰기·권한 검사가 모두 성공한 뒤 exit 0으로 끝낸다.
EC2 ECS agent·ecs-init이 container dependency를 지원하는지 배포 전 확인한다.

장기 host `sourcePath`를 재사용하지 않는 task별 공유 volume을 사용한다. writer에는 쓰기 mount,
앱에는 읽기 전용 mount를 제공한다. 파일을 임시로 완성·검증한 뒤 최종 경로로 게시하고,
앱 UID 10001의 파일 읽기와 상위 directory 접근 권한을 모두 확인한다. writer의 소유권 설정 권한은
초기화에만 사용한다. 빈 파일·누락·잘못된 PEM·alias 충돌·경로 탈출을 성공으로 처리하지 않는다.
파일이나 SDK 응답·예외 원문을 stdout/stderr에 출력하지 않는다. task 종료 직후 host 파일이 지워진다고
가정하지 않고 ECS volume 정리와 host 잔존 경계를 후속 구현에서 검증한다.

SDK 조회는 task role을 사용하며 execution role의 ECS 환경변수 Secret 주입과 구별한다.
enrollment task role에는 두 JWT ARN, dashboard task role에는 공개키 ARN만 읽기 허용한다.
동일 task의 writer와 앱은 task role을 공유하므로 writer만 개인키 조회 권한을 가진다고 표현하지 않는다.
EC2 host에 함께 있는 컨테이너도 강한 보안 격리 경계로 간주하지 않는다. ingest role과 CI 배포 역할에는
JWT 조회·값 등록·버전 변경 권한을 추가하지 않는다.

writer 이미지도 ARM64 artifact를 고정하고 timeout·조회 실패·exit code·재시도 종료를 검사한다.
기존 Spring 앱 1024 MiB 소프트 예약은 writer를 포함한 총 task 사용량이 아니다.
세 앱 합계 3072 MiB에 writer 예약·실제 peak·host 여유를 추가해 placement·메모리·OOM·교체 배포를 확인한다.
이번 ADR로 writer 메모리 숫자나 ASG 크기를 추정해 확정하지 않는다.

### 4. EKS: 버전 지정 ASCP/CSI 키 파일

기존 Pod Identity·ASCP·Secrets Store CSI 구성을 확장한다. enrollment 전용 ServiceAccount 역할은
두 JWT ARN, dashboard 전용 역할은 공개키 ARN의 조회만 허용한다. ASCP에 필요한
`secretsmanager:GetSecretValue`·`secretsmanager:DescribeSecret`을 해당 ARN으로 제한한다.
ingest의 ServiceAccount·SPC 권한은 기존 범위를 유지한다. Auto Mode에 Pod Identity agent를 중복 설치하지 않는다.

JWT SecretProviderClass는 `usePodIdentity: "true"`, 개인키·공개키 각각의 `objectVersion`에
배포 기록의 VersionId를 지정한다. 개인키는 PKCS8 PEM 파일로, 공개키 JSON은 `jmesPath`로
각 `kid`의 PEM을 별도 파일로 추출하고 `objectAlias`와 앱 파일 맵을 일치시킨다.
하이픈·점 등이 있는 `kid`는 JMESPath 인용 identifier로 적절히 escape한다. `kid`를 그대로 파일 경로로
사용하지 않고 검토한 alias를 사용한다. 공개키 JSON 파일 하나를 PEM 파일로 설정하지 않는다.

키 파일 mount는 기존 `configtree:/mnt/secrets-store/` 설정 파일 mount와 구별한다.
configtree 또는 앱 설정에는 PEM 대신 별도 키 mount의 경로와 파일 맵만 전달한다.
Kubernetes Secret 동기화·자동 회전·자동 reload는 사용하지 않는다. 고정 VersionId 변경은 SPC와
배포 입력을 함께 갱신한 뒤 Pod를 명시적으로 재생성해 적용한다.

UID 10001의 initContainer는 선택한 파일 맵 전체의 존재·비어 있지 않음·읽기와 directory 접근을
원문 출력 없이 검사한다. 권한 숫자나 `fsGroup` 선언만으로 CSI 소유권·접근을 보장하지 않는다.
실제 mount에서 UID 10001 접근을 확인하고 앱 기동의 PEM 해석·키 정합 검사와 분리해 기록한다.
앱과 검사 컨테이너 mount는 읽기 전용이며 dashboard Pod에는 개인키 원본·파일을 제공하지 않는다.

### 5. 교체와 복구

1. 새 개인키 버전과 구·신 공개키를 포함한 버전을 준비·검증하고 보존 label을 붙인다.
2. **모든 ECS/EKS enrollment·dashboard verifier**에 구·신 공개키와 명시적 파일 맵을 적용하고
   실제 신·구 키 서명 토큰 검증을 확인한다. 아직 구 개인키로 발급한다.
3. 모든 enrollment signer의 개인키 VersionId·`active-kid`를 함께 전환한다.
   구 signer가 더 이상 발급하지 않는 마지막 시각을 확인한다.
4. 마지막 구 키 발급 이후 **330초 이상** 기다리고 구 공개키를 제거한 버전·맵으로 모든 verifier를 재생성한다.
   Secret 갱신·첫 signer 전환 시각부터 대기 시간을 계산하지 않는다.

이는 현재 backend의 AT 300초와 검증 skew 30초를 반영한다. TTL/skew 계약이 바뀌면 허브와 운영 절차를 함께 개정한다.
일반 앱 배포의 enrollment → ingest → dashboard 순서는 JWT 교체 순서를 대체하지 않는다.
키 교체는 두 런타임과 전체 인스턴스를 조정하는 별도 운영 작업이다.

교체 실패 시 후속 전환을 중단한다. signer 복구 전 해당 키를 검증하는 공개키 버전·맵을 모든 verifier에
먼저 적용한다. 신 키 토큰이 이미 발급됐다면 신 공개키를 즉시 제거하지 않는다.
구 signer로 돌아갈 때도 private VersionId·`active-kid`를 함께 복구하고, 마지막 신 키 발급 후 최소 330초까지
신 공개키를 보존한다. Helm revision·ECS 이미지 복구만으로 키 참조·label·파일 맵이 복구됐다고 보지 않는다.

## Constraints

이번 변경은 ADR·계약·운영 문서와 로컬 커밋이다. 실제 키 생성·조회·등록, CDK·Helm·backend 코드 구현,
AWS 배포·Kubernetes 설치·인증 기능 검증은 실행하지 않는다. 기존 실제 Secret 3개와 과거 로컬 검증 수치는 그대로다.
공통 계약은 환경별로 적용하지만 이 ADR의 AWS 전달 구현 범위는 dev이며 prod 인프라는 변경하지 않는다.

## Alternatives Considered

- Parameter Store SecureString과 기본 KMS: 운영 경로를 추가하는 부담에 비해 비용 절감이 작다는 판단으로 기각한다. 가격 수치는 확정하지 않는다.
- 공개키 이미지 포함: 키 교체가 앱 이미지 재빌드·배포에 묶이므로 기각한다.
- 같은 Secret의 개인키·공개키 필드: dashboard의 개인키 조회 권한을 분리할 수 없어 기각한다.
- CDK Custom Resource 또는 앱 시작 시 생성: 재시도·일반 배포가 키 수명을 바꾸는 위험 때문에 채택하지 않는다.
- 앱 SDK 조회 또는 KMS 서명 위임: 현재 backend 파일 로더를 유지하며, 앱·발급 경로 변경은 이번 범위에 넣지 않는다.

## Consequences/Tradeoffs

### Positive

동일 키 원본과 버전으로 ECS/EKS를 비교하고 앱 이미지·배포와 키 수명을 분리한다.
dashboard에 개인키를 공급하지 않으며 기존 파일 로더와 인증 계약을 유지한다.

### Negative

초기화·등록 복구·보존 label과 전체 verifier/signer 교체를 수동 조정해야 한다.
ECS writer·volume·메모리 검증과 EKS CSI 권한·추출 alias 검증이 추가된다.
개인키는 enrollment 파일·메모리에 존재하고 ECS task role은 컨테이너 단위로 분리되지 않는다.
버전 고정으로 Secret 값 변경만으로 앱을 갱신할 수 없고 조회 장애는 신규 task/Pod 기동을 막는다.

## Follow-up

- 최초 키 초기화·두 Secret 버전 등록·검증·복구 도구와 label 보존 책임을 구현한다.
- dev CDK ARN 참조·task 역할·writer·volume·SUCCESS 의존성과 EKS 역할·SPC·mount·values/schema를 구현한다.
- writer 자원·실제 UID 접근·신구 토큰 검증·교체·롤백 리허설 증거를 남긴다.
- 공개키 신뢰 원본 또는 개인키 비반출·자동 회전 요구가 생기면 공통 ADR과 전달 결정을 재검토한다.

## Acceptance Criteria

문서 채택은 ADR 상태·인덱스·링크와 backend 설정·코드 심볼 대조로 확인한다.
구현 수락은 누락·빈 파일·읽기 불가·잘못된 PEM·RSA 규격·키쌍/`kid` 불일치·맵/alias 오류,
초기화의 시험 서명·검증, 두 Secret 등록 부분 실패와 같은 키 재시도, writer 실패 시 앱 미기동, UID 10001 접근,
dashboard/ingest 개인키 권한 부재를 검사한다. ECS/EKS 전체 verifier의 신구 토큰 검증과
마지막 발급 시각·330초 대기·공개키 제거·양방향 롤백 결과를 별도 기록한다.
로컬 문서 검사·synth·render·healthy만으로 이 수락 조건을 완료 처리하지 않는다.

## References

- [허브 JWT 키 공급 ADR](../../../docs/adr/0022-user-jwt-key-provisioning.md), [dashboard 계약](../../../docs/contracts/dashboard-api.md)
- [backend 사용자 인증 운영](../../../pulsemetry-backend/docs/user-auth-operations.md), `UserJwt`·`UserAuthConfig.userJwt()`·`SecurityConfig.dashboardAuthenticator()`
- [ECS 공유 volume 전달](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/specifying-sensitive-data.html), [container dependency](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_ContainerDependency.html)
- [ECS task IAM role](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-iam-roles.html), [bind mount 수명](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/bind-mounts.html)
- [ASCP 버전·JSON 파일 설정](https://docs.aws.amazon.com/secretsmanager/latest/userguide/ascp-examples.html), [Pod Identity 연동](https://docs.aws.amazon.com/secretsmanager/latest/userguide/ascp-pod-identity-integration.html)
- [Secret 버전 보존](https://docs.aws.amazon.com/secretsmanager/latest/userguide/whats-in-a-secret.html), [Pod volume 권한](https://kubernetes.io/docs/tasks/configure-pod-container/security-context/#configure-volume-permission-and-ownership-change-policy-for-pods)
- [dev 수동 런북](../runbooks/dev-eks-manual-deployment.md)
