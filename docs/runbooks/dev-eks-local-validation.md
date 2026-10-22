# PROJ-206~212 로컬 검증 기록

> **역사적 기록:** ADR-0035·PROJ-248 이후 dev 백엔드는 EKS 전용이다. 아래 ECS 구성·명령·검증 수치는 당시 기록이며 현재 실행 절차가 아니다. 현재 운영은 [EKS 런북](dev-eks-manual-deployment.md), 기존 ECS 철거는 [철거 런북](dev-ecs-retirement.md)을 따른다.

검증일은 2026-10-12(KST)다. `develop`의 `2a382e0`을 기준으로 이슈별 stacked 브랜치에 구현했다.
이 기록은 AWS 배포·Kubernetes API server 승인·실제 데이터 통신 결과가 아니다.
실행 절차는 [수동 런북](dev-eks-manual-deployment.md), 결정은 [ADR-0028](../adr/0028-dev-eks-auto-mode-transition.md)을 따른다.

## 실행한 검사

| 검사 | 결과와 범위 |
|---|---|
| TypeScript | `npm run build` 통과 |
| 전체 Jest | 20 suites, 404 tests 통과. `HELM_BIN`·`KUBECONFORM_BIN`을 지정해 Helm 테스트도 실행했으며 skip 없음 |
| CDK 합성·기존 template 비교 | 테스트 계정·`cdk.json` feature flag로 prod A/B·기본 dev·cicd를 합성. 변경 전 `2a382e0`에서 보관한 전체 template와 동일 |
| EKS 활성화 | 5스택 합성, 기존 리소스·Edge output·ECS Application 보존, EKS↔Edge 의존 없음, SG Network 소유, 명시적 API 접근·Node role 검사 |
| EKS 운영자 role | 외부 role ARN 입력 없이 CDK 생성, same-account trust, 클러스터 한정 `eks:DescribeCluster`, 생성 role의 cluster admin AccessEntry와 ARN·이름 output 연결 assertion 통과 |
| LBC | 공식 chart/controller 3.6.0·CRD SHA256 대조, Helm lint/render, 표준 리소스 10개와 CRD 7개 schema 검사, TGB 전용 IAM 경계 검사 |
| 앱·기반 Helm | Helm 3.22.0·kubeconform 0.8.0, workload 리소스 25개·platform 리소스 6개와 거절해야 할 입력 49개 검사 |
| runtime Helm | 고정 archive SHA256, strict lint/render/schema: SPC 2개·CSI 16개·ASCP 4개·Fluent Bit 6개, 총 28개 valid, invalid/error/skip 0 |
| output→values | CDK JSON·CloudFormation describe-stacks 형식, immutable image, 필수 참조·중복 충돌·미해석 token 거절, 8개 values 생성 및 실제 chart와 결합 렌더링 |
| IAM·Secret 경계 | 기존 Secret 3개 참조만 사용. 관리자 Secret은 enrollment만. `eks_validation/*`·`eks/*` 각각 PutObject만 허용하는 assertion 통과 |
| Spring configtree | 실제 Boot 4.1.0과 고정 backend YAML·Kotlin DTO로 placeholder·DTO binding·환경변수 우선순위·필수 directory 누락 검사 통과 |
| initContainer | chart의 실제 shell command로 앱별 필수 파일 누락·빈 파일 거절 검사 통과 |
| 런북 | bash 블록 9개 `bash -n`, 내장 Python 구문, 문서 내부 링크 검사. 명령 블록은 실행하지 않음 |
| Git | `git diff --check`, 이슈별 고유 커밋과 직전 브랜치 ancestry 검사 |

`NodeClass` 2개와 `NodePool` 2개는 AWS 제공 CRD의 live schema를 조회하지 않았으므로 **구조 검사만** 수행했다.
위 platform 6개 중 Namespace·StorageClass는 Kubernetes strict schema를 검사했다. 표준 리소스와 OSS TGB,
runtime SPC 검사에 `-ignore-missing`은 사용하지 않았다. CSI chart의 CRD 설치 hook이 실제 클러스터에서
실행되는지는 이번 렌더링 결과로 증명하지 않는다.

CDK의 기존 RDS 공개 접근·암호화·ECS 배포 설정 경고와 테스트 fixture의 subnet 참조·listener tag schema 경고는
남아 있다. 합성 성공을 경고 0개 또는 AWS 서비스 수락으로 기록하지 않는다.

## backend 검증 대상

형제 backend checkout이 오래된 상태여서 기존 GitHub 읽기 권한으로 다음 commit의 소스만 임시 경로로
읽었다. backend 파일·이미지를 변경하지 않았으며 실제 앱 자동설정·서버·RDS·AWS는 실행하지 않았다.

- commit: `4d6ccf2e2809344eac9feb1873f2d527eee2f212`
- Spring Boot 4.1.0, Kotlin 2.3.21, JDK 25 및 준비된 Gradle dependency cache
- `PulsemetryProperties.kt`: SHA256 `198052fb01bc02c77193c064126cd2b14fa75e4278604aae16268a9af0ba33b3`
- `TelemetryIngestProperties.kt`: SHA256 `d152f4aa9732e0832414f3d1567c6d59a67137c7e6a58b07f4c743958df410d3`
- enrollment `application.yaml`: SHA256 `7f42eb7ac5a7aebfab6694ce2f4012500536bac5e914a3131b7c3927f3c79d0d`
- ingest `application.yaml`: SHA256 `ca49f68f246c7ea400c73cba4ad54a56c9ddbdd9ca637cabf066e325717b8ddf`

`scripts/test-configtree.py --fetch-ref <commit>`로 같은 소스 5개를 재현하고,
`--backend <snapshot>`으로 준비된 소스를 사용할 수 있다. 네트워크 client 기본 상수만 fixture stub으로 격리한다.
로컬 파일의 읽기 검사는 실제 CSI 파일 소유권·UID 10001의 mount 접근 검증을 대신하지 않는다.

## 배포 검증 대기

- 서울 리전 EKS 1.36·인스턴스 가용성, 노드 생성·교체·API 접근, webhook 통신
- Pod Identity·CSI mount·필수 파일 접근과 Secret 변경 후 명시적 재시작
- 실제 ARM64 이미지·바이너리 공급·시작 시간·메모리 안정성
- TG 등록·health, 검증 tenant의 RDS/S3/ClickHouse 처리와 event ID 정합성
- Fluent Bit의 Auto Mode 노드 로그 접근·CloudWatch 전달과 제외 namespace
- WAF 실제 signature·마스킹·공유 rate 집계 영향
- HTTPS 전체 CLI E2E, 데이터 이관·Canary·ECS 제거 및 RPO/RTO 리허설

배포·push·PR 생성·Jira 조회/변경은 이번 구현 작업에서 수행하지 않았다. 로컬 구현 완료는 Jira의 live 완료조건 충족을 뜻하지 않는다.

## PROJ-220에서의 문서 인계

이 파일은 PROJ-212 브랜치의 기존 검증 기록을 가져온 것이다. 위 20 suites·404 tests와 configtree/Helm 검사는
당시 enrollment·ingest·ClickHouse 구현의 기록이며 dashboard와 PROJ-226 기준 코드의 현재 재검증 결과가 아니다.
PROJ-220은 [ADR-0029](../adr/0029-dev-dashboard-api-ecs-and-eks-deployment.md)와 수동 런북 §10을 추가한다.
실제 dashboard CDK·Helm·설정·권한 구현과 기능 검증은 PROJ-221~225에서 따로 기록한다.
NodePort 숫자는 PROJ-223에서 확정하고 SG·TG·output·Service와 대조한다.
이번 문서 채택을 실제 이미지 공급·서비스 생성·AWS 배포·기능 성공으로 표시하지 않는다.

## PROJ-218 후속 구현의 새 로컬 검증

PROJ-230·221·223·231·224의 2026-10-17 검증은
[별도 기록](proj218-local-implementation-validation.md)에 정리했다. 위 PROJ-206~212 수치와
구분하며, 새 기록도 AWS 배포·실제 Secret·CSI·인증·snapshot·복구 성공을 증명하지 않는다.
