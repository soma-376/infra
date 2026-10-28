# 프론트 관측 EC2 — PROJ-260 1단계

이 모듈은 **관측 수신 기반만** 만든다. dev/prod 프론트의 환경변수·태스크·보안 그룹 연결은 바꾸지 않는다.
코드·로컬 검증 완료와 AWS 배포 완료는 다르다. 이 작업에서 실제 apply는 실행하지 않았다.

## 머지와 적용 순서

선행 변경은 [bootstrap PR #60](https://github.com/soma-376/infra/pull/60)이다.
이 PR과 별도로 머지·관리자 적용해야 한다. 기존 bootstrap 전체 계획에는 관측 외의 prod 미반영 변경도 있으므로
선행 PR의 상태 점검 결과를 먼저 검토한다. 본 PR은 bootstrap IAM 리소스를 포함하지 않는다.

1. **관리자 bootstrap 선행**: `frontend/bootstrap/observability.tf`가 전용 SSM 역할·instance profile과
   dev-plan/dev-apply 권한을 정의한다. 기존 bootstrap 절차에 따라 관리자가 계획을 검토하고 별도로 반영한다.
   bootstrap은 머지 시 자동 apply되지 않는다. 환경 CI에 IAM 생성 권한을 추가하지 않는다.
2. `develop`에 머지하면 기존 `Frontend Terraform Apply`가 검증 후 보호된 `frontend-dev-apply`
   Environment의 승인/정책을 거쳐 dev 환경 전체의 최종 plan/apply를 수행한다.
   `observability.auto.tfvars.json`이 모듈을 활성화한다. `main`의 prod 환경에는 이 모듈이 없다.
3. bootstrap이 준비되지 않았다면 instance profile data 조회에서 계획이 실패한다. **머지만 하면 무조건 생성되는 것은 아니다.**
4. Terraform은 EC2·EBS 연결까지 관리한다. 첫 부팅의 cloud-init이 Docker·Compose와 설정을 설치하고
   systemd 서비스를 시작한다. Terraform apply 성공만으로 cloud-init/컨테이너 정상 실행을 보장하지 않는다.
   아래 운영 검증을 별도로 수행한다.

기존 환경 전체 plan에 관계없는 앱/API 변경이 보이면 함께 적용하지 말고 원인을 확인한다.
이번 변경은 기존 runtime 입력이나 ECS 서비스·이미지를 수정하지 않는다.

## 생성되는 구성

| 구성 | 값/경계 |
| --- | --- |
| EC2 | AL2023 ARM64, `t4g.medium` 2 vCPU/4GiB, dev public subnet 한 곳 |
| 루트 | gp3 20GiB 암호화, EC2 교체 시 새로 생성 |
| 데이터 | 별도 gp3 100GiB 암호화, `/srv/pulsemetry-observability`, `prevent_destroy` |
| 접근 | SSH key/ingress 없음, Grafana localhost:3000, SSM 터널 |
| 네트워크 | public IPv4는 패키지/이미지/SSM HTTPS egress용. public IP 자체도 과금 |
| 수신 | Alloy 4318은 호스트 사설 IP에만 bind. SG ingress 없음 → 아직 앱에서 접근 불가 |
| IAM | 전용 `soma-376-frontend-observability` profile, SSM 관리 권한만 부여 |

EBS attach/detach 권한은 Component=observability 소유 리소스로 제한한다. 기존 VPC를 쓰며
VPC peering·NAT·ALB·공개 도메인·인증서를 추가하지 않는다. prod의 다른 VPC 연결은 다음 단계다.

## 부팅 후 실행되는 스택

| 컨테이너 | 역할 | 메모리 한도 |
| --- | --- | --- |
| Grafana | 인증이 필요한 조회 화면, 데이터 소스 UID prometheus/loki/tempo | 512MiB |
| Prometheus | 메트릭, 7일 또는 TSDB 20GB 중 먼저 도달하는 기준 | 640MiB |
| Loki | 로그, 72시간 보존 | 512MiB |
| Tempo | 트레이스, 72시간 보존 | 768MiB |
| Alloy | OTLP HTTP 수신 → 각 저장소 전송, 원본 환경 라벨 유지 | 384MiB |
| Alloy host | 이 EC2의 CPU/RAM/파일시스템·디스크 지표, 15초 간격 | 256MiB |
| init-data | 첫 시작 시 데이터 디렉터리 UID 10001 소유권 설정 후 종료 | 일회성 |

이미지는 digest로 고정한다. Compose v2.39.4 ARM64 바이너리는 고정 SHA-256으로 검증한다.
Docker 패키지는 AL2023 패키지 저장소를 사용한다. 설정과 대시보드는 압축 user data로 공급한다.
`files/hosts.json`은 **EC2 OS** 대시보드이며 Node RSS/힙 지표와 다르다. 앱용 대시보드는 후속 단계다.
로컬의 Mimir나 기존 백엔드 EKS에는 접근하지 않는다.

## 영속성·복구

- 루트 디스크와 Docker image/cache는 교체 가능하다. Grafana DB, Prometheus TSDB, Loki/Tempo 저장소,
  Alloy WAL 및 최초 관리자 비밀번호는 데이터 EBS에 보존한다.
- EBS volume ID로 NVMe 장치를 선택한다. 파일시스템이 없는 빈 디스크만 XFS로 초기화하고,
  알 수 없는 기존 파일시스템은 실패 처리한다. 강제 포맷은 하지 않는다.
- Docker와 스택 systemd 서비스 모두 데이터 mount 이후에만 시작한다. 루트 디스크에 데이터를 잘못 쓰지 않는다.
- 설정 또는 AMI 변경은 EC2 교체다. 기존 인스턴스를 중지한 뒤 EBS를 detach하고 새 EC2에 연결한다.
  한 개 EC2라 이 동안 관측 중단이 있다. 강제 detach는 하지 않는다.
- 최초 비밀번호는 `openssl rand`로 생성해 UID 10001/0400으로 보관한다. Git·Terraform state·user data에 값이 없다.
  Grafana UI에서 비밀번호를 변경하면 초기 파일의 비밀번호는 더 이상 로그인 값이 아니다.
- 이 구성에 자동 snapshot/외부 장애 알림은 없다. OS 패널은 관측 서버가 완전히 죽으면 볼 수 없다.
  데이터 보호용 snapshot·독립 CloudWatch 상태 경보는 다음 운영 단계에서 구성한다.
- 보존 기간은 즉시 삭제나 전체 100GiB의 강제 상한이 아니다. WAL·compaction·로그 폭증 여유가 필요하다.

## 배포 후 확인 (이번 작업에서는 실행하지 않음)

```bash
terraform -chdir=frontend/environments/dev output -json observability
# 출력의 instance_id를 사용한다. 운영자 AWS 자격증명 및 SSM Session Manager plugin 필요.
aws ssm start-session --region ap-northeast-2 --target INSTANCE_ID
```

호스트에서 다음으로 첫 부팅·디스크·컨테이너 상태를 확인한다.

```bash
sudo cloud-init status --long
sudo systemctl status pulsemetry-observability
sudo findmnt /srv/pulsemetry-observability
sudo journalctl -u pulsemetry-observability --no-pager -n 100
cd /opt/pulsemetry-observability
sudo docker compose ps
sudo docker compose logs --tail 100
```

서버에서 초기 비밀번호를 확인할 때는 SSM 대화형 세션에서만
`sudo cat /srv/pulsemetry-observability/secrets/grafana-admin-password`를 실행한다.
공유되는 Run Command 출력·CI 로그·채팅에 비밀번호를 남기지 않는다. 기본 ID는 `admin`이다.

로컬에서 비어 있는 포트를 확인하고 SSM 터널을 연다.

```bash
aws ssm start-session --region ap-northeast-2 --target INSTANCE_ID \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["3000"],"localPortNumber":["13300"]}'
```

`http://localhost:13300`에 로그인해 EC2 Hosts 대시보드에서 environment=shared,
host_role=observability, instance=실제 인스턴스 ID를 선택한다.
수집 상태 1, 전체 RAM 약 4GiB, 데이터 mount 약 100GiB를 호스트와 대조한다.
외부에서 Grafana/OTLP에 직접 접근할 수 없어야 한다. 실제 EC2 재부팅 후 데이터 유지도 검증한다.

## 로컬 검증

```bash
bash frontend/scripts/check.sh
python3 frontend/scripts/test-observability.py
```

첫 명령은 fmt·validate·mock Terraform 계획을 검증한다. 실제 AWS apply를 수행하지 않는다.
두 번째는 독립 Compose 프로젝트·빈 임시 포트·일회용 볼륨에서 로그인 강제, OS 대시보드,
OTLP metric/log/trace의 수신·환경 라벨, 컨테이너 재시작 후 데이터 보존을 검증하고 정리한다.
Docker Desktop에서 OS 지표는 Linux VM 수치다. AWS AMI 부팅·SSM·보안 그룹 효과를 입증하지는 않는다.

## 후속 체크리스트

- [ ] 관리자 bootstrap 반영과 보호된 CI 실제 계획 검토
- [ ] AWS 첫 부팅, SSM 접속, 재부팅/교체 후 EBS 보존 검증
- [ ] dev EC2 → 관측 EC2 SG ingress/egress 및 앱 OTLP 환경변수 연결
- [ ] dev OS 수집 에이전트 배포와 Node 대시보드 연결
- [ ] prod VPC 경로·인증/접근 제한 설계와 실제 수집 검증
- [ ] 디스크 예산·외부 장애 경보·백업/복구 정책

## t4g.medium 시작 용량과 확장 기준

초기 저부하 수집용으로 2 vCPU/4GiB를 사용한다. 상시 컨테이너 메모리 한도 합계는 3GiB이며
약 1GiB를 OS·Docker·SSM 등으로 남긴다. 한도는 실제 사용량이나 메모리 예약이 아니며, 각 컨테이너가
한도에 도달하면 호스트에 여유가 있어도 OOM이 발생할 수 있다. Alloy memory limiter는 256MiB다.

CPU credit은 `standard`로 명시하여 surplus credit 과금을 막는다. t4g.medium의 baseline은 vCPU당 20%다.
크레딧 소진 시 CPU 처리량이 제한되어 조회·수집이 느려질 수 있다. CPUCreditBalance는 CloudWatch에서
확인한다. 현재 OS 대시보드에 CPU credit 지표가 자동으로 들어오는 것은 아니다.

메모리 사용률 80% 이상 지속, 컨테이너 OOM/재시작, 전송 지연이 발생하면 수집량·조회 부하를 확인하고
8GiB 및 컨테이너 한도 확대를 검토한다. CPU credit이 지속 소진되면 메모리 증설만으로 해결되지 않으므로
고정 성능 인스턴스 또는 추가 과금을 감수하는 unlimited를 검토한다. 로컬 소량 데이터 테스트는
4GiB EC2 전체 용량·장시간 부하를 검증한 결과가 아니다. dev/prod 합산 부하는 연결 후 측정한다.
