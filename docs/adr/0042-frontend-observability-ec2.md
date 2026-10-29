# 0042. 프론트 관측 스택을 전용 EC2와 영구 EBS에 배포한다

## Status

Accepted — 사용자 요청에 따른 IaC 구현. 수신 기반 배포 후 dev 앱 연결을 후속 구현한다. prod 연결은 별도 단계다.

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
- 수신 포트는 사설 IP에만 bind한다. dev 앱 연결 활성화 시 앱 SG → 관측 SG TCP 4318 ingress와 반대 방향 egress만 추가한다. 공개 CIDR ingress는 허용하지 않는다.
- 기존 프론트 SDK의 OTLP HTTP를 사용한다. ECS 환경 변수로 SDK 활성화, dev 환경 이름, 서비스 이름, Terraform 관측 endpoint를 전달한다. 앱 코드·이미지 배포는 프론트 레포가 소유하며 기존 CloudWatch stdout 로그는 유지한다.
- dev는 Docker bridge이므로 송신자 SG는 앱 EC2의 SG다. prod 기본값은 비활성이고 이 경로를 공유하지 않는다.
- user data는 최초 부팅에만 적용하며 기존 EC2에서는 user_data_base64 변경을 무시한다. AMI 변경 또는 명시적 교체는 별도 계획으로 수행한다. 부팅/스택 설정 수정은 기존 호스트에 자동 반영되지 않으므로 별도 전환 작업이 필요하다.
- 대시보드 JSON은 infra/frontend/observability/dashboards가 소유하며 user data에서 제외한다. 영구 EBS 디렉터리를 Grafana에 마운트하고 독립 CI가 SSM 전용 문서로 갱신한다.
- 대시보드 배포 역할은 지정 SSM 문서와 관측 태그 EC2에만 접근한다. 일반 RunShellScript·Terraform·앱 배포 권한은 없다.
- 최초 마운트 전환은 Grafana 컨테이너만 재생성한다. 이후에는 provisioning reload로 반영하며 실패 시 이전 파일로 복구한다. 데이터 볼륨이 붙기 전에는 스택을 시작하지 않는다.

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


## 2026-10-30 dev 호스트 수집기 자동 설치 보완

수동 설치 파일만으로는 머지 후 dev OS 계측이 시작되지 않는 누락을 보완한다.
기존 EC2와 Terraform으로 교체된 EC2에 같은 SSM Association을 적용한다.
user data를 변경하거나 EC2 교체를 유발하지 않으며 대상은 dev application의 인스턴스 ID 하나다.
설치 코드는 dev state의 전용 SSM 문서로 관리하고 Association이 명시적 문서 버전을 참조한다.
bootstrap에는 dev 역할의 해당 문서/Association 관리 권한만 추가한다. 임의 Run Command 실행 권한과 prod 권한은 추가하지 않는다.
SG 이후 설치, Docker 기동 대기, IMDSv2 인스턴스 라벨, 설치 실패 전파와 900초 성공 대기를 적용한다.
주기적 재설치는 하지 않으며 재부팅은 Docker 정책으로 복구한다. 비활성화 시 컨테이너 자동 제거는 하지 않는다.
설치 성공과 Grafana 데이터 수신은 별도로 검증한다. 실제 apply는 관리자 bootstrap 이후 리뷰·머지된 dev CI에서 수행한다.
