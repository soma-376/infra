# dev Application 검토 정의

`catalog.json`은 기존 release를 인계할 17개 관리 단위를 정의한다. 배포 원본의 실제 release 이름과
namespace는 운영 inventory를 입력하며 예시 이름으로 대체하지 않는다. `telemetry-kafka-admin`과
Argo 자체는 카탈로그 밖이다.

`scripts/dev-argocd-applications.mjs`는 `--input <JSON> --output-dir <새 디렉터리>`로 로컬
`application-review.json`만 만든다. 이 파일은 Kubernetes manifest가 아닌 검토 보고서다. 모든 정의의
`skip-reconcile`은 `true`이며 자동 sync·self-heal·prune·allowEmpty는 비활성이다. 활성화 우회 옵션은 없다.
LBC는 인증서 Secret·webhook CA 소유권과 부분 소실 복구가 정해지지 않아 `quarantined`로 표시한다.

- 공통 입력: `schemaVersion: 1`, `mode`, `infraRevision`(lowercase full SHA),
  `inventory`(카탈로그의 각 `id`와 실제 `releaseName`·`namespace`, 정확히 17개).
- `mode: handoff`: `handoffRevision` H만 받는다. B/V나 root/P를 만들지 않는다.
- `mode: gitops`: `valuesRevision` V와 `bundleManifestSha256` B를 받는다. 이 값들은 로컬 선언 입력이며
  성공한 생산 run·manifest 검증 완료를 증명하지 않는다. root도 중지된 template로만 포함한다.

native Helm Application은 테스트 Pod/Job을 제외하고, CRD를 소유하는 LBC·CSI·Strimzi Operator·관측
Application에는 `ServerSideApply=true`를 둔다. `Replace`·`Force`는 사용하지 않는다. 실제 CRD 소유권과
필드 충돌 수락은 인계 관문에 남는다. Helm admission hook은 테스트와 다르므로 일괄 제거하지 않는다.

`health/application.lua`는 현재 spec·comparedTo·적용 revision·Synced·Healthy·operation을 대조한다.
표준 Lua library는 열지 않으며 SHA 문법은 생성기에서, 실제 적용 일치는 health에서 검증한다.
`health/kafka.lua`는 Kafka·KafkaTopic·KafkaUser의 현재 generation Ready만 인정한다. 같은 상태 계약을
확인하지 않은 KafkaNodePool이나 Karpenter NodePool에 이 검사를 재사용하지 않는다.

전체 readiness는 항상 `blocked`, 배포 가능한 Application 수는 0이다. 실제 Git 읽기·관리 권한·렌더
동일성·CMP 게시 이미지·관측 hook·기능 검증 및 자동화 활성화는 PROJ-310의 인계 작업이다.
