# PROJ-218 후속 로컬 구현·검증 기록

2026-10-17에 PROJ-230·221·223·231·224를 구현하고 티켓별 로컬 브랜치에 커밋했다.
PROJ-225는 보류한다. CDK/Helm 배포, 이미지·Git push, PR 생성, Jira 변경은 수행하지 않았다.
실제 Secret을 조회하거나 DB 계정·키를 등록하지 않았고 모든 입력은 fixture다.

## 구현과 브랜치 경계

| 티켓 | 브랜치 | 이 브랜치가 추가하는 구현 |
|---|---|---|
| 230 | `feature/PROJ-230-dashboard-ecs-runtime` | 필수 dev JSON 입력, 네 DB 연결 helper, 일회성 JWT writer |
| 221 | `feature/PROJ-221-dashboard-api-ecs` | dashboard ECS 서비스·TG·재배포 권한, 공통 path/method/OPTIONS |
| 223 | `feature/PROJ-223-dashboard-helm-workload` | EKS 누적 이력 통합, 세 앱 Helm 구조와 YAML 생성기 |
| 231 | `feature/PROJ-231-dashboard-eks-runtime` | Pod Identity·설정/JWT SPC·별도 RO 키 mount·YAML runtime 입력 |
| 224 | `feature/PROJ-224-dashboard-eks-routing` | dashboard 전용 검증 TG·30081 SG·output·TGB, 공통 라우팅 |

230은 222의 `8725eda`에서 분기했다. 고유 변경이 없던 221은 230까지 fast-forward했다.
223은 기존 EKS 누적 tip `f36ccc8`에서 분기하고 221의 `c6b5be0`을 merge했다.
통합 커밋 `21e0991`과 223 자체 구현 `107cb71`을 분리했다. 231은 223에서,
224는 231에서 분기했다. 기존 206~212·222의 branch ref와 commit은 변경하지 않았다.

## 실행한 로컬 검사

| 검사 | 결과와 범위 |
|---|---|
| TypeScript | `npm run build` 통과 |
| Jest | 22 suites·474 tests 통과. Helm과 kubeconform 경로를 지정해 외부 도구 suite도 실행 |
| Writer | 23 tests 중 22 통과·1 skip. AWS mock·시험 키, 지정 버전·kid/alias·PEM/RSA·키쌍·권한 실패·deadline·비밀 없는 오류 검사 |
| Helm 구조/실패 입력 | Helm 3.22.0·kubeconform 0.8.0, workload resource 55개·platform 6개·실패 입력 103개 검사 |
| 실제 generated 조합 | fixture output과 runtime YAML로 생성한 9개 YAML 사용. 정적 workload → generated 앱 순서로 각 앱 4개 리소스와 runtime SPC 5개 lint/template/1.36 strict schema 통과 |
| Runtime 고정 패키지 | SHA256·lint/render·strict schema: SPC 5개, CSI 16개, ASCP 4개, Fluent Bit 6개 통과 |
| Spring map | 실제 Boot 4.1.0/Spring 7.0.8 Binder와 backend 설정 클래스에서 대소문자·점·슬래시가 다른 6개 kid 보존 확인. 빈 local fallback 제외도 확인 |
| Synth | fixture account·AZ context로 ECS-only/EKS-enabled dev를 합성하고 missing lookup context가 없음을 확인 |
| 라우팅 | 허브 계약의 75개 owner/path/method/preflight 조합 대조. ECS/EKS 각각 53개 조건 동일, TG 분리·HEAD/미지원 method/여분 segment/public health 404 검사 |
| 보존 | prod 모드 A/B 템플릿 동일. cicd는 221의 backend-dev dashboard 재배포 권한 추가만 변경 |

Helm은 `scripts/eks-values.mjs --runtime-values <yaml>`로 생성한 `runtime.yaml`과 앱별 YAML을
`--values`로 전달한다. runtime 입력 자체를 Helm에 중첩하거나 EKS JSON manifest/`--set-json`을
도입하지 않았다. 기존 사용자 `generated/`를 보존하고 검증 파일은 별도 임시 디렉터리에 생성했다.

기존 EKS tip과 최종 합성 결과를 비교하면 Network의 기존 리소스는 동일하며 30081 ingress 두 개만
추가된다. EKS stack은 기존 리소스를 삭제하지 않고 enrollment 조회 정책에 JWT 두 ARN을 추가하며
dashboard 역할·정책·Pod Identity association 세 개를 추가한다. 기존 클러스터·역할·TG의
logical ID와 속성을 보존했다. Edge에서는 기존 넓은 listener rule을 공통 method별 규칙으로
대체하고 dashboard TG를 추가한다. WAF는 기존 검사·등록 rate 조건을 유지하며 vendor catalog
검사만 추가한다. 이러한 의도된 라우팅 변경을 리소스 무변경으로 표현하지 않는다.

## 운영 검증으로 남긴 항목

- Docker daemon이 없어 ARM64 Node 24 이미지 실행·128 MiB 한도·실제 UID/GID 10001 writer 시험은 미실행이다.
  writer unit test는 호스트 Node와 현재 UID로 수행했으며 root 전용 시험 하나를 skip했다.
- 실제 CSI 접근과 UID 10001 파일 읽기, NodePort 30081 점유·target health는 미검증이다.
- 실제 DB 준비·키 버전 등록·ARM64 이미지 공급·ECS/EKS digest 대조와 배포는 수행하지 않았다.
- ECS 배치·OOM·writer 실패 시 실제 앱 미기동, 인증·snapshot·키 교체·복구는 후속 운영 관문이다.
- 관리 응답·메일의 추가 암호화키/transport 공급은 범위 밖이므로 두 enabled flag는 false만 허용한다.

Pod Ready·Helm 렌더링·합성 성공은 기능 수락을 대신하지 않는다. 운영 순서와 verifier → signer →
330초 대기 → 구 공개키 제거는 [ECS runtime 런북](dev-dashboard-ecs-runtime.md)과
[EKS 수동 런북](dev-eks-manual-deployment.md)을 따른다.
