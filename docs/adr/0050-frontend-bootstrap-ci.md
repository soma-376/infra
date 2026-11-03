# 0050. 프론트 Terraform bootstrap을 승인된 GitHub Actions로 갱신한다

## Status

Accepted (PROJ-260). 2026-10-30 최초 IAM과 GitHub Environment 설정을 완료했다. 실제 OIDC CI 실행은 코드 반영 후 별도 검증한다.

## Context

bootstrap의 IAM 변경을 관리자가 로컬에서 적용한 뒤 dev runtime을 배포하고 있었다.
ECS DAEMON 전환처럼 새 IAM 권한이 필요한 변경에서 적용 순서가 누락될 수 있다.
bootstrap은 dev/prod 공통이므로 일반 dev 배포 역할에 IAM 수정 권한을 추가하지 않는다.

## Decision

- `frontend/bootstrap/ci.tf`가 plan/apply 전용 역할을 만든다. 최초 한 번 관리자가 검토한 plan을 적용한다.
- 기존 GitHub OIDC provider를 조회하고 실제 immutable subject prefix와 Environment를 정확히 제한한다.
- `frontend-bootstrap-plan`은 same-repo PR 및 develop에서 사용자 승인 후 실행한다. fork PR은 AWS 없이 검증한다.
- `frontend-bootstrap-apply`는 develop 전용이며 사용자 승인과 branch policy를 사용한다. 관리자 bypass는 끈다.
  초기 reviewer는 요청자 계정이다. 요청자 본인 승인도 가능하도록 self-review 금지는 사용하지 않는다.
- bootstrap의 배포 원본은 develop 하나다. main은 prod runtime만 적용하며 공통 bootstrap 변경은 먼저 develop에 반영한다.
- 기존 runtime apply workflow에서 bootstrap reusable workflow 성공 후 dev runtime apply를 실행한다.
  bootstrap에 변경이 없으면 apply 승인 없이 다음 단계로 넘어간다. plan Environment의 승인 자체는 필요하다.
- PR에서도 bootstrap plan을 별도로 실행한다. runtime PR plan은 현재 배포 권한으로 병렬 수행되므로
  아직 적용되지 않은 새 권한이 필요한 경우 bootstrap 선행 적용 후 다시 검증한다.
- plan은 읽기와 정확한 `.tflock` 객체 쓰기만 가능하다. apply만 프론트 이름 범위의 IAM 및 bootstrap 리소스를 관리한다.
- IAM 정책/신뢰를 변경하는 apply 역할은 관리자 경계다. prefix 제한은 계정 전체 IAM에 대한 직접 변경을 줄이지만,
  자기 역할/정책 수정까지 가능하므로 강한 privilege-escalation 차단 경계라고 주장하지 않는다.
- Secret GetSecretValue는 부여하지 않는다. UpdateSecret은 메타데이터 외 값도 수정할 수 있으므로 승인 대상이다.
- state 버킷/객체는 기존 `bootstrap/terraform.tfstate`를 사용한다. runtime state 본문 쓰기는 허용하지 않는다.
- plan 바이너리/state는 GitHub artifact나 PR 댓글에 올리지 않는다. 계획 전체 JSON에서 timestamp를 제외하고,
  의미상 집합인 최상위 `relevant_attributes` 목록만 정렬해 해시를 출력한다. 리소스 값·입력·prior state와 배열 순서는 보존한다.
  Terraform 1.13.5의 참조 목록 출력 순서 차이로 동일 계획을 거부하는 문제를 방지한다.
  승인 후 같은 커밋에서 재계획하고 해시가 일치할 때 그 바이너리를 적용한다. SHA·baseline·입력·계획이 달라지면 중단한다.
  이는 저장한 바이너리를 job 간 전달하는 방식은 아니다. stale saved-plan 검사와 S3 lock도 그대로 사용한다.
- 공통 concurrency group으로 bootstrap 실행을 직렬화한다. 오래된 승인 대기 실행은 운영자가 취소하고 최신 실행을 승인한다.

## Consequences

- 이후 일반 bootstrap 변경에 로컬 apply가 필요하지 않다. 역할/Environment 복구는 관리자가 수행한다.
- 현재 IAM 이름 범위/리소스 종류 밖의 신규 서비스 도입은 별도 권한 검토가 필요하다.
- 공통 state에 prod 기반 권한도 있으므로 bootstrap plan의 모든 환경 영향을 확인해야 한다.
- 계정 로그인·환경 보호 설정·AWS plan과 workflow 코드 검증은 실제 OIDC CI 실행의 대체 증거가 아니다.

## Alternatives Considered

- 기존 dev-apply에 IAM 권한 추가: runtime 배포 권한과 관리자 경계가 섞여 제외했다.
- bootstrap과 dev workflow를 독립적으로 실행: 권한 생성 전 runtime 배포가 시작될 수 있어 제외했다.
- 공개 저장소 artifact에 plan 바이너리 업로드: 계획에 state/민감 값이 포함될 수 있어 사용하지 않는다.

## Verification

2026-10-30 최초 관리자 apply: bootstrap CI 역할·정책·연결 9개와 ECS 호스트 Alloy 배포 권한 4개,
총 13개 생성, 기존 리소스 변경·삭제 0개. 이후 bootstrap plan은 No changes였다.
GitHub Environment 두 개의 reviewer/branch 정책과 관리자 bypass 비활성화를 재조회했다.
IAM 시뮬레이션에서 plan 역할의 IAM 수정/state 본문 쓰기 거부와 apply 역할의 허용을 확인했다.
이 검증은 실제 GitHub OIDC 로그인·CI apply 성공을 뜻하지 않는다.
