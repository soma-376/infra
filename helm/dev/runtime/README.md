# dev EKS 런타임

CDK는 기존 Secrets Manager ARN·Pod Identity 역할·association과 `/eks/dev/application` 로그 그룹을 소유한다. Helm은 아래 release를 소유한다. Secret 값은 values에 넣지 않는다.

| release | namespace | chart | 고정 버전 |
|---|---|---|---|
| secrets-store-csi-driver | kube-system | secrets-store-csi-driver | 1.6.1 |
| secrets-provider-aws | kube-system | secrets-store-csi-driver-provider-aws | 3.1.4 |
| fluent-bit | pulsemetry-dev-logs | fluent-bit | 0.58.3 (image 5.1.3) |
| runtime-config | pulsemetry-dev | `chart/` | 0.1.0 |

`versions.json`은 공개 chart index와 tgz를 대조한 URL·SHA256이다. 별도 CSI release를 설치하고 ASCP의 driver dependency를 꺼서 `^1` 범위가 설치 버전을 바꾸지 않게 한다. Auto Mode 제공 Pod Identity Agent·EBS·네트워크 구성요소는 설치하지 않는다. CSI·ASCP·Fluent Bit은 ARM64 두 NodePool에 배치한다.

Spring 앱은 UID/GID 10001로 `configtree:/mnt/secrets-store/`를 읽는다. PULSEMETRY 파일은 Pod 전용 readOnly CSI volume의 `0444` 파일로 만들며, Secret 읽기 권한은 namespace·ServiceAccount·cluster별 Pod Identity로 제한한다. driver 1.6.1의 CSIDriver는 fsGroupPolicy를 명시하지 않으므로 `0440`과 fsGroup만으로 읽기 권한이 생긴다고 가정하지 않는다. 앱 chart의 initContainer가 같은 UID로 필수 파일의 존재·읽기 가능·비어 있지 않음을 검사한다. 실제 CSI mount·Pod Identity·UID 권한은 배포 후 검증 대상이다.

ASCP jmesPath는 원본 JSON도 파일로 제공한다. `_source_db_json`·`_source_admin_json`은 `0400`이고 앱이 사용하는 PULSEMETRY 필드만 `0444`다. HMAC Secret은 JSON 추출 없이 전체 SecretString을 읽는다. 관리자 Secret ARN·token 파일은 enrollment SPC에만 존재하며 ingest 권한·SPC에는 없다. Kubernetes Secret 복제·자동 회전은 비활성화한다. 변경 반영은 enrollment 준비 확인 후 ingest까지 명시적 rollout restart로 처리한다.

Fluent Bit은 `*_pulsemetry-dev_*.log`만 tail하고 Kubernetes metadata의 namespace도 재검사한다. 노드·시스템 namespace 로그를 전송하지 않으며, CDK가 생성한 단일 로그 그룹으로 stdout/stderr 문자열을 전달한다. `auto_create_group Off`와 로그 그룹별 IAM으로 그룹 생성을 막는다. 14일 보존은 dev 초기 정책이고 실제 전달·누락·권한 검증은 아직 수행하지 않았다.

검증 prefix `eks_validation`와 병행 운영 prefix `eks`는 CDK `ArchivePrefix` output에서 values로 전달한다. ingest의 S3 권한은 해당 prefix의 PutObject뿐이며 조회·정리는 운영자 권한이다. 두 값을 함께 바꾸는 절차는 배포 런북을 따른다.

설치·복구 전체 순서는 [dev EKS 런북](../../../docs/runbooks/dev-eks-manual-deployment.md)을 따른다. 로컬 configtree 검증은 `python3 scripts/test-configtree.py --backend <backend checkout 또는 고정 source snapshot>`으로 실행한다. backend 소스·YAML을 변경하거나 DB·AWS에 접속하지 않는다.

이번 검증 대상은 backend commit `4d6ccf2e2809344eac9feb1873f2d527eee2f212`다. 같은 소스를 재현하려면 `python3 scripts/test-configtree.py --fetch-ref 4d6ccf2e2809344eac9feb1873f2d527eee2f212`를 실행한다. 이 옵션은 기존 `gh` 접근으로 YAML·DTO·버전 카탈로그 5개만 임시 경로에 읽고 검증 뒤 삭제한다. 기본 실행은 형제 checkout을 읽으며 각 소스 SHA256을 출력하므로 검증 대상이 달라졌는지 비교할 수 있다. Spring Boot 4.1.0·Kotlin 2.3.21·JDK 25와 준비된 Gradle dependency cache가 필요하고 `--gradle-cache`로 cache 위치를 지정할 수 있다.

fixture는 현재 두 Kotlin DTO 소스를 다시 컴파일해 Boot의 ConfigDataEnvironmentPostProcessor와 Binder에 전달한다. 네트워크 클라이언트의 기본 상수만 무해한 상수 stub으로 격리하며, 실제 앱 자동설정·HTTP·RDS·AWS 연결은 실행하지 않는다. 원본 JSON `0400` 파일도 fixture에 포함하고 PULSEMETRY 값·OS 환경변수 우선순위·필수 디렉터리 누락을 검사한다. 개별 필수 파일 누락·빈 파일은 앱 chart의 실제 init shell command로 검사한다. 로컬 파일 검증은 CSI mount와 UID 10001의 live 접근 증거가 아니다.

근거: [AWS ASCP](https://github.com/aws/secrets-store-csi-driver-provider-aws), [CSI driver](https://github.com/kubernetes-sigs/secrets-store-csi-driver/releases/tag/v1.6.1), [Pod Identity trust](https://docs.aws.amazon.com/eks/latest/userguide/pod-id-role.html), [Fluent Bit CloudWatch output](https://docs.fluentbit.io/manual/data-pipeline/outputs/cloudwatch), [Spring configtree](https://docs.spring.io/spring-boot/reference/features/external-config.html).
