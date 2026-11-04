# 0057. dev Argo의 Git 읽기 인증은 전용 GitHub App과 native repository Secret으로 공급한다

## Status

Accepted (PROJ-287; ADR 0056의 Git 관리 자격증명 공급 경계를 부분 대체한다. AWS 애플리케이션 Secret의 CSI 원칙과 C/B/V/P 공급 계약은 유지한다. 실제 App 설치·키 등록·권한 검증은 PROJ-310의 운영 수락 대상이다.)

## Context

[ADR 0056](0056-dev-argocd-gitops-operations.md)은 Argo의 Git 읽기 identity와 infra/backend 게시 identity를
분리한다. PROJ-279의 게시용 GitHub App은 private 저장소에 쓰기 권한을 요구하므로 Argo에 같은 개인키를
공급하면 읽기 전용 경계가 성립하지 않는다. job에서 installation token을 축소해도 개인키의 권한 상한은 줄지 않는다.

고정한 Argo CD v3.5.7의 native GitHub App 인증은 Kubernetes repository/repo-creds Secret에서
`githubAppPrivateKey`를 읽는다. `argocd repo add --github-app-private-key-path`는 운영자 파일의 내용을
등록하는 옵션이며 repo-server가 CSI 파일을 계속 참조하는 기능이 아니다. 기존 CSI-only 원칙을 그대로
적용하려면 별도 token broker 또는 Git credential helper의 구현·운영이 필요하다.

이 결정은 infra가 소유한 dev Argo 관리 인증 구현만 바꾼다. backend의 이미지 게시 권한, private 파일 형식,
publisher 간 CAS 계약과 애플리케이션 Secret 공급은 바꾸지 않는다.

## Decision

### 1. 읽기 identity와 저장소 범위

- `soma-376` 소유의 Argo 전용 GitHub App을 사용하고 선택 저장소는 `infra-generated-values` 하나로 제한한다.
  repository 권한은 `Contents: read`와 GitHub의 기본 Metadata 읽기다. organization 권한·Git 쓰기는 주지 않는다.
- 공개 `https://github.com/soma-376/infra.git`는 인증 없이 읽는다. reader App을 공개 infra나 backend에 설치하지 않는다.
- native repository credential은 `https://github.com/soma-376/infra-generated-values.git`의 정확한 URL에 연결한다.
  organization 전체에 적용하는 credential template은 사용하지 않는다. 여러 AppProject가 같은 저장소를 사용하므로
  저장소 credential은 특정 Project에 귀속시키지 않고 각 AppProject의 정확한 `sourceRepos` 허용목록으로 제어한다.
- Argo reader와 기존 infra publisher·후속 backend publisher의 개인키를 분리한다. 이 변경에서 기존 게시 workflow를
  수정하거나 같은 App의 token scope를 읽기 identity 분리의 대체물로 사용하지 않는다.
- 이 App은 Git 읽기용이다. Argo UI의 OAuth/SSO 로그인, webhook, 공개 callback endpoint는 구성하지 않는다.

### 2. native repository Secret의 제한적 예외

- `argocd` namespace에서 위 private 저장소 URL에 대응하는 native repository Secret 하나에만 reader 개인키를
  보관한다. 이는 Git 관리 인증을 위한 별도 예외이며 Strimzi 인증서 예외를 확대하는 것이 아니다.
- 운영자는 GitHub에서 발급받은 PEM 파일을 보호된 로컬 터미널에서 native CLI로 등록한다. App ID·Installation ID·
  저장소 URL·PEM 파일 경로만 운영 입력이다. PEM 원문을 명령 인자·환경변수·Git·Helm values·release history·
  generated YAML·CI artifact·로그·모델 컨텍스트로 전달하지 않는다. 실제 등록은 PROJ-310에서 수행한다.
- 별도 AWS Secrets Manager 원본·IAM·Pod Identity·CSI 동기화 리소스는 추가하지 않는다. 로컬 PEM은 등록·교체용
  임시 운영 입력이며 Secret 복구가 필요하면 GitHub에서 새 키를 발급한다. 같은 개인키를 다시 다운로드할 수 있다고 가정하지 않는다.
- 키는 등록 CLI/API, Kubernetes Secret과 이를 처리하는 Argo 프로세스를 거친다. repo-server만 키를 갖는다고
  표현하지 않는다. Secret 접근 권한은 기존 Argo 관리 경계로 제한하고 앱·publisher에 부여하지 않는다.
- CMP에 이 Secret을 mount하지 않고 `provideGitCreds=false`를 유지한다. repo-server와 CMP의 `/tmp`도 분리한다.
  같은 Pod의 sidecar 구성을 별도 보안 경계라고 주장하지 않는다.
- AWS 애플리케이션 Secret은 계속 ASCP/CSI/configtree로 공급한다. 앱 Secret 복제·Git 저장과 일반 Secret의
  native repository Secret 전환은 허용하지 않는다.

### 3. 수명과 복구

Argo의 native 인증 구현이 단기 installation token을 발급·캐시·갱신한다. 별도 token 저장·갱신 CronJob은 만들지
않는다. GitHub installation token은 한 시간 후 만료되지만 App 개인키는 운영자가 폐기해야 한다.

교체 순서는 새 개인키 발급 → 같은 repository credential 갱신 → 새 인증과 재시작·토큰 갱신 후 읽기 확인 →
이전 개인키 폐기다. 단순 캐시 hit를 새 키 성공으로 처리하지 않는다. 개인키 폐기가 이미 발급한 installation
token을 즉시 무효화한다고 가정하지 않으며, 긴급 회수에는 App 설치 중지·해제와 발급 token의 잔여 수명을 함께 고려한다.

Secret 소실 시에는 새 키 발급·등록·Git 읽기를 검증한다. 복구를 위해 앱 Secret, publisher 개인키 또는 개인 PAT를
대체 입력으로 사용하지 않는다. 결과에는 App/Installation 식별자·선택 저장소·권한·키 fingerprint·시각만 남긴다.

## Alternatives Considered

- 게시용 App 재사용: 등록 수는 줄지만 키 권한 상한에 Git 쓰기가 포함되므로 채택하지 않는다.
- CSI 파일과 custom broker/helper: Kubernetes Secret의 개인키 저장을 피할 수 있으나 자체 token 갱신·캐시·
  동시성·재시작·회전 검증이 필요하다. 현재 dev 도입 범위에는 native 인증을 사용한다.
- 전용 AWS Secrets Manager 원본에서 복제: 중앙 원본 보관이 가능하지만 별도 Secret·IAM·공급 절차가 추가되고
  native Secret 예외도 여전히 필요하다. 이번에는 운영자 등록과 새 키 발급 복구로 제한한다.
- PAT 또는 장기 installation token 저장: 사용자 계정이나 token 만료 운영에 결합되므로 사용하지 않는다.

## Consequences/Tradeoffs

### Positive

Argo의 읽기 권한 상한을 App 등록 자체로 제한하며 기본 인증의 token 갱신을 사용한다. 앱 Secret 공급과 게시
workflow를 변경하지 않고 GitOps 저장소 연결을 준비할 수 있다.

### Negative

개인키가 Kubernetes Secret에 보관되므로 Kubernetes/Argo 관리 권한과 운영자 키 취급을 신뢰해야 한다.
키 교체·폐기·복구는 운영 절차이며 자동 회전을 제공하지 않는다. 로컬 구성 검증은 실제 Git 권한이나 인증 갱신의 증거가 아니다.

## Follow-up

- PROJ-310에서 App 생성·선택 저장소 설치·키 등록과 실제 Git 읽기를 검증한다.
- 읽기 App의 쓰기 거부, 미설치 private 저장소 접근 거부, repo-server 재시작 뒤 읽기, token 만료 이후 갱신,
  새 키 전환·이전 키 폐기를 기록한다. 원문 없이 결과를 보관한다.
- PROJ-287의 Application·RBAC·CMP 로컬 구성과 실제 workload 인계는 구분한다. LBC 인증서 소유권 해결과
  관측 webhook hook 수락 등 [운영 런북](../runbooks/dev-argocd-operations.md)의 관문을 통과하기 전 자동화를 켜지 않는다.

## References

- [Argo v3.5.7 repository Secret 구현](https://github.com/argoproj/argo-cd/blob/v3.5.7/util/db/repository_secrets.go) — `repositoryToSecret`, `secretToRepository`
- [Argo v3.5.7 Git 인증 구현](https://github.com/argoproj/argo-cd/blob/v3.5.7/util/git/creds.go) — `GitHubAppCreds.getAccessToken`, `getInstallationTransport`
- [Argo v3.5.7 repository CLI](https://github.com/argoproj/argo-cd/blob/v3.5.7/cmd/argocd/commands/repo.go) — `NewRepoAddCommand`
- [GitHub App installation 인증](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation)
- [GitHub App 개인키 관리](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps)
