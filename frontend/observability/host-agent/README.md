# EC2 OS 지표 수집 (PROJ-260)

프론트 dev EC2와 관측 EC2 각각에서 실행하는 Linux 전용 Alloy다. Node SDK의 RSS/힙은 수집하지 않는다.
CPU·RAM·파일시스템 용량/inode·디스크 I/O 원본을 15초 간격으로 수집하여 Prometheus remote write로 보낸다.
관측 EC2도 저장소 디스크 고갈·메모리 부족을 확인해야 한다. 단, 이 서버 전체가 중단되면 이 안의 Grafana도
중단되므로 EC2 상태 검사 경보 등 독립된 장애 감지는 별도로 필요하다.

## 적용 상태와 선행 조건

2026-10-28 확인 시 dev EC2는 존재하지만 PROJ-260의 프론트 관측 전용 EC2는 아직 없다.
이 구성은 호스트 에이전트이며 EC2·Prometheus·네트워크를 생성하지 않는다. 적용 전 다음을 준비한다.

- 관측 EC2의 Prometheus에 `--web.enable-remote-write-receiver`를 설정한다.
- 사설 IP의 9090 포트를 두 호스트에서만 접근하도록 보안 그룹으로 제한한다. 인터넷 전체에 공개하지 않는다.
- 다른 VPC라면 사설 라우팅을 먼저 구성한다. 공개 경로를 사용할 경우 이 무인증 구성을 그대로 사용하지 말고
  TLS와 인증 프록시 및 Alloy 인증 설정을 함께 추가한다.
- Linux Docker Engine과 Compose가 필요하다. Docker Desktop은 Linux VM을 계측하며 macOS 자체 수치가 아니다.
- 관측 서버의 Grafana는 `pulsemetry-frontend/observability/hosts.json`을 dashboard provisioning 경로에 마운트한다.
  데이터 소스 UID는 `prometheus`를 유지한다. 로컬 Compose에는 해당 마운트가 포함되어 있다.

## 각 EC2에서 실행

이 디렉터리를 해당 호스트의 `/opt/pulsemetry-host-agent`에 배치하고 그 경로에서 실행한다.
실제 관측 서버 사설 IP를 넣는다. IP를 확인하지 않은 채 예시 주소를 실행하지 않는다.

```bash
export HOST_INSTANCE_ID=i-069f59e2280925158
export HOST_ENVIRONMENT=dev
export HOST_ROLE=frontend-dev
export PROMETHEUS_REMOTE_WRITE_URL=http://OBSERVABILITY_PRIVATE_IP:9090/api/v1/write
docker compose config --quiet
docker compose up -d
```

관측 EC2는 자신의 실제 인스턴스 ID, `HOST_ENVIRONMENT=shared`, `HOST_ROLE=observability`를 사용한다.
주소는 관측 서버 사설 IP를 동일하게 사용한다. 컨테이너의 localhost는 호스트의 Prometheus가 아니다.
호스트 에이전트는 인바운드 포트를 열지 않는다. 읽기 전용 호스트 마운트와 PID namespace를 사용하며
Docker 소켓/privileged 모드는 사용하지 않는다. WAL은 named volume에 보존된다.

## 검증과 운영

Grafana의 **Pulsemetry · EC2 Hosts (OS)**에서 환경·역할·인스턴스를 선택한다.
Node 프로세스 대시보드는 기존 **Pulsemetry frontend · Local**과 분리되어 있다.

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
에이전트만 중지할 때 `docker compose down`을 실행한다. WAL 보존을 위해 `-v`는 쓰지 않는다.
