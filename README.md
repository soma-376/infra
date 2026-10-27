# Pulsemetry AWS 인프라

AWS CDK v2로 prod·dev·cicd를 관리한다. dev 백엔드는 EKS 전용이며 prod와 `frontend/` Terraform의 ECS는 유지한다.
무인자 환경 기본값은 **prod**다. 실행 전 대상 환경과 diff를 확인한다.

## 문서 진입점

- [AGENTS.md](AGENTS.md): 스택 구조·입력·불변 규칙
- [ADR 인덱스](docs/adr/README.md), [dev EKS 전용 ADR-0035](docs/adr/0035-dev-backend-eks-only.md)
- [기존 dev ECS 수동 철거](docs/runbooks/dev-ecs-retirement.md): PROJ-249 선행·수동 Snapshot·Application 삭제·Edge/Network/IAM 순서
- [EKS 수동 설치·검증·복구](docs/runbooks/dev-eks-manual-deployment.md)
- [telemetry Gateway·MSK](docs/runbooks/dev-telemetry-kafka.md), [Prometheus·Grafana 관측](docs/runbooks/dev-observability.md)
- [dashboard 저장소·인증 준비](docs/runbooks/dev-dashboard-prerequisites.md), [OIDC 준비](docs/runbooks/dev-oidc-prerequisites.md)
- [DB 비공개 접근·SSM 릴레이](docs/runbooks/dev-database-access.md)
- [HTTPS 적용·복구](docs/runbooks/dev-alb-https.md)
- [PROJ-248 로컬 검증 결과](docs/runbooks/proj248-local-validation.md)
- [PROJ-254 DB 접근 변경 로컬 검증 결과](docs/runbooks/proj254-local-validation.md)
- [공통 dashboard 계약](../docs/contracts/dashboard-api.md): API·설정·저장소·인증의 단일 출처; dev ECS CD 종료 정합화는 PROJ-249 인계
- [PROJ-206~212 역사적 검증](docs/runbooks/dev-eks-local-validation.md), [dashboard 역사적 검증](docs/runbooks/proj218-local-implementation-validation.md)

PROJ-248은 코드·문서·로컬 검증이다. 실제 AWS 철거·Snapshot 생성·DB 연결 문제 해결·EKS 기능 검증은 별도 증거다.
코드에서 Application 스택을 제거해도 배포된 스택은 자동 삭제되지 않는다. 최초 철거에 dev 전체 배포를 사용하지 않는다.

## 로컬 검증과 입력

```bash
npm run build
# 관측 의존 차트를 lock의 고정 SHA-256으로 준비한다.
node scripts/observability-prepare.mjs
# Helm/schema 검증까지 포함하려면 Helm 3.22.0·kubeconform 0.8.0 경로를 지정한다.
HELM_BIN=/path/to/helm-3.22.0 KUBECONFORM_BIN=/path/to/kubeconform PROMTOOL_BIN=/path/to/promtool-3.9.1 npm test -- --runInBand
# 실행 계정과 기존 AWS 인증을 준비한다. 실제 dev profile이 자동 선택된다.
: "${CDK_DEFAULT_ACCOUNT:?대상 계정을 환경으로 지정한다}"
AWS_REGION=ap-northeast-2 npm run synth:dev
```

`config/dev/deployment.json`은 dev 도메인·인증서 UUID·전체 context를, `config/dev/runtime.yaml`은
JWT·OIDC 고정 버전·callback·DB TLS·tracing·dashboard 설정을 소유한다. 실제 계정 ID와 Secret 원문은 넣지 않는다.
공식 dev CDK 명령과 `npm run values:dev -- ...`가 같은 profile을 읽는다. 이미지 digest·배포 output·MSK 조회 결과만
실행마다 공급하며 [도메인 런북](docs/runbooks/dev-domain-migration.md)을 따른다. 이전 개인 runtime/보고서 파일은 원본이 아니다.
profile 없는 저수준 명령은 기존 동작을 유지하지만 현재 dev 후속 배포에는 사용하지 않는다.
`devDashboardRuntimeFile`과 ECS image/ASG/certificate 입력은 제거됐다.
기존 EKS와 앱 `Validation*` output·TG 이름을 유지한다. PROJ-254는 ClickHouse 공개 output/TG/TGB와
ClickHouse Helm의 `vpcId`·`targetGroupBindings` 입력을 제거한다. 구 values를 재사용하지 말고 새 생성기로 만든다.
