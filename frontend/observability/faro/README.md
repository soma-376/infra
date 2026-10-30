# 브라우저 RUM 수신기

브라우저 → 프론트 HTTPS `/api/rum/collect` → 관측 EC2의 사설 `12347` → Faro 전용 Alloy → 기존 Loki 경로다. 서버 OTLP 4318 경로와 분리한다. Grafana Cloud 서비스는 사용하지 않는다.

## Terraform 적용 범위

- bootstrap: dev plan/apply의 전용 Faro SSM 문서 조회·배포 권한, 관측 인스턴스 태그 제한, RUM 대시보드 허용목록 갱신.
- dev: `frontend_telemetry_enabled`일 때 전용 SSM Document/Association, 앱 SG ↔ 관측 SG TCP 12347, 앱 `RUM_ENABLED=true`, `RUM_ENVIRONMENT=dev`, `FARO_COLLECTOR_URL` 환경변수.
- 관측 EC2 `/opt/pulsemetry-faro`의 독립 Compose 프로젝트에서 192MiB/0.5 CPU 제한 Alloy를 실행한다. 기존 OTLP Alloy·스토리지·Grafana·EC2는 재생성하지 않는다. 앱 환경변수 변경은 ECS 앱 재배포를 유발한다.
- 수신기는 사설 IP에만 바인딩한다. 관리 readiness 포트 12348은 호스트 loopback에만 연다. 기존 Docker network `pulsemetry-observability_default`를 사용한다.
- SSM Association은 고정 코드만 실행하며 입력 파라미터가 없다. 문서 버전이 바뀌면 다시 적용한다. 설정 검증·readiness 실패 시 이전 파일로 돌아간다. 신규 설치 실패면 테스트한 서비스만 내린다.
- Association 제거만으로 컨테이너가 자동 삭제되지는 않는다. 제거할 때는 앱 전송 중단 후 별도 IaC 정리 문서를 배포해야 한다.

## 적용 순서

1. 프론트 Faro SDK PR을 먼저 배포한다. 환경변수가 없으므로 비활성이다.
2. infra PR의 bootstrap plan/승인/apply를 진행한다. 추가 IAM 권한과 대시보드 SSM 스크립트가 준비된다.
3. dev Terraform plan/승인/apply로 수신기·SG·앱 환경변수를 반영한다. 준비 중에는 RUM 수집 실패가 있을 수 있으나 앱 기능을 차단하지 않는다.
4. Frontend Dashboards 워크플로에서 `rum.json` 배포를 확인한다. bootstrap보다 먼저 실행되면 기존 허용목록 검증에 실패하므로 bootstrap 완료 후 재실행한다.
5. Chrome에서 페이지 진입·클릭 후 탭을 숨기고 `Pulsemetry · Browser RUM`의 dev 수신을 확인한다.

prod 설정은 바뀌지 않는다. runtime apply·실제 dev 수신은 PR 머지 이후 별도 검증 사항이다.

## 수집/집계 제한

로그는 `job="frontend-rum"`, JSON의 `app_environment`, `page_url`, `value_lcp|inp|cls`로 조회한다. 사용자·세션·원본 URL·브라우저 로그는 프론트에서 제외한다. sourcemap 다운로드·연결 메타데이터 전달은 끈다.

수신기에는 16KiB/요청, 전역 20 req/s·burst 40 제한이 있다. 새 로그 스트림은 Loki 기존 보존 기간을 따른다. 별도 스토리지 비용은 없지만 기존 Loki 디스크와 관측 EC2 자원을 사용한다.

p75·분포는 선택 기간의 **수신 보고값**을 집계한다. 동일 측정의 갱신·재전송은 여러 보고가 될 수 있으므로 방문별 최종 p75나 사용자 수로 표현하지 않는다. 최초 진입 경로 그룹만 구분하며 SPA 내부 이동의 독립 LCP를 측정하지 않는다.

## 로컬 검증

`python3 frontend/scripts/test-faro.py`는 임시 포트·Docker 네트워크의 Faro/Loki에서 세 지표를 전송하고 실제 대시보드 쿼리 결과를 검증한다. 끝나면 테스트 컨테이너와 네트워크를 제거한다. AWS 인증이나 apply가 필요 없다.

공식 수신기 계약: https://grafana.com/docs/alloy/latest/reference/components/faro/faro.receiver/
