# 0017. Collector config를 env provider로 주입

## Status

Accepted

## Context

`ApplicationStack`의 `otel-collector` 컨테이너는 **config를 전혀 주입받지 않는 상태**였다.
`command`도 `environment`도 `secrets`도 없었고, 볼륨 마운트도 없었다. 그 결과 컨테이너는
이미지에 내장된 기본 config(`/etc/otelcol-contrib/config.yaml` — OTLP 수신 후 `debug` exporter로 출력)로
기동한다. 들어온 텔레메트리를 stdout에 찍고 버리는 셈이고, 같은 태스크에 co-locate된
`post-processor`([ADR-0004](0004-task-level-colocation.md))로는 아무것도 넘어가지 않는다.

MVP가 목표로 하는 파이프라인은 기본 config로는 만들 수 없다.

- 실시간 정규화 스트림 (OTLP → `post-processor`)
- 제품별(`codex_cli_rs` / `claude-code`) 원본 아카이브 분리 — `filter` processor의 OTTL 조건
- 시크릿 마스킹 — `redaction` processor의 `blocked_values` 정규식

셋 다 contrib 배포판 전용 컴포넌트에 의존한다. 따라서 커스텀 config를 **어떤 경로로 컨테이너에
넣을 것인가**가 선행 결정이며, 이 ADR이 그 결정을 기록한다.

이 결정을 지금 내리는 이유는, config 주입 경로가 한 번 정해지면 이후 config 변경의 운영 방식
(누가·어디서·무엇을 배포해야 바뀌는가)이 전부 거기에 묶이기 때문이다.

## Decision

레포에 `config/otel-collector.yaml`을 두고, **synth 시점에 파일을 읽어 컨테이너
환경변수 `OTEL_CONFIG`로 넣고 `--config=env:OTEL_CONFIG`로 기동한다.**

```ts
const collectorConfig = readFileSync(
  join(__dirname, '..', 'config', 'otel-collector.yaml'), 'utf8',
);

task.addContainer('otel-collector', {
  command: ['--config=env:OTEL_CONFIG'],
  environment: { OTEL_CONFIG: collectorConfig },
  // ...
});
```

`env:`는 Collector가 공식 지원하는 config provider다. `--config`는 `file:`, `env:`, `yaml:`,
`http:`, `https:` 스킴을 받으며, `env:`는 지정한 환경변수의 **내용 전체**를 config 본문으로 읽는다.
ECS의 `command`는 Docker `CMD`를 대체하고 `ENTRYPOINT`(`/otelcol-contrib`)는 유지되므로,
최종 실행 커맨드는 `/otelcol-contrib --config=env:OTEL_CONFIG`가 된다.

근거는 세 가지다.

**1. 새 AWS 리소스·IAM·빌드 파이프라인이 전혀 필요 없다**

SSM 파라미터도, ECR 레포도, Docker 빌드도, 실행 역할 권한 추가도 없다. 이 레포에는
**빌드/테스트 CI가 없다**(AGENTS.md 섹션 H). 이미지 빌드를 전제하는 방식은 팀원 전원에게
`docker buildx` arm64 환경을 요구하게 되는데, 그 비용을 config 주입 하나 때문에 치를 이유가 없다.

**2. config가 진짜 `.yaml` 파일로 남는다**

에디터 하이라이팅, YAML 린트, PR 리뷰의 라인 단위 diff가 전부 정상 동작한다.
TS 문자열 리터럴로 박아넣거나 이미지 안에 숨기는 것과 비교했을 때의 실질적 차이다.

**3. config 변경이 `cdk diff`에 그대로 드러난다**

config는 이 시스템의 데이터 처리 규칙 그 자체(무엇을 마스킹하고, 무엇을 어디로 보내는가)다.
인프라 변경 리뷰 흐름 안에 남는 편이 낫다.

## Constraints

- **신원 전파 3요소는 드리프트 금지 항목이다.** receiver 의 `include_metadata: true`,
  `headers_setter/pulsemetry_tenant` 확장(`x-pulsemetry-*` 4종), `batch.metadata_keys` 4종은
  auth-proxy 신원 헤더 전파의 전제이며([ADR-0023](0023-dev-auth-proxy-between-alb-and-collector.md),
  허브 `../docs/contracts/telemetry-ingest.md` §4), 하나만 빠져도 헤더가 소실되어 ClickHouse 의
  `tenant_id`·`installation_id` 가 빈 문자열이 된다. 이 셋은 이 레포 `config/otel-collector.yaml` 과
  `ai-telemetry-pipeline/otel-collector-config.yaml` **두 파일에서 반드시 같은 값이어야 하며 함께
  바꾼다.** 실제로 한쪽만 바뀌어 드리프트가 발생한 이력이 있고(허브 §5 B4, PROJ-77 로 복구)
  자동 검증 장치는 없다 — 세 요소가 다시 갈라진 사실이 발견되면 그때 감지 장치를 재검토한다.
  collector 가 `pulsemetry-backend` 로 이관되면(backend ADR-0007) 이 항목의 소유가 함께 이동한다.
- **config에 시크릿을 넣을 수 없다.** 값이 CloudFormation 템플릿과 ECS 콘솔에 평문으로 남는다.
  현재 config는 마스킹 *패턴*만 담고 실제 자격증명은 담지 않으므로 해당 없다.
  시크릿이 필요해지면 그 항목만 `secrets`로 분리하고 config에서 `${env:...}`로 참조한다.
- **태스크 정의 전체가 64 KiB를 넘을 수 없다.** 현재 config는 8,890 바이트다
  (PROJ-57·PROJ-77 로 증가. 자주 바뀌는 값이므로 `wc -c config/otel-collector.yaml` 로 확인한다).
  `CollectorTask` 정의 전체는 여전히 한도 대비 여유가 크다.
- **`$` 이스케이프**: confmap이 config 안의 `${...}`와 `$VAR`를 확장한다. 리터럴 `$`가 필요하면
  `$$`로 써야 한다. 현재 정규식에는 `$`가 없다.
- **이 이미지에는 비root가 쓸 수 있는 디렉터리가 없다.**
  `otel/opentelemetry-collector-contrib`는 `User=10001:10001`로 돌고, scratch 기반이라
  `/tmp`조차 존재하지 않는다. 따라서 `file/*` exporter가 `/data`를 만들려면 루트 파일시스템에
  써야 하고, UID 10001로는 불가능하다. **file exporter를 쓰는 한 `user: '0'`이 필수다.**
  이 제약은 최초 배포에서 `mkdir /data: permission denied` (exit 1)로 드러났다. 실측 결과:

  | 시도 | 결과 |
  |---|---|
  | 기본 유저 | `mkdir /data: permission denied` |
  | 경로를 `/tmp/...`로 | `mkdir /tmp: permission denied` (`/tmp`가 없다) |
  | `/data`에 빈 볼륨 마운트 | `mkdir /data/claude_code: permission denied` (볼륨이 root 소유) |
  | `--user 0:0` | 정상 기동 |

  로컬 `docker-compose.dev.yml`에서 문제가 없었던 이유는 bind mount가 `./data/codex`와
  `./data/claude_code`를 미리 만들어 주기 때문이다. Fargate에는 그 bind mount가 없다.

## Alternatives Considered

- **SSM Parameter Store + ECS `secrets`**: `cdk deploy` 없이 파라미터 값만 고치고
  `force-new-deployment`로 교체할 수 있다는 점이 유일하고 실질적인 장점이다. 그러나 값 크기 한도가
  Standard 4 KB / Advanced 8 KB(유료)인데 현재 config가 6.4 KB다. Standard에는 아예 못 들어가고,
  Advanced에 넣더라도 남는 여유가 1.6 KB뿐이라 마스킹 패턴 몇 개만 늘어도 한도에 닿는다.
  **(그리고 실제로 닿았다 — 현재 8,890 바이트로 Advanced 한도 8,192 바이트를 이미 초과해 이 대안은 더 이상 성립하지 않는다.)**
  또한 IaC의 값과 실제 값이 갈라지는 drift가 생기고, 다음 `cdk deploy`가 손수정을 덮어쓴다.
  MVP 단계에서 이 운영 유연성이 그 대가만큼 급하지 않다.
- **커스텀 이미지에 `COPY config.yaml`**: 불변성이 가장 높고 프로덕션에서 가장 흔한 방식이다.
  다만 이 레포에 빌드 CI가 없고, [ADR-0007](0007-precreate-ecr-outside-cdk.md)이
  "OTel Collector와 ClickHouse는 공식 이미지를 쓰므로 ECR 대상에서 제외"라고 명시하고 있어
  새 ECR 레포 생성과 함께 ADR-0007 개정이 필요하다. config 한 줄 고치는 데 빌드 → push →
  `force-new-deployment` 루프를 돌아야 하는 것도 MVP 속도에 맞지 않는다.
- **S3 + init 사이드카 + 공유 볼륨**: 재배포 없이 교체 가능하고 크기 제한도 없다. 대신 사이드카
  컨테이너, 태스크 볼륨, `dependsOn` 순서, S3 IAM까지 부품이 가장 많다. S3 객체가 낡아도 아무도
  모르는 조용한 실패 표면이 크다. MVP엔 과하다.
- **ADOT 이미지 + `AOT_CONFIG_CONTENT`**: AWS 배포판은 엔트리포인트가 환경변수 내용을 파일로
  써 주므로 형태가 비슷하다. 그러나 이미지를 교체해야 하고, contrib 전용인 `redaction`과
  `filter`의 OTTL 컴포넌트를 잃는다. 우리 config가 정확히 그 둘에 의존하므로 기각한다.

## Consequences/Tradeoffs

### Positive

- **`post-processor`로 보내는 endpoint는 `localhost`다.** Fargate는 `awsvpc` 네트워크 모드라
  같은 태스크의 컨테이너가 네트워크 네임스페이스를 공유한다. Cloud Map
  ([ADR-0005](0005-cloud-map-private-dns-discovery.md))도 컨테이너 링크도 아니다.
  이것이 [ADR-0004](0004-task-level-colocation.md) co-location의 직접적 이득이다.
- 상수 배치는 [ADR-0015](0015-arm64-fargate-for-cost-savings.md)의 판단을 따른다. `PORTS`처럼
  스택 간 공유되는 리터럴만 `lib/common/config.ts`에 두고, config 파일 경로 같은 값은
  각 환경의 `application-stack.ts`(`lib/prod/`·`lib/dev/`)에 `COLLECTOR_CONFIG_PATH` 로 둔다.

### Negative

- **config 변경에는 `cdk deploy`가 필요하다.** 운영자가 콘솔에서 즉시 고칠 수 없다.
  긴급 상황에서 마스킹 규칙 하나를 바꾸려 해도 인프라 배포 경로를 타야 한다.
  이 마찰이 실제로 문제가 되면 SSM 방식으로 전환한다(위 Alternatives의 첫 항목).
- **config YAML이 CloudFormation 템플릿과 ECS 콘솔에 평문으로 노출된다.**
  이 파일에 시크릿을 넣으면 안 된다. `config/otel-collector.yaml` 상단에 이 경고를 주석으로 남긴다.
- **`file/*` exporter를 쓰려고 collector 컨테이너를 root로 실행한다.** 위 Constraints에서 보듯
  이 이미지에는 비root가 쓸 수 있는 경로가 없어서 다른 선택지가 없다. 이 대가는 작지 않다 —
  ALB `/v1/*`로 들어오는 **외부 OTLP 입력을 파싱하는 프로세스가 root로 돈다.**
  root 범위는 `otel-collector` 컨테이너 하나로 한정하고 `post-processor`에는 적용하지 않는다.
- **`file/*` exporter의 원본 아카이브는 태스크 재시작 시 소실된다.** Fargate 임시 스토리지에
  쓰기 때문이다. MVP에서는 실시간 파이프라인 검증을 우선하고 이 휘발성을 **의도적으로 감수한다.**
  또한 `append: true`는 `rotation`과 함께 쓸 수 없어 파일이 무한 증가한다. 기본 임시 스토리지
  20 GiB를 채우면 태스크가 죽는다.
- **위 두 대가는 `awss3` exporter로 옮기면 동시에 사라진다.** 파일시스템을 아예 쓰지 않으므로
  root가 필요 없어지고 휘발성도 해소된다. `rawSignalBucket.grantReadWrite(task.taskRole)`가
  이미 태스크 역할에 S3 쓰기 권한을 주고 있어 IAM 변경 없이 config만 바꾸면 된다
  ([ADR-0013](0013-raw-signal-retention-for-mvp.md)이 상정한 방향이기도 하다).
  file exporter를 유지하는 것은 MVP 한정 선택이다.
- **이미지 태그는 이번에 고정하지 않는다.** `otel/opentelemetry-collector-contrib`를 무태그
  (= `latest`)로 계속 쓴다. config가 `filter`의 `trace_conditions` 문법과 file exporter의
  `create_directory` 옵션에 의존하는데, 둘 다 특정 버전 이상에서만 존재하고 상위 버전에서 문법이
  바뀔 수 있다. 태스크가 재시작되는 임의의 시점에 새 `latest`를 당겨오므로 **조용한 기동 실패가
  가능하다.** 로컬 `validate`를 통과한 이미지와 실제로 뜨는 이미지가 다를 수 있다는 뜻이다.
  **태그 고정은 후속 과제로 남긴다.**
- **gRPC 4317은 config에서 제외한다.** 보안 그룹(`network-stack.ts`)과 ALB 타깃 그룹
  (`edge-stack.ts`)이 4318(HTTP)만 다룬다. config에만 4317을 열어두면 아무도 도달할 수 없는
  포트를 바인딩하는 셈이다. 필요해지면 SG·타깃 그룹과 함께 열되, ALB의 gRPC 지원은 HTTP/2와
  TLS를 요구하므로 [ADR-0008](0008-dual-auth-alb-cognito-and-otlp-token.md)의 모드 B
  (HTTP 폴백)에서는 쓸 수 없다.
- **config 오류는 기존 테스트로 잡히지 않는다.** `cdk synth`와 `npm test`는 문자열을 문자열로만
  다루므로 컴포넌트 이름 오타나 스키마 위반을 통과시킨다. 이를 보완하기 위해
  `test/prod/application-stack.test.ts`에 파이프라인 참조 정합성 검사를 둔다.
- **배포 전 관문은 `validate`가 아니라 실제 기동 확인이다.**
  `otelcol-contrib validate`는 config 파싱과 컴포넌트 **해석**까지만 하고 exporter를 실제로
  start하지 않는다. 그래서 파일시스템 권한, 포트 바인딩, 디렉터리 부재 같은 **런타임 실패를
  원리상 잡지 못한다.** 최초 배포의 `mkdir /data: permission denied`가 정확히 이 틈으로
  빠져나갔다 — `validate`는 통과했고 컨테이너는 죽었다. 관문은 아래로 대체한다.

  ```bash
  CID=$(docker run -d --platform linux/arm64 --user 0:0 \
    -e OTEL_CONFIG="$(cat config/otel-collector.yaml)" \
    otel/opentelemetry-collector-contrib --config=env:OTEL_CONFIG)
  docker logs "$CID" 2>&1 | grep -E "Everything is ready|Failed to start component|^Error:"
  docker rm -f "$CID"   # 반드시 이 ID 만 지목한다
  ```

  `Everything is ready.`가 나와야 통과다. 정리할 때 `--filter ancestor=...` 같은 광범위
  매칭을 쓰면 같은 이미지를 쓰는 로컬 개발 컨테이너까지 지운다. 실제로 한 번 그랬다.

## Follow-up

- **성립 불가로 닫힘** — "운영자가 재배포 없이 config를 고쳐야 하는 상황이 반복될 때 → SSM Parameter
  Store로 전환". config(8,890 B)가 SSM Advanced 한도(8,192 B)를 이미 초과했다.
- **발동됨** — config가 8 KB를 넘었다(현재 8,890 B). 남은 선택지는 커스텀 이미지 전환(ADR-0007 개정)뿐이다.
  다만 태스크 정의 64 KiB 한도까지는 여유가 크므로 **즉시 조치 대상은 아니라고 판단한다** —
  관리가 실제로 어려워지거나 64 KiB 에 근접하는 시점에 전환한다.
- 원본 아카이브 보존이 요구사항이 될 때 → `awss3` exporter로 전환.
- **collector의 root 실행이 보안 리뷰에서 걸릴 때 → `awss3` exporter로 전환한다.**
  file exporter를 없애면 root가 필요 없어진다. 이 둘은 한 몸이라 함께 움직인다.
- `latest` 이미지 변경으로 기동이 깨질 때 → 태그 고정을 즉시 처리한다.
  최초 배포 시점에 실제로 당겨온 버전은 **0.157.0**이었다. 이 버전은 이미
  `"otlphttp" alias is deprecated; use "otlp_http" instead` 경고를 낸다 — alias가 제거되는
  버전이 올라오면 이번과 같은 방식으로 조용히 기동이 깨진다.

## References

- [OpenTelemetry Collector — Configuration providers](https://opentelemetry.io/docs/collector/configuration/)
- [filterprocessor README](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/processor/filterprocessor/README.md)
- [fileexporter README](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/exporter/fileexporter/README.md)
- [AWS Systems Manager endpoints and quotas — Parameter Store](https://docs.aws.amazon.com/general/latest/gr/ssm.html)
