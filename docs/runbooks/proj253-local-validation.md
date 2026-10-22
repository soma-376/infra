# PROJ-253 로컬 검증 기록

2026-10-22에 dev Spring 앱의 임시 `blocked.certs` ConfigMap 공급을 검증했다.
기준선은 infra `7939816`이며 실제 AWS/Kubernetes 배포·TLS 회귀·취약점 재현 E2E는 수행하지 않았다.

## 원본과 provenance

- 공식 Unix URL은 `https://ops.java/unix/blocked.certs`다. 직접 GET은 HTTP 403을 반환하여
  기존 브라우저 다운로드 원본을 재사용했다. 다운로드 출처 메타데이터의 URL과 복사 전후 해시를 확인했다.
- 원본 파일 생성·수정 시각과 이번 로컬 편입 시각을 구분한다. 원본 다운로드 시각은 단정하지 않는다.
- Oracle 공식 JDK 25.0.5.0.2 Linux ARM64 archive를 별도로 내려받아 현재 게시된 archive SHA-256을
  검증하고 내부 `lib/security/blocked.certs`와 편입 원본의 **바이트 전체 일치**를 확인했다.
  Oracle JDK를 앱 이미지에 설치하거나 실행한 것은 아니다.
- 번들은 5,608 bytes·SHA-256 fingerprint 86개이며 SHA-256은
  `2596bb6dda83c66d96c5a252d7b2ae1f24cc1ae3f1890223b4f3591a8d52bf10`이다.
  URL·시각·archive 해시·검증 한계는 [SOURCE.json](../../helm/dev/workloads/spring-app/files/SOURCE.json)에 기록했다.

## 결과

| 검증 | 결과 |
|---|---|
| TypeScript build | 통과 |
| 전체 Jest | 27 suites·561 tests 통과, skip 0 |
| Helm 3.22.0·kubeconform 0.8.0 | 전체 Jest에 포함, lint/render/schema 및 잘못된 입력 거부 통과 |
| 차단 목록 회귀 | 세 앱 runtime 비활성/활성·JWT/OIDC 조합, release별 ConfigMap·파일 내용·단일 파일 mount·권한·checksum·기존 CSI 보존 통과 |
| 누락·빈 파일 / 파일 갱신 | 렌더링 거부 / checksum 변경·JWT/OIDC revision 보존 통과 |
| 로컬 ARM64 Temurin | UID 10001·네트워크 차단·읽기 전용 mount에서 JVM 실제 목록 로드 통과 |
| OIDC Spring fixture | 생략/false/true, 실제 Helm init shell·DTO binding 검증 통과 |
| CDK 합성 | prod A/B·dev·cicd 조회 없는 합성 통과, 기준선과 템플릿 13개 전체 JSON 동일 |
| 기존 configtree Spring fixture | 변경 전후 모두 동일한 backend 의존성 누락으로 실패, 아래 설명 참조 |

ConfigMap 파일 모드는 `292`로 렌더링한다. 이는 `0444`의 십진수이며 YAML 1.1/1.2에서
같은 권한으로 해석된다. 테스트에서 해당 값을 확인하며 첫 검증에서 발견한 octal 해석 차이를 해소했다.

로컬 JVM 검증 이미지는 `pulsemetry-dashboard-api:proj-219`, image ID
`sha256:7fc545cb28cb01025e2f787c7eed57654ebc6d2f6c6e4e3b5f8b9eeced3381b4`다.
Temurin `25.0.4.1+1-LTS`의 기존 차단 항목 38개를 모두 보존하고 새 목록 86개가
`UntrustedCertificates`에 실제 로드됨을 확인했다. 나머지 security 파일의 합산 해시와 기본 truststore의
인증서 118개는 전후 동일했다. 이 이미지는 로컬 검증 대상이며 세 live 이미지의 확인을 대신하지 않는다.

## 재실행

```bash
: "${HELM_BIN:?Helm 3.22.0 바이너리}"
: "${KUBECONFORM_BIN:?kubeconform 0.8.0 바이너리}"
: "${VERIFY_IMAGE:?로컬에 준비한 ARM64 Temurin 25 기반 이미지 ID/digest}"
export HELM_BIN KUBECONFORM_BIN
npm run build
npm test -- --runInBand
python3 scripts/test-blocked-certs.py --image "$VERIFY_IMAGE"
python3 scripts/test-oidc-config.py
git diff --check
```

JVM fixture는 JDK 25의 `javac`를 사용하며 `JAVAC_BIN`으로 지정할 수 있다. Docker 이미지는 pull하지
않는다. 배포 전에는 [수동 런북 §12](dev-eks-manual-deployment.md#12-dev-jvm의-임시-blockedcerts-공급)에 따라
실제 배포할 세 이미지마다 검증한다.

CDK 비교는 기준선과 작업본의 격리 복사본에서 같은 `test/helpers.ts` 조립 함수와 고정 테스트 env/AZ
context를 사용했다. CLI `synth '*' --no-lookups`로 각 assembly를 생성했으며 계정 조회·실제 AWS
템플릿 조회는 하지 않았다. 임시 fixture wrapper만 사용하고 CDK 배포 코드와 context 파일은 변경하지 않았다.

## 기존 configtree fixture의 제한

형제 backend `f3c5461`의 `TelemetryIngestProperties`가 `CodeburnReferencePrices.VERSION`을 참조하지만,
기존 `scripts/test-configtree.py`는 해당 의존성을 컴파일 입력에 포함하지 않는다.
따라서 DTO 컴파일 단계에서 `unresolved reference 'CodeburnReferencePrices'`로 실패한다.
infra 기준선 `7939816`에서도 같은 backend 소스를 지정해 동일 실패를 재현했다.
이는 이번 chart 변경에 도달하기 전의 기존 fixture 문제이며 해당 스크립트와 backend는 수정하지 않았다.
전체 Jest·새 JVM 검증·OIDC fixture의 통과를 이 별도 fixture의 성공으로 기록하지 않는다.

실제 dev 배포, Secret 조회, 앱 DB 접속, push, PR 생성, Jira 변경은 수행하지 않았다.
