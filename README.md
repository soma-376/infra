# Pulsemetry AWS 인프라

AWS CDK v2로 prod·dev·cicd 리소스를 관리한다. 무인자 환경 기본값은 **prod**다.
명령 실행 전 대상 환경과 변경 diff를 확인한다.

## 문서 진입점

- [AGENTS.md](AGENTS.md): 스택 구조·불변 규칙·기존 배포 런북과 현재 구현 기준
- [ADR 인덱스](docs/adr/README.md): 결정과 부분 대체 관계
- [dashboard 배포 ADR-0029](docs/adr/0029-dev-dashboard-api-ecs-and-eks-deployment.md): 최초 이미지·수동 CDK·세 앱 ECS CD·수동 EKS Helm의 순서와 증거
- [EKS 수동 설치·검증·복구 런북](docs/runbooks/dev-eks-manual-deployment.md): PROJ-207~211 및 dashboard 후속 구현이 준비된 checkout에서 실행
- [PROJ-206~212 로컬 검증 기록](docs/runbooks/dev-eks-local-validation.md): 당시 검증 증거와 live 미검증 경계
- [공통 dashboard 계약](../docs/contracts/dashboard-api.md): endpoint·method·OPTIONS·설정명·저장소·인증의 단일 출처

PROJ-220은 문서 채택이다. 현재 PROJ-226 코드는 dashboard ECR 공급 권한만 준비하며 dashboard 서비스나
EKS workload의 생성·기동·AWS 배포 성공을 뜻하지 않는다. 문서에 적힌 배포 명령은 이번 작업에서 실행하지 않는다.

## 로컬 검증

```bash
npm run build
npm test -- --runInBand
```

CDK 합성·배포와 환경별 옵션은 AGENTS.md의 명령어 및 실행할 런북을 따른다.
실제 배포 전에 이미지·설정·기능·복구의 각 완료조건을 별도로 확인한다.
