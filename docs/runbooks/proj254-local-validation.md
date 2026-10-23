# PROJ-254 로컬 구현 검증 기록

2026-10-23에 [ADR 0038](../adr/0038-dev-databases-private-access-via-ssm-relay.md)의 dev DB 공개 접근 제거와
전용 SSM 릴레이를 검증했다. 비교 기준은 변경 전 commit `96d1a152ccdc6ad70b9eaa9b2047f5b25cb45fab`이다.
AWS 배포·실제 DB 접속·외부 차단·SSM 인가 성공의 증거는 아니다. 앱 API·DB 스키마는 변경하지 않았다.

## 실행 결과

| 검증 | 결과 |
|---|---|
| `npm run build` | 통과 |
| 전체 Jest | 34 suites, 744 tests 통과, skip 0 |
| DB helper 대역 테스트 | 위 Jest에 포함된 75개 통과; AWS CLI·kubectl 대역 사용, 실제 접속 없음 |
| dev CDK assertion | 위 Jest에 포함된 19 suites, 425 tests 통과 |
| prod·dev·cicd CLI synth | 고정 테스트 환경·AZ context·`--no-lookups`로 각각 통과 |
| Helm 3.22.0·kubeconform 0.8.0 | workload 167개·platform 10개 resource와 잘못된 입력 234개 검증 통과 |
| 관측 Helm·promtool 3.9.1 | lock의 고정 chart archive와 SHA-256 확인 후 전체 Jest 안에서 통과 |
| EKS values generator | 위 Jest에 포함된 65개 통과; 구 ClickHouse output 무시, 새 values에서 TG·vpcId 부재 |
| `python3 scripts/test-configtree.py` | 실제 Spring Boot 4.1.0·backend YAML·DTO binding, 환경변수 우선순위, 필수 파일/디렉터리 오류 검증 통과 |
| `python3 scripts/test-oidc-config.py` | generator → Helm → Spring DTO의 localhost 옵션 생략/false/true와 파일 누락·빈 값·읽기 불가 거부 통과 |
| 문서·diff | 변경 문서의 상대 링크, 신규 DB 런북 Bash 블록 구문, `git diff --check` 통과 |

최초 전체 Jest는 관측 의존 chart archive가 없어 한 건 실패했다. `observability-prepare.mjs`로 공식 archive를
고정 SHA-256과 대조해 준비한 뒤 전체 744개가 통과했다. Helm schema 다운로드에는 네트워크 접근이 필요했다.
다운로드 실패를 schema 성공으로 처리하거나 검증을 생략하지 않았다. 의존 archive는 Git에서 제외한다.

기존 JVM fixture 두 개도 현재 코드에 맞췄다. configtree 검증은 backend DTO가 새로 참조하는 가격 버전
상수를 실제 소스에서 읽어 격리 fixture에 공급하고 source hash를 기록한다. 가격 계산 구현은 검증 대상이 아니다.
OIDC 검증은 Gateway·MSK·관측을 포함한 현재 generator 인자와 공유 outputs fixture를 사용하고,
현재 init command가 요구하는 telemetry JWT 파일도 합성한다. 검증 조건은 유지하며 실제 Secret을 사용하지 않는다.

재실행할 때는 도구 버전을 확인한 뒤 다음을 실행한다. Python 검증은 형제 backend checkout과 로컬 JVM 의존성을 사용한다.

```bash
: "${HELM_BIN:?Helm 3.22.0 바이너리 절대 경로}"
: "${KUBECONFORM_BIN:?kubeconform 0.8.0 바이너리 절대 경로}"
: "${PROMTOOL_BIN:?promtool 3.9.1 바이너리 절대 경로}"
export HELM_BIN KUBECONFORM_BIN PROMTOOL_BIN
node scripts/observability-prepare.mjs
npm run build
npm test -- --runInBand
python3 scripts/test-configtree.py
python3 scripts/test-oidc-config.py
```

## 합성 및 렌더링 보존 비교

`test/helpers.ts`의 같은 context·테스트 환경으로 변경 전후 템플릿을 대조했다. 실제 AWS 템플릿 조회나
CloudFormation change set은 실행하지 않았다. prod A/B, cicd, dev 기본·OIDC 목록·HTTPS·명시적 redirect 입력을 비교했다.

| 대상 | 확인 결과 |
|---|---|
| prod A/B·cicd | 전체 템플릿 동일 |
| 기존 DevEksStack | 전체 템플릿 동일; EKS API 릴레이·operator·Pod Identity 보존 |
| 기존 Data 리소스 | RDS의 `PubliclyAccessible: true → false`만 변경; subnet group·DB·Secret 논리 ID/속성 보존 |
| Data 추가 | DB 릴레이 EC2·암호화 gp3·IMDSv2, SSM instance role, DB operator, Session 문서 2개, output 4개 |
| Network | SG 1개·relay 규칙 5개 추가; RDS CIDR ingress와 공개 ALB/ClickHouse 규칙 제거; 기존 SG description·논리 ID 보존 |
| Edge | ClickHouse listener·TG·output 2개 제거; 남는 모든 리소스 동일 |
| ClickHouse Helm | TGB 부재; Service·StatefulSet·volumeClaimTemplates/PVC 구성 렌더링 보존 |

최종 dev는 스택 4개·ALB 1개·앱 TG 4개·WAF association 1개·사용자 정의 SG 9개·릴레이 EC2 2개다.
DB 릴레이에는 inbound·SSH key·Kubernetes/Secret 권한이 없다. SSM 목적지·포트·operator 역할 분리와
호출자/relay 조건은 CDK assertion으로 검증했다. 이는 IAM의 실제 요청 평가나 ENI 경로를 재현한 결과가 아니다.

helper 검증은 PostgreSQL/ClickHouse의 정확한 CLI 인자·프로필 분리·로컬 포트, 잘못된 outputs/kubeconfig,
Pod 조회 실패·미준비·삭제 중·소유자 불일치·중복·잘못된 IP, 자식 프로세스 종료 코드와 signal 전달을 포함한다.
ClickHouse IP는 로컬에서 조회해 SSM `host`에 전달하며 EC2에서 원격 스크립트를 실행하지 않는다.

## 남은 live 수락 조건

[DB 접속·전환 런북](dev-database-access.md)의 Network → Data/SSM 준비 → 새 Helm values 및 TGB 정리 → Edge 순서를 따른다.
운영자 접속 공백을 잡고 외부 직접 접속 실패, 두 DB 터널·읽기 쿼리 성공, 앱 DB 연결 유지, Pod 교체 후 재연결을 확인한다.
실제 SSM Agent/plugin 호환, 다른 대상·문서·호출자 세션 거부, Pod ENI SG·TGB finalizer 정리도 별도 확인한다.
이번 작업에서는 AWS 배포·push·PR·Jira 변경과 실제 DB 연결을 수행하지 않았다.
