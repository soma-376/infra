# 0048. dev CloudFormation은 고정한 합성 결과를 승인한 뒤 GitHub Actions로 배포한다

## Status

Accepted (PROJ-259·270·271·272; 코드·문서·로컬 검증 범위이며 AWS 배포와 GitHub 보호 설정은 별도)

ADR-0024의 앱 배포 역할 4개는 유지한다. 이 결정은 infra 저장소의 dev CloudFormation 역할 두 개와
승인 절차를 더한다. 앱 이미지 공급·수동 Helm 배포·prod·frontend Terraform 계약은 바꾸지 않는다.

## Context

dev 배포 입력은 ADR-0040에 따라 추적된 `config/dev/deployment.json`을 사용한다. 기존
`dev-deployment-inputs.yml`은 AWS 없이 입력·합성·Helm 전달을 검사하지만 배포된 스택과의 차이는
확인하지 않는다. 프론트엔드 Terraform CD는 승인 뒤 plan을 만드는 구조여서 PROJ-259의
diff → 승인 → deploy 순서를 그대로 제공하지 않는다.

승인 대기 중 문서·Helm 전용 변경이 develop에 병합되면 기존 plan은 최신 SHA 검사에서 중단된다.
해당 변경은 CD의 `paths` 필터 밖이므로 새 plan도 자동 실행되지 않는다. GitHub의 기존 run 재실행은
원래 SHA를 유지하므로, 최신 develop에서 plan부터 새로 시작할 수 있는 수동 실행 경로가 필요하다.

현재 dev와 prod는 같은 계정·리전의 기본 `hnb659fds` bootstrap을 참조한다. 운영자가 기존
CloudFormation 실행 역할의 `AdministratorAccess` 연결을 확인했고, 이번에는 해당 bootstrap을
재사용하기로 선택했다. 이 확인은 전체 실효 권한·permissions boundary·SCP를 감사한 결과가 아니다.

## Decision

### 대상과 입력

- 자동 배포는 기존 `DevNetworkStack`, `DevDataStack`, `DevEdgeStack`, `DevEksStack`의 후속
  업데이트만 수행한다. 최초 설치·ECS 철거·실패 스택 복구는 수동 절차다.
- `env=cicd`는 관리자가 수동 배포한다. prod·frontend·Kubernetes·Helm은 이 workflow의 대상이 아니다.
- 실제 계정은 GitHub Variable로 주입하고 리전은 `ap-northeast-2`로 고정한다. 현재 profile과
  `package-lock.json`을 사용하며 이미지 digest·MSK 조회·runtime values 생성은 요구하지 않는다.
- 새로운 nested stack·Docker asset·추가 context lookup은 지원 결정을 추가하기 전까지 거부한다.

### 읽기 전용 diff와 승인 대상

1. 현재 네 스택의 템플릿·ID·갱신 시각·상태와 AZ를 읽고, 현재 profile로 빈 임시 디렉터리에
   `--no-lookups` 합성한다. 진행 중이거나 복구가 필요한 상태와 조회 오류는 실패다.
2. 스택마다 `cdk diff --app <assembly> <stack> --exclusively --template <baseline> --method template`
   을 실행한다. AWS에서 읽은 baseline과 로컬 합성 결과를 비교하므로 diff 과정에서 bootstrap
   배포 역할을 맡거나 Change Set·asset을 만들지 않는다.
3. commit SHA·run ID·attempt·계정·리전·스택 목록·baseline과 파일별 해시를 plan artifact에 담는다.
   artifact ID와 plan 해시는 job output으로 전달한다. 이름이 같은 다른 실행의 artifact는 사용하지 않는다.
4. 승인 후 동일 Assembly를 검증하여 배포한다. 재합성하지 않으며 최신 develop SHA와 baseline이
   달라지거나 파일·역할·asset 목적지가 허용목록과 다르면 중단하고 plan부터 다시 실행한다.

승인은 **고정한 소스와 합성 결과**에 대한 승인이다. template diff는 정확한 교체 판정이나 저장된
CloudFormation Change Set이 아니며, 스택 밖의 직접 변경·동적 참조 값 변경까지 잠그지 않는다.

### 역할과 GitHub 보호

`DeployStack`은 기존 앱 역할 4개와 별도로 아래 두 역할을 소유한다. ARN을 output으로 제공하며
합계는 역할 6개다. 기존 bootstrap 리소스·역할과 dev synthesizer는 변경하지 않는다.
병행 WAF·SES ADR과의 번호 충돌로 이 결정을 0044에서 0048로 재번호했다. 최초 배포된 IAM 역할·output
Description의 `ADR-0044` 문자열은 불필요한 배포 차이를 피하기 위해 기존 표기로 유지한다.

| 역할 | 권한과 신뢰 |
|---|---|
| `soma-376-infra-dev-diff` | dev 스택 상태·템플릿과 AZ 조회만. `infra-dev-pr-plan`, `infra-dev-plan` Environment OIDC 신뢰 |
| `soma-376-infra-dev-deploy` | 같은 조회와 기존 bootstrap deploy·file-publishing·lookup 역할의 정확한 ARN에 대한 AssumeRole. `infra-dev-deploy`만 신뢰 |

- OIDC audience와 immutable 조직·저장소 ID를 포함한 Environment subject를 `StringEquals`로 고정한다.
  Environment subject에는 branch가 들어가지 않으므로 허용 branch와 reviewer는 GitHub 보호 규칙으로 제한한다.
- PR plan은 같은 저장소 PR만 실행하고 필수 reviewer·자기 승인 방지를 둔다. fork는 AWS 없는 검증만 한다.
  `pull_request_target`으로 PR 코드를 실행하지 않는다.
- CD plan Environment는 develop 전용이며 승인 없이 읽는다. deploy Environment는 develop 전용·필수
  reviewer·자기 승인 방지를 둔다. 관리자 보호 우회를 허용하지 않도록 설정한다.
- diff 역할에는 Secret 값·쓰기·AssumeRole 권한을 주지 않는다. deploy 역할에도 CFN 실행 역할의 직접
  AssumeRole이나 image-publishing 권한을 주지 않는다. 기존 bootstrap deploy 역할이 실행 역할을 전달한다.
- 기존 관리자급 실행 역할 재사용은 **dev/prod의 IAM 격리가 아니다**. workflow·manifest 검사와
  사람의 승인이 대상 범위를 통제하며, 강한 권한 격리는 별도 작업이다.

### 실행 순서와 결과

- PR은 PR별 concurrency로 병렬 실행하고 같은 PR의 이전 실행을 취소한다.
- CD는 `plan` → `deploy` 두 job이며 workflow 전체를 고정 concurrency group과
  `cancel-in-progress: false`로 직렬화한다. 기본 pending 교체 동작을 수용하고 최신 SHA만 배포한다.
- CDK·profile·의존성·pipeline 변경이 CD를 실행한다. cicd 전용·Helm 전용 변경은 자동 CD를 실행하지 않는다.
- `workflow_dispatch`는 `refs/heads/develop`에서만 허용하며 새 run의 `plan`부터 시작한다.
  임의 SHA·artifact를 받는 입력은 두지 않는다. push와 동일한 concurrency·Environment 승인·최신 SHA·
  baseline·artifact 검증을 적용한다. 다른 branch·tag는 AWS 인증 전에 job 조건으로 제외하고
  스크립트의 실행 식별자 검사에서도 거부한다.
  오래된 승인 대기는 거절하거나 취소한 뒤 최신 develop으로 새 run을 요청한다.
- 네 스택을 명시해 의존 순서대로 직렬 배포한다. 배포 실패를 성공으로 바꾸거나 자동 재시도하지 않는다.
- 무변경도 정상 plan으로 기록하고 승인 뒤 기본 deploy의 no-op을 사용한다. `--force`를 쓰지 않고,
  `diff --fail`의 exit 1을 변경 있음으로 해석하지 않는다.
- 성공·실패의 diff·배포 로그·스택별 결과를 artifact로 14일 보관한다. Secret 원문·AWS 자격증명·CSI 파일을
  조회하거나 artifact로 저장하지 않는다. 로컬 결과와 실환경 검증 결과를 구분한다.

## Alternatives Considered

- 승인 전에 Change Set 준비: 교체 판정은 정확하지만 plan에 쓰기·asset 게시 권한이 필요하고
  다중 스택 의존 처리도 복잡해진다. 이번에는 읽기 전용 diff와 고정 Assembly를 선택한다.
- dev 전용 bootstrap·실행 권한·permissions boundary: 권한 격리에 유리하지만 기존 dev 역할과
  합성·asset 정책 변경을 포함한다. 사용자가 기존 bootstrap 재사용을 선택하여 후속으로 남긴다.
- 기존 프론트엔드 CD 복사: 승인 뒤 plan이 생겨 검토 대상과 승인 순서가 다르다.
- 승인 후 소스 재합성: 승인 대상과 배포 입력이 달라질 수 있어 사용하지 않는다.
- 최신 SHA 검사 완화 또는 경로 필터 제거: 승인 대상의 최신성 보장과 자동 실행 범위를 유지하기 위해
  채택하지 않는다. 수동 실행으로 재계획 경로만 보완한다.

## Consequences/Tradeoffs

### Positive

- PR에서 실제 배포 템플릿과 비교하고, 승인한 입력과 배포 입력의 연결을 기록한다.
- 기존 앱 역할·dev/prod 리소스·수동 Helm 책임을 보존한다.
- stale plan과 잘못된 계정·스택·artifact를 배포 전에 차단한다.

### Negative

- bootstrap 관리자 권한을 재사용하므로 악성 dev 템플릿에 대한 계정 내 완전한 격리는 제공하지 않는다.
- GitHub Environment·branch protection과 최초 역할 배포는 별도 관리자 설정이며 코드만으로 활성화되지 않는다.
- 수동 실행 활성화에는 default branch의 `workflow_dispatch` 정의가 필요하다. 활성화 시점의
  default branch와 workflow 등록 여부를 확인한다.
- template diff의 교체 판정은 보수적일 수 있고, workflow 직렬화는 수동 AWS 작업을 잠그지 않는다.
- 승인 대기 중 다른 변경이 생기면 재계획·재승인이 필요하다. 배포된 여러 스택 전체가 원자적으로 롤백되지는 않는다.

## Follow-up

- PROJ-270 문서 → PROJ-271 역할·권한 테스트 → PROJ-272 workflow·스크립트 테스트 순서로 stack한다.
- 최초 활성화 전에 관리자 cicd 배포, OIDC 연결, Environment 보호, 기존 dev 철거 완료를 확인한다.
- 실제 PR diff·승인·no-op·변경 배포·실패 복구는 별도 실환경 수락 검증으로 남긴다.
- dev/prod IAM 격리, 최초 설치, nested stack·Docker asset은 별도 설계한다.

## Acceptance Criteria

- fixture 합성에서 기존 dev/prod 템플릿과 앱 역할 4개가 보존되고 cicd 역할 두 개만 추가된다.
- AWS 없는 테스트가 fork·승인 순서·stale SHA·baseline 변경·artifact 변조·잘못된 대상·실패 결과 보존을 검증한다.
- 수동 실행도 develop 최신 SHA만 허용하고 새 plan·승인을 요구하며 다른 branch·tag와 과거 artifact를 거부한다.
- 코드·문서·테스트 커밋과 실환경 적용 여부가 분리되어 보고된다.

## References

- [운영 런북](../runbooks/dev-cloudformation-cicd.md), [앱 OIDC ADR-0024](0024-github-actions-oidc-deploy-roles.md)
- [dev EKS 전용 ADR-0035](0035-dev-backend-eks-only.md), [배포 profile ADR-0040](0040-dev-public-origin-and-additional-certificates.md)
- [AWS CDK diff](https://docs.aws.amazon.com/cdk/v2/guide/ref-cli-cmd-diff.html), [AWS CDK 보안](https://docs.aws.amazon.com/cdk/v2/guide/best-practices-security.html)
- [GitHub OIDC AWS](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws)
- [GitHub 수동 실행](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow),
  [GitHub 재실행의 SHA·ref 유지](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs)
