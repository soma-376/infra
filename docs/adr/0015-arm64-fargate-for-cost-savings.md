# 0015. Fargate 태스크를 ARM64로 통일

## Status

Accepted

## Context

이 레포의 컴퓨트는 아키텍처가 갈려 있었다.

| 워크로드 | 아키텍처 | 근거 |
|---|---|---|
| `ClickhouseTask` (EC2) | ARM64 | `InstanceClass.T4G` + `AmiHardwareType.ARM`. ADR-0003에서 비용을 이유로 선택한 값이다. |
| `CollectorTask`, `DashboardTask` (Fargate) | x86_64 | `runtimePlatform` 미지정 |

여기서 문제는 Fargate가 x86_64라는 사실 자체가 아니라, **x86_64를 고른 것이 아니라 지정하지 않아서 x86_64였다는 점**이다. CDK `FargateTaskDefinition`의 `runtimePlatform` 기본값은 `undefined`이고, 그러면 합성 템플릿에 `RuntimePlatform` 속성이 아예 들어가지 않아 ECS 서비스 기본값인 x86_64가 적용된다. 결과적으로 앱 레포가 어느 아키텍처로 이미지를 빌드해야 하는지가 인프라 코드 어디에도 드러나지 않았다.

이 결정을 지금 내리는 이유는 타이밍이다. 결정 당시 ECR 레포 3개(`soma-376/post-processor`, `soma-376/api-server`, `soma-376/batch-processor`)에는 아직 이미지가 push되지 않았다 — 이후 [ADR-0023](0023-dev-auth-proxy-between-alb-and-collector.md)이 `soma-376/auth-proxy`를 더해 레포는 넷이 됐고, 현재 빌드되는 이미지는 `ai-telemetry-pipeline`의 post-processor·auth-proxy 둘이다(`api-server`·`batch-processor`는 대응 모듈이 미존재 — 산출물 구성 확정 시 갱신한다, ADR-0024 Follow-up). 기존 amd64 이미지가 없으므로 전환 비용이 사실상 0이고, 앱 레포는 처음부터 arm64로 빌드하면 된다. 이미지가 쌓인 뒤라면 재빌드와 재push가 필요했을 것이다.

## Decision

`CollectorTask`와 `DashboardTask`의 `runtimePlatform`을 `ARM64` + `LINUX`로 **명시한다**.
dev 의 ECS on EC2 태스크도 같은 이유로 ARM64 다([ADR-0022](0022-dev-infrastructure-topology.md) 3번 — 호스트 ASG 가 `t4g` + ARM AMI). 근거는 세 가지다.

**1. 비용 약 20% 절감**

us-east-1 공표 요금 기준으로 Linux/ARM은 Linux/X86 대비 vCPU와 메모리 모두 약 20% 저렴하다.

| 항목 | Linux/X86 | Linux/ARM |
|---|---|---|
| vCPU 시간당 | 약 $0.040 | 약 $0.032 |
| 메모리 GB 시간당 | 약 $0.0044 | 약 $0.0036 |

현재 상시 구동분은 `CollectorTask`(0.5 vCPU + 1 GB)와 `DashboardTask`(0.5 vCPU + 2 GB)를 합쳐 1 vCPU + 3 GB다. 730시간 기준으로 월 약 $38.8에서 약 $31.2로, **월 약 $7.6**이 줄어든다. 서울 리전은 절대액이 다소 높지만 절감 비율은 같다. MVP 규모에서 절대액은 크지 않으나, 태스크를 늘릴수록 비율대로 커지는 구조적 절감이다.

**2. ClickHouse EC2와 아키텍처 일치**

t4g 인스턴스가 이미 Graviton이다. 컴퓨트 전체가 ARM64로 통일되면 "이 서비스는 어느 아키텍처인가"를 매번 확인할 필요가 없어진다.

**3. 빌드 대상의 명문화**

암묵적 기본값 대신 코드에 아키텍처가 박히면서, 앱 레포와의 빌드 계약이 인프라 코드와 AGENTS.md에 드러난다. 이것이 비용 절감보다 실질적인 이득일 수 있다.

## Constraints

- **Linux 전용**. Fargate ARM64는 Windows 컨테이너를 지원하지 않는다. 현재 전 서비스가 Linux이므로 무관하다.
- **Fargate 플랫폼 버전 1.4.0 이상**. CDK 기본값이 `LATEST`라 충족한다.
- **리전 제약**: us-east-1의 `use1-az3` AZ만 미지원이다. 배포 대상인 ap-northeast-2는 무관하다.
- **로깅**: Fluent Bit 또는 CloudWatch를 쓸 수 있다. 현재 `awsLogs` 드라이버를 쓰므로 해당한다.
- **공개 이미지 호환성 확인 완료**: `otel/opentelemetry-collector-contrib:latest`는 멀티아치 매니페스트에 linux/arm64를 포함한다(amd64, arm64, arm/v7, 386, ppc64le, riscv64, s390x). `clickhouse/clickhouse-server:latest`도 linux/arm64를 포함하며 이미 ARM EC2에서 구동 중이다.

## Alternatives Considered

- **x86_64를 명시**: 앱 레포가 amd64로 빌드하는 관행이 흔해 마찰이 가장 적다. 다만 비용 이점을 버리고 EC2와 아키텍처가 계속 갈린 채로 남는다. 명시한다는 점에서 현행보다는 낫지만 ARM64보다 나은 점이 없다.
- **현행 유지(미지정)**: 아무 이득 없이 CDK/ECS 기본값 변경에 노출되고, 빌드 계약이 문서화되지 않은 상태가 지속된다.
- **ClickHouse를 x86으로 되돌려 통일**: 아키텍처는 일치하지만 t4g의 비용 이점을 버리는 역방향이라 기각한다. ADR-0003의 비용 판단을 뒤집을 근거가 없다.

## Consequences/Tradeoffs

### Positive

- [ADR-0003](0003-hybrid-launch-type-ec2-clickhouse-fargate-apps.md)의 Consequences/Tradeoffs에 적힌 Fargate 비용 근거는 이 ADR의 ARM64 요금으로 대체된다.
- `runtimePlatform` 값은 `lib/common/config.ts`가 아니라 `lib/prod/application-stack.ts`의 모듈 스코프 상수로 두었다. AGENTS.md의 "공유 상수는 config.ts에" 규칙은 스택 간에 공유되는 리터럴을 대상으로 하는데, 이 값은 CDK enum이고 소비처가 한 파일뿐이다. 현재 `config.ts`는 `aws-cdk-lib/core`만 import하는 가벼운 모듈이라 `aws-ecs` 의존을 새로 들이는 쪽이 손해다.

### Negative

- **앱 레포 2곳이 `linux/arm64`로 빌드해야 한다.** 이 레포는 앱 레포의 CI를 강제할 수 없다([ADR-0009](0009-single-infra-repo-stack-boundary.md), [ADR-0007](0007-precreate-ecr-outside-cdk.md)과 같은 종류의 레포 경계 문제다). 배포 전에 앱 레포 쪽에 전달해야 한다.
- **이 불일치는 테스트로 잡히지 않는다.** 이미지 URI에는 아키텍처가 드러나지 않으므로 `cdk synth`도 `npm test`도 통과하고, 태스크 기동 시점에만 다음과 같이 실패한다.

  ```
  image Manifest does not contain descriptor matching platform 'linux/arm64'
  ```

  ECS는 이 실패를 재시도하므로 배포가 실패로 끝나지 않고 장시간 지연되는 형태로 나타난다. `circuitBreaker`가 꺼져 있어 최대 3시간까지 끌 수 있다.
- x86 전용 네이티브 바이너리에 의존하는 라이브러리가 앱에 있으면 재검토가 필요하다. JVM과 Go 기반이라면 대개 문제가 없다.

## Follow-up

- 앱이 arm64 빌드가 불가능한 의존성을 도입할 때. 이 경우 해당 태스크만 x86_64로 되돌릴 수 있다(태스크 정의 단위로 독립적이다).
- ap-northeast-2에서 ARM 가용량 부족으로 태스크 기동이 지연될 때.
- Fargate 요금 개정으로 ARM과 x86의 가격차가 사라질 때.

## References

- [Amazon ECS task definitions for 64-bit ARM workloads](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ecs-arm64.html)
- [AWS Fargate Pricing](https://aws.amazon.com/fargate/pricing/)
