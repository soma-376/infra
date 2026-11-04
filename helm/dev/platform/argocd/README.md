# dev Argo CD 설치 기반

[ADR 0056](../../../../docs/adr/0056-dev-argocd-gitops-operations.md)의 Argo 자체를 운영자가 수동 Helm으로 관리한다.
PROJ-274는 고정 설치 구성·로컬 검사·운영 절차를 제공한다. **실제 dev 설치·UI 로그인·재기동 성공은 별도 검증이다.**
기존 workload의 Helm 인계, private Git 연결, 관리 대상 AppProject/RBAC, Strimzi CMP와 중앙 관측 연결은 후속 작업이다.

## 고정 입력과 초기 권한

- release와 namespace는 모두 `argocd`다. 공식 chart **10.11.7**, Argo CD **v3.5.7**, 실행 도구 **Helm 3.22.0**을 사용한다.
  `vendor/`의 원본 archive와 `SOURCE.json`·`SHA256SUMS`를 함께 관리하고, 실행 이미지는 ARM64를 확인한 digest로 고정한다.
- `values.yaml`은 기존 `pulsemetry-dev-apps` ARM64 노드의 비 HA 구성이다. server는 TLS를 유지한 ClusterIP이며
  공개 ALB·Ingress·DNS와 별도 NodePool은 만들지 않는다. 실제 설치 전 apps 풀의 가용 자원·Pod requests를 확인한다.
- `createClusterRoles=false`·`createAggregateRoles=false`로 광역 역할을 만들지 않는다. Argo 내부 Role은 `argocd`의
  설정·Secret·Argo CR 운영에만 사용한다. `cluster.inClusterEnabled=false`라 적용 대상 로컬 클러스터도 비활성이다.
  이는 설치용 권한이며 ADR의 최종 dev workload 관리 RBAC를 구현한 상태가 아니다.
- Application을 생성하지 않는다. ApplicationSet은 chart에 `enabled` 옵션이 없어 `replicas=0`으로 중지하고
  `allowAnyNamespace=false`를 유지한다. Dex·notifications와 private Git 자격증명은 이 설치에 연결하지 않는다.
- `bootstrap-default-project.yaml`은 default Project의 source·destination·resource 권한을 닫는다.
  Helm release와 별도로 운영자가 적용·관리하며, 후속 Application도 별도 명시적 Project를 사용한다.

## 로컬 검증

아래 명령은 레포 루트에서 실행한다. live 클러스터 연결이나 Secret 조회 없이 고정 archive를 렌더한다.

```bash
set -euo pipefail
: "${HELM_BIN:?검증한 Helm 3.22.0 실행 파일 경로}"
test "$("$HELM_BIN" version --template '{{.Version}}')" = v3.22.0
(cd helm/dev/platform/argocd && shasum -a 256 -c SHA256SUMS)
"$HELM_BIN" lint helm/dev/platform/argocd/vendor/argo-cd-10.11.7.tgz \
  --strict --kube-version 1.36.0 --namespace argocd \
  --values helm/dev/platform/argocd/values.yaml
ARGOCD_RENDER=$(mktemp)
"$HELM_BIN" template argocd helm/dev/platform/argocd/vendor/argo-cd-10.11.7.tgz \
  --namespace argocd --kube-version 1.36.0 \
  --values helm/dev/platform/argocd/values.yaml > "$ARGOCD_RENDER"
HELM_BIN="$HELM_BIN" npm test -- --runInBand test/helm/argocd.test.ts
rm "$ARGOCD_RENDER"
```

렌더 검사에는 checksum·이미지 digest·ARM64 배치, TLS/ClusterIP, namespace Role과 광역 권한 부재,
Application 부재, 별도 default Project의 제한을 포함한다. 실제 스케줄링·TLS 접속·권한 거부의 증거로 확대하지 않는다.

## 수동 설치

먼저 [EKS 수동 런북](../../../../docs/runbooks/dev-eks-manual-deployment.md) §2-3의 operator 프로필·터널·kubeconfig 절차를 따른다.
SSM 터널을 유지하고 그 절차에서 만든 전용 `KUBECONFIG`·`EKS_CONTEXT_NAME`을 사용한다.
원래 EKS hostname과 CA 검증을 유지하며 기본 kubeconfig로 대체하지 않는다.
다음 명령은 **실제 적용 절차**이며 로컬 검증 단계에서 실행하지 않는다.

```bash
set -euo pipefail
: "${HELM_BIN:?검증한 Helm 3.22.0 실행 파일 경로}"
: "${KUBECONFIG:?EKS SSM 전용 kubeconfig 경로}"
: "${EKS_CONTEXT_NAME:?EKS 런북에서 준비한 dev SSM context 이름}"
test "$("$HELM_BIN" version --template '{{.Version}}')" = v3.22.0
test "$(kubectl --kubeconfig "$KUBECONFIG" config current-context)" = "$EKS_CONTEXT_NAME"
kubectl --kubeconfig "$KUBECONFIG" --context "$EKS_CONTEXT_NAME" \
  config view --minify -o jsonpath='{.contexts[0].context.cluster}{"\n"}{.clusters[0].cluster.server}{"\n"}{.clusters[0].cluster.tls-server-name}{"\n"}'
kubectl --kubeconfig "$KUBECONFIG" --context "$EKS_CONTEXT_NAME" \
  --request-timeout=15s get --raw=/readyz
"$HELM_BIN" --kubeconfig "$KUBECONFIG" --kube-context "$EKS_CONTEXT_NAME" list --all-namespaces
```

출력된 cluster의 계정·리전·dev 식별자와 loopback 서버 주소·원래 TLS hostname을 배포 기록과 대조한다.
기존 `argocd` release·namespace 또는 Argo CRD가 있으면 소유권과 버전을 먼저 조사한다. 기존 리소스에
`--take-ownership`을 적용하거나 설치 실패를 피하려고 CRD를 지우지 않는다. 대상과 소유권이 맞을 때만 계속한다.

```bash
(cd helm/dev/platform/argocd && shasum -a 256 -c SHA256SUMS)
"$HELM_BIN" upgrade --install argocd helm/dev/platform/argocd/vendor/argo-cd-10.11.7.tgz \
  --kubeconfig "$KUBECONFIG" --kube-context "$EKS_CONTEXT_NAME" \
  --namespace argocd --create-namespace \
  --values helm/dev/platform/argocd/values.yaml --wait --wait-for-jobs --timeout 10m
kubectl --kubeconfig "$KUBECONFIG" --context "$EKS_CONTEXT_NAME" wait \
  --for=condition=Established --timeout=120s \
  crd/applications.argoproj.io crd/applicationsets.argoproj.io crd/appprojects.argoproj.io
kubectl --kubeconfig "$KUBECONFIG" --context "$EKS_CONTEXT_NAME" apply \
  -f helm/dev/platform/argocd/bootstrap-default-project.yaml
kubectl --kubeconfig "$KUBECONFIG" --context "$EKS_CONTEXT_NAME" -n argocd \
  get deploy,statefulset,pod,service,appproject,application,applicationset
```

chart는 CRD를 `templates/crds/`에서 렌더한다. 첫 설치에서 default Project까지 `extraObjects`에 넣으면
CRD 등록 전 discovery가 실패할 수 있으므로 위 두 단계를 합치지 않는다. chart의 Redis 초기화는 pre-install hook Job이다.
실패 시 Job 상태와 원문을 제외한 오류를 조사하고, `--no-hooks`·인증 비활성화로 우회하지 않는다.

## 접속과 초기 관리자 처리

같은 전용 kubeconfig·context를 준비한 별도 터미널에서 SSM 세션과 아래 port-forward를 함께 유지한다.

```bash
: "${KUBECONFIG:?EKS SSM 전용 kubeconfig 경로}"
: "${EKS_CONTEXT_NAME:?확인한 dev SSM context 이름}"
kubectl --kubeconfig "$KUBECONFIG" --context "$EKS_CONTEXT_NAME" -n argocd \
  port-forward --address 127.0.0.1 service/argocd-server 8080:443
```

브라우저에서 `https://127.0.0.1:8080`을 연다. 초기 인증서는 Argo가 생성한 self-signed 인증서이므로
브라우저 경고가 예상된다. 확인한 dev context의 loopback port-forward인지 대조한 뒤 해당 로컬 접속만 처리한다.
server TLS나 EKS CA 검증을 끄거나 port-forward를 `0.0.0.0`에 열지 않는다.

초기 사용자 이름은 `admin`이다. **아래 조회는 운영자가 기록·화면 공유가 없는 로컬 터미널에서 직접 실행한다.**
에이전트 도구로 실행하지 않으며 원문을 대화·모델 컨텍스트·Git·파일·검증 로그에 복사하지 않는다.
AWS 애플리케이션 Secret을 Argo 관리 자격증명으로 재사용하지 않는다.

```bash
set +x
kubectl --kubeconfig "$KUBECONFIG" --context "$EKS_CONTEXT_NAME" -n argocd \
  get secret argocd-initial-admin-secret -o go-template='{{.data.password | base64decode}}{{"\n"}}'
```

UI의 User Info에서 즉시 암호를 바꾸고 로그아웃·재로그인으로 새 암호를 확인한다. 안전한 운영자 보관소에
관리 자격증명을 보관한 뒤 초기 Secret만 정리한다. 암호와 세션 토큰은 증거에 포함하지 않는다.

```bash
kubectl --kubeconfig "$KUBECONFIG" --context "$EKS_CONTEXT_NAME" -n argocd \
  delete secret argocd-initial-admin-secret
```

`argocd-secret`·Redis 인증 Secret은 삭제하지 않는다. 초기 admin 처리는 SSO·팀별 관리 RBAC 구축의 완료가 아니다.

## 운영 수락·업그레이드·복구

실제 설치 후에만 다음을 기록한다: infra SHA·chart/version·Pod imageID, 세 CRD Established,
server/repo-server/controller/Redis Ready, ApplicationSet replica 0, ClusterIP와 loopback UI 로그인,
default Project 제한·관리 Application 부재, ServiceAccount의 대상 밖 변경 거부, 초기 암호 변경·Secret 정리 여부.
동일 입력 재적용과 Pod 재생성 뒤 회복도 별도 확인한다. `kubectl auth can-i --as` 검사는 운영자의 impersonation
권한이 필요하며, 실행할 수 없으면 실제 거부 검증을 미확인으로 남긴다.

업그레이드는 공식 upgrade 안내와 CRD 호환성을 검토하고 vendor·checksum·이미지·values를 한 변경으로 리뷰한 뒤
로컬 검사와 live diff를 거쳐 수동 적용한다. `--reuse-values`나 임의 `--set`을 다음 배포 원본으로 사용하지 않는다.
실패 시 현재 Helm revision·Pod/Job 상태를 확인하고 검증된 추적 입력으로 복구한다. `helm uninstall`, namespace/CRD 삭제,
CRD 자동 downgrade 또는 과거 revision으로의 무조건적인 rollback을 복구 명령으로 사용하지 않는다.
`crds.keep=true`는 전체 복구 보장을 의미하지 않는다.

PROJ-287/310에서 private Git 읽기·관리 RBAC·AppProject·Application/CMP와 인계 조건을 준비한 뒤에만
로컬 클러스터 관리를 활성화한다. 그전에는 기존 앱 배포를 수동 Helm으로 유지한다. 현재 Fluent Bit 수집 목록에
`argocd`는 없으며 이 변경은 중앙 로그·metrics 연결을 추가하지 않는다. 전체 인계·배포·복구 계약은
[Argo 운영 런북](../../../../docs/runbooks/dev-argocd-operations.md)이 소유한다.

참고: [namespace 설치](https://argo-cd.readthedocs.io/en/stable/operator-manual/installation/),
[default Project 제한](https://argo-cd.readthedocs.io/en/stable/user-guide/projects/#the-default-project),
[초기 로그인](https://argo-cd.readthedocs.io/en/stable/getting_started/#4-log-in-using-the-cli),
[CRD 설치 순서](https://helm.sh/docs/chart_best_practices/custom_resource_definitions/).
