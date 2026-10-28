# dev 설치 경로 WAF 적용·검증·복구

기준은 ADR 0027과 PROJ-269다. 정확한 `/unix`, `/windows`와 기존 등록 API 세 조건이
출발지 IP별 300건/300초를 공유한다. bootstrap 두 조건은 URL_DECODE 한 번을 적용하여
`/%75nix`·`/%77indows` 같은 단일 인코딩 경로도 같은 예산에 넣고 나머지 예산에서 제외한다. `429`·`Retry-After: 60`은 재시도 안내이며 정확한 해제 시각은 아니다.

## 적용

1. 최신 `develop`에서 `npm run build`, `npm test -- --runInBand`, prod/dev/cicd synth를 실행한다.
2. 추적된 `config/dev/deployment.json`으로 합성하고 현재 DevEdgeStack 템플릿과 비교한다.
   WebACL의 등록·나머지 rate 범위에 두 URL_DECODE exact path가 이동한 것 외 변경이 있으면 먼저 원인을 확인한다.
3. 현재 EKS ALB ARN에 연결된 Web ACL과 관리형 버전 가용성을 읽고 합성 Rules의 `CheckCapacity`를 확인한다.
4. PR CI·필수 리뷰와 병합을 확인한 뒤 dev profile로 DevEdgeStack만 `--exclusively` 배포한다.
   다른 스택, prod, Helm 앱은 이 정책 변경의 배포 대상이 아니다.
5. 배포된 Web ACL의 `EnrollmentRateBlock`·`RemainingRateBlock`, association ARN을 다시 조회한다.

## 배포 전 경로 확인

2026-10-28 dev에 코드 없는 GET을 `curl --path-as-is`로 확인했다. `/unix`·`/%75nix`·`/u%6eix`,
`/windows`·`/%77indows`는 같은 bootstrap missing-code 400 응답이었다. `/unix/`·`/windows/`,
`/unix;foo`·`/windows;foo`, `//unix`·`/%2funix`·`/%2575nix`는 ALB 기본 404였다.
`/x/../unix`는 403, `/./unix`는 bootstrap과 다른 일반 Bad Request 400으로 거부되었다.
이 표본은 단일 URL_DECODE rate 보완의 근거이며 모든 URI 정규화의 동등성이나 배포 후 rate 차단 증거는 아니다.

## 실제 검증

- 사용자 승인된 dev 테스트 초대를 사용한다. 코드·토큰·query를 로그/증거/PR에 적지 않는다.
- 같은 출발지에서 `/unix`·`/windows`·`/api/v1/enroll`을 섞어 요청하되, 부하 생성에는 누락/무효 코드를
  사용한다. AWS 근사 판정 때문에 정확히 301번째 차단을 기대하지 않는다. 요청 횟수·시간·HTTP 상태·헤더만 남긴다.
- 429가 시작되면 세 경로와 인코딩 bootstrap 경로에서 `Retry-After: 60`을 확인한다. 차단 중 승인된
  유효 초대로 기존 enroll API를 한 번 호출하여 429와 같은 헤더를 확인한다. 요청 전후 DB를 읽어
  `used_at`·설치 수·멤버 상태가 변하지 않았음을 기록한다. 코드 원문은 출력하지 않는다.
- 다른 실제 출발지 IP(별도 dev 실행 위치)에서 정상 요청을 확인한다. 전달 헤더를 바꿔 다른 IP로 가장하지 않는다.
- 요청을 멈춘 뒤 회복을 확인한다. 공유 NAT의 정상 사용자 영향과 검증 시간대를 기록한다.
- 성공 증거에는 commit·PR·배포 시각·Web ACL ID·실제 요청 상태 요약·비소비 비교 결과를 남긴다.
  template assertion이나 WAF 로그의 COUNT만으로 실제 차단 완료를 표시하지 않는다.

## 복구

배포 전 DevEdgeStack 템플릿·배포 commit을 보관한다. backend DB 사전 검증(PROJ-268)을 이미 공개했다면
먼저 그 기능을 포함하지 않은 검증된 enrollment 이미지로 되돌린 뒤 이전 정책 commit의 DevEdgeStack만
동일 profile로 배포한다. ALB/association·나머지 정책을 삭제하거나 rate 규칙을 임시 비활성화하지 않는다.
배포 후 경로 분류·정상 요청·차단 회복을 재확인한다.
