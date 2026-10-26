# dev 도메인 전환 입력

프론트는 `https://dev.pulsemetry.co.kr`, 공개 API는 `https://api-dev.pulsemetry.co.kr`이다.
이 디렉터리는 기존 Helm release의 전체 values를 대체하지 않는 **도메인 override**다.
Secret 버전, 이미지 digest, DB 연결, JWT issuer는 기존 값을 유지한다.
전환 기간에는 기존 프론트 origin/redirect와 백엔드 인증서도 유지한다.

## Helm 적용

기존 release의 chart와 values를 먼저 백업한다. 원본 YAML이 없으면 Helm release에서 복원하고,
복원 chart의 렌더링이 배포된 manifest와 일치하는지 확인한다. 최신 저장소 chart로 무조건
교체하면 도메인 이외 변경이 섞일 수 있으므로 chart/이미지 업그레이드는 별도로 검토한다.

```bash
helm upgrade dashboard-api "$DASHBOARD_CHART" -n pulsemetry-dev \
  --reuse-values -f helm/dev/domains/dashboard-api.yaml --atomic --timeout 5m
helm upgrade enrollment-api "$ENROLLMENT_CHART" -n pulsemetry-dev \
  --reuse-values -f helm/dev/domains/enrollment-api.yaml --atomic --timeout 5m
```

명시적인 kubeconfig와 dev namespace를 사용한다. 두 앱은 기존 Recreate 전략을 유지하므로
재시작 중 짧은 중단이 발생한다. 후속 생성 YAML 배포에도 이 override를 **마지막 `-f`**로
전달한다. 완전한 runtime 입력을 다시 만들 때에는 같은 공개 URL/CORS/callback을 반영한다.
`userAuth.issuer`는 접속 주소가 아닌 JWT 검증 식별자라 이번 이전에서 바꾸지 않는다.

## ALB 인증서

기존 인증서는 기본으로 남기고 새 도메인 인증서를 SNI에 추가한다. 후속 CDK 배포에도
아래 context를 보존한다. 계정별 cdk.context.json은 커밋하지 않는다.

```bash
npx cdk diff DevEdgeStack --exclusively --profile sandbox \
  -c env=dev -c 'devOidcClientKeys=["cognito-a","cognito-b"]' \
  -c devAllowedCidr=0.0.0.0/0 -c devEksArchivePrefix=eks_validation \
  -c devEksCertificateArn=arn:aws:acm:ap-northeast-2:806121397741:certificate/62e2bd1f-6ddb-426a-a3d5-bbe30883bbb7 \
  -c devEksAdditionalCertificateArn=arn:aws:acm:ap-northeast-2:806121397741:certificate/77f93d1d-b750-46a6-b7c4-997da969cf41 \
  -c devHttpRedirectEnabled=true
```

검토한 같은 입력으로 `deploy DevEdgeStack --exclusively`를 수행한다. 다른 스택의 변경을 섞지 않는다.
구 도메인 사용 종료 후 별도 변경으로 기본 인증서를 새 ARN으로 전환하고 추가 SNI 설정을 제거한다.

## 프론트와 Cognito

- Terraform `frontend/environments/dev/runtime.auto.tfvars.json`의 enrollment/dashboard URL은
  BFF 런타임 입력이다. PR 머지 후 보호된 frontend Terraform CI가 적용한다.
- 프론트 저장소 GitHub Environment `dev`의 `NEXT_PUBLIC_ENROLLMENT_API_URL`은 새 API URL이다.
  빌드 시 삽입되므로 값을 바꾼 뒤 프론트 이미지를 다시 빌드·배포해야 한다.
- Cognito dev company-a/b 앱 클라이언트의 CallbackURLs에
  `https://api-dev.pulsemetry.co.kr/api/v1/auth/oidc/callback/oidc`를 추가한다.
  기존 localhost 콜백 및 다른 클라이언트 설정을 유지하며 read-modify-write한다.
- 프론트 `/auth/callback`과 Cognito → 백엔드 콜백은 서로 다른 주소다.

## 확인

TLS 검증을 끄지 않고 프론트 `/login`의 200, 신구 API `/_tls-check`의 ALB default 404를 확인한다.
이는 TLS/라우팅 점검이며 사용자 로그인 성공을 의미하지 않는다. 앱 rollout과 CORS를 확인하고,
최종 로그인은 실제 테스트 계정으로 검증한다. DB의 tenant별 OIDC client 정보가 별도 관리된다면
그 client ID와 issuer도 Cognito 설정에 맞는지 확인한다.
