# EC2 OS 지표 수집 (PROJ-260)

프론트 dev EC2와 관측 EC2 각각에서 실행하는 Linux 전용 Alloy다. Node SDK의 RSS/힙은 수집하지 않는다.
CPU·RAM·파일시스템 용량/inode·디스크 I/O 원본을 15초 간격으로 수집한다. dev는 OTLP로 관측 Alloy에 보내고, 관측 EC2는 내부 Prometheus로 remote write한다.
관측 EC2도 저장소 디스크 고갈·메모리 부족을 확인해야 한다. 단, 이 서버 전체가 중단되면 이 안의 Grafana도
중단되므로 EC2 상태 검사 경보 등 독립된 장애 감지는 별도로 필요하다.

## ECS DAEMON 운영 (전환 코드, 실제 배포는 별도)

`frontend/environments/dev/host-agent-ecs.tf`가 기존 dev ECS 클러스터에
`soma-376-frontend-dev-host-agent` 서비스를 생성한다. `frontend_telemetry_enabled=true`일 때만
활성화하며, DAEMON 전략으로 대상 ARM64 EC2마다 Alloy 태스크 하나를 실행한다.
앱의 REPLICA 서비스·태스크 정의·EC2 user data와 관측 EC2 Compose는 변경하지 않는다.
prod Fargate에는 이 서비스를 만들지 않는다.

- 이미지 digest와 `config.alloy`, `start-ecs.sh`가 태스크 정의에 포함된다. 설정 변경은 태스크 revision과 서비스 갱신으로 반영한다.
- CPU 256 units, 메모리 256MiB를 예약/제한한다. 신규 호스트에도 이 여유 용량이 필요하다.
- `/proc`, `/sys`, `/`와 cloud-init의 `/var/lib/cloud/data/instance-id`를 읽기 전용으로 mount한다.
  EC2별 instance 라벨은 이 파일에서 읽으므로 Terraform에 한 호스트 ID를 고정하지 않는다.
- 기존 job=`frontend-host`, environment=`dev`, host_role=`frontend-dev`를 유지한다.
- bridge 네트워크, host PID namespace를 사용한다. Docker socket·privileged·공개 포트·task IAM 역할은 없다.
- 앱과 같은 SG → 관측 Alloy TCP 4318 경로를 사용한다. Prometheus 9090은 공개하지 않는다.
- 로컬 JSON 로그를 10MiB × 3개로 순환한다. 컨테이너 교체 시 과거 로컬 로그는 보존되지 않는다.
- 최대 배포 비율 100%, 최소 0%로 이전 태스크 종료 후 교체한다. 갱신 중 짧은 OS 수집 공백은 허용한다.
- 태스크 중단 복구는 ECS가 관리한다. `up=1`만으로 OTLP 도착을 보증하지 않으므로 최신 timestamp도 확인한다.
- ECS bind mount는 기존 Docker `rslave` 옵션을 그대로 지원하지 않는다. 운영 중 새 디스크를 mount하면
  Alloy 태스크를 재배포하고 해당 mountpoint 수집을 확인한다. 현재 루트 디스크 수집이 기본 대상이다.

## 적용 순서와 기존 수집기 전환

1. 관리자 bootstrap plan에서 **dev 호스트 Alloy 전용 ECS 권한** 추가만 확인 후 적용한다.
   기존 SSM 조회 권한 수정은 전환 작업에도 필요하다. prod 권한·앱 배포 역할은 확대하지 않는다.
2. dev plan에서 기존 EC2·앱 서비스 교체가 없는지 확인한다. 추가 대상은 Alloy 태스크 정의·서비스이며,
   기존 SSM 문서/Association은 설치 대신 정리 명령으로 갱신된다. 실제 apply는 리뷰·머지 후 CI에서 실행한다.
3. Association은 cloud-init ID와 Docker 상태를 확인한 뒤, 이름이 `pulsemetry-dev-host-agent`이고
   owner 라벨이 `frontend-host-agent`인 기존 컨테이너만 제거한다. 미존재는 성공, 다른 소유자는 실패다.
4. ECS 서비스는 정리 Association 성공 후 생성한다. 이후 새 호스트에는 ECS가 자동 배치한다.
   SSM은 더 이상 Alloy를 설치/업데이트하지 않는다. 전환 Association과 IAM은 완료 확인 후 후속 PR에서 제거할 수 있다.
5. ECS 서비스 events·태스크 상태와 아래 PromQL의 instance별 결과를 확인한다.
   현재 코드/테스트 통과를 실제 배포·수신 완료로 해석하지 않는다.

```promql
up{job="frontend-host",environment="dev",host_role="frontend-dev"}
time() - timestamp(node_memory_MemTotal_bytes{job="frontend-host",environment="dev",host_role="frontend-dev"})
```

정리 후 ECS 기동 실패 시 앱은 계속 실행되지만 OS 수집은 중단될 수 있다. 이미지 pull·용량·mount·설정 오류를
ECS events와 해당 컨테이너 로그에서 해결한 뒤 서비스를 재배포한다. 최초 서비스 배포에는 자동 롤백할 이전
revision이 없다. 기존 설치기로 복구할 경우 **먼저 ECS 서비스가 중지되고 태스크가 0개인지 확인**해야 한다.
ECS 전환 후 아래 수동 설치/Compose를 동시에 실행하면 같은 호스트 지표가 중복 수집된다.

## 수동 복구·독립 검증 전용 (ECS 서비스와 동시 실행 금지)

### Compose 없는 dev EC2

`config.alloy`와 `install-dev.sh`를 같은 디렉터리에 배치한 뒤 다음을 실행한다. endpoint와 instance ID는 Terraform output/실제 AWS 조회로 확인한다.

```bash
sudo bash install-dev.sh http://OBSERVABILITY_PRIVATE_IP:4318 DEV_INSTANCE_ID
```

설치기는 digest가 고정된 이미지를 검증한 뒤 전용 컨테이너 하나를 실행한다. 기존 앱을 변경하지 않고 포트를 공개하지 않는다. 중지할 때는 `docker stop pulsemetry-dev-host-agent`를 사용한다.

## Compose가 설치된 dev EC2에서 실행

이 디렉터리를 해당 호스트의 `/opt/pulsemetry-host-agent`에 배치하고 그 경로에서 실행한다.
실제 관측 서버 사설 IP를 넣는다. IP를 확인하지 않은 채 예시 주소를 실행하지 않는다.

```bash
export HOST_INSTANCE_ID=i-069f59e2280925158
export HOST_ENVIRONMENT=dev
export HOST_ROLE=frontend-dev
export OTEL_EXPORTER_OTLP_ENDPOINT=http://OBSERVABILITY_PRIVATE_IP:4318
docker compose config --quiet
docker compose up -d
```

관측 EC2 자체 수집에는 이 설정 대신 관측 모듈의 `host.alloy`를 사용한다.
호스트 에이전트는 인바운드 포트를 열지 않는다. 읽기 전용 호스트 마운트와 PID namespace를 사용하며
Docker 소켓/privileged 모드는 사용하지 않는다. OTLP 전송 큐는 메모리에 있으며 재시작 시 미전송 샘플은 유실될 수 있다.

## 검증과 운영

Grafana의 **Pulsemetry · Dev Frontend**에서 dev OS 및 Node 패널을 확인한다. 관측 EC2는 **Observability Server**에서 확인한다.

```promql
up{job="frontend-host"}
node_memory_MemTotal_bytes{job="frontend-host"}
node_filesystem_size_bytes{job="frontend-host",mountpoint="/"}
```

두 호스트의 라벨·CPU 코어 수·전체 RAM·루트 디스크 용량을 실제 `lscpu`, `free -b`, `df -B1`와 비교한다.
`up=1`은 로컬 scrape 성공이며 전송 장애 여부는 데이터 최신성도 함께 확인한다. 미수신은 정상 0으로 표시하지 않는다.
CPU/RAM/디스크 80%·90% 색상은 초기 시각화 기준이고 경보 정책은 아니다. CPU는 전체 코어 기준 0~100%,
RAM은 `(MemTotal-MemAvailable)/MemTotal`, 디스크는 일반 사용자 가용 용량 기준이다.
RAM에는 앱 외의 ECS Agent·Docker·OS 사용량도 포함된다.

문제 시 `docker compose logs --tail=100 alloy-host`로 전송 실패/수집 실패를 확인한다.
Compose로 설치한 에이전트만 중지할 때 `docker compose down`을 실행한다.
