# dev CloudFormation CI/CD 운영

[ADR-0048](../adr/0048-dev-cloudformation-cicd.md)·PROJ-259의 운영 인계다. PROJ-270은 문서를,
PROJ-271은 역할을, PROJ-272는 workflow와 검증 스크립트를 순서대로 구현한다. 이번 작업은
로컬 검증·커밋까지이며 아래 관리자 설정과 AWS 배포는 수행하지 않는다.

[Argo 운영 런북](dev-argocd-operations.md)은 후속 Kubernetes 적용 경로다. 이 workflow의 승인된 Assembly 배포와
generated snapshot/배포 revision 게시, Argo sync는 서로 다른 단계다. 현재 workflow에는 generated 게시나 Helm 적용이 없으며,
후속 공급 경로를 구현해도 이 문서의 AWS 승인·최신 SHA·baseline·artifact 검증을 생략하지 않는다.

## 1. 대상과 선행조건

- 대상은 `ap-northeast-2`의 기존 `DevNetworkStack`, `DevDataStack`, `DevEdgeStack`, `DevEksStack`이다.
  최초 설치는 [EKS 수동 런북](dev-eks-manual-deployment.md)을 따른다.
- [ECS 철거](dev-ecs-retirement.md)와 필요한 [DB 공개 경로 제거](dev-database-access.md)를 먼저 끝낸다.
  `DevApplicationStack`이 없다는 사실만으로 Edge·Network의 후속 정리까지 완료됐다고 판단하지 않는다.
  기존 ECS 리소스가 남은 상태에서 일반 CD로 철거 순서를 대신하지 않는다.
- 네 스택은 모두 존재하고 정상 완료 상태여야 한다. 진행 중·실패·복구 중 상태는 별도 운영 절차로 해결한다.
  권한 오류나 네트워크 실패는 스택 부재로 처리하지 않는다.
- 기존 `hnb659fds` bootstrap의 S3·역할과 현재 OIDC provider 소유권을 확인한다. 실행 역할의
  `AdministratorAccess` 재사용을 전제로 하며, 이 workflow를 dev/prod IAM 격리로 설명하지 않는다.
- prod·frontend Terraform·Helm·앱 이미지 배포·Secret 값 등록·DB 마이그레이션은 이 CD에 포함하지 않는다.

## 2. 관리자 최초 설정

이 절은 리뷰·머지 후 별도로 수행할 관리자 작업이다. workflow가 자기 역할·Environment·보호 규칙을
만들거나 수정하도록 권한을 주지 않는다.

### cicd 배포

1. 현재 `DeployStack`에서 GitHub OIDC provider를 소유하는지, 기존 ARN을 참조하는지 확인한다.
   **기존 소유 모드를 유지한다.** 이미 CDK가 관리하는 provider에 새 `githubOidcProviderArn`을 넣어
   import 모드로 바꾸지 않는다. 계정에 provider가 있다는 이유로 provider를 다시 생성하지도 않는다.
2. `env=cicd`를 명시해 합성·diff를 확인한다. 기존 앱 역할 4개·provider·output이 보존되고
   infra 역할 두 개·정책·output만 추가되어야 한다. 다른 변경이 있으면 먼저 검토한다.
3. 동일 입력으로 `DeployStack`만 수동 배포한다. 자동 dev workflow로 cicd를 배포하지 않는다.
4. `soma-376-infra-dev-diff`, `soma-376-infra-dev-deploy`의 output ARN을 아래 Variables에 등록한다.

실제 계정은 환경에서 지정하고 기록 파일·소스에 하드코딩하지 않는다. 기존 배포가 사용하는
`githubOidcProviderArn` context가 있다면 동일하게 전달한다. 아래 예시는 provider 소유 모드를 바꾸지 않는다.

```bash
: "${CDK_DEFAULT_ACCOUNT:?대상 계정}"
export CDK_DEFAULT_REGION=ap-northeast-2
export AWS_REGION=ap-northeast-2
npm ci
npm run build
npm run synth:cicd
npm run diff:cicd
# diff와 기존 OIDC 소유 모드를 검토한 관리자가 별도로 실행한다.
npm run deploy:cicd
```

### GitHub Environments와 Variables

| Environment | 허용 실행 | 보호 규칙 | Variables |
|---|---|---|---|
| `infra-dev-pr-plan` | 같은 저장소의 develop 대상 PR | 필수 reviewer, 자기 승인 방지, 관리자 우회 차단 | `AWS_ACCOUNT_ID`, `CDK_DIFF_ROLE_ARN` |
| `infra-dev-plan` | develop | develop branch만 허용, 승인 없이 읽기 | `AWS_ACCOUNT_ID`, `CDK_DIFF_ROLE_ARN` |
| `infra-dev-deploy` | develop | develop branch만 허용, 필수 reviewer, 자기 승인 방지, 관리자 우회 차단 | `AWS_ACCOUNT_ID`, `CDK_DEPLOY_ROLE_ARN` |

PR Environment의 deployment branch 정책은 PR merge ref를 허용해야 한다. 실제 PR 실행에서
Environment 정책이 허용하는 ref를 확인하고, deploy Environment를 넓혀 PR을 우회 허용하지 않는다.
OIDC의 subject는 Environment를 포함하며 branch를 포함하지 않으므로 이 보호 규칙을 생략하지 않는다.

`AWS_ACCOUNT_ID`는 세 Environment에서 같은 대상 계정이고 역할 ARN도 그 계정이어야 한다.
이 값들은 GitHub **Variables**이며 access key를 저장할 GitHub Secret은 만들지 않는다.
새 역할은 immutable 조직·저장소 ID를 포함한 `soma-376/infra` subject와 audience를 완전 일치시킨다.

develop에는 PR 리뷰·필수 검증·직접 push 제한을 설정하고 workflow·IAM 변경에 CODEOWNERS 리뷰를
적용한다. `push` 이벤트 자체는 직접 push와 PR merge를 구분하지 않는다. PR 코드는 읽기 권한으로도
임의 코드를 실행할 수 있으므로 승인 전에 workflow·의존성·합성 코드를 함께 검토한다.

수동 재계획을 활성화하려면 default branch에 `workflow_dispatch`를 선언한
`dev-cdk-deploy.yml`이 있어야 한다. default branch가 develop이면 해당 정의의 develop 병합이 필요하다.
활성화 전에 GitHub의 [수동 실행 조건](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)과
실제 default branch의 파일을 확인한다. 실행 대상은 계속 develop으로 제한한다.

## 3. PR과 CD 흐름

### PR: `dev-cdk-pr.yml`

1. AWS 없는 빌드·검증은 fork를 포함해 실행한다. 기존 dev 입력 검증 workflow도 유지한다.
2. 같은 저장소 PR만 `infra-dev-pr-plan` 승인을 거쳐 diff 역할을 맡는다.
3. 네 스택의 현재 템플릿·상태와 AZ를 읽고 추적 profile로 `--no-lookups` 합성한다.
4. 각 스택의 local `cdk diff --template` 결과를 Job Summary와 artifact로 남긴다.

PR별 concurrency를 사용하므로 다른 PR은 병렬로 실행한다. 같은 PR의 새 실행은 이전 실행을 취소한다.
PR에는 배포 권한이 없고, PR artifact를 CD의 배포 입력으로 승격하지 않는다.

### CD: `dev-cdk-deploy.yml`

| job | 동작 |
|---|---|
| `plan` | 최신 develop SHA 확인, 빌드·검증, baseline 조회, 한 번 합성, diff, plan artifact 게시 |
| `deploy` | Environment 승인, 같은 실행의 artifact 검증, 최신 SHA·baseline 재확인, 저장된 Assembly 배포, 결과 수집 |

- 승인 화면에서 plan Job Summary와 artifact를 확인한다. 승인 후 재합성하지 않는다.
- workflow 전체가 고정 concurrency group을 쓰며 실행 중 CD는 취소하지 않는다. pending 실행은 최신
  실행으로 교체될 수 있다. 오래된 SHA의 승인 대기는 거절·취소하고 최신 실행을 검토한다.
- CDK 코드·profile·의존성·pipeline 변경만 자동 CD를 유발한다. cicd 전용 변경은 역할 수동 배포 대상으로,
  Helm 전용 변경은 별도 수동 Helm 절차로 처리한다.
- `workflow_dispatch`는 develop의 새 plan부터 같은 두 job을 실행한다. 다른 branch·tag는 AWS 인증
  전에 job 조건으로 제외하고 스크립트도 거부한다. 별도 SHA·artifact 입력이나 승인 생략 경로는 없다.
- 네 스택을 명시해 의존 순서대로 직렬 배포한다. 무변경이면 승인 후 기본 CDK no-op으로 끝난다.
  `--force`, 보호 우회, 자동 rollback 재시도는 하지 않는다.

### 최신 develop으로 수동 재계획

승인 대기 중 문서·Helm 전용 PR이 병합되면 기존 plan은 오래된 SHA가 되지만 `paths` 필터 때문에
새 CD가 자동 실행되지 않는다. 기존 run의 **Re-run jobs**는 원래 SHA·ref를 유지하므로 이 상황의
해결책이 아니다([GitHub 재실행 동작](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs)).

1. 오래된 plan의 승인 대기를 거절하거나 취소한다. 고정 concurrency 때문에 새 실행이 기존 승인
   대기 뒤에 머물 수 있다. 이미 배포 중인 실행을 재계획 목적으로 취소하지 않는다.
2. Actions의 **Dev CDK Deploy → Run workflow**에서 branch **develop**을 선택해 새 run을 만든다.
   CLI를 사용할 때도 아래처럼 ref를 명시한다.

   ```bash
   gh workflow run dev-cdk-deploy.yml --repo soma-376/infra --ref develop
   ```

3. 새 plan의 SHA·baseline·diff·artifact를 확인하고 `infra-dev-deploy`에서 다시 승인한다.
   계획 또는 승인 중 develop이 다시 바뀌면 동일하게 중단되므로 최신 develop으로 다시 계획한다.

## 4. 승인 전 확인과 artifact

plan은 baseline 템플릿과 스택 ID·상태·생성/갱신 시각을 보관한다. Assembly manifest가 가리키는 파일,
계정·리전·스택 목록·bootstrap 역할·asset 목적지와 전체 파일 해시를 검사한다. 추가 lookup,
nested stack, Docker asset은 현재 지원하지 않는다.

artifact에는 소스 SHA, run ID·attempt, plan 파일 해시, 계정·리전, 스택 목록과 파일 해시가 연결된다.
deploy는 같은 run/attempt의 artifact ID를 사용하고 이름만으로 이전 artifact를 찾지 않는다.
승인 후 develop HEAD와 baseline을 다시 읽어 일치해야 쓰기를 시작한다. 변경되면 새 plan·승인이 필요하다.
배포 job만 다시 실행해 과거 승인을 재사용하지 않는다.

diff·배포 로그·스택별 결과는 성공·실패 모두 14일 보관한다. Secret 원문·AWS 자격증명·CSI 파일은
읽거나 저장하지 않는다. CloudFormation 템플릿에도 비밀 원문을 넣지 않는 기존 규칙을 유지한다.
template diff는 실제 교체 여부를 완전히 확정하지 않으며 외부 리소스 drift·동적 참조 값 변경을
잠그지 않는다. 수동 AWS 변경은 CD concurrency의 잠금 대상이 아니므로 배포 시간에 조율한다.

## 5. 실패·복구

| 상황 | 처리 |
|---|---|
| 역할·Variable 누락, OIDC 거부 | 관리자 설정·subject·계정·Environment 보호를 확인한다. 권한을 wildcard로 넓히지 않는다. |
| baseline 조회 실패, 스택 없음·진행 중·복구 필요 | plan을 중단한다. 기존 상태를 읽기 확인하고 최초 설치 또는 복구 절차를 따른다. |
| legacy ECS 잔존 | [철거 런북](dev-ecs-retirement.md)을 완료하고 새 plan을 만든다. |
| SHA·baseline·artifact 해시 불일치 | deploy를 중단한다. 위 수동 재계획 절차로 최신 develop에서 새 plan을 만들고 다시 승인한다. |
| nested stack·Docker asset·추가 lookup | 지원 설계와 권한·테스트를 먼저 추가한다. 검증기를 우회하지 않는다. |
| CDK 배포 실패 또는 rollback | 실패 결과를 보존하고 이후 진행을 멈춘다. 이미 완료된 스택까지 원자적으로 되돌아가지는 않는다. |

실패 원인을 수정한 뒤 현재 스택이 정상 완료 상태인지 확인하고 새 plan을 만든다. 애플리케이션
기능 문제는 [EKS 런북](dev-eks-manual-deployment.md)의 확인·복구로 다루며 CloudFormation 성공만으로
Pod·TLS·OIDC·DB·수집 E2E 성공을 선언하지 않는다.

## 6. 로컬 검증과 실환경 수락

- PROJ-270: ADR·인덱스·런북 링크와 역할·승인·실행 계약을 검토한다.
- PROJ-271: fixture 계정 template assertion, cicd synth, 기존 앱 역할 4개 보존을 확인한다.
- PROJ-272: AWS 없는 fixture로 fork·승인·동시 실행·stale SHA·artifact 변조·잘못된 대상·조회 오류·
  무변경·부분 실패를 검증한다. 수동 실행의 develop 제한·새 plan·최신 SHA·artifact 검증도 확인한다.
  전체 Jest·build와 dev/prod/cicd fixture synth를 수행한다.
- 실제 OIDC 연결, PR diff, reviewer 승인, no-op, 변경 배포, 실패 결과 수집은 별도 승인된 실환경에서 확인한다.
  이번 로컬 구현 결과와 해당 증거를 구분해 기록한다.
