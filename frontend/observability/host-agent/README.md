# EC2 OS 지표 수집 (PROJ-260)

프론트 dev EC2와 관측 EC2 각각에서 실행하는 Linux 전용 Alloy다. Node SDK의 RSS/힙은 수집하지 않는다.
CPU·RAM·파일시스템 용량/inode·디스크 I/O 원본을 15초 간격으로 수집한다. dev는 OTLP로 관측 Alloy에 보내고, 관측 EC2는 내부 Prometheus로 remote write한다.
관측 EC2도 저장소 디스크 고갈·메모리 부족을 확인해야 한다. 단, 이 서버 전체가 중단되면 이 안의 Grafana도
중단되므로 EC2 상태 검사 경보 등 독립된 장애 감지는 별도로 필요하다.

## 적용 상태와 선행 조건

2026-10-29 확인: 관측 EC2는 실행 중이나 dev에는 수집기가 없다. dev 수집기는 OS 지표를 OTLP로 변환하여 앱과 같은 관측 Alloy의 사설 4318 포트로 보낸다. Prometheus의 9090은 외부에 공개하지 않는다.

- infra PR #66의 dev 앱 SG → 관측 SG TCP 4318 송수신 규칙이 필요하다.
- 관측 EC2 자체 수집기는 모듈 내 `host.alloy`를 사용하며 Compose 내부 Prometheus로 직접 전송한다.
- 아래 수동 설치는 dev EC2용이다. 재부팅은 Docker restart 정책으로 복구되지만 EC2 **교체 시에는 재설치**해야 한다. 현재 EC2 부팅 IaC에 자동 설치된 것으로 간주하지 않는다.

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
