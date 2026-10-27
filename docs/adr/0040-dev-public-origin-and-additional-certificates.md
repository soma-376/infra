# 0040. dev 공개 origin과 추가 인증서를 배포 입력으로 보존한다

## Status

Accepted — ADR-0033의 공개 URL·output·values 생성기 미변경 결정을 부분 대체한다. DNS·ACM 외부 소유, 기존 listener·라우팅 식별자와 환경 경계는 유지한다.

## Context

dev의 새 프론트와 API 도메인을 런타임에만 적용하면 다음 values 생성과 Helm 배포에서
`PULSEMETRY_PUBLIC_BASE_URL`이 HTTP ALB DNS로 돌아간다. ALB에 수동 추가한 SNI 인증서도
기존 단일 인증서 context에 표현되지 않는다. 프론트의 브라우저 빌드 주소와 BFF 런타임 주소는
서로 다른 입력이므로 한쪽만 전환하면 로그인 왕복이 서로 다른 도메인을 사용한다.

## Decision

- 선택적 `devEksPublicBaseUrl`은 경로·인증정보·query·fragment·명시적 port가 없는 HTTPS origin이다.
  기본 인증서 입력이 있을 때만 허용한다. 명시한 값을 기존 `ValidationPublicBaseUrl` output과
  enrollment의 공개 URL에 전달한다. 생략 시 기존 `http://<ALB DNS>`를 유지한다.
- `devEksAdditionalCertificateArns`는 배열 또는 JSON 배열 문자열이며, 생략하면 빈 목록이다.
  기존 `devEksCertificateArn`을 기본 인증서로 유지하고 추가 항목은 SNI 인증서로 선언한다.
  서울 리전·배포 계정·ARN 형식·중복·기본 인증서와 중복·기본 인증서 없는 추가 입력을 검증한다.
  목록 재정렬로 리소스가 교체되지 않도록 인증서 ARN에 기반한 식별자를 사용한다.
- 이미 배포된 추가 인증서가 다른 logical ID를 사용하는 경우 `devEksAdditionalCertificateLogicalIds`의
  ARN→logical ID 맵으로 그 식별자를 보존한다. 키는 추가 인증서 목록의 부분집합이며 값은 서로 다른
  유효한 CloudFormation logical ID다. 새 연결에는 기본 ARN 해시 ID를 사용한다. 기존 연결의 제거와
  동일 인증서 재등록을 같은 배포에서 수행하지 않는다.
- dev API origin은 `https://api-dev.pulsemetry.co.kr`, 프론트 origin은 `https://dev.pulsemetry.co.kr`이다.
  OIDC callback base·실패 복귀·허용 origin·허용 redirect는 기존 runtime 입력을 사용한다.
  CORS는 enrollment와 dashboard에, 나머지 OIDC 설정은 enrollment에만 전달한다.
- 사용자 JWT issuer는 접근 주소가 아니므로 보존한다. JWT/BFF 키·Secret 버전·기존 localhost 허용값도 보존한다.
  Cognito의 callback 등록은 실제 dev client 관리 주체가 소유하며 새 IdP나 계정을 만들지 않는다.
- 프론트 Terraform은 dev 도메인·기존 인증서 참조·BFF API 주소를 소유한다. 브라우저 공개 API 주소는
  기존 GitHub dev 환경의 빌드 입력이다. prod와 애플리케이션 API 계약은 변경하지 않는다.
- 배포 입력은 현재 release·Deployment와 대조한다. 기존 DB TLS·수집 모드·tracing·이미지·키의
  차이를 도메인 변경에 섞지 않는다. generated 파일만 수정한 상태를 재현 가능한 배포 원본으로 취급하지 않는다.
- `config/dev/deployment.json`은 공개 API·프론트 origin, 인증서 UUID·기존 logical ID와 전체 dev context를,
  같은 디렉터리의 `runtime.yaml`은 비밀 없는 앱 설정과 고정 Secret VersionId를 소유한다.
  실제 계정 ID·Secret 원문·AWS 조회 결과·이미지 digest·개인 보고서 경로는 저장하지 않는다.
  인증서 ARN은 실행 환경의 `CDK_DEFAULT_ACCOUNT`와 서울 리전으로 조립한다. ADR-0030의 계정·Secret 공개 제한은 유지한다.
- 공식 `synth:dev`·`diff:dev`·`deploy:dev`와 수동 런북은 `devDeploymentProfile`을 명시하여
  추적 입력을 자동 선택한다. 기존 context가 같은 값을 명시하면 허용하고, profile과 충돌하면 실패한다.
  profile 없는 저수준 CDK/API의 기존 HTTP fallback은 유지한다. profile 경로는 저장소 기준이다.
- `values:dev`는 같은 profile을 `--deployment-profile`로 선택하고 그 runtime을 기본으로 읽는다.
  출력의 공개 URL, OIDC callback base, 실패 복귀, 프론트 origin·redirect 허용 목록을 profile과 대조한다.
  명시한 다른 runtime 파일도 이 검사를 통과해야 한다. 이미지 digest·배포 output·MSK 조회 결과는 계속 명시 입력이다.
- 선택적 `postgresSslMode.enrollment/ingest`는 `require`만 허용하며 해당 JDBC URL에 `sslmode=require`를 붙인다.
  실제 dev 입력에는 두 값을 저장한다. 생략한 기존 runtime의 URL 생성과 dashboard URL은 유지한다.
- 추적 원본과 workload base만으로 현행 manifest를 재현한다. 도메인 배포를 위해 별도의 로컬 override를
  요구하지 않는다. runtime 버전 참조 갱신은 변경 검토·실제 Secret 버전 보존 확인과 함께 수행한다.

## Constraints

ARN 검증은 인증서 상태·SAN·DNS 정합을 보장하지 않는다. 실제 연결은 배포 전후 별도로 확인한다.
프론트 새 origin에는 기존 origin의 세션 쿠키가 이전되지 않으므로 새 로그인이 필요하다.

## Alternatives Considered

- 수동 Pod 환경변수와 ALB 인증서만 유지: 다음 배포에 사라져 채택하지 않는다.
- 기존 기본 인증서 교체: 이전 hostname의 TLS 호환을 잃을 수 있어 추가 SNI를 사용한다.
- DNS·ACM 발급을 새로 관리: 소유권 이전은 이 작업 범위를 넘으므로 기존 외부 관리를 유지한다.

## Consequences/Tradeoffs

### Positive

- 공개 URL과 인증서를 배포 원본에서 재현하며 기존 도메인 TLS를 함께 유지한다.
- 인증 로직과 토큰 신뢰 식별자를 바꾸지 않고 접근 도메인을 전환한다.

### Negative

- CDK context, runtime 입력, 프론트 Terraform, 빌드 변수와 Cognito 등록을 함께 확인해야 한다.
- live override가 생성 입력에 빠져 있으면 적용을 멈추고 원본을 복원해야 한다.
- 비밀 없는 버전 참조도 저장소에서 관리하므로 실제 키·client 버전 변경 시 runtime 입력을 함께 갱신해야 한다.

## Acceptance Criteria

- HTTPS 공개 URL과 추가 인증서의 합성·생성·Helm 전달, 입력 오류와 기존 HTTP fallback을 검증한다.
- 기존 ALB/listener/TG/WAF/규칙 ID 및 다른 환경 템플릿을 보존한다.
- 공식 dev 명령과 fixture 기반 PR 검사로 profile 연결·충돌 거부·Secret 버전·TLS·tracing 보존을 검증한다.
- 실제 dev 로그인·실패 복귀·세션 갱신·로그아웃과 재배포 후 설정 유지를 별도 증거로 남긴다.

## References

- [PROJ-261](https://team376.atlassian.net/browse/PROJ-261)
- [ADR-0033](0033-dev-alb-https-with-external-acm.md)
- [dev 도메인 전환 런북](../runbooks/dev-domain-migration.md)
