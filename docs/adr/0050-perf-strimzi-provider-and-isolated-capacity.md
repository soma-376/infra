# 0050. 격리 perf 환경에 공급자별 Kafka 계약과 고정 Strimzi 용량을 적용한다

## Status

Accepted — PROJ-292의 로컬 구현 범위다. 사용자는 B01–B07 구현과 이번 작업의 리뷰 생략을 승인했다. 사용자는 총 100,000원·생성 후 24시간 내 시험과 삭제·두 경로 합계 10,000요청/최대 20RPS/실행당 600초/추가 저장 1GiB를 확정했다. 공개 도메인은 perf-api.pulsemetry.co.kr, 합성 초기 데이터는 400명/50팀/약 400설치/180일이다. 실제 배포와 성능 검증은 NOT_RUN이다.

## Context

미머지 PROJ-192 구현은 독립 EKS·VPC·RDS·S3·발생기와 MSK IAM 9098을 전제로 했다. 현재 dev는 ADR-0049의 Strimzi 4.2.2/mTLS 9093을 사용한다. 과거 perf ADR 0038/0039 번호는 develop에서 다른 결정에 이미 사용하므로 이 결정으로 구현 이력을 통합하고 기존 문서를 덮어쓰지 않는다.

환경 교환 계약의 소유자는 telemetry-load-tests다. [허브 ADR 0029](https://github.com/soma-376/docs/blob/main/adr/0029-perf-strimzi-readiness-and-path-comparison.md)이 레포 간 버전·시험 경로 경계를 정하고 이 문서는 infra의 구현·자원 소유만 정한다.

## Decision

- 최신 develop의 dev/prod/cicd를 보존하고 PROJ-192의 perf 전용 영역을 선별 통합한다. `perf → common` 단방향 의존을 유지한다. dev 스택을 perf에서 import하지 않는다.
- v2 교환 파일과 fixture를 보존한다. 새 공급자 계약은 v3이며 version dispatch와 bundle 혼합 거부로 처리한다. canonical schema와 공유 사본은 load-tests의 export 명령으로 동기화한다.
- 기존 MSK 가설 프로필은 호환용으로 보존하고 Strimzi 고정 용량 가설을 별도 프로필로 추가한다. Strimzi는 전용 ARM64 m7g.large 노드 3대에 dual-role broker/controller 3개를 배치하고 main topic 6 partitions/RF3/minISR2/mTLS9093을 사용한다. 자동 크기 조정은 측정 용량으로 취급하지 않는다.
- 고정 NodePool은 `replicas`·`limits.nodes`·중단 예산 0을 유지하고 `disruption.consolidateAfter: Never`를 명시한다. EKS 1.36 실측 CRD가 이 필드를 필수로 요구하며, `replicas`가 설정되면 consolidation 필드는 동작상 무시된다. 객체 전체의 기본값에 의존하지 않는다.
- CDK는 별도 VPC·SG·EKS·RDS·S3·Secret·IAM, Helm은 Kafka CR·NodePool·PVC·앱·Job을 소유한다. runner는 Kafka/DB/JWT 개인키 권한을 갖지 않는다.
- Auto Mode ClusterRole에는 기존 관리형 정책을 유지하고 소유 태그를 가진 compute·EBS·ENI 생성에만 추가 Allow를 준다. 계정/서울 리전 ARN, 고정 EKS cluster/request·principal tag, 정확한 환경 owner, 명시한 tag-key 집합으로 제한한다. Compute의 class/pool은 프로필 pool 집합이며 초기 NodeClass 검사에서 비어 있는 EKS pool tag를 허용한다. PVC에는 owner만 요구한다. 새 CreateTags·CopyVolumes·Snapshot·태그 변경 권한은 추가하지 않는다.
- dev의 고정 Kafka 이미지·PKCS12 mount·역할별 ACL·CA/user metadata 검증을 재사용한다. 공유 chart의 기본 dev 입력과 렌더는 유지하고 perf namespace/pool/topic/group은 명시적 environment 입력으로 분리한다.
- Strimzi CA와 사용자 Secret의 필요한 public truststore/password 및 user keystore/password 항목만 mount한다. CA 개인키와 원문 secret은 values/output/evidence에 넣지 않는다. UID/resourceVersion 기반 revision을 배포 입력에 기록한다.
- perf verify Job은 provider별 lag 경로를 명시한다. MSK env를 Strimzi Job에 공급하지 않는다. 기존 generic Prometheus probe의 freshness/coverage/미커밋 의미 보완은 PROJ-297이 소유한다.
- Kafka CR/PVC의 keep/Retain 수명은 삭제 가능성으로 오인하지 않는다. 잔존 inventory에 CR/PVC와 데이터 volume을 기록하고 실제 삭제는 별도 수명·정리 절차와 승인된 입력에 따른다.

## Constraints

확정 예산·실행 상한·24시간 정리를 PROJ-294 gate에 반영하기 전에는 배포하지 않는다. 기존 Retain/raw 7일/evidence 90일 동작은 과거 호환 구현이며 24시간 정리 구현 완료로 취급하지 않는다. 로컬 template/schema/Helm 검증은 readiness나 성능 PASS가 아니다. 공개 ALB/WAF/TLS는 PROJ-293, 실행 예산·수명은 PROJ-294, 발생기 관측은 PROJ-296, drain은 PROJ-297, 외부 진단/DB 기준선은 PROJ-298에서 별도 변경한다.

## Alternatives Considered

MSK v2 필드를 Strimzi 값으로 덮는 방식은 과거 증거 의미를 바꾸므로 제외했다. 공유 dev 자원에 부하를 주는 방식은 격리·고정 용량 조건을 충족하지 못한다. dev chart를 복사해 독립 발전시키는 방식은 mTLS/ACL 수정 누락 위험으로 제외했다.

## Consequences/Tradeoffs

### Positive

dev 배포를 바꾸지 않고 실제 Kafka 공급자와 perf 계약을 맞춘다. v2 과거 증거를 유지하며 provider와 자원 배치를 추적할 수 있다.

### Negative

별도 EKS·고정 노드·Kafka 운영 비용과 인증서/PVC 수명 관리 책임이 생긴다. 구 perf 통합과 현재 chart 일반화의 회귀 검증 범위가 넓다. 단일 AZ 가설은 다중 AZ 운영 가용성을 증명하지 않는다.

## Acceptance Criteria

v2 fixture 불변, v3 provider와 혼합 버전 거부, MSK/Strimzi template의 상호 불필요 권한 부재, 고정 Kafka 노드/스토리지, 최소 ACL와 원문 없는 mTLS metadata, dev 기본 Helm 렌더 동등성을 검증한다. build/test와 prod/dev/cicd/perf 로컬 합성을 통과하며 실제 배포·부하·정리는 NOT_RUN으로 남긴다.

## References

- [dev Strimzi](0049-dev-strimzi-kafka-and-staged-msk-retirement.md)
- [telemetry Kafka 계약](https://github.com/soma-376/docs/blob/main/contracts/telemetry-kafka.md)
- [load-tests v2/v3 계약 원본](https://github.com/soma-376/telemetry-load-tests/blob/main/docs/contracts/infra-environment.md)

## 2026-10-30 실제 최초 설치 보완

perf 최초 설치에서 NodeClass 7개는 생성됐지만 NodePool 7개는 `spec.disruption.consolidateAfter: Required value`로 거부됐다. 기존 kubeconform 검사가 NodePool CRD 누락을 허용해 이 오류를 잡지 못했다. 실제 EKS의 `karpenter.sh/v1` 구조 schema를 검증용으로 고정하고, 필수 필드 제거가 실패하는 회귀 검사를 추가한다. 구조 schema 검사는 CEL·controller 권한·노드 생성 성공을 대신하지 않으며 실제 server dry-run과 NodeClass Ready/노드 수를 별도로 확인한다.

같은 최초 설치에서 관리형 Compute 정책의 tag-key 허용 목록이 NodeClass 소유 태그 두 개를 제외해 `CreateLaunchTemplateAuthCheckFailed`가 발생했다. StorageClass의 owner 및 추가 ENI도 관리형 태그 제한과 함께 점검한다. 추가 권한의 범위는 [Auto Mode custom tags 공식 지침](https://docs.aws.amazon.com/eks/latest/userguide/auto-cluster-iam-role.html#tag-prop)을 따르되 현재 생성에 필요한 세 경로만 허용한다. AWS 관리형 정책 자체의 기존 권한을 축소하거나 추가 권한 조건을 전체 역할의 권한 경계라고 표현하지 않는다.
