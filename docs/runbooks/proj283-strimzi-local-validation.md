# PROJ-283 Strimzi 구현·검증 기록

이 기록은 코드 및 배포 전 점검 결과다. 실제 설치·수집 전환·장애 검증·MSK 삭제 완료 증거가 아니다.
전환 절차는 [dev Strimzi 런북](dev-strimzi-kafka.md)을 따른다.

## 코드 검증

- infra 전체 Jest 45 suites / 1277 tests 통과. TypeScript build와 diff whitespace 검사 통과.
- Helm 3.22.0, kubeconform, promtool 3.9.1을 지정해 Helm schema/render·공식 Strimzi 1.3.0 CRD·PromQL을 검증했다. suite skip은 없다.
- backend 공통 모듈·Gateway·ingest 206 tests 통과, 두 bootJar 생성 성공.
  실제 Strimzi Kafka 4.2.2 이미지에서 mTLS ACK→수신→수동 commit과 잘못된 CA·사용자 인증서 없는 접속 거절을 확인했다.
- prod HTTP/HTTPS 8개와 CI/CD 1개 합성 템플릿은 기존 infra develop `0b37a008`과 바이트 단위로 동일하다.
- MSK 제거 단계에서 앱의 JWT·RDS·S3 Pod Identity를 보존하며 MSK 전용 역할만 제거하는 것을 검증했다.
  자동 CI는 최초 삭제를 차단하고 수동 철거 완료가 실제 baseline으로 확인된 뒤 후속 자동 배포를 허용한다.

## 실제 dev 사전 확인

AWS SSO와 EKS 전용 SSM 터널로 읽기 전용 점검했다. EKS는 1.36이며 노드 버전은 1.36.4다.
ClickHouse는 ap-northeast-2a, 현재 EKS 노드 4대는 모두 Ready이고 PVC 7개는 Bound다.
기존 HTTP ingest·enrollment·dashboard와 ClickHouse가 Ready이며 Gateway ALB 대상은 비어 있다.
CRD 및 ClusterRole 생성 권한을 확인했다. Standard On-Demand vCPU quota는 256이며 해당 AZ가 m7g.large를 지원한다.
이는 인스턴스 시작 시점의 실제 가용 용량을 예약한 결과는 아니다.

현재 CloudFormation 4개는 UPDATE_COMPLETE다. 실계정 합성 결과와 실제 template을 비교했다.
준비 단계에서는 Kafka SG·통신 규칙·출력을 추가하고 MSK CloudWatch 지표 경보 5개를 제거한다.
MSK cluster/configuration·Data·ALB 기능 리소스의 삭제/교체는 없다. CDK Metadata 갱신은 별도다.

CloudFormation·ALB·노드·PVC·배포 이미지 digest·Helm revision과 민감값을 제거한 values는 로컬 접근 제한된
배포 기록으로 보관했다. 전체 Secret 원문을 저장하는 raw Helm 백업은 만들지 않는다.
HTTP 복구는 기록된 Helm revision과 기존 ALB 대상으로 수행한다.

## 남은 실제 인수 검증

리뷰·배포 승인 후 전용 노드/Operator/Kafka 설치, validation JWT 요청→ACK→consume→commit→ClickHouse·로그/trace,
ACL 양방향 거절·HTTP 크기 경계·1/2 broker 장애·노드 교체 후 PVC/offset 보존·인증서 실제 갱신 및 앱 재접속을 검증한다.
이후 main dual→Gateway ALB→Kafka 모드로 전환하고 최소 30분 안정화한다.
기존 MSK 미확인 데이터 폐기는 사용자 승인 범위이며, 실제 삭제·ENI 해제 확인 뒤에만 전용 네트워크를 제거한다.

Helm의 Kafka 관리용 이전 release는 failed 상태였으며 해당 상태를 신규 Strimzi 검증 성공으로 해석하지 않는다.
