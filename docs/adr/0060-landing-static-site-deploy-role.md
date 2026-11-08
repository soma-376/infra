# 0060. 랜딩 정적 사이트는 외부 생성 S3·CloudFront에 DeployStack의 전용 OIDC 역할로 배포한다.

## Status

Accepted (PROJ-327; 역할 배포·첫 자동 배포 검증은 별도)

## Context

`soma-376/pulsemetry-landing`은 Next.js `output: "export"` 정적 사이트다. 서버 코드가 없으므로 ECS·ALB가 필요 없고,
빌드 산출물 `out/`을 S3에 올리고 CloudFront로 서빙하면 된다.

- 버킷 `pulsemetry-landing-prod`(ap-northeast-2, 퍼블릭 접근 차단)와 CloudFront 배포 `EQE94IEKI2ZPY`(OAC, 기본 루트
  `index.html`, 403/404 → `/404.html`)는 PROJ-327에서 콘솔·CLI로 먼저 만들었다. 이 레포의 어느 스택도 소유하지 않는다.
- 대표 도메인은 `www.pulsemetry.co.kr`이다. DNS는 가비아(외부)가 관리하며 루트 도메인 CNAME을 지원하지 않는다.
  CloudFront 인증서는 us-east-1 ACM에서 별도로 발급한다.
- 앱 레포 배포 권한은 `DeployStack`(ADR-0024)이 GitHub OIDC 역할로 소유한다. 랜딩 저장소에는 아직 배포 역할이 없어,
  결정하지 않으면 장기 액세스 키를 GitHub Secret에 넣거나 사람이 매번 수동으로 업로드해야 한다.
- 랜딩 저장소(ID `1444074394`)는 2026-07-15 이후 생성되어 OIDC `sub`에 immutable org/repo ID가 들어간다. develop 없이
  main 단일 브랜치를 쓴다.

## Decision

1. `DeployStack`에 `github-deploy-pulsemetry-landing-prod` 역할 1개를 추가한다. 기존 앱 역할 맵(`deployRoles`)과
   infra 역할과 분리해 `lib/cicd/landing-deploy-role.ts`가 소유하며 `DeployStack`의 역할은 총 7개가 된다.
2. 신뢰 정책은 기존 OIDC 공급자를 공유하고 `StringEquals`로
   `repo:soma-376@297555253/pulsemetry-landing@1444074394:ref:refs/heads/main`과 `aud=sts.amazonaws.com`만 허용한다.
3. 권한은 `aws s3 sync --delete`와 `aws cloudfront create-invalidation`이 호출하는 것만 준다.
   - `s3:ListBucket` — 버킷 ARN
   - `s3:PutObject`, `s3:DeleteObject` — 버킷 객체 ARN
   - `cloudfront:CreateInvalidation` — 배포 `EQE94IEKI2ZPY` ARN
4. 버킷 정책·ACL·CloudFront 설정·`s3:GetObject`·IAM 권한은 주지 않는다. CI는 콘텐츠만 바꾸고 공개 범위·라우팅은 바꾸지 못한다.
5. 버킷 이름과 배포 ID는 `LANDING_DEPLOY` 상수가 단일 출처다. 역할 ARN은 output `PulsemetryLandingProdDeployRoleArn`으로 내고,
   랜딩 저장소 Variables `AWS_DEPLOY_ROLE_ARN`·`CLOUDFRONT_DISTRIBUTION_ID`에 넣는다.
6. 버킷·배포 자체를 CDK로 가져오는 일(import)은 이 ADR의 범위가 아니다.

## Alternatives Considered

### A. 랜딩 저장소에 IAM 사용자 액세스 키를 Secret으로 저장
- 장점: infra 변경·관리자 배포 없이 바로 쓸 수 있다.
- 단점: 장기 자격 증명이 유출되면 만료가 없다. 브랜치 제한을 IAM으로 표현할 수 없다.
- 탈락 이유: ADR-0024가 OIDC 단기 자격 증명으로 통일했다.

### B. 버킷·CloudFront까지 새 CDK 스택으로 소유
- 장점: 리소스 정의와 권한이 한 곳에 있어 이름 drift를 테스트로 막을 수 있다.
- 단점: 이미 만든 리소스를 import하거나 재생성해야 하고, DNS·인증서가 외부라 스택만으로 완결되지 않는다.
- 탈락 이유: 랜딩을 먼저 공개하는 것이 우선이며 import는 후속으로 미룬다.

### C. 기존 `DEPLOY_TARGETS`(ECR/ECS 대상 맵)에 행 추가
- 장점: 기존 루프를 재사용한다.
- 단점: 대상 타입이 ECR·ECS로 고정돼 S3·CloudFront 권한을 표현하려면 맵의 계약을 바꿔야 한다. prod/dev 두 환경 축도 맞지 않는다.
- 탈락 이유: 기존 4개 역할의 trust·권한·output을 바꾸지 않으려고 분리 모듈을 쓴다(ADR-0048의 infra 역할과 같은 방식).

## Consequences/Tradeoffs

### Positive
- main 머지만으로 빌드 → 업로드 → 캐시 무효화가 장기 키 없이 실행된다.
- 다른 브랜치·PR·태그는 역할을 맡을 수 없다.

### Negative
- 버킷·배포가 IaC 밖이라 이름·ID가 바뀌어도 CloudFormation은 성공하고 Actions만 `AccessDenied`로 실패한다.
  - 완화: `LANDING_DEPLOY` 상수와 테스트가 기대 ARN을 고정하고, 리소스 교체 시 상수와 랜딩 Variables를 함께 바꾼다.
- main 보호(리뷰 필수)가 곧 공개 사이트 배포 권한의 경계다. 랜딩 저장소 branch protection이 필수다.
- 수동으로 만든 버킷 정책·CloudFront 설정은 코드 리뷰 대상이 아니다.

## Follow-up

- `DeployStack`을 `-c env=cicd -c githubOidcProviderArn=<기존 ARN>`으로 배포하고 output ARN을 랜딩 Variables에 등록한다.
- 랜딩 첫 자동 배포의 AssumeRole·sync·invalidation 성공을 PROJ-327에 기록한다.
- `www.pulsemetry.co.kr` 인증서 검증·CloudFront 대체 도메인 연결·가비아 www CNAME·루트 포워딩을 확인한다.
- 버킷·CloudFront를 CDK로 import할지 재검토한다.

## Acceptance Criteria

- `npx jest test/cicd`가 통과하고 랜딩 역할의 trust `sub`·네 액션·리소스 ARN을 고정한다.
- 배포 후 `aws iam get-role --role-name github-deploy-pulsemetry-landing-prod`가 존재하고, 랜딩 main의 Actions run이 성공한다.

## References

- ADR-0024(배포 역할과 immutable OIDC subject), ADR-0048(분리 모듈 방식의 infra 역할)
- `lib/cicd/landing-deploy-role.ts`의 `LANDING_DEPLOY`·`createLandingDeployRole()`
- 랜딩 `.github/workflows/deploy.yml`
