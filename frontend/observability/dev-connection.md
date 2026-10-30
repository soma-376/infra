# dev 프론트 → 관측 서버 연결

기존 SDK는 서버 메트릭·trace·console/요청 오류 로그를 OTLP HTTP로 보낸다.
infra가 태스크 환경 변수와 네트워크를 소유하며 브라우저 계측과 prod 연결은 포함하지 않는다.

## 배포 순서

1. 프론트 계측 PR #29를 리뷰·머지하고 dev 이미지 배포 완료를 확인한다. SDK는 명시적으로 켜기 전에는 비활성이다.
2. 인프라 적용 전에 프론트 dev Environment의 `ECS_DEPLOY_ENABLED`를 잠시 false로 변경하고 진행 중 앱 CD가 없는지 확인한다. 두 레포의 배포가 겹치면 안 된다(허브 ADR 0022).
3. 인프라 PR plan을 검토한다. SG 규칙 2개 생성, ECS 태스크 정의 revision 교체 및 서비스 갱신만 예상한다. `skip_destroy=true`이므로 이전 task definition은 등록 해제하지 않는다. 단일 태스크 교체 중 짧은 중단이 발생할 수 있다.
4. 리뷰·머지 후 dev 자동 apply와 ECS steady state를 확인하고, 이전과 동일한 앱 digest인지 대조한다. 프론트 CD 설정을 원래 값으로 복원한다.
5. dev 호스트 OS 수집은 `host-agent-ecs.tf`의 ECS DAEMON 서비스로 배포한다. 기존 Docker 수집기 정리와 bootstrap 선행 작업은 [호스트 수집기 안내](host-agent/README.md)를 따른다. 같은 SG의 사설 TCP 4318 경로를 사용하며 9090 포트는 열지 않는다.
6. `https://dev.pulsemetry.co.kr/login` 요청을 생성하고 관측 EC2에서 아래 조회로 실제 수집을 검증한다.

## 설정과 경계

- `frontend_telemetry_enabled=true`일 때만 dev에 연결한다. runtime/observability 둘 다 필요하다.
- 프론트 EC2 SG → 관측 SG TCP 4318 송수신만 허용한다. dev ECS bridge 트래픽은 호스트 SG를 사용한다.
- endpoint는 Terraform의 관측 EC2 사설 IP 출력으로 조립한다. IP를 입력 파일에 고정하지 않는다.
- `OTEL_SDK_DISABLED=false`, `OTEL_DEPLOYMENT_ENVIRONMENT=dev`, `OTEL_SERVICE_NAME=pulsemetry-frontend`, `OTEL_EXPORTER_OTLP_ENDPOINT`를 ECS task definition에 넣는다.
- Grafana/저장소 공개 ingress는 열지 않는다. stdout의 기존 CloudWatch 수집은 유지한다.
- EC2의 volume_tags 갱신은 무시한다. 별도 EBS 리소스가 데이터 볼륨 태그를 관리하며 EC2 refresh가 합쳐 반환한 Name을 제거하지 않는다. 신규 볼륨 생성 시 태그는 계속 부여한다.

## 수신 검증

OS는 `up{job="frontend-host",host_role="frontend-dev",environment="dev"}`와 `node_memory_MemTotal_bytes`를 확인하고 EC2 instance 라벨 및 전체 RAM을 실제 호스트와 대조한다.

Prometheus에서 `frontend_node_memory_bytes{deployment_environment_name="dev",service_name="pulsemetry-frontend"}`와 요청 메트릭을 확인한다. 실제 저장된 metric 이름은 API로 조회한다.
Tempo에서 `{ resource.service.name = "pulsemetry-frontend" && resource.deployment.environment.name = "dev" }`를 검색한다.
Loki에서 `{service_name="pulsemetry-frontend",deployment_environment_name="dev"}`를 조회한다. 에러를 인위적으로 발생시키지 않고 앱 시작 로그 또는 정상 서버 로그부터 확인한다. 기존 요청에 서버 로그가 없으면 trace만으로 로그 수집 성공을 판정하지 않는다.

SDK 없는 이미지나 로컬 synthetic OTLP 전송을 실제 dev 수집 성공의 증거로 사용하지 않는다.

## 롤백

수집 장애 시 `frontend_telemetry_enabled=false`를 PR로 반영한다. OTel 환경 변수와 SG 규칙만 제거하며 데이터 볼륨·관측 스택을 삭제하지 않는다.
