# 0027. dev ALB에 경로별 Count 예외를 가진 WAF를 적용한다

## Status

Accepted (배포 증거 대기)

PROJ-159의 PROJ-197·198·199는 문서·CDK·테스트·환경별 synth까지 구현한다. 이 상태는
정책이 확정됐다는 뜻이며, AWS 배포·실제 차단·로그 전달·정상 요청 오탐 0건의 증거는 아니다.
기존 로그 그룹 정책용 ADR-0020 예약은 유지한다.

## Context

dev ALB는 정확한 OTLP 세 경로, `/api/v1` 앱 API, bootstrap·바이너리 다운로드와 ClickHouse
`:8123` 디버깅을 함께 제공한다. 일반 웹 공격·악성 IP·과도한 요청을 탐지하고 일부를 차단하면서
정상 OTLP와 SQL 디버깅은 보존해야 한다. ALB의 WAF 본문 검사 한도는 8KB이고, 정상 코드·프롬프트나
SQL도 공격 문자열과 겹칠 수 있다. WAF에서 본문 탐지가 없다는 사실만으로 JSON/protobuf·gzip
요청이 안전하다고 판단할 수 없다.

`Clarify PROJ-159 requirements`에서 최종 합의한 범위는 dev ALB만이며 ingest 전체를 Count로
두지 않는다. 국가·악성 IP·URI·헤더·query 공격은 ingest에도 Block을 유지하고, OTLP 본문과
ingest rate만 Count로 처리한다. 정상 개발자·CI의 VPN·공유 NAT, User-Agent가 없는 HTTP
클라이언트, 설치 파일명 때문에 생길 수 있는 오탐은 개별 예외로 좁힌다.

이 결정은 `infra`의 dev WAF 리소스·경로별 예외·탐지 로그에 한정한다. 앱의 인증·형식·크기 계약은
변경하지 않고 후속 검사가 필요함을 기록한다. PROJ-200의 [infra PR #18](https://github.com/soma-376/infra/pull/18)
(`8836ef9`)에 맞춰 앱 경로를 `/api/v1`로 이동하고 추가된 공개 앱 경로도 내용 검사에 포함한다.
prod WAF 전환, PR #18 외의 라우팅 추가, TLS 구성과 앱
검사 구현은 이번 범위에 없다.

## Decision

### 1. dev ALB 전체에 REGIONAL Web ACL을 연결한다

`DevEdgeStack`에 dev 전용 WAF construct를 만들고 기존 ALB에 Web ACL을 연결한다. 기본 동작은
Allow이며 명시한 Block 규칙만 요청 평가를 종료한다. 기존 listener·target group ID와 속성,
`:8123` 디버깅 listener, dev SG와 `devAllowedCidr`는 그대로 유지한다. 새 context 키는 추가하지 않는다.
WAF는 ALB를 통과하지 않는 RDS·ClickHouse 직접 접근을 보호하지 않는다.

URI 경로의 단일 정의를 ALB와 WAF가 공유한다. 아래의 앱 경로는 OTLP·등록·인증·관리·bootstrap의
합집합이며, 등록 rate 범위는 그중 등록·토큰·초대 세 조건에 한정한다.

| 분류 | URI 조건 | 내용 검사 본문 | 내용 검사 query |
|---|---|---|---|
| OTLP | `/v1/traces`, `/v1/metrics`, `/v1/logs` 정확히 일치 | Count | Block |
| 등록·토큰·초대 API | `/api/v1/enroll` 정확히 일치, `/api/v1/installations/` prefix, `/api/v1/invitations` prefix | Block | Block |
| 인증·manifest API | `/api/v1/auth/` prefix, `/api/v1/manifest` 정확히 일치 | Block | Block |
| 조직 관리·문의·업데이트 API | `/api/v1/organizations/` prefix, `/api/v1/inquiries`, `/api/v1/check-updates` 정확히 일치 | Block | Block |
| bootstrap·다운로드 | `/windows`, `/unix` 정확히 일치, `/bin/` prefix | Block | Block |
| 앱 경로 밖 | 위 조건의 부정, 일반 ClickHouse SQL 디버깅 포함 | Count | Count |

`/v1/traces/`, bare `/api/v1/installations`·`/api/v1/auth`·`/api/v1/organizations`·`/bin`은 앱
경로가 아니고, `/api/v1/invitations-old`는 ALB의 `/api/v1/invitations*`와 같이 앱 경로다.
exact 경로의 trailing slash·자식 경로와 `/api/v1/healthz`도 공개 앱 경로가 아니다.
구 `/v1/enroll`·`/v1/installations/*`·`/v1/invitations*`는 더 이상 앱 경로가 아니며,
`/api/v1/*` 전체 wildcard를 추가하지 않는다. OTLP는 `/api/v1`로 옮기지 않는다.

Web ACL은 두 listener 모두에 적용되며 실제 listener port를 조건으로 구분하지 않는다.
따라서 `:8123`에서도 앱과 같은 URI를 요청하면 앱 정책을 적용한다. 정상 SQL 본문·query의 Count는
앱 경로 밖에 한정하며 Host 헤더를 이용한 전면 Allow 예외는 만들지 않는다. 이는 다른 Block 규칙을
건너뛰어 앱 경로 차단을 우회하는 것을 막기 위한 결정이다.

### 2. 버전과 전역 예외를 명시한다

관리형 그룹의 vendor는 모두 `AWS`이며 그룹 `OverrideAction`은 `None`으로 둔다.

| 그룹 | 고정 버전 | 기본 정책과 예외 |
|---|---|---|
| `AWSManagedRulesCommonRuleSet` | `Version_1.23` | Block 기본, 아래 개별 Count와 경로별 label Block |
| `AWSManagedRulesKnownBadInputsRuleSet` | `Version_1.26` | Block 기본, 본문·query는 개별 Count와 경로별 label Block |
| `AWSManagedRulesSQLiRuleSet` | `Version_2.4` | Block 기본, 본문·query는 개별 Count와 경로별 label Block |
| `AWSManagedRulesAmazonIpReputationList` | 비버전 그룹 | 악성 IP Block, 정찰·DDoS 목록 Count |
| `AWSManagedRulesAnonymousIpList` | 비버전 그룹 | 두 목록 모두 Count |

세 내용 검사 그룹의 버전은 Count override 이름과 label 매핑의 변경을 통제하려고 고정한다.
IP 목록 그룹에는 버전 속성을 넣지 않으며 목록 자체는 AWS에서 계속 바뀐다. 공식 문서는 최신
static version을 설명하므로 서울 리전에서 사용할 고정 버전의 메타데이터와 동일하다는 증거는 아니다.
AWS 세션 만료로 `ap-northeast-2` 버전 가용성과 실제 룰 메타데이터는 미확인이다. 배포 전 읽기 API로
각 버전의 룰 이름과 label을 다시 확인한다.

**WAF 요청 로그에는 관리형 룰셋 버전이 직접 기록되지 않는다.** `formatVersion`은 로그 형식 버전이며
Common·KnownBadInputs·SQLi의 버전을 뜻하지 않는다. 요청 시각·`webaclId`·`ruleGroupId`·rule/label을
배포 당시 CDK 버전 고정값, 합성 템플릿, 해당 commit과 CloudFormation 배포 기록에 대조해야 한다.
현재 checkout의 값만으로 과거 요청의 정책 버전을 확정하지 않는다. 버전 갱신·만료 전에 override·label·
예외 범위를 함께 검증하고, 적용 commit과 배포 시점을 남긴다.

다음 규칙은 모든 경로에서 Count로 override하고 후속 label Block에 포함하지 않는다.

| 그룹 | 개별 Count 규칙 | 이유 |
|---|---|---|
| Common | `NoUserAgent_HEADER` | 개발용 HTTP 클라이언트 |
| Common | `SizeRestrictions_QUERYSTRING`, `SizeRestrictions_Cookie_HEADER`, `SizeRestrictions_BODY`, `SizeRestrictions_URIPATH` | 실제 앱 허용 크기와 정상 표본을 확인하기 전 오탐 관찰 |
| Amazon IP | `AWSManagedReconnaissanceList`, `AWSManagedIPDDoSList` | 의심 목록 관찰, DDoS 목록의 기본 Count 유지 |
| Anonymous IP | `AnonymousIPList`, `HostingProviderIPList` | 정상 VPN·프록시·CI·호스팅 출발지 오탐 고려 |

`AWSManagedIPReputationList`는 기본 Block을 유지한다. 사용자 정의 `GeoMatch`는 출발지 IP의 국가가
`CN`, `RU`, `KP`, `IR`이면 모든 경로에서 Block한다. 국가 목록은 접근 정책이며 악성 IP 여부는 별도
IP 평판 규칙이 판단한다. Cookie를 포함한 헤더·URI 내용 검사는 위 크기·User-Agent·확장자 예외를
제외하면 기본 Block을 유지한다.

### 3. 개별 Count override 뒤 정확한 label로 경로별 Block을 적용한다

본문 9개와 query 9개 규칙을 `RuleActionOverrides`로 각각 Count로 둔다. 전체 그룹을 Count로
override하지 않는다. Count는 평가를 계속하므로 같은 요청에서 국가·악성 IP·URI·헤더나 다른 Block
규칙이 매칭되면 차단될 수 있다. 국가 규칙을 먼저 평가하므로 해당 요청은 본문 Count 로그 없이
먼저 차단될 수도 있다. ingest가 모든 보안 검사에서 제외되는 것은 아니다.

아래 label은 `LabelMatchStatement`의 `Scope: LABEL`과 전체 key의 정확한 일치를 사용한다.
namespace 전체를 Block하지 않는다.

| 그룹 | 본문 규칙 | 정확한 label key |
|---|---|---|
| Common | `EC2MetaDataSSRF_BODY` | `awswaf:managed:aws:core-rule-set:EC2MetaDataSSRF_Body` |
| Common | `GenericLFI_BODY` | `awswaf:managed:aws:core-rule-set:GenericLFI_Body` |
| Common | `GenericRFI_BODY` | `awswaf:managed:aws:core-rule-set:GenericRFI_Body` |
| Common | `CrossSiteScripting_BODY` | `awswaf:managed:aws:core-rule-set:CrossSiteScripting_Body` |
| KnownBadInputs | `JavaDeserializationRCE_BODY` | `awswaf:managed:aws:known-bad-inputs:JavaDeserializationRCE_Body` |
| KnownBadInputs | `Log4JRCE_BODY` | `awswaf:managed:aws:known-bad-inputs:Log4JRCE_Body` |
| KnownBadInputs | `ReactJSRCE_BODY` | `awswaf:managed:aws:known-bad-inputs:ReactJSRCE_Body` |
| SQLi | `SQLi_BODY` | `awswaf:managed:aws:sql-database:SQLi_Body` |
| SQLi | `SQLiExtendedPatterns_BODY` | `awswaf:managed:aws:sql-database:SQLiExtendedPatterns_Body` |

본문 label Block의 조건은 **본문 label 중 하나 AND 앱 경로 AND NOT 정확한 OTLP 세 경로**다.
앱 경로 밖의 SQL 디버깅과 정확한 OTLP 본문을 후속 규칙에서 다시 차단하지 않는다.

| 그룹 | query 규칙 | 정확한 label key |
|---|---|---|
| Common | `EC2MetaDataSSRF_QUERYARGUMENTS` | `awswaf:managed:aws:core-rule-set:EC2MetaDataSSRF_QueryArguments` |
| Common | `GenericLFI_QUERYARGUMENTS` | `awswaf:managed:aws:core-rule-set:GenericLFI_QueryArguments` |
| Common | `RestrictedExtensions_QUERYARGUMENTS` | `awswaf:managed:aws:core-rule-set:RestrictedExtensions_QueryArguments` |
| Common | `GenericRFI_QUERYARGUMENTS` | `awswaf:managed:aws:core-rule-set:GenericRFI_QueryArguments` |
| Common | `CrossSiteScripting_QUERYARGUMENTS` | `awswaf:managed:aws:core-rule-set:CrossSiteScripting_QueryArguments` |
| KnownBadInputs | `JavaDeserializationRCE_QUERYSTRING` | `awswaf:managed:aws:known-bad-inputs:JavaDeserializationRCE_QueryString` |
| KnownBadInputs | `Log4JRCE_QUERYSTRING` | `awswaf:managed:aws:known-bad-inputs:Log4JRCE_QueryString` |
| SQLi | `SQLi_QUERYARGUMENTS` | `awswaf:managed:aws:sql-database:SQLi_QueryArguments` |
| SQLi | `SQLiExtendedPatterns_QUERYARGUMENTS` | `awswaf:managed:aws:sql-database:SQLiExtendedPatterns_QueryArguments` |

query label Block의 조건은 **query label 중 하나 AND 앱 경로**다. query는 정확한 OTLP 경로에서도
Block하고 앱 경로 밖에서만 Count로 둔다.

`RestrictedExtensions_URIPATH`도 개별 Count로 override한 뒤 label
`awswaf:managed:aws:core-rule-set:RestrictedExtensions_URIPath`가 매칭되고 **NOT `/bin/` prefix**일 때
Block한다. 정상 `/bin/file.exe`의 파일명 보호를 위한 해당 룰만의 예외이며 `/other/file.exe`에는
예외가 없다. `/bin/*`의 다른 URI·헤더·query 공격이나 rate 제한은 계속 적용한다.

정확한 OTLP 본문을 Count로 두더라도 앱에서 **인증, 압축 전후 크기 제한, 압축 해제,
JSON/protobuf 파싱, OTLP 구조 검증**을 수행해야 한다. ALB의 8KB 검사 한도와 gzip/protobuf의
표현 특성 때문에 WAF는 이 검사를 대신하지 못한다. 이 ADR은 앱의 기존 검사 구현 완료나 안전성을
증명하지 않고, 앱 후속 확인·보강을 별도 책임으로 남긴다.

### 4. rate는 출발지 IP별 세 그룹으로 합산한다

각 규칙은 `AggregateKeyType: IP`, 평가 구간 300초를 사용한다. `X-Forwarded-For`를 신뢰하는
별도 aggregation은 추가하지 않는다.

| 대상 | IP별 300초 제한 | 초과 동작 | 초기값의 의도 |
|---|---:|---|---|
| 정확한 OTLP 세 경로 | 10,000건 | Count | 배치·재시도·공유 NAT의 burst 관찰 |
| 등록·토큰·초대 API 세 조건 | 300건 | Block, HTTP 429 | 기존 세 경로의 범위를 `/api/v1`로 이동해 저빈도 API의 반복 호출 제한 |
| 나머지, 인증·manifest·조직 관리·문의·업데이트·bootstrap·다운로드·디버깅 포함 | 1,000건 | Block, HTTP 429 | 여러 설치 GET·재시도·같은 NAT의 동시 설치에 여유 제공 |

세 숫자는 실측값이나 AWS 권장값이 아닌 **dev 초기 가설**이다. bootstrap·다운로드·SQL 디버깅처럼
서로 다른 특성의 요청을 함께 합산하는 한계가 있다. 요청 건수는 다운로드 바이트·전송 비용·SQL
쿼리 복잡도를 제한하지 않는다. 공유 NAT 뒤의
정상 요청도 같은 IP로 합산될 수 있으므로 실트래픽으로 재검토한다. 추가된 인증·조회·관리 경로를
등록 300건 범위에 합산하지 않으며 별도 대시보드 조회 2,000건 후보도 채택하지 않는다.
새 앱 경로의 본문/query Block과 rate 1,000건은 서로 다른 조건이며, 앱이라는 이유만으로
등록 rate를 적용하지 않는다.

Block rate 응답은 HTTP 429와 `Retry-After: 60`을 사용해 인증 실패와 요청량 초과를 구분한다.
rate 제한은 근사적으로 동작하므로 60초는 재시도 안내이며 정확한 차단 해제 시각을 보장하지 않는다.
CLI 전체의 429 자동 재시도를 전제로 하지 않는다. `telemetryctl/internal/forward/retry.go`의
`classify()`는 OTLP 전송의 401·403을 인증 처리, 429를 재시도로 분류하고 `parseRetryAfter()`는
서버 안내를 재시도 최대 대기 시간으로 제한한다. 이 동작은 OTLP forwarder 범위이며 enrollment·
bootstrap 등 모든 CLI HTTP 요청의 자동 재시도를 뜻하지 않는다.

평가 순서는 국가 → Amazon IP·Anonymous IP 그룹 → 세 rate 규칙 → Common·KnownBadInputs·SQLi
그룹 → 본문·query·확장자 label Block으로 고정한다. Count는 이후 규칙 평가를 계속하고 Block은 종료한다.

### 5. Count·Block 로그만 남기고 민감 필드를 마스킹한다

| 항목 | 결정 |
|---|---|
| 저장소·이름 | CloudWatch Logs, `aws-waf-logs-soma-376-dev` |
| 보존·삭제·암호화 | 14일, `RemovalPolicy.DESTROY`, CloudWatch Logs 기본 암호화 |
| 로그 필터 | 기본 DROP, `BLOCK`·`COUNT`·`EXCLUDED_AS_COUNT` 중 하나가 매칭되면 KEEP |
| 마스킹 | Authorization·Cookie·X-Admin-Token, 전체 query string |
| 요청 샘플링 | Web ACL과 모든 사용자 정의 규칙에서 비활성화 |
| 지표 | CloudWatch metrics 활성화 |

최종 action이 Allow여도 개별 Count override가 탐지한 요청은 남긴다. 관리형 Count override가
필터에서 빠지지 않도록 `EXCLUDED_AS_COUNT`를 포함한다. 어떤 탐지도 없는 일반 Allow 요청은 저장하지 않는다.

`LoggingConfiguration.RedactedFields`에 세 `SingleHeader`와 `QueryString`을 설정한다.
동시에 Web ACL `DataProtectionConfig`에는 `SINGLE_HEADER`의 지정 header keys와 `QUERY_STRING`을
`SUBSTITUTION`으로 설정하고 `ExcludeRuleMatchDetails`·`ExcludeRateBasedDetails`를 모두 false로
명시해 해당 필드의 match/rate 상세도 보호한다. 전체 query 보호에는 `FieldKeys`를 넣지 않는다.
로그 redaction과 요청 sampling은 별도 설정이므로 redaction만으로 샘플이 보호된다고 가정하지 않는다.
실제 로그 전달·민감 필드 비노출은 배포 후 합성 설정과 별도로 확인한다.

## Constraints

- ALB 본문 검사 한도 8KB와 실제 listener port를 직접 분리할 수 없는 제약을 수용한다.
- 내용 기반 Count 예외는 인증·크기·파싱의 대체 수단이 아니다. URI·헤더·query의 Block과 국가/IP
  차단은 해당 예외와 독립적으로 유지한다.
- `prod → common`, `dev → common`, `cicd → common` import 경계를 지키고 prod·cicd 정책을 바꾸지 않는다.
- 서울 리전 API 조회가 완료되기 전에는 고정 버전 가용성·룰 존재·label 정합성을 배포 가능 증거로 주장하지 않는다.

## Alternatives Considered

### A. ingest 전체와 관리형 그룹 전체를 Count로 둔다

- 장점: 정상 수집을 차단할 위험이 작다.
- 단점: 국가·악성 IP·URI·헤더 공격까지 탐지 전용이 되고, 그룹 반환 action만 바꾸면 개별 평가가
  원래 terminating rule에서 멈출 수 있다.
- 탈락 이유: ingest도 일반 보안 규칙에서 차단한다는 최종 합의에 맞지 않는다.

### B. 모든 내용 검사에 기본 Block을 적용한다

- 장점: 정책과 예외가 단순하다.
- 단점: 정상 OTLP·코드·프롬프트·디버깅 SQL·다운로드 파일명을 차단할 수 있다.
- 탈락 이유: 오탐 우려를 Count로 관찰하는 dev 목표에 맞지 않는다.

### C. Host 헤더의 `:8123` 또는 앱 경로로 전면 Allow한다

- 장점: 디버깅·수집 요청을 쉽게 통과시킨다.
- 단점: 클라이언트가 조작할 수 있는 Host나 경로만으로 국가/IP·헤더 검사까지 건너뛸 수 있다.
- 탈락 이유: 필요한 개별 검사만 Count로 바꾸는 방식으로 정상 요청을 보존한다.

### D. 관리형 그룹의 default version을 사용한다

- 장점: 버전 갱신 작업이 줄어든다.
- 단점: 룰 이름·label·탐지 변경이 배포 commit과 무관하게 들어오며 요청 로그에 버전 전용 필드가 없다.
- 탈락 이유: 개별 override와 후속 exact-label 정책을 검토 가능한 고정값으로 관리한다.

## Consequences/Tradeoffs

### Positive

- 국가·악성 IP·일반 웹 공격 차단을 ingest에도 유지하면서 정상 본문·SQL의 오탐을 관찰할 수 있다.
- 경로 정의를 ALB와 공유하고 override·label·버전을 함께 검증해 정책 drift를 줄인다.
- 탐지 로그만 14일 보존하고 지정 민감 필드와 match 상세를 마스킹해 로그 양과 노출을 줄인다.

### Negative

- 본문 Count·디버깅 query Count는 공격을 직접 차단하지 않으므로 앱 검증과 운영 관찰이 필요하다.
- WAF는 ALB 전체에 적용되고 URI로 분류하므로 `:8123`에서 앱 URI를 사용하면 앱 정책의 영향을 받는다.
- rate 초기값과 국가/IP 분류가 정상 개발자·공유 NAT 요청을 차단할 수 있으며 0건 오탐을 아직 증명하지 못한다.
- 버전 고정은 업데이트·만료 대응과 배포 기록 관리 부담을 만든다. 비버전 IP 목록의 변경은 고정할 수 없다.
- Allow 전체 로그를 남기지 않아 전체 트래픽 분석은 앱·ALB 지표와 함께 해야 한다. DESTROY는 스택 삭제 시
  탐지 이력을 잃으므로 운영 전환 때 보존·감사 정책을 다시 결정해야 한다.

## Follow-up

- 배포 전 `ListAvailableManagedRuleGroupVersions`·버전을 지정한 `DescribeManagedRuleGroup`으로 서울 리전
  가용성·룰·label·만료 조건을 확인한다. 문서의 최신 버전 표를 API 확인의 대체 증거로 쓰지 않는다.
- 인프라 배포 principal의 `wafv2:PutLoggingConfiguration` 및 CloudWatch Logs delivery·resource policy
  생성/조회 권한을 확인한다. 로그 설정 성공 시 WAF가 CloudWatch Logs resource policy를 구성하므로
  실제 전달도 확인한다. 이 권한은 앱 레포의 GitHub 배포 역할에 추가하지 않는다.
- 관리형 버전 갱신·만료 전에 18개 본문/query override와 확장자 label, 전역 Count 예외를 재검증하고
  commit·합성 템플릿·배포 시각을 함께 기록한다. 만료로 default 전환이 발생할 수 있으므로 배포 당시
  고정값만으로 만료 이후 평가 버전을 단정하지 않는다.
- 앱 팀과 인증·압축 전후 크기·해제·JSON/protobuf·OTLP 구조 검증의 현행 범위와 보강 필요를 확인한다.
- dev 배포 후 정상 수집·enrollment·bootstrap·설치 파일·SQL 디버깅 표본과 공유 NAT 요청으로 오탐을
  확인한다. 목표는 정상 요청 오탐 차단 0건이며 관찰 기간·대표 트래픽·담당자는 별도 확정한다.
- 실제 국가/IP·내용·rate 차단과 429 응답, Count 로그·전달·마스킹, 필요한 정책 복구를 확인한다.
- 비용·로그 접근·장기 감사·운영 보존은 예약 ADR-0020 및 prod 전환 결정에서 다시 다룬다.

## Acceptance Criteria

로컬 완료 증거는 다음으로 한정한다.

- ADR·인덱스·AGENTS·코드 주석이 범위·버전 로그·경로·예외·rate·응답·로그 정책에서 일치한다.
- 기존 `buildDevApp()` fixture의 template assertion으로 dev ALB association, 기본 Allow, 고정 버전,
  국가·override·exact-label 조건, IP별 rate·429, 로그·마스킹·샘플링을 검증한다. snapshot은 추가하지 않는다.
- 정상 요청 조건, OTLP 본문 Count, 국가·악성 IP Block, 앱 본문/query Block, SQL 디버깅 Count,
  `/bin/file.exe` 예외·`/other/file.exe` Block과 trailing slash·prefix 경계를 합성 정책에서 검증한다.
- 전체 `npm test`, `npm run build`, prod A/B·dev·cicd synth가 통과하고 기존 템플릿 대비 변경은
  dev WAF·로그 리소스에 한정된다. 기존 ALB listener·target group·다른 환경 리소스는 동일하다.

이 검증은 AWS의 실제 탐지 signature 실행, 리전 버전 수용, 실제 차단·로그 전달·오탐 0건을 증명하지 않는다.

## References

- [PROJ-159](https://team376.atlassian.net/browse/PROJ-159), [PROJ-197](https://team376.atlassian.net/browse/PROJ-197), [PROJ-198](https://team376.atlassian.net/browse/PROJ-198), [PROJ-199](https://team376.atlassian.net/browse/PROJ-199)
- `Clarify PROJ-159 requirements`의 최종 규칙안·ingest 예외 정정·rate 초기값 설명
- [ADR 0022](0022-dev-infrastructure-topology.md), [ADR 0026](0026-dev-backend-deployment-units-and-staged-migration.md)
- [PROJ-200 infra PR #18](https://github.com/soma-376/infra/pull/18), 기준 commit `8836ef9`의 `DevEdgeStack` 라우팅과 health check
- [AWS 관리형 기본 규칙·label](https://docs.aws.amazon.com/waf/latest/developerguide/aws-managed-rule-groups-baseline.html), [SQLi 규칙·label](https://docs.aws.amazon.com/waf/latest/developerguide/aws-managed-rule-groups-use-case.html), [IP 목록](https://docs.aws.amazon.com/waf/latest/developerguide/aws-managed-rule-groups-ip-rep.html)
- [관리형 버전 변경 이력](https://docs.aws.amazon.com/waf/latest/developerguide/aws-managed-rule-groups-changelog.html), [버전 관리](https://docs.aws.amazon.com/waf/latest/developerguide/waf-managed-rule-groups-versioning.html), [개별 action override](https://docs.aws.amazon.com/waf/latest/developerguide/web-acl-rule-group-override-options.html)
- [ALB 본문 검사 한도](https://docs.aws.amazon.com/waf/latest/developerguide/web-acl-setting-body-inspection-limit.html), [Rate 기준](https://docs.aws.amazon.com/waf/latest/developerguide/waf-rule-statement-type-rate-based-high-level-settings.html)
- [WAF 로그 필드](https://docs.aws.amazon.com/waf/latest/developerguide/logging-fields.html), [ActionCondition](https://docs.aws.amazon.com/waf/latest/APIReference/API_ActionCondition.html), [로그 마스킹·샘플링](https://docs.aws.amazon.com/waf/latest/developerguide/logging.html)
- [CloudWatch Logs 목적지·배포 권한](https://docs.aws.amazon.com/waf/latest/developerguide/logging-cw-logs.html), [PutLoggingConfiguration](https://docs.aws.amazon.com/waf/latest/APIReference/API_PutLoggingConfiguration.html)
- [DataProtectionConfig](https://docs.aws.amazon.com/waf/latest/APIReference/API_DataProtectionConfig.html), [DataProtection](https://docs.aws.amazon.com/waf/latest/APIReference/API_DataProtection.html), [FieldToProtect](https://docs.aws.amazon.com/waf/latest/APIReference/API_FieldToProtect.html)
