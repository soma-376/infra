# PROJ-248 로컬 구현 검증 기록

2026-10-21에 dev 백엔드 ECS 제거 변경을 검증했다. 비교 기준은 변경 전 commit
`5f276bebb5b0c6e20e889c6818ef39e1b50e2809`의 EKS 활성 구성이다.
이 기록은 AWS 배포·ECS 철거·Snapshot 생성·DB 연결 문제 해결·실제 기능 검증을 증명하지 않는다.

## 실행 결과

| 검증 | 결과 |
|---|---|
| `npm run build` | 통과 |
| 전체 Jest | 26 suites, 557 tests 통과, skip 0 |
| Helm 3.22.0·kubeconform 0.8.0 | 전체 Jest 안에서 lint/render/schema 및 잘못된 입력 거부 검증 통과 |
| EKS values generator | 전체 Jest 안에서 generated YAML·runtime/workload 경계·OIDC 입력 검증 통과 |
| `python3 scripts/test-configtree.py` | 실제 Spring Boot 4.1.0·backend YAML·Kotlin DTO binding, 필수 파일/디렉터리 오류와 환경변수 우선순위 통과 |
| `python3 scripts/test-oidc-config.py` | generated YAML → Helm → Spring DTO 경로의 localhost 옵션 생략/false/true와 Secret 파일 누락·빈 값·읽기 불가 거부 통과 |
| 문서·diff | Bash/sh 블록 53개 구문 검사와 `git diff --check` 통과 |

시스템 Helm v4 대신 별도 Helm `v3.22.0+g144ca65` 바이너리를 명시했다. 보관된 공식 archive의 SHA256과
추출 바이너리 일치를 확인했다. kubeconform은 `v0.8.0`을 사용했다. 최초 전체 테스트는 샌드박스 DNS 제한으로
공개 Kubernetes schema 다운로드 한 건이 실패했고, 네트워크 허용 재실행에서 전체 557개가 통과했다.
스키마 검증을 생략하거나 오류를 무시하지 않았다. 도구·차트 버전을 변경하지 않았다.

재실행 시 버전을 확인한 바이너리를 지정한다.

```bash
: "${HELM_BIN:?Helm 3.22.0 바이너리 절대 경로}"
: "${KUBECONFORM_BIN:?kubeconform 0.8.0 바이너리 절대 경로}"
export HELM_BIN KUBECONFORM_BIN
"$HELM_BIN" version --short
"$KUBECONFORM_BIN" -v
npm run build
npm test -- --runInBand
python3 scripts/test-configtree.py
python3 scripts/test-oidc-config.py
```

Spring fixture는 형제 backend checkout과 로컬 JVM 의존성을 사용한다. 외부 schema 조회는 필요하지만
검증 스크립트는 AWS·개발 DB·Secret 원문에 접속하지 않는다.
문서 상대 링크 검사에서는 기존 ADR-0026의 허브 `0016-use-api-v1-for-application-http-routes.md` 참조가
형제 checkout에 없는 것을 확인했다. 이번 변경에서 도입한 링크가 아니며 추정 경로로 바꾸지 않았다.

## 합성 결과와 보존 비교

변경 전에 `test/helpers.ts`의 동일 CDK context·고정 테스트 환경으로 템플릿을 저장한 뒤 변경 후와 비교했다.
실제 AWS 템플릿을 조회한 비교가 아니다. 검증 자료는 로컬 임시 디렉터리에 저장했으며 배포 입력으로 쓰지 않는다.

| 구성 | 확인 결과 |
|---|---|
| prod A / B | 각각 네 스택의 전체 템플릿이 변경 전과 동일 |
| dev 기본 EKS·빈 OIDC 목록 | Data·EKS 전체 템플릿 동일 |
| dev OIDC `cognito-a`, `Cognito_B` | 기존 JSON key 집합을 새 배열로 이전해 Data·EKS 전체 템플릿 동일; Secret 이름·논리 ID·Retain·output·IAM 보존 |
| dev HTTPS redirect true / false | Data·EKS 전체 템플릿 동일; 남는 Edge·Network 리소스의 논리 ID·속성 동일 |
| 모든 dev 비교 구성 | 제거 스택은 DevApplicationStack 하나; 남는 Edge·Network 리소스의 추가/속성 변경 없음; `Validation*` output 동일 |
| cicd | backend-dev 정책의 ECS 권한만 제거; 다른 리소스·역할 trust·prod 정책·ARN output 값 동일; dev 역할 output 설명만 현행화 |

최종 dev assembly는 Network·Data·Edge·EKS 네 스택이다. CDK가 선언한 리소스를 합산해 다음을 확인했다.

- ECS·AutoScaling·Cloud Map 리소스 각각 0개
- ALB 1개, TG 4개, WAF WebACL 및 association 각각 1개
- 사용자 정의 SG 6개, EKS cluster 1개, RDS 1개, S3 bucket 1개
- 기본 Secret 9개와 명시한 OIDC key별 원본

입력 테스트는 `devEksEnabled` 생략/true 허용·false 거부, 폐기 context 거부, OIDC 필수 배열의
빈 목록·CLI JSON·정상 목록·누락·중복·형식·최대 개수/길이를 검사했다. JWT writer 입력은 거부하고
기존 EKS runtime 검증은 유지했다. backend-dev는 세 앱 ECR 공급 권한만 가지며 ECS/EKS 권한을 추가하지 않았다.

## 남은 실행 경계

실제 철거는 PROJ-249의 backend workflow와 허브 배포 계약 정합화 이후
[수동 철거 런북](dev-ecs-retirement.md)을 따른다. EKS 접근·인증·수집·조회·CSI/Pod Identity·TG 상태,
Snapshot 복원 가능성·RDS 연결 수는 운영자가 별도로 검증해야 한다. prod와 frontend Terraform은 변경하지 않았다.
