# AWS 대시보드 독립 배포

AWS 관측 서버의 두 대시보드 원본은 이 디렉터리다.

| 파일 | 대시보드 | 고정 UID |
| --- | --- | --- |
| dev-frontend.json | Dev Frontend: dev OS·Node·요청·Loki·Tempo 안내 | pulsemetry-dev-overview |
| observability.json | Observability Server: 관측 EC2 OS·수집 상태 | pulsemetry-frontend-hosts |

Grafana 데이터 소스 UID는 prometheus/loki/tempo를 유지한다. 기존 북마크도 유지한다. AWS 화면에서 변경한 내용은 Git에 역으로 저장되지 않는다. JSON을 수정해 PR로 관리한다. 프론트 저장소의 frontend.json은 로컬 앱 계측 검증용으로만 유지한다.

## 역할과 배포 경계

- Terraform: EC2·EBS·네트워크·최초 Docker/관측 스택 설치. JSON 내용은 user data에 포함하지 않는다.
- Frontend Dashboards CI: JSON 검사 → SSM 전용 문서 → EBS의 `/srv/pulsemetry-observability/dashboards` → Grafana provisioning reload → 실제 UID·제목·패널 확인.
- JSON-only 변경에는 Terraform plan/apply workflow가 실행되지 않는다. 대시보드 CI와 dev Terraform apply는 동일 concurrency 그룹으로 직렬화한다.
- 수집기·앱 설정·보안 그룹은 변경하지 않는다. dev 미수신 문제는 앱/infra 배포 및 OS 수집기 설치로 별도 해결한다.

## 최초 전환 순서 (아직 AWS에 적용하지 않음)

1. 관리자 bootstrap 계획에서 `frontend/bootstrap/dashboards.tf`의 전용 OIDC 역할·정책·SSM 문서 추가를 검토하고 적용한다. 기존 미적용 리소스가 섞이면 먼저 분리한다. 새 문서는 환경변수 입력을 지원하는 SSM Agent **3.3.2746.0 이상**과 python3가 필요하다. 기존 EC2에서 `python3 --version`, `amazon-ssm-agent -version`을 확인한다.
2. GitHub Environment `frontend-dashboards`를 생성하고 develop 브랜치만 허용한다. 리뷰 승인 정책을 설정한다. Environment variables에 `AWS_ACCOUNT_ID`, bootstrap output의 `DASHBOARD_DEPLOY_ROLE_ARN`을 설정한다. 비밀번호는 GitHub에 넣지 않는다.
3. infra 변경을 리뷰·머지한다. dev Terraform plan에서 **관측 EC2/EBS 교체 없음**을 확인한다. 최초 코드 전환은 Terraform 및 대시보드 workflow가 함께 실행될 수 있으며 순서는 보장되지 않으므로 Terraform 완료 후 대시보드 workflow를 재실행할 수 있다.
4. `Frontend Dashboards`를 develop에서 실행한다. 기존 `./hosts.json` 단일 파일 마운트가 있으면 실행 중 Compose의 해당 한 줄만 EBS 디렉터리 마운트로 바꾼다. `docker compose up -d --no-deps --force-recreate grafana`로 Grafana만 재생성한다. 잠깐 화면이 중단되며 기존 SSM 터널은 Grafana 복구 후 재사용할 수 있다. Prometheus/Loki/Tempo/Alloy는 재시작하지 않는다.
5. 기존 DB 관리 Dev Frontend도 같은 UID로 파일 provisioning에 편입한다. 두 대시보드의 `meta.provisioned=true` 및 패널 내용을 API로 검증한다.

기존 EC2에서 user_data_base64 변경은 무시한다. 이는 **대시보드뿐 아니라 향후 부팅 스크립트/초기 스택 설정 수정도 기존 서버에 자동 반영되지 않음**을 뜻한다. 해당 변경은 별도의 호스트 업데이트 계획 또는 명시적 EC2 교체로 수행해야 한다. AMI 등 다른 EC2 속성 변경에 따른 교체는 계속 계획된다. 새 EC2는 최신 부팅 설정을 사용한다.

## 일반 패널 변경

JSON 수정 → PR 검사 → develop 머지 → 별도 대시보드 배포. 디렉터리 마운트 전환 이후에는 컨테이너 재생성 없이 파일 교체와 provisioning reload만 수행한다. Terraform 실행이나 EC2 교체가 필요 없다.

```bash
python3 frontend/scripts/deploy-dashboards.py  # 로컬 검사, AWS 호출 없음
python3 frontend/scripts/test-dashboards.py
# bootstrap과 Environment 준비 후 CI가 실행하는 명령
python3 frontend/scripts/deploy-dashboards.py --deploy
```

새 EC2 생성/교체 후에는 대시보드 workflow를 다시 실행한다. EBS의 기존 JSON은 보존되지만 최신 Git 버전 반영을 확인해야 한다. bootstrap의 SSM 문서에 배포기 코드가 포함되므로 `dashboard-release.py` 변경은 관리자 bootstrap 적용이 먼저 필요하다. JSON만 변경할 때는 bootstrap이 필요 없다.

## 실패·복구 및 권한

- 배포 전에 Grafana admin 인증을 검사한다. 현재 서버의 초기 비밀번호 파일을 사용하며, UI에서 비밀번호를 변경해 파일과 달라졌다면 파일/자격증명을 안전하게 동기화한 뒤 다시 실행한다. 인증 실패 시 파일을 바꾸지 않는다.
- 고정된 두 파일 이름·UID·데이터 소스만 허용한다. base64/gzip 입력은 환경변수로 전달하고 shell 코드로 보간하지 않는다.
- 이전 JSON·Compose·DB 대시보드 원본을 EBS의 `dashboard-backups/<배포 시각>/`에 저장한다. 실패 시 해당 파일과 최초 마운트를 복구하고 DB 관리였던 대시보드를 복원한다. 백업은 자동 삭제하지 않으므로 운영 중 용량을 관리한다.
- 복구 자체가 실패하면 CI도 실패한다. 서버의 백업 디렉터리와 SSM command ID를 기준으로 조사한다. 검증 실패를 성공으로 처리하지 않는다.
- CI 역할은 태그가 일치하는 관측 EC2와 `soma-376-frontend-dashboards` 문서만 실행할 수 있다. 임의 RunShellScript·앱 EC2·EC2 생성/삭제·IAM 관리 권한은 없다.

## 검증 기록

로컬 payload/실패 복구 테스트, 두 대시보드의 실제 Docker 파일 provisioning 및 저장소 재시작 보존 검증, Terraform mock 검증을 수행했다. dev 실제 plan은 기존 관측 연결 변경(3 add / 1 change / 1 destroy)만 있으며 관측 EC2/EBS 교체가 없다. 실제 bootstrap 적용·SSM 마운트 전환·AWS 대시보드 배포는 수행하지 않았다.

참고: [AWS SSM 환경변수 파라미터](https://docs.aws.amazon.com/systems-manager/latest/userguide/documents-syntax-data-elements-parameters.html).
