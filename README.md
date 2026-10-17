# Pulsemetry AWS 인프라

AWS CDK v2로 prod·dev·cicd 리소스를 관리한다. 무인자 환경 기본값은 **prod**다.
명령 실행 전 대상 환경과 변경 diff를 확인한다.

## 문서 진입점

- [AGENTS.md](AGENTS.md): 스택 구조·불변 규칙·기존 배포 런북과 현재 구현 기준
- [ADR 인덱스](docs/adr/README.md): 결정과 부분 대체 관계
- [dashboard 배포 ADR-0029](docs/adr/0029-dev-dashboard-api-ecs-and-eks-deployment.md): 최초 이미지·수동 CDK·세 앱 ECS CD·수동 EKS Helm의 순서와 증거
- [dashboard 저장소·인증 준비 런북](docs/runbooks/dev-dashboard-prerequisites.md): DB 계정 Secret 4개·JWT 원본 2개와 수동 DB 준비·키 등록·후속 인계
- [EKS 수동 설치·검증·복구 런북](docs/runbooks/dev-eks-manual-deployment.md): PROJ-207~211 및 dashboard 후속 구현이 준비된 checkout에서 실행
- [PROJ-206~212 로컬 검증 기록](docs/runbooks/dev-eks-local-validation.md): 당시 검증 증거와 live 미검증 경계
- [공통 dashboard 계약](../docs/contracts/dashboard-api.md): endpoint·method·OPTIONS·설정명·저장소·인증의 단일 출처

PROJ-220은 문서 채택이다. PROJ-226의 dashboard ECR 공급 권한에 이어 PROJ-222는 공통 Secret 리소스를
정의한다. DB 비밀번호는 향후 배포 시 생성되며 JWT 원본은 값 없이 생성된다. DB 계정 생성·키 등록은
운영자가 수동으로 수행하고, runtime 주입은 PROJ-230·231에서 연결한다. dashboard 서비스나 EKS workload의
생성·기동·AWS 배포 성공을 뜻하지 않으며 이번 작업에서 배포 명령은 실행하지 않는다.

## 로컬 검증

```bash
npm run build
npm test -- --runInBand
```

CDK 합성·배포와 환경별 옵션은 AGENTS.md의 명령어 및 실행할 런북을 따른다.
실제 배포 전에 이미지·설정·기능·복구의 각 완료조건을 별도로 확인한다.

### PROJ-230·221 로컬 구현

dev dashboard ECS 서비스와 파일 기반 JWT 공급을 구현했다. dev synth는
`-c devDashboardRuntimeFile=<비밀 없는 JSON 경로>`를 필수로 받는다.
입력 구조·서비스·라우팅·검증 경계는 [ECS runtime 런북](docs/runbooks/dev-dashboard-ecs-runtime.md)을 따른다.
실제 DB 준비·키 등록·이미지 공급·AWS 배포는 이 구현에 포함하지 않는다.
