# PROJ-335 dev Argo CD root와 자동 동기화

이 절차는 이미 수동 인계한 18개 Application을 같은 코드·이미지로 root에 연결한다.
게시 계약은 [허브 ADR 0036](https://github.com/soma-376/docs/blob/main/adr/0036-simple-dev-git-publication-and-argocd-sync.md)과
[generated values 계약 v2](https://github.com/soma-376/docs/blob/main/contracts/generated-values-sync.md)를 따른다.
PROJ-334의 게시기는 Git 선택까지만 처리하고, root와 하위 Application이 실제 리소스를 적용한다.
이 문서와 로컬 테스트의 존재는 실제 dev 자동화 활성화 완료를 뜻하지 않는다.

## 1. 처음 연결할 때 보존할 것

- 기존 `pulsemetry-dev-*` Application 18개의 이름·UID, releaseName·namespace, Helm values 순서,
  Strimzi CMP, `ignoreDifferences`와 syncOptions를 보존한다.
- 현재 Application에 고정된 공통 infra SHA를 유지한다. 최신 chart나 새 이미지를 초기 연결에 섞지 않는다.
- Application별 values 참조가 다르면 각 참조의 실제 `dev/generated/<파일>` 바이트를 모은다.
  수동 offset-admin 사본은 현재 kafka Application의 values 참조에서 가져온다. 이 사본은 Job 실행 요청이 아니다.
- 현재 네 이미지와 일치하는 원본 완료 manifest 및 producer 증거를 사용한다. Secret 원문·kubeconfig·조회 응답을
  검토 자료나 Git에 넣지 않는다. endpoint·ARN이 있는 values와 검토 출력은 private 경로에서만 취급한다.

infra와 backend의 새 게시 스위치를 끄고, 기존 게시 실행이 모두 종료됐는지 확인한 뒤 시작한다.
기존 PROJ-279 사본 writer나 PROJ-311의 상태 기반 게시기를 동시에 실행하지 않는다.
private `main`에 `delivery-state.json`·`activation.json`·기존 desired가 있으면 초기 연결로 덮어쓰지 않는다.

## 2. 검토 자료 만들기

기존 EKS 운영자 context로 Application을 조회하되 Secret은 조회하지 않는다. 입력 JSON은 다음 형태로
필요한 필드만 정제한다. `status`, UID, resourceVersion, managedFields는 별도 로컬 비교 기록에 보관하며 입력에는 넣지 않는다.

```json
{
  "schemaVersion": 1,
  "expectedHead": "<private main의 현재 전체 SHA>",
  "applications": [
    {
      "apiVersion": "argoproj.io/v1alpha1",
      "kind": "Application",
      "metadata": {
        "name": "<기존 Application 이름>",
        "namespace": "argocd",
        "annotations": {},
        "labels": {}
      },
      "spec": {}
    }
  ]
}
```

`applications`에는 기존 18개 선언을 모두 넣는다. `spec`은 기존 값을 보존하고 metadata는 controller가
붙인 tracking 값이 아니라 기존 선언의 label·annotation만 남긴다. 예시 이름이나 빈 spec은 운영 입력이 아니다.
private values checkout에는 각 Application이 참조하는 commit이 존재해야 한다. generated 디렉터리는
정확한 파일 13개만 갖고, 각 파일은 해당 commit에서 가져온 내용이어야 한다.

```bash
node scripts/dev-gitops/bootstrap.mjs \
  --input "$BOOTSTRAP_INPUT" \
  --candidate "$COMPLETION_JSON" \
  --provenance "$PRODUCER_JSON" \
  --generated-dir "$CURRENT_GENERATED" \
  --values-repository "$VALUES_CHECKOUT" \
  --output-dir "$NEW_REVIEW_DIRECTORY"
```

기본 명령은 Git과 클러스터에 쓰지 않는다. 현재 참조의 파일 바이트를 로컬 Git object와 대조하고 다음을 만든다.

- `snapshot/`: 현재 설정·이미지·producer를 보존한 게시 입력
- `templates/`: 기존 비교 설정을 보존하고 auto sync·self-heal만 켠 child 입력
- `root.yaml`: root 선언. `dev/applications` 안에 root 자신을 넣지 않는다.
- `bootstrap-review.json`: 원본 HEAD·infra SHA·bundle hash·파일 hash. 아직 values/desired commit은 null이다.

`templates/`는 새 values SHA를 아직 갖지 않는 입력이므로 그대로 적용하지 않는다. root·child 모두
`automated.enabled=true`, `selfHeal=true`, `prune=false`, `allowEmpty=false`, `retry.limit=0`을 사용한다.

## 3. Git 게시와 root 한 번 등록

같은 입력으로 원본 성공 run/attempt·artifact ZIP/hash·이미지 packaged contract를 다시 확인한 뒤 게시한다.
현재 배포 이미지를 검증하므로 더 새로운 producer가 있다는 이유만으로 초기 이미지를 교체하지 않는다.
게시 인증은 기존 승인된 publisher 실행 경로에서 런타임으로 공급하고 원문을 명령 인자·로그에 출력하지 않는다.

```bash
BOOTSTRAP_ENABLED=true node scripts/dev-gitops/bootstrap.mjs \
  --input "$BOOTSTRAP_INPUT" \
  --candidate "$COMPLETION_JSON" \
  --provenance "$PRODUCER_JSON" \
  --generated-dir "$CURRENT_GENERATED" \
  --values-repository "$VALUES_CHECKOUT" \
  --output-dir "$NEW_PUBLISH_DIRECTORY" \
  --publish
```

게시기는 snapshot commit을 먼저 로컬에서 만들고, 그 SHA를 참조하는 desired·18개 Application·root commit을
만든 후 한 번 push한다. 예상 HEAD가 바뀌면 중단한다. 두 publisher의 장기 잠금이나 readiness 파일을 만들지 않는다.
`published/`가 최종 Git 선언이며 `bootstrap-result.json`의 `clusterApplied`는 false다.

기존 EKS 운영자는 현재 AppProject·관리 RBAC·Git reader가 준비됐는지 확인하고 root 하나만 적용한다.

```bash
kubectl --context "$EXISTING_EKS_OPERATOR_CONTEXT" apply -f "$NEW_PUBLISH_DIRECTORY/root.yaml"
```

root는 private main의 `dev/applications`를 읽어 기존 child를 갱신한다. child auto sync가 실제 workload를 적용한다.
ApplicationSet·새 AWS 역할·CI의 Kubernetes 쓰기 권한은 필요하지 않다. Argo CD 자체와 management Helm은
기존 수동 관리로 남는다.

## 4. 완료 확인과 이후 운영

처음 연결한 뒤 root와 18개 child가 현재 목표 revision의 `Synced / Healthy`이며 진행 중 operation이 없는지 확인한다.
초기 연결 전후의 child UID·PVC UID/volume/capacity·네 image digest·replica·mount가 보존되는지 대조한다.
예상하지 않은 교체·삭제·설정 차이는 일반 자동 배포로 숨기지 않고 원인을 해결한다.

검토한 비파괴 metadata 변경을 PROJ-334 게시기로 한 번 게시하여 root의 child 참조 변경과 실제 리소스 반영을 확인한다.
그 metadata에만 drift를 만들고 self-heal 복구를 확인한다. backend 이미지 게시도 실제 Git 선택과 Argo 적용을 각각 기록한다.
이 검증을 로그인·업무조회·전체 수집 저장·인증서 회전 성공으로 확대하지 않는다.

일반 게시기는 rollout 완료를 기다리지 않는다. 연속 변경은 중간 버전을 건너뛰고 최신 Git 상태로 수렴할 수 있다.
실패하면 Argo UI와 현재 revision에서 확인하며 자동 rollback이나 전역 blocked 상태를 만들지 않는다.
같은 revision의 sync 실패를 끝없이 자동 재시도하지 않으므로 원인을 고친 새 Git 선언이나 명시적 수동 sync로 복구한다.

유지보수는 Git에서 대상 child의 `automated.enabled=false`와 `selfHeal=false`를 함께 기록하고 root 반영·현재 operation
종료를 확인한 뒤 수행한다. publisher는 이 정책을 보존한다. 재개는 같은 Git 경로로 다시 켠다.
root 자체를 중지해야 하면 운영자가 root의 자동화를 먼저 끄고 Git 작업을 진행한다.
복구는 검토한 이전 Git 선언 또는 수정 선언을 게시하는 수동 절차이며 DB downgrade·PVC 복원·offset reset은 자동화하지 않는다.

## 5. 로컬 확인

```bash
node --test test/dev-gitops/bootstrap.test.mjs
```

테스트는 초기 source·effective bytes 보존, 위험한 입력 거부, stale HEAD 거부, 상태 파일 없는 두 commit 게시,
명시적 publish 없는 검토 명령의 무부작용을 확인한다. AWS·GitHub·실제 클러스터를 호출하지 않는다.
