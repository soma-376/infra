# Pulsemetry AWS 인프라

AWS CDK v2로 prod·dev·cicd를 관리한다. dev 백엔드는 EKS 전용이며 prod와 `frontend/` Terraform의 ECS는 유지한다.
무인자 환경 기본값은 **prod**다. 실행 전 대상 환경과 diff를 확인한다.

## 문서 진입점

- [AGENTS.md](AGENTS.md): 스택 구조·입력·불변 규칙
- [ADR 인덱스](docs/adr/README.md), [dev EKS 전용 ADR-0035](docs/adr/0035-dev-backend-eks-only.md)
- [기존 dev ECS 수동 철거](docs/runbooks/dev-ecs-retirement.md): PROJ-249 선행·수동 Snapshot·Application 삭제·Edge/Network/IAM 순서
- [EKS 수동 설치·검증·복구](docs/runbooks/dev-eks-manual-deployment.md)
- [dashboard 저장소·인증 준비](docs/runbooks/dev-dashboard-prerequisites.md), [OIDC 준비](docs/runbooks/dev-oidc-prerequisites.md)
- [HTTPS 적용·복구](docs/runbooks/dev-alb-https.md)
- [PROJ-248 로컬 검증 결과](docs/runbooks/proj248-local-validation.md)
- [공통 dashboard 계약](../docs/contracts/dashboard-api.md): API·설정·저장소·인증의 단일 출처; dev ECS CD 종료 정합화는 PROJ-249 인계
- [PROJ-206~212 역사적 검증](docs/runbooks/dev-eks-local-validation.md), [dashboard 역사적 검증](docs/runbooks/proj218-local-implementation-validation.md)

PROJ-248은 코드·문서·로컬 검증이다. 실제 AWS 철거·Snapshot 생성·DB 연결 문제 해결·EKS 기능 검증은 별도 증거다.
코드에서 Application 스택을 제거해도 배포된 스택은 자동 삭제되지 않는다. 최초 철거에 dev 전체 배포를 사용하지 않는다.

## 로컬 검증과 입력

```bash
npm run build
# Helm/schema 검증까지 포함하려면 Helm 3.22.0·kubeconform 0.8.0 경로를 지정한다.
HELM_BIN=/path/to/helm-3.22.0 KUBECONFORM_BIN=/path/to/kubeconform npm test -- --runInBand
# OIDC 원본이 없는 신규 환경의 명시적 빈 목록 예시다. 기존 환경에서는 전체 key 목록을 유지한다.
npm run synth:dev -- -c 'devOidcClientKeys=[]'
```

`devOidcClientKeys`는 CDK 원본 선언이다. JWT·OIDC 버전·callback·dashboard 설정은 별도 EKS runtime YAML을
`eks-values.mjs --runtime-values`로 전달한다. `devDashboardRuntimeFile`과 ECS image/ASG/certificate 입력은 제거됐다.
EKS resource ID·`Validation*` output·TG 이름·Helm 입력 형식은 유지한다.
