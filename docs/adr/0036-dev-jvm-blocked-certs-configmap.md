# 0036. dev JVM의 임시 인증서 차단 목록을 Helm ConfigMap으로 공급한다

## Status

Accepted (PROJ-253 임시 대응, 코드·문서·로컬 검증 범위이며 실제 배포는 별도)

## Context

[OpenJDK 2026-10-21 권고](https://openjdk.org/groups/vulnerability/advisories/2026-10-21)는
CVE-2026-91403 대응으로 런타임 업그레이드 또는 OS에 맞는 `blocked.certs` 교체를 안내한다.
이 작업은 패치 이미지 전환 전까지 dev에 배포하는 Spring Boot 네 앱(enrollment·ingest·dashboard·Gateway)의 파일 공급을 담당한다.
Temurin 패치 제공 여부는 실제 이미지 전환 시 다시 확인한다.

backend `Dockerfile`의 `runtime-base`는 Temurin 25 JRE를 사용한다. 로컬 ARM64 backend 이미지에서
`java.home=/opt/java/openjdk`와 `lib/security/blocked.certs`가 일반 파일임을 확인했다.
배포 이미지도 같은 경로인지 적용 전에 확인해야 한다. OpenJDK `UntrustedCertificates`는 클래스
초기화 때 파일을 읽어 static 상태로 보관하므로 실행 중 파일 교체만으로 기존 JVM이 갱신되지 않는다.

ADR 0028·0035에 따라 dev Kubernetes 선언은 infra의 Helm이 소유한다. Gateway 역시 같은 Temurin runtime-base와 공통 spring-app chart를 사용한다.
이번 대응은 API·앱 코드나
Secret 계약을 변경하지 않는 단일 레포의 임시 배포 설정이다.

## Decision

1. 공식 [Unix용 원본](https://ops.java/unix/blocked.certs)을 `spring-app` chart에 포함한다.
   원본을 임의로 구성하거나 축약하지 않고 출처·취득 시점·SHA-256을 함께 기록한다.
   다운로드 실패·빈 파일·형식 또는 해시 불일치는 완료를 막는 오류로 취급한다.
2. `enrollment-api`·`telemetry-ingest`·`dashboard-api`·`telemetry-gateway`의 각 release가
   `<Release.Name>-blocked-certs` ConfigMap을 소유한다. 공용 runtime-config release에 넣지 않는다.
3. 앱 컨테이너에만 `blocked.certs` key를 `subPath`로 사용하여
   `/opt/java/openjdk/lib/security/blocked.certs`에 읽기 전용으로 마운트한다.
   파일 모드는 `0444`이며 security 디렉터리·`cacerts`·다른 파일을 가리지 않는다.
4. 원본 내용의 SHA-256을 Pod template annotation에 넣는다. Helm으로 파일을 갱신하면
   Deployment가 새 Pod를 생성한다. `subPath`의 실행 중 자동 갱신에 의존하지 않는다.
5. 네 dev 앱에 별도 values 옵션 없이 적용하며 runtime/JWT 활성 여부와 독립시킨다.
   기존 Secret/사용자 JWT/telemetry JWT CSI volume과 `verify-configtree` initContainer는 그대로 유지한다.
   차단 목록 mount는 앱 컨테이너에만 추가하며 Gateway의 telemetry JWT revision·Kafka 설정과 내부 metrics를 보존한다.
6. 기존 replica 1·`Recreate`를 유지한다. 파일 갱신은 앱 재시작과 일시 중단을 수반한다.
   CDK·prod·frontend·ClickHouse·backend Dockerfile은 이번 변경 범위가 아니다.

## Alternatives Considered

### 운영자가 공용 ConfigMap을 수동 관리

파일 교체와 앱 release의 재시작을 별도로 관리해야 한다. 앱별 upgrade·rollback 소유권을 일치시키기
위해 채택하지 않는다.

### security 디렉터리 전체를 마운트하거나 root로 파일 복사

기존 `cacerts` 등 파일을 가리거나 추가 쓰기 권한·초기화 절차가 필요하다. 단일 파일의 읽기 전용
마운트로 충분하므로 채택하지 않는다.

## Consequences/Tradeoffs

### Positive

- 이미지 재빌드 없이 JVM 시작 전에 공개 차단 목록을 공급할 수 있다.
- 파일과 Pod revision이 같은 Helm 변경에 포함되며 기존 Secret 접근 권한을 늘리지 않는다.

### Negative

- Temurin의 `java.home` 경로와 파일 형식에 의존하므로 이미지 변경 시 다시 검증해야 한다.
- 네 release에 ConfigMap이 각각 생기며 갱신하려면 각 앱을 재배포해야 한다.
- 임시 mount가 계속 남으면 패치 이미지의 더 최신 목록을 가릴 수 있다.
- 패치 전 chart로 rollback하면 대응이 사라질 수 있으므로 해당 revision을 무조건 복구 대상으로 삼지 않는다.

## Follow-up

- 실제 배포는 별도 승인 범위이며 로컬 성공을 live 적용 증거로 기록하지 않는다.
- 패치된 Temurin 기반 이미지를 재빌드하고 이미지 자체의 차단 목록을 검증한다.
  검증한 digest 배포와 임시 ConfigMap·mount·annotation 제거를 같은 앱 release 변경으로 수행한다.
  취약한 이미지로 돌아가야 한다면 이 임시 보호를 유지한 chart를 사용한다.

## Acceptance Criteria

- 공식 원본의 출처·SHA-256, chart/ConfigMap 내용 일치, 비어 있거나 누락된 파일의 렌더링 실패를 검증한다.
- 네 앱과 runtime/사용자 JWT/OIDC/telemetry JWT 조합에서 정확한 단일 파일 mount·권한·checksum 및 기존 mount 보존을 검증한다.
- 로컬 ARM64 Temurin에서 UID 10001로 읽기 전용 파일을 마운트하고 JVM의 실제 차단 목록 로드와
  기존 `cacerts` 접근을 확인한다. 이 검증은 live TLS 또는 취약점 재현 E2E를 대신하지 않는다.
- Helm lint/render·Kubernetes schema·회귀 테스트·TypeScript build·조회 없는 CDK 합성을 통과하고
  CDK 산출물이 기준선과 동일함을 확인한다.

## References

- [PROJ-253](https://team376.atlassian.net/browse/PROJ-253)
- [PROJ-253 로컬 검증 기록](../runbooks/proj253-local-validation.md)
- [OpenJDK UntrustedCertificates](https://github.com/openjdk/jdk25u/blob/master/src/java.base/share/classes/sun/security/util/UntrustedCertificates.java)
- [ConfigMap과 subPath 갱신 제약](https://kubernetes.io/docs/tasks/configure-pod-container/configure-pod-configmap/)
- [ADR 0028: dev EKS Auto Mode](0028-dev-eks-auto-mode-transition.md)
- [ADR 0035: dev 백엔드 EKS 전용](0035-dev-backend-eks-only.md)
