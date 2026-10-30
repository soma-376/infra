# perf 비용·실행 gate와 독립 정리

[ADR 0052](../adr/0052-perf-budget-and-independent-cleanup.md)의 현행 Strimzi 전용 절차다. 로컬 코드/모의 API 검증과 실제 배포·정리 증거는 구분한다. MSK/v2 과거 foundation은 이번 실행에 사용하지 않는다.

## 승인 제한과 비용 가정

`profiles/perf/readiness-budget-v1.json`은 Strimzi profile 파일 SHA를 고정한다. 승인액은 100,000원이고 계획 예상액은 **97,586원**이다. 기존 고정 자원 24h·전송/로그/S3·1600원/USD·VAT10%·여유15% 가정 96,586원에 Lambda/정리 로그 예비분 1,000원을 더했다. 실제 청구 API로 검증한 값이 아니며 `actual_billing_verified:false`를 유지한다. profile/NAT 수 변경은 기존 예상액을 재사용할 수 없다.

| 항목 | 한도 |
|---|---|
| 총 수명 | 첫 소유 자원 생성부터 삭제 완료 86,400초 |
| 강제 정리 시작 | 첫 생성부터 79,200초(22h), 삭제 확인 여유 2h |
| 전체 요청 | smoke와 두 경로 합계 10,000 |
| 부하 | 최대 20RPS, 실행당 600초 |
| 시험 추가 저장 | Kafka 복제/S3/CH/시험 증거 합계 1GiB |
| 부하 후 검증 | drain 900초, 최종 저장 검증 별도 900초 |
| CH/Kafka 가용 공간 | 각 볼륨 max(20GiB, 전체20%) |
| 발생기 가용 공간 | max(10GiB, 전체20%) |

1일 S3/로그/Prometheus retention은 보조 정책이다. lifecycle 만료 시각을 정확히 24h 삭제 완료로 간주하지 않는다. 데이터 seed는 시험 추가 저장 기준선 이전이고 별도 dataset 크기·전체 볼륨 하한을 확인한다.

## 배포 전에 보호부터 확인

1. 이번 계정/서울 리전의 기존 `Perf*Stack`과 perf ECR 두 이름을 조회한다. 다른 환경 태그·기존 shared 자원을 채택하지 않는다. 고정 스택/cluster 이름이므로 동시 perf 환경은 허용하지 않는다.
2. 같은 CDK assembly의 `PerfGuardrailStack`을 먼저 배포한다. workload 스택의 assembly dependency가 이 순서를 고정한다. VPC에 붙지 않은 Lambda, 1분 schedule, SSM 상태와 고정 cleanup 문서를 확인한다. 모든 CFN 스택에 같은 계정의 기존 CDK CloudFormation execution RoleARN이 있어야 한다. 드라이버는 그 역할을 지정/변경하지 않고 이미 연결된 역할로 DeleteStack만 요청한다.
3. `soma-376/perf-k6-runner`, `soma-376/perf-tools`가 없음을 확인한 뒤 CDK 밖에서 생성한다. 생성 요청에 `pulsemetry:perf-environment=<이번 ID>`, `Env=perf`, `Org=soma-376` 태그를 넣는다. **기존 shared ECR에는 새 소유 태그를 붙이지 않는다.** 드라이버는 정확한 두 이름+태그+계정/리전 확인 후 이미지를 포함해 삭제한다.
4. 나머지 스택을 배포하고 실제 `CreationTime`, ECR `createdAt`, outputs를 로컬에 보관한다. 상태의 `created_epoch`는 이들 최솟값이며 이후 update로 연장하지 않는다. `PerfBudgetSha256`, `PerfEvidenceCleanupMode=owned-24h`, `PerfCleanupStateParameter`를 request/배포 원본과 묶는다.
5. `ssm describe-instance-information`에서 relay Online과 고정 SSM 문서 가용성을 확인한다. relay는 AL2023의 python3/awscli-2를 설치하고 전용 perf EKS access entry만 사용한다. 이 확인 실패 상태에서 시험을 시작하지 않는다.

고정 권한은 CFN 허용목록+환경 태그, EC2 소유 태그, ECR 두 ARN, perf 스택의 S3 이름 범위다. S3 객체는 bucket 태그를 상속하지 않으므로 API 실행 전에 bucket 태그를 다시 확인한다. 공유 ACM, CDK bootstrap, 기존 dev/shared ECR는 정리 대상이 아니다. 새 AWS 유료 서비스/용량을 추가하면 예상액과 policy를 다시 확인한다.

## 실행 전/실행 중 관측

`scripts/perf-execution-gate.ts --environment-id <id> --observation <json>`은 네트워크 호출 없이 승인 제한을 대조한다. JSON의 정확한 필드는 `lib/perf/budget.ts`의 `PerfExecutionObservation`이다. 환경 ID·policy SHA·조회 원본 SHA, 60초 이내 관측 시각, 실제 CFN/ECR 생성 시각 배열, 소비/예약/이번 계획 요청 수, RPS/초, seed 후 추가 저장량과 이번 예상 추가량, CH 1/Kafka 3/generator 1 디스크의 고유 identity·total/free bytes를 넣는다. 원본 SHA가 실제 조회를 인증해 주는 것은 아니므로 조회 파일/계정/리전/노드/PVC 매핑을 함께 보관한다.

gate는 남은 시간에 부하+drain+최종검증이 들어가지 않거나 요청/저장/디스크 하한을 넘으면 실패한다. 요청 예산은 load-tests paired manifest와 조건부 smoke slot 선점으로 관리한다. 운영자는 실행 중에도 같은 디스크/추가 저장 지표를 관찰하고 하한 또는 1GiB 한도를 위반하면 Job을 SIGTERM grace로 중단한다. 이 로컬 gate나 정리 Lambda가 실시간 예산 청구액/모든 부하 중단을 자동 집행한다고 표현하지 않는다.

## 조기 정리와 자동 정리

실제 이번 시험은 끝나는 대로 로컬 증거를 수집하고 즉시 정리한다. deadline까지 기다리지 않는다. S3 raw/evidence, run manifest·Grafana/Prometheus·WAF/ALB 원본, cleanup status를 내려받고 checksum을 보관한다. Secret 원문을 증거에 넣지 않는다.

```sh
aws lambda invoke --region ap-northeast-2 --function-name soma-376-perf-cleanup \
  --cli-binary-format raw-in-base64-out \
  --payload '{"action":"cleanup","environment_id":"<이번 환경 ID>"}' cleanup-response.json
aws ssm get-parameter --region ap-northeast-2 \
  --name /soma-376/perf/<이번환경ID>/cleanup-state > cleanup-state.json
```

정리 요청은 상태에 남고 다음 주기에도 계속된다. 순서는 TGB finalizer 완료 → 앱/Job 중단 → Kafka Topic/User/Kafka/NodePool CR → 관측 writer/PVC/PV → 전용 클러스터 PDB → 고정 NodePool/노드 → Edge/EKS/Data/Network/Evidence 스택 → 새 ECR 이미지/소유 EC2/EBS/S3 잔존 → Guardrail 자체 삭제다. Kubernetes finalizer는 강제로 제거하지 않는다. relay/SSM/API 오류가 있으면 상태는 ERROR이며 다음 주기에 재시도한다. cloud API의 404와 권한 오류를 혼동하지 않는다.

S3는 모든 version/delete marker와 미완료 multipart를 처리한다. 페이지가 남으면 다음 호출에서 남은 첫 페이지부터 재개한다. CFN의 S3 auto-delete/VPC 기본 SG provider 로그도 명시 LogGroup/Destroy이며 생성 시 자동 로그 잔존을 피한다. RDS는 Snapshot/Retain 없이 Delete, Secrets Manager도 CFN Delete의 ForceDeleteWithoutRecovery 동작을 사용한다. Kafka Retain PV의 실제 EBS는 마지막 태그 조회에서 unattached 상태를 확인한 뒤 삭제한다.

## 삭제 완료와 실패 대응

`SELF_DELETE_REQUESTED`는 최종 완료가 아니다. 보호 스택이 아직 남아 있는 중간 상태다. 운영자는 CFN 여섯 스택 부재/DELETE_COMPLETE, ECR 두 저장소 부재, 소유 EC2/EBS/NAT/EIP/VPC/RDS/Secret/log group 및 S3 bucket 부재를 서울 리전에서 다시 조회한다. `scripts/perf-inventory.ts --cleanup-mode owned-24h ...`는 evidence/guard도 잔존으로 보고, tagging API+CFN 입력만으로 서비스 전체 부재를 증명하지 않는다. SSM parameter/schedule/function/정리 로그까지 GuardrailStack과 함께 사라졌는지 확인한다. 이미 보존한 로컬 상태/최종 조회만 증거로 남긴다.

ERROR가 지속되면 운영자가 CloudWatch/SSM/CFN 상세를 조회하고 원인을 고친 뒤 같은 driver를 재호출한다. 이번 세션은 실패와 삭제 확인 결과를 채팅에 보고한다. 외부 알림 전달을 보장하지 않는다. 24h가 지나면 시험은 금지하고 삭제만 계속 재시도하며 위반과 잔존 자원을 명시한다. AWS 장애·finalizer 오류 중 24h 완료를 보장했다거나 미조회 비용을 0이라고 보고하지 않는다.

## 검증

`npm run build`, `npm test -- --runInBand test/perf`, `python3 scripts/test-perf-cleanup.py`로 profile/상한/소유권/재시도/버전 삭제와 CDK 의존성/IAM을 확인한다. 이 검사만으로 실제 EventBridge/SSM/CloudFormation 삭제 성공을 주장하지 않는다.

- [CFN service role 재사용](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/using-iam-servicerole.html)
- [CFN Delete와 Secret 제거](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-attribute-deletionpolicy.html)

- [AL2023의 AWS CLI 패키지 이름](https://docs.aws.amazon.com/linux/al2023/ug/amzn2-al2023-ami.html)

- [EKS Auto Mode의 PDB를 존중하는 노드 축소](https://docs.aws.amazon.com/eks/latest/userguide/auto-static-capacity.html)

## PROJ-294 로컬 검증 기록

- `npm run build`와 diff 공백 검사를 통과했다. 네트워크 허용 전체 회귀는 58 suite/1,514 tests PASS였다. 이후 bootstrap/runtime 병합 기준으로 rebase한 관련 perf/Helm 11 suite/215 tests를 다시 통과했다.
- 정리 모의 AWS/Kubernetes 검사는 19개 PASS다. 다른 소유권/계정/CFN role 부재·기한·실패 재진입·ECR 이미지·S3 버전/multipart·페이지·마지막 addon PDB 순서를 다룬다.
- fixture 계정/리전의 6개 스택을 실제 CDK CLI `--no-lookups`로 합성했다. 모든 Lambda에 명시 CFN 로그 그룹이 있고 Retain/Snapshot 자원은 0개다. 기존 CDK의 subnet/ListenerRule 검증 경고와 AWS 실제 배포 검증을 구분한다.
- 초기 sandbox 전체 검사는 kubeconform 원격 schema 접근 실패로 중단하고 네트워크 허용 검사로 대체했다. 실제 배포·부하·삭제·청구 확인은 NOT_RUN이다.
