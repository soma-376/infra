# dev cert-manager 고정 구성

[ADR 0058](../../../../docs/adr/0058-dev-lbc-cert-manager-and-argocd-handoff.md)의 신규 플랫폼 Application이다.
namespace와 release는 `cert-manager`이며 기존 ARM64 apps 노드를 사용한다. Kubernetes 1.36과
cert-manager v1.21.3의 공식 지원 범위를 기준으로 고정했다.

`SOURCE.json`은 공식 chart index의 checksum, 공개 이미지 index digest와 실제 `linux/arm64` child
manifest digest를 기록한다. 다섯 이미지의 child manifest·config 해시와 config의 OS/architecture를 조회해
확인했으며 `values.yaml`은 child digest를 사용한다. ACME solver도 고정하지만 이번 LBC는 CA Issuer만 쓴다.
`chart/`는 `vendor/cert-manager-v1.21.3.tgz`를 그대로 펼친 원본이다. 원본을 직접 수정하지 않는다.

```bash
node scripts/dev-argocd-prepare-charts.mjs --check
helm template cert-manager helm/dev/platform/cert-manager/chart \
  --namespace cert-manager --kube-version 1.36.0 --include-crds --skip-tests \
  --values helm/dev/platform/cert-manager/values.yaml
```

실제 렌더 비교에는 고정 Helm 3.22.0과 Argo native Helm 4.2.1을 사용한다. `crds.enabled=true`와
`crds.keep=true`를 유지하고 Application은 server-side apply를 사용한다. Namespace는 `extraObjects`로
생성한다. leader-election Lease는 `cert-manager` namespace에 두고 기존 기본 사용자 역할로 RBAC를 집계하지 않는다.

startup API check의 SA·Role·RoleBinding은 PostSync의 wave -5, Job은 wave 1이다. Helm에서는
`post-install,post-upgrade`로 실행하고 `before-hook-creation,hook-succeeded` 정책으로 재실행한다.
webhook의 `hostNetwork=false`·10250과 기존 SG를 유지한다. 실제 control-plane 통신, 인증서 발급·갱신,
반복 sync와 LBC 인계는 [운영 런북](../../../../docs/runbooks/dev-argocd-operations.md)의 별도 수락 대상이다.

- [공식 지원 버전](https://cert-manager.io/docs/releases/)
- [공식 Helm 설치](https://cert-manager.io/docs/installation/helm/)
- [공식 chart index](https://charts.jetstack.io/index.yaml)
