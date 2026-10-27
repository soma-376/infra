# 0041. 프론트 관측 스택을 전용 EC2와 영구 EBS에 배포한다

## Status

Accepted — 사용자 요청에 따른 IaC 구현. 실제 apply와 dev/prod 앱 연결은 이번 단계에서 수행하지 않는다.

## Context

프론트 관측 저장소는 백엔드 EKS와 독립적으로 운영한다. 기존 frontend Terraform은 관리자 bootstrap과
환경별 CI 권한을 분리한다. 단일 EC2 관측 스택 배포는 infra 저장소 내부 구현이며 앱 계측 계약은 변경하지 않는다.

## Decision

- 기존 dev VPC public subnet에 ARM64 t4g.medium 한 대를 둔다. public IPv4는 NAT 없는 환경의 다운로드·SSM egress용이다.
- 초기 사양은 2 vCPU/4GiB이며 컨테이너 한도 합계 3GiB로 시작한다. CPU credit은 standard로 명시한다.
- SSH와 Grafana 공개 ingress는 없다. Grafana는 loopback:3000과 SSM 터널로만 접근한다.
- 역할·instance profile·배포 권한은 bootstrap이 소유한다. 환경 CI는 IAM을 생성하지 않는다.
- 루트 gp3 20GiB와 별도 gp3 100GiB를 암호화한다. 데이터 EBS는 prevent_destroy로 보호하고 EC2 교체 때 재연결한다.
- digest 고정 Docker Compose로 Grafana·Prometheus·Loki·Tempo·Alloy 및 OS 수집 Alloy를 실행한다.
- 지표 7일(최대 TSDB 20GB), 로그·trace 3일을 시작값으로 한다. 전체 디스크의 강제 상한은 아니므로 OS 패널로 감시한다.
- 비밀번호는 최초 부팅 시 데이터 디스크에서 생성하며 Terraform state/user data에 넣지 않는다.
- 최초 앱 연결은 후속 변경이다. 수신 포트는 사설 IP에만 bind하고 SG ingress는 비워 둔다.
- user data/config 변경은 EC2 교체를 수반한다. 데이터 볼륨이 붙기 전에는 스택을 시작하지 않는다.

## Alternatives Considered

- 백엔드 EKS 공유: 프론트 관측을 분리한다는 사용자 결정에 따라 제외했다.
- 인스턴스 루트에 데이터 저장: 교체 시 데이터 유실 위험으로 제외했다.
- CI에 IAM 관리 허용: 기존 권한 경계를 유지하기 위해 제외했다.

## Consequences/Tradeoffs

### Positive

- 기존 앱을 변경하지 않고 관측 수신 기반과 운영 접속을 먼저 준비한다.
- 재부팅·EC2 교체 시 동일 데이터 EBS와 Grafana 자격증명을 재사용한다.

### Negative

- T4g는 CPU credit 소진 시 처리량이 제한된다. 소량 초기 운영 후 RAM·OOM·credit·수집 지연을 측정해 증설한다.
- 단일 서버/AZ 장애 시 관측 전체가 중단된다. 자동 백업·외부 장애 알림은 별도 후속 작업이다.
- bootstrap 관리자가 권한을 먼저 반영해야 환경 CI apply가 성공한다. public IPv4도 과금된다.
- 부팅 시 패키지 저장소·GitHub·이미지 registry 접근이 필요하다.

## Follow-up

- dev OTLP 및 OS 수집 연결, prod 사설 네트워크 연결, 앱 대시보드는 별도 단계로 검증한다.
- 배포 후 실제 보존량·재부팅·볼륨 재연결·접근 차단을 검증한다.
