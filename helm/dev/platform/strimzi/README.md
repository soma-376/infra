# dev Strimzi Operator

공식 Strimzi 1.3.0 archive·SHA256과 multi-arch 이미지 digest는 `SOURCE.json`에 고정한다.
Kafka 4.2.2와 dev EKS 1.36을 사용한다. ARM64 manifest가 있는 이미지만 선택했다.
설치·인증서·전환·철거는 [런북](../../../../docs/runbooks/dev-strimzi-kafka.md)을 따른다.

Helm **3.22.0**으로 실행한다. upstream chart는 감시 목록에 operator namespace를 덧붙이므로
`scripts/strimzi-operator-post-render.mjs`를 모든 install/upgrade에 함께 사용한다.
검증된 namespace 목록이 아니면 renderer가 실패한다. 공식 CRD와 RBAC는 변형하지 않고,
`STRIMZI_NAMESPACE`만 `pulsemetry-dev`로 좁힌다. Helm 4의 plugin post-renderer와 혼용하지 않는다.

Strimzi CRD는 cluster scope다. 기존 Strimzi 설치가 있으면 CRD 버전·소유 release·RBAC 충돌을 먼저 조사한다.
Helm의 CRD 자동 업그레이드에 의존하지 않는다. 이번 초기 설치는 vendor의 CRD를 사용하며
다음 버전 변경은 공식 upgrade 절차와 검증된 Kafka 버전 조합을 별도 검토한다.

[ADR 0054](../../../../docs/adr/0054-dev-argocd-gitops-operations.md)의 Argo 인계 이후에는 전용 CMP가
같은 vendor·Helm 3.22.0·post-render 검증을 수행한다. 이 문서 추가로 CMP가 구현되거나 인계가 완료된 것은 아니다.
실제 인계 전에는 위 Helm 경로를 유지하며 renderer를 생략한 native Helm Application으로 대체하지 않는다.
