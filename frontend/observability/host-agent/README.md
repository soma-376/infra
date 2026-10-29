# EC2 OS 지표 수집 (PROJ-260)

프론트 dev EC2와 관측 EC2 각각에서 실행하는 Linux 전용 Alloy다. Node SDK의 RSS/힙은 수집하지 않는다.
CPU·RAM·파일시스템 용량/inode·디스크 I/O 원본을 15초 간격으로 수집한다. dev는 OTLP로 관측 Alloy에 보내고, 관측 EC2는 내부 Prometheus로 remote write한다.
관측 EC2도 저장소 디스크 고갈·메모리 부족을 확인해야 한다. 단, 이 서버 전체가 중단되면 이 안의 Grafana도
중단되므로 EC2 상태 검사 경보 등 독립된 장애 감지는 별도로 필요하다.

## 적용 상태와 선행 조건

2026-10-29 확인: 관측 EC2는 실행 중이나 dev에는 수집기가 없다. dev 수집기는 OS 지표를 OTLP로 변환하여 앱과 같은 관측 Alloy의 사설 4318 포트로 보낸다. Prometheus의 9090은 외부에 공개하지 않는다.

- infra PR #66의 dev 앱 SG → 관측 SG TCP 4318 송수신 규칙이 필요하다.
- 관측 EC2 자체 수집기는 모듈 내 `host.alloy`를 사용하며 Compose 내부 Prometheus로 직접 전송한다.
- 아래 수동 설치는 장애 진단용이다. 기본 설치 경로는 Terraform의 SSM Association이다. 코드 구현과 실제 apply 완료는 별도로 확인한다.


### 자동 설치·갱신 (2026-10-30 추가, 실제 apply 전)

`frontend/environments/dev/host-agent.tf`가 고정 설치 문서와 SSM Association을 관리한다.
`frontend_telemetry_enabled=true`일 때만 생성한다. 대상은 application 모듈이 출력한 **단일 dev EC2 ID**다.
관측 EC2나 prod는 대상에 포함하지 않는다. 기존 user data를 변경하지 않아 수집기 추가만으로 EC2가 교체되지 않는다.

- 최초 apply: 기존 dev EC2에 SSM으로 설치한다. 앱·ECS Agent는 재시작하지 않는다.
- EC2 교체: Terraform이 새 인스턴스 ID로 Association을 갱신해 설치한다. SSM/Docker가 준비된 뒤 실행되므로 부팅 완료와 수집 시작은 동시가 아니다.
- 설정/설치기/관측 endpoint 변경: dev state의 SSM 문서 버전이 바뀌고 Association이 그 숫자 버전을 실행한다. 대시보드 문서와 달리 이후 수집기 코드 수정마다 bootstrap apply가 필요하지 않다.
- 재부팅: `--restart unless-stopped`로 복구한다. 수동 stop은 자동 복구하지 않는다.
- 주기적 재설치 일정은 없다. Association 삭제/관측 비활성화는 이미 설치한 컨테이너를 제거하지 않는다. 완전 중지 시 별도로 해당 컨테이너만 중지·제거한다.

적용 순서:

1. 관리자가 `frontend/bootstrap` plan을 확인하고 호스트 문서·Association 관리 권한을 적용한다. dev-plan은 읽기만, dev-apply만 쓰기 권한을 갖는다. prod 역할은 바뀌지 않는다.
2. 리뷰·머지 후 기존 `Frontend Terraform Apply` CI가 dev 문서와 Association을 생성한다. SG 연결 완료 후 설치하며 성공 대기 시간은 900초다.
3. SSM 설치 성공은 컨테이너 실행까지만 검증한다. 아래 PromQL로 dev 호스트 지표와 timestamp가 갱신되는지 확인해야 실제 전송 완료다.

```promql
up{job="frontend-host",environment="dev",host_role="frontend-dev"}
time() - timestamp(node_memory_MemTotal_bytes{job="frontend-host",environment="dev",host_role="frontend-dev"})
```

실패 시 SSM State Manager에서 `soma-376-frontend-dev-host-agent` 실행 상세와
`docker logs --tail=100 pulsemetry-dev-host-agent`를 확인한다. 실패 뒤 단순 apply가 실행을 다시 유발한다고 가정하지 않는다.
관리자가 원인을 해결한 뒤 해당 Association의 Apply association now로 재실행하고 수신을 확인한다.
설치기는 새 이미지 pull·설정 validate를 기존 컨테이너 제거 전에 수행하지만, 제거 후 실행 실패에 대한 자동 롤백은 없다.
프론트 앱은 유지되며 호스트 수집만 중단될 수 있다.

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
