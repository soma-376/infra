# dev CloudFormation CI/CD 운영

[ADR-0048](../adr/0048-dev-cloudformation-cicd.md)·PROJ-259의 운영 인계다. PROJ-270은 문서를,
PROJ-271은 역할을, PROJ-272는 workflow와 검증 스크립트를 순서대로 구현한다. 이번 작업은
로컬 검증·커밋까지이며 아래 관리자 설정과 AWS 배포는 수행하지 않는다.

[Argo 운영 런북](dev-argocd-operations.md)은 후속 Kubernetes 적용 경로다. 이 workflow의 승인된 Assembly 배포와
generated snapshot/배포 revision 게시, Argo sync는 서로 다른 단계다. PROJ-279는 CDK 성공 뒤 인계 전 generated 사본을 게시한다. Helm 적용은 운영자가 수행하며,
정식 GitOps snapshot/desired 게시는 후속이다. AWS 승인·최신 SHA·baseline·artifact 검증은 유지한다.

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

## 7. PROJ-279 generated values 자동 공급

### 최초 준비와 활성화

초기에는 `GENERATED_VALUES_SYNC_ENABLED`를 설정하지 않거나 `false`로 둔다. 비활성 plan은 backend
조회·GitHub App 없이 기존 CDK 경로로 실행된다. 다음 준비를 완료한 뒤 **새 plan**에서 활성화한다.

1. 관리자 경로로 `env=cicd`의 deploy 역할 AssumeRole 정책을 반영한다. dev CDK 배포로
   `soma-376-dev-eks-values-reader`와 `EksValuesReaderRoleArn` output을 준비한다. 기존 DeployStack 역할 수는 6개다.
2. 운영자가 현재 고정된 dev base values로 base chart를 수동 upgrade하여 `pulsemetry-dev`의
   `generated-values-reader` Role·RoleBinding을 설치한다. 최초 RBAC는 새 publisher에 의존하지 않는다.
3. GitHub App을 backend와 private 사본 저장소에 설치한다. backend `Actions: read`, `Contents: read`,
   사본 `Contents: write`가 필요하다. 각 job은 필요한 저장소·권한만 가진 단기 token을 발급하고 종료 시 회수한다.
   기존 `GITHUB_TOKEN`에는 사본 쓰기 권한을 추가하지 않는다.
4. `infra-dev-plan`과 `infra-dev-deploy`에서 `GENERATED_VALUES_APP_ID` Variable과
   `GENERATED_VALUES_APP_PRIVATE_KEY` Secret을 사용할 수 있게 준비한다. 키 원문을 Git·로그·artifact에 넣지 않는다.
   `infra-dev-plan`의 `GENERATED_VALUES_SYNC_ENABLED` Variable을 `true`로 설정한다. 기존 AWS Variables,
   develop 제한·필수 reviewer·자기 승인 방지와 보호 우회 차단을 유지한다.
5. private 저장소는 `main`, private visibility, README·AGENTS만 있는 초기 상태 또는 완전한 사본이어야 한다.
   GitOps 파일이나 다른 writer가 있으면 활성화하지 않는다. main의 force push와 삭제도 보호한다.

새 develop plan은 최신 성공 backend `deploy_dev.yml` 실행 하나의 정확한 attempt를 선택한다. Gateway를
포함한 네 build step 성공과 ARM64 manifest digest·SHA·provenance·로그 해시를 고정한다. 로그 누락·만료·
형식 변경·Gateway skip은 실패이며 이전 run이나 mutable tag로 대체하지 않는다. 원문 로그는 새 artifact에
복사하지 않는다. backend manifest 전환은 PROJ-311의 후속 범위다.

CDK deploy 성공 뒤 원본 SHA/run/attempt, plan artifact ID/hash, 배포 후 baseline hash를
`deployment-receipt.json`에 기록하고 별도 `dev-cdk-receipt-<run>-<attempt>` artifact로 14일 보관한다.
`publish`는 같은 `infra-dev-deploy` Environment와 workflow concurrency 안에서 이 증거를 검증한다.
처음 실행 시에는 publisher가 동작 중이므로 workflow 전체의 완료·성공을 요구하지 않고 원본 plan/deploy
job의 완료·성공을 확인한다.

runner는 고정 SSM plugin으로 기존 relay·전용 문서에 연결하고 reader 역할로 EKS에 접근한다. 원래
TLS hostname·CA를 보존한 개별 `PartialObjectMetadata` 요청만 수행하고 전체 Secret 응답으로 fallback하지 않는다.
RBAC는 Secret 5개에 대한 get 권한이며 metadata 필드만 허용하는 권한은 아니다. 응답 제한은 수집기가 강제한다.
Helm 3.22.0과 SHA로 고정한 chart로 13개 consumers를 렌더한 뒤 metadata·baseline·private HEAD를 재확인한다.
게시 직전 Git handshake의 HEAD도 전용 pre-push 검사로 고정한다. force push·자동 rebase는 수행하지 않는다.

### 결과 확인과 게시 전용 재시도

- `plan.json.generatedValues`가 승인한 활성 여부·이미지 입력이다. 승인 후 Variable을 바꿔도 그 plan을 활성화하지 않는다.
- `publish` Summary와 `result-publish.json`은 `published`, `noop`, `failed`와 commit/실행 식별자만 남긴다.
  generated YAML·조회 원문·endpoint·kubeconfig를 공개 artifact에 추가하지 않는다.
- 자동 commit 제목은 `auto(dev): values 동기화 by infra@<SHA 12자리> (run <ID>/<publisher attempt>)`다.
  본문은 infra SHA와 backend SHA·원본 run/attempt를 연결한다. 동일 내용에는 commit이 없다.
- CDK가 성공하고 게시만 실패했다면 **Re-run failed jobs** 또는 해당 `publish` job만 재실행한다.
  전체 workflow의 failure는 사본 재시도 거부 근거가 아니다. 원본 plan/deploy job의 성공·artifact ID/hash·
  receipt가 유지되고 현재 AWS baseline이 같아야 한다. publisher attempt와 원본 배포 attempt를 구분한다.
- 게시 재시도에서는 고정 이미지·원본 infra checkout을 유지하고 Outputs·metadata만 새로 조회한다.
  develop HEAD 이동만으로 거부하지 않지만 baseline 변경·증거 누락·14일 artifact 만료는 새 plan·승인이 필요하다.
  기존 **deploy job만 재실행하여 승인 attempt를 넘기는 동작은 계속 거부**한다.
- private HEAD 경쟁·GitOps 표식·부분 사본·추가 파일·symlink는 중단한다. push 응답 유실 시 원격 HEAD가
  방금 만든 정확한 commit이면 성공으로 판정하고, 그 외에는 실패한다. 로컬 수동 생성·게시로 우회하지 않는다.

`config/dev/runtime.yaml`·새 사본 scripts 변경도 CD plan을 생성한다. Helm 전용 변경은 계속 자동 CD 대상이
아니므로 필요하면 develop의 `workflow_dispatch`로 새 plan을 만든다. 스위치를 끄는 것은 새 plan에 적용된다.
Argo 인계 시 이미 승인된 사본 실행도 종료·취소됐는지 확인하고 이 writer를 먼저 중지한다. 실제 실행 중
이미지를 별도로 확인하여 정식 manifest·desired 기준을 인계한다.

### 실환경 수락

로컬 테스트와 별도로 reader AssumeRole·SSM/TLS·정확한 RBAC(다른 Secret get/list·write 거부), CD 최초 게시,
동일 내용 no-op, 실패 시 기존 사본 보존, publisher-only 재시도를 확인한다. 이번 구현은 AWS 배포·App 설치·
스위치 활성화·실제 사본 게시·Helm 적용을 수행한 증거가 아니다.
