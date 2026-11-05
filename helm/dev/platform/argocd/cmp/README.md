# Strimzi 렌더 전용 CMP

`pulsemetry-strimzi-v1`은 Application의 고정 infra commit C를 repo root로 checkout한 뒤 그 C의
vendor archive·SHA-256·정적 values와 `scripts/strimzi-operator-post-render.mjs`를 사용한다.
Helm 3.22.0과 `--include-crds`를 보존하고 `--skip-tests`로 테스트 hook을 제외한다.
namespace는 `strimzi-system`, Kubernetes 버전은 1.36.0이다.
release 이름은 inventory에서 검증해 전달한 `ARGOCD_ENV_RELEASE_NAME`으로만 받는다.

이미지는 Node 24.14.1의 ARM64 지원 index digest와 별도 `package-lock.json`의 js-yaml 5.2.3을 사용한다.
repo root의 node_modules나 ESM에서 동작하지 않는 NODE_PATH에 의존하지 않는다. 같은 C의 renderer를
임시 디렉터리에 복사하고 이미지의 고정 node_modules를 연결하므로 Git checkout과 executable bit를 바꾸지 않는다.
archive·Helm 버전·원본 감시 목록·렌더 성공·비어 있지 않은 출력을 검증한 뒤에만 최종 YAML을 stdout에 쓴다.

```bash
docker build --platform linux/arm64 -t pulsemetry-strimzi-cmp:local helm/dev/platform/argocd/cmp
HELM_BIN=/path/to/helm-3.22.0 PULSEMETRY_CMP_IMAGE=pulsemetry-strimzi-cmp:local \
  npm test -- --runInBand test/scripts/dev-argocd-renderers.test.ts
node scripts/dev-argocd-prepare-charts.mjs --check
```

이 build는 registry 게시가 아니다. 운영 적용 전에 게시한 이미지의 검증된 ARM64 digest를 관리 설정에 입력해야 한다.
sidecar는 UID 999·비루트·읽기 전용 root, 별도 `/tmp` emptyDir와 제한된 자원을 사용한다.
Argo가 제공하는 cmp-server binary·plugin socket·이 디렉터리의 plugin.yaml만 연결한다.
Git credential·ServiceAccount token을 CMP에 mount하지 않고 `provideGitCreds=false`, `preserveFileMode=false`를 유지한다.
같은 Pod의 sidecar라는 사실을 독립된 보안 경계로 해석하지 않는다.

Argo 3.5.7 공식 소스의 native renderer는 Helm 4.2.1이다. 위 Helm 3.22.0은 Strimzi CMP 전용이다.
`ARGOCD_NATIVE_HELM_BIN`에 검증한 4.2.1을 지정하면 테스트가 native chart fixture의 3.22.0 결과와 비교한다.
PROJ-310은 LBC의 cert-manager 경로에서 반복 렌더 동일성을 검사하고, cert-manager startup과
observability의 Helm hook은 phase·RBAC·반복 실행 계약을 검사한다. 실제 인증서 전환과 반복 sync는 별도 수락이다.
이 로컬 비교는 실제 release inventory·live manifest·PVC·인증서·기능의 인계 검증을 대신하지 않는다.

## vendored chart 갱신

`scripts/dev-argocd-prepare-charts.mjs --write --archive <공식 tgz>`는 기존 버전 파일의 checksum에
맞는 입력만 받는다. LBC·cert-manager·CSI driver·ASCP·Fluent Bit은 native Application이 읽도록 풀어 두고,
observability wrapper의 의존성 archive 4개는 원본 바이트 그대로 보관한다. `--check`는 네트워크 없이
checksum과 풀어 둔 모든 파일의 집합·내용을 대조하며 source를 수정하지 않는다.
Argo는 dependency update나 runtime 다운로드 없이 이 고정 checkout을 렌더한다.
