# dev ALB 외부 ACM 인증서 적용과 HTTP 복구

PROJ-238·[ADR-0033](../adr/0033-dev-alb-https-with-external-acm.md)은 외부에서 관리하는 ACM 인증서를
dev ECS ALB와 EKS 검증 ALB에 연결한다. 이 문서는 운영 절차이며 실제 AWS 배포·TLS 접속을 실행한 기록이 아니다.
ACM 발급·DNS 검증·Route 53·도메인 context·앱 공개 URL·endpoint output·Helm 생성기 변경은 포함하지 않는다.

## 1. 입력과 준비

| Context | 기본값 | 동작 |
|---|---|---|
| `devCertificateArn` | 없음 | ECS ALB의 ACM 인증서. 생략하면 기존 HTTP 80 유지 |
| `devEksCertificateArn` | 없음 | EKS 검증 ALB의 ACM 인증서. `devEksEnabled=true` 필요 |
| `devHttpRedirectEnabled` | `true` | 인증서가 있는 모든 ALB에 별도 80 → HTTPS 443 HTTP 301 추가 |

두 ARN은 독립적이다. 같은 인증서를 쓰려면 두 context에 같은 ARN을 넣는다. 한쪽 ARN만 주어도 된다.
인증서는 `arn:aws:acm:ap-northeast-2:<배포 계정>:certificate/<인증서 ID>` 형식이어야 한다.
빈 문자열·잘못된 타입/형식·다른 리전·다른 계정은 오류다. redirect는 boolean 또는 CLI의 `true`/`false`만 받는다.
인증서가 없는 ALB에는 redirect flag가 영향을 주지 않는다. `Certificate.fromCertificateArn()`은
참조만 하므로 합성 성공으로 인증서 존재·발급 상태·SAN·유효기간을 확인할 수 없다.

운영자는 대상 계정·서울 리전의 사용 가능한 인증서와 그 인증서에 포함된 도메인, 도메인에서 해당 ALB로
향하는 DNS를 먼저 확인한다. ECS/EKS에 같은 인증서를 쓰는 경우 두 도메인이 인증서에 포함돼야 한다.
인증서 값이나 private key를 이 레포에 넣지 않으며 ARN은 비밀 원문이 아니다.
기존 인증서를 교체할 때는 새 인증서 적용과 접속 검증이 끝날 때까지 이전 인증서를 외부 ACM에 보존한다.
복구 시 이전 ARN을 다시 참조할 수 있어야 한다.
ALB 443 ingress는 해당 ALB의 SG에 기존 `devAllowedCidr`로만 추가된다. listener의 `open:false`는 유지한다.

이미 배포된 EKS에는 계속 `devEksEnabled=true`를 전달한다. HTTPS 복구를 이유로 EKS를 비활성화하지 않는다.
기존 runtime JSON·이미지 태그·ASG 용량·ALB/RDS CIDR·archive prefix와 다른 배포 context는 모두 유지한다.
PROJ-244 이후 EKS API는 private 전용이다. 폐기된 `devEksApiAllowedCidrs`는 모든 context 입력에서
제거한다. 기존 public API에서의 전환·SSM 터널 준비는 [EKS 런북 §2](dev-eks-manual-deployment.md#2-eks-활성화-설정과-cdk-배포)를
먼저 완료하며, HTTPS listener 전환에 EKS API 접근 전환을 섞지 않는다.
아래 예시는 기존 dev 스택이 배포되어 있고 인증서 context를 CLI 배열에서만 공급하는 경우다.
`cdk.json` 또는 다른 입력에 저장한 ARN/redirect 값이 있다면 먼저 함께 확인한다. ARN 제거 단계에서는
모든 입력 출처에서 해당 키를 제거해야 하며 빈 문자열이나 `null`을 넣어 비활성화하지 않는다.

```bash
# 실제 운영값을 환경에 준비한 뒤 실행한다. fixture runtime 파일로 배포하지 않는다.
: "${CDK_DEFAULT_ACCOUNT:?배포 계정을 환경으로 지정한다}"
export CDK_DEFAULT_REGION=ap-northeast-2
export AWS_REGION=ap-northeast-2
: "${DEV_ALLOWED_CIDRS:?기존 devAllowedCidr}"
: "${ECS_RUNTIME_JSON:?기존 devDashboardRuntimeFile 절대 경로}"
: "${DEV_IMAGE_TAG:?기존 devImageTag}"
: "${DEV_APP_ASG_MAX_CAPACITY:?기존 devAppAsgMaxCapacity}"
: "${DEV_EKS_ENABLED:?현재 배포된 EKS 활성 여부 true 또는 false}"
: "${HTTPS_RUN_DIR:?저장소 밖 실행 증거 디렉터리}"
mkdir -p "$HTTPS_RUN_DIR"

HTTPS_BASE_CONTEXT=(-c env=dev
  -c "devAllowedCidr=$DEV_ALLOWED_CIDRS"
  -c "devDashboardRuntimeFile=$ECS_RUNTIME_JSON"
  -c "devImageTag=$DEV_IMAGE_TAG"
  -c "devAppAsgMaxCapacity=$DEV_APP_ASG_MAX_CAPACITY"
  -c "devEksEnabled=$DEV_EKS_ENABLED")
if [ "$DEV_EKS_ENABLED" = true ]; then
  : "${DEV_EKS_ARCHIVE_PREFIX:?기존 devEksArchivePrefix}"
  HTTPS_BASE_CONTEXT+=(-c "devEksArchivePrefix=$DEV_EKS_ARCHIVE_PREFIX")
fi

# 활성화할 ARN만 환경에 설정한다. 이미 HTTPS인 다른 ALB의 ARN도 보존한다.
HTTPS_CERT_CONTEXT=()
if [ -n "${DEV_CERTIFICATE_ARN:-}" ]; then
  HTTPS_CERT_CONTEXT+=(-c "devCertificateArn=$DEV_CERTIFICATE_ARN")
fi
if [ -n "${DEV_EKS_CERTIFICATE_ARN:-}" ]; then
  HTTPS_CERT_CONTEXT+=(-c "devEksCertificateArn=$DEV_EKS_CERTIFICATE_ARN")
fi
```

실제 배포 직전에는 각 단계의 synth/diff에서 목적 외 변경이 없는지 확인한다. 특히 ALB·SG·TG·앱 listener와
기존 규칙의 logical ID·SG 설명을 유지하고, 규칙 교체·EKS 삭제·prod/cicd 변경이 나오면 적용하지 않는다.
무인자 `cdk deploy`의 기본 환경은 prod다. 아래 모든 명령은 `HTTPS_BASE_CONTEXT`의 `env=dev`를 사용한다.

## 2. 기존 HTTP 스택의 HTTPS 활성화

| 단계 | 인증서 입력 | redirect | 앱 listener | 별도 80 listener |
|---|---|---|---|---|
| A: 기존 HTTP | 없음 | 무관 | 기존 ID, HTTP 80 | 없음 |
| B: TLS 전환 | 있음 | `false` | 같은 ID, HTTPS 443 | 없음 |
| C: HTTPS + redirect | 있음 | `true` | 같은 ID, HTTPS 443 | HTTP 301 |

**A → B 완료 확인 → C** 순서로 배포한다. 기존 앱 listener를 80에서 443으로 먼저 갱신한 뒤
80 redirect를 만든다. B에서 해당 ALB의 HTTP 접근은 끊기며 기존 80 SG ingress만 남는다.
공통 flag이므로 다른 ALB가 이미 HTTPS인 경우 그 ALB의 80 redirect도 B에서 사라진다.
각 ALB의 기존 인증서 ARN을 계속 전달하고 두 ALB의 HTTP 중단을 함께 고려한다.

```bash
# B: ARN 입력 + redirect=false. synth와 diff를 검토한 뒤 deploy를 실행한다.
npx cdk synth --all "${HTTPS_BASE_CONTEXT[@]}" "${HTTPS_CERT_CONTEXT[@]}" \
  -c devHttpRedirectEnabled=false --output "$HTTPS_RUN_DIR/stage-b"
npx cdk diff DevNetworkStack DevEdgeStack "${HTTPS_BASE_CONTEXT[@]}" \
  "${HTTPS_CERT_CONTEXT[@]}" -c devHttpRedirectEnabled=false
npx cdk deploy DevNetworkStack DevEdgeStack "${HTTPS_BASE_CONTEXT[@]}" \
  "${HTTPS_CERT_CONTEXT[@]}" -c devHttpRedirectEnabled=false
```

CloudFormation 업데이트 완료, 기존 앱 listener의 443/HTTPS·지정 인증서·TLS 정책과 80 listener 부재,
443 SG CIDR, 기존 target health를 확인한다. HTTPS domain으로 인증서 검증이 성공하는지 확인한 뒤 C로 진행한다.
실패하면 첫 CloudFormation 실패 이벤트와 현재 listener 상태부터 확인하고 수동 listener 삭제로 우회하지 않는다.

```bash
# C: B 적용 완료와 HTTPS 검증 뒤에만 실행한다.
npx cdk synth --all "${HTTPS_BASE_CONTEXT[@]}" "${HTTPS_CERT_CONTEXT[@]}" \
  -c devHttpRedirectEnabled=true --output "$HTTPS_RUN_DIR/stage-c"
npx cdk diff DevNetworkStack DevEdgeStack "${HTTPS_BASE_CONTEXT[@]}" \
  "${HTTPS_CERT_CONTEXT[@]}" -c devHttpRedirectEnabled=true
npx cdk deploy DevNetworkStack DevEdgeStack "${HTTPS_BASE_CONTEXT[@]}" \
  "${HTTPS_CERT_CONTEXT[@]}" -c devHttpRedirectEnabled=true
```

완료 후 선택한 ARN과 `devHttpRedirectEnabled=true`를 배포 설정에 보존한다. 후속 일반 배포에서 ARN을
빠뜨려 HTTP 복구를 우발적으로 시작하지 않는다. 이 명령은 이미 배포된 dev 스택의 listener 전환용이며,
신규 환경의 Data/Application/EKS 초기 배포를 대신하지 않는다.

## 3. HTTP 복구

**C → B 완료 확인 → A** 순서다. 먼저 모든 기존 인증서 ARN을 유지하면서 위 B 명령의
`devHttpRedirectEnabled=false`를 적용한다. 업데이트 완료와 80 redirect listener 삭제를 확인한 뒤,
HTTP로 되돌릴 ALB의 ARN만 `HTTPS_CERT_CONTEXT`와 다른 context 출처에서 제거한다.

```bash
# 예: 두 ALB를 모두 HTTP로 복구한다. 한 ALB만 복구하면 다른 ALB의 ARN 항목은 유지한다.
HTTPS_CERT_CONTEXT=()

# A: 이전 B 업데이트의 완료와 80 redirect 삭제를 먼저 확인한다.
npx cdk synth --all "${HTTPS_BASE_CONTEXT[@]}" "${HTTPS_CERT_CONTEXT[@]}" \
  -c devHttpRedirectEnabled=false --output "$HTTPS_RUN_DIR/stage-a"
npx cdk diff DevNetworkStack DevEdgeStack "${HTTPS_BASE_CONTEXT[@]}" \
  "${HTTPS_CERT_CONTEXT[@]}" -c devHttpRedirectEnabled=false
npx cdk deploy DevNetworkStack DevEdgeStack "${HTTPS_BASE_CONTEXT[@]}" \
  "${HTTPS_CERT_CONTEXT[@]}" -c devHttpRedirectEnabled=false
```

기존 앱 listener가 같은 ID로 HTTP 80에 복귀하고 해당 ALB의 443 ingress가 제거됐는지 확인한다.
다른 ALB가 계속 HTTPS라면 그 ARN을 유지한 상태로 위 C 명령을 실행해 그 ALB의 80 redirect를 복구한다.
한 업데이트에서 ARN 제거와 redirect 삭제를 함께 시도하지 않는다. redirect의 `DependsOn`만으로 삭제와
기존 listener의 80 포트 복귀 순서가 보장된다고 가정하지 않는다. listener의 Port·Protocol은
[CloudFormation 교체 없는 갱신 속성](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-elasticloadbalancingv2-listener.html)이지만,
이 사실은 인증서·TLS 정책 변경이나 두 단계 전환의 무중단을 보장하지 않는다.

## 4. 접속 검증과 완료 경계

각 활성 ALB마다 해당 인증서의 도메인으로 검증한다. 다음은 인증 없이 default 404와 redirect만 확인하는 예다.
80·443 접근은 `devAllowedCidr`에 들어가는 주소에서 실행한다.

```bash
: "${TLS_DOMAIN:?검증할 ALB에 연결된 인증서 도메인}"
# 인증서 검증을 건너뛰는 -k를 쓰지 않는다. HTTPS default 404를 확인한다.
curl -sS -D - -o /dev/null "https://$TLS_DOMAIN/_tls-check"
# C에서 301 및 HTTPS 443으로의 host/path/query 보존을 확인한다.
curl -sS -D - -o /dev/null "http://$TLS_DOMAIN/_tls-check?check=https"
```

- HTTPS listener는 `SslPolicy.TLS13_RES`와 지정 ARN을 사용하고 기존 path·method·OPTIONS·default 404를 유지한다.
  app listener와 기존 규칙, ALB·SG·TG의 ID와 WAF association을 이전 배포와 비교한다.
- ClickHouse 8123은 기존 HTTP 경로다. 이 작업은 target group의 HTTP 연결이나 health check를 TLS로 바꾸지 않는다.
- 기존 `AlbDnsName`·`OtlpEndpoint`·EKS 검증 endpoint output과 `PULSEMETRY_PUBLIC_BASE_URL`은 바뀌지 않는다.
  `http://<ALB DNS>` 요청의 301은 그 host를 보존하므로 인증서가 ALB DNS를 포함하지 않으면 TLS 이름 검증이 실패한다.
  output이나 Helm 생성값을 그대로 최종 HTTPS endpoint로 사용할 수 있다고 가정하지 않는다.
- OTLP는 인증서 도메인의 HTTPS endpoint로 직접 요청한다. HTTP 301이 POST body·인증 헤더를 보존한다고 가정하지 않는다.
  공개 URL·manifest·OIDC callback·CORS 등의 후속 정합과 실제 인증·수집·snapshot·설치 검증은 별도로 수행한다.

로컬 관문은 전체 Jest·TypeScript build, prod A/B·dev/EKS HTTP/HTTPS·cicd synth와 template assertion이다.
이 성공은 실제 ACM 인증서 상태·DNS·AWS 배포·TLS·Cognito 로그인·CLI E2E 성공을 증명하지 않는다.
각 실제 단계의 CloudFormation 상태·listener/SG/target 상태·접속 결과·복구 결과를 별도 배포 기록으로 남긴다.

## 5. PROJ-238 로컬 검증 기록

2026-10-19 KST, 이 변경의 로컬 검증 결과다.

- `npm run build` 통과. 전체 Jest는 24 suites·586 tests 통과, 1 suite·5 tests skip, snapshots 0개다.
  skip은 `HELM_BIN`·`KUBECONFORM_BIN` 미지정에 따른 기존 조건부 Helm 검증이다. 이 작업은 Helm을 변경하지 않는다.
- `--no-lookups` CLI synth 8개 조합을 통과했다: prod HTTP/HTTPS, dev HTTP/HTTPS,
  EKS HTTP/HTTPS/HTTPS redirect=false, cicd.
- 인증서 미입력 dev/EKS HTTP와 prod A/B·cicd의 18개 stack template이 변경 전 기준선과 완전히 같았다.
- `git diff --check`, 신규 문서 상대 링크와 이 런북의 shell 문법 검사를 통과했다.

위 결과는 로컬 코드·합성 검증이며 ACM 조회·AWS 배포·도메인 접속·TLS·애플리케이션 E2E는 실행하지 않았다.
