# 0031. dev dashboard DB 자격 증명과 사용자 JWT Secret 원본은 CDK로 생성하고 보존한다

## Status

Accepted (PROJ-222의 dev Secret 원본 관리 결정, AWS 배포·값 등록·DB 적용 증거 대기)

[ADR-0030](0030-dev-user-jwt-keys-from-secrets-manager.md)의 §1 중 CDK가 JWT 원본을 생성하지 않고
참조만 관리한다는 소유 경계를 부분 대체한다. JWT 형식·버전 고정·파일 공급·권한 분리·교체와
복구 계약은 유지한다. 이 결정은 infra의 dev 리소스 관리 범위이며 prod와 공통 인증 계약을 바꾸지 않는다.

## Context

dashboard는 RDS·ClickHouse의 source 조회와 cache 쓰기에 서로 다른 계정이 필요하다.
사용자 JWT도 개인키·공개키 원본을 분리하고 ECS/EKS가 같은 ARN과 지정 버전을 사용해야 한다.
ADR-0030은 키 생성·등록과 앱 배포를 분리했지만 Secret 원본까지 운영자가 별도 생성하도록 두었다.
계정 정보와 JWT 원본의 이름·보존 정책을 인프라 코드에서 함께 관리할 필요가 있다.

기존 `DevDataStack`의 RDS master·공유 token hash·관리자 token Secret 3개는 기존 앱 계약이다.
새 dashboard 계정을 준비한다는 이유로 이 Secret이나 enrollment·ingest의 기존 자격 증명을 교체하지 않는다.
Secret 리소스를 만드는 일과 실제 DB 사용자·schema·grant, 유효한 JWT 키를 준비하는 일은 별도다.

## Decision

### 1. 여섯 개 원본과 생성 방식

`DevDataStack`에 아래 여섯 개 `AWS::SecretsManager::Secret`을 추가한다. 기존 세 개의 construct와
속성을 유지하며, 합성 템플릿의 Secret 수는 총 9개다. 이 숫자는 현재 AWS 계정의 실제 리소스 수를 뜻하지 않는다.

| Secret 이름 | 내용·생성 |
|---|---|
| `soma-376/dev/dashboard/rds-source` | `username=dashboard_rds_source`와 생성한 `password`의 JSON |
| `soma-376/dev/dashboard/rds-cache` | `username=dashboard_rds_cache`와 생성한 `password`의 JSON |
| `soma-376/dev/dashboard/clickhouse-source` | `username=dashboard_ch_source`와 생성한 `password`의 JSON |
| `soma-376/dev/dashboard/clickhouse-cache` | `username=dashboard_ch_cache`와 생성한 `password`의 JSON |
| `soma-376/dev/user-jwt/private-key` | 값 없이 생성하고 운영자가 검증한 PKCS8 PEM 버전을 등록 |
| `soma-376/dev/user-jwt/public-keys` | 값 없이 생성하고 운영자가 검증한 `kid → X.509 PEM` JSON 버전을 등록 |

DB Secret은 `GenerateSecretString`의 `SecretStringTemplate`에 username만 두고 `GenerateStringKey=password`,
`PasswordLength=32`, `ExcludePunctuation=true`, `IncludeSpace=false`로 영숫자 비밀번호를 생성한다.
값은 Secrets Manager가 배포 시 생성하므로 코드·synth 산출물에 비밀번호를 적지 않는다.
JWT Secret은 `CfnSecret`에 `SecretString`과 `GenerateSecretString`을 모두 지정하지 않는다.
빈 원본 생성은 유효한 키 버전이나 앱 기동 준비가 완료됐다는 뜻이 아니다.

### 2. 보존과 암호화

새 여섯 개 모두 `DeletionPolicy: Retain`과 `UpdateReplacePolicy: Retain`을 적용한다.
기존 세 개의 삭제 정책은 변경하지 않는다. 앱 stack 삭제·교체 뒤에도 키와 DB 자격 증명 원본을 보존한다.
`KmsKeyId`는 지정하지 않아 AWS 관리형 `aws/secretsmanager`를 사용하고 customer managed KMS key와
자동 회전은 추가하지 않는다.

보존은 버전 label 보존이나 DB 비밀번호 동기화를 대신하지 않는다. 운영자는 활성·교체·롤백 버전을 관리한다.
Secret 이름·logical ID·생성 설정 변경은 별도 검토한다. DB 생성 설정을 바꿔 새 비밀번호 버전이 생겨도
실제 DB 사용자의 비밀번호는 자동 변경되지 않는다. 보존 원본이 남은 상태에서 같은 이름으로 새 리소스를
생성하면 충돌할 수 있으므로 삭제·재생성으로 해결하지 않고 기존 ARN의 재사용·관리 복구를 먼저 검토한다.

### 3. CDK와 운영자의 책임

CDK는 여섯 개의 원본 생성·이름·보존 정책과 후속 소비를 위한 `ISecret`·ARN 참조를 소유한다.
PROJ-230은 ECS IAM·지정 버전 writer·volume·앱 설정을, PROJ-231은 EKS Pod Identity·SPC·
VersionId·키 추출 alias·mount를 연결한다. 이번 변경에서 앱 role에 조회 권한을 추가하거나
앱에 새 자격 증명을 주입하지 않는다.

운영자는 DB Secret의 username/password에 맞춰 네 실제 DB 사용자와 필요한 schema·grant를 수동 적용하고
권한을 검증한다. JWT 키쌍 생성·시험 서명/검증·두 버전 등록·부분 실패 복구·label 관리도 수동 절차로 안내한다.
새 초기화 도구·script·Custom Resource를 만들지 않으며 CDK·앱 시작 시 RSA 키를 생성하지 않는다.
운영자가 원문을 처리할 때는 승인된 런타임 전달 경로를 사용하고 원문을 문서·명령 이력·로그·증거에 남기지 않는다.

JWT의 고정 ARN 두 개·VersionId·active-kid·공개키 파일 맵과 verifier 선행 교체·330초 대기는
ADR-0030과 허브 ADR-0022를 그대로 따른다. 기존 HMAC·관리자 token을 dashboard에 공유하지 않는다.

## Constraints

PROJ-222는 CDK 원본 정의와 운영 절차를 준비한다. 실제 Secret 조회·값 등록·JWT 키 생성·DB 접속과 변경,
AWS 배포·런타임 전달·인증 기능 검증은 수행하지 않는다. 기존 세 Secret과 과거 로컬 검증 기록은
배포된 새 여섯 원본이나 dashboard DB 권한·JWT 공급의 완료 증거가 아니다.

## Alternatives Considered

- 원본까지 운영자가 수동 생성: 이름·보존 정책의 인프라 관리가 분산돼 채택하지 않는다.
- JWT에 `GenerateSecretString` 사용: 임의 문자열은 RSA 키가 아니므로 채택하지 않는다.
- DB 계정·키 등록 자동화 도구 또는 Custom Resource: 이번 작업은 운영자 절차로 안내하며 DB·키 변경을 배포에 묶지 않는다.
- 개인키·공개키 통합 Secret: dashboard의 개인키 조회 권한을 분리할 수 없어 ADR-0030과 같이 기각한다.

## Consequences/Tradeoffs

### Positive

원본 여섯 개의 이름·생성 방식·보존을 CDK와 template assertion으로 검토할 수 있다.
JWT 키 수명과 실제 DB 권한 적용을 앱 배포에서 분리하고 기존 세 Secret의 연속성을 유지한다.

### Negative

Secret 생성만으로 DB 로그인·권한·JWT 키가 준비되지 않아 운영자의 별도 적용·검증이 필요하다.
Retain 원본의 비용·삭제·재연결과 버전 label을 운영자가 계속 관리해야 한다.
DB 비밀번호 버전과 실제 DB 사용자가 어긋나면 후속 앱 연결이 실패할 수 있다.

## Follow-up

- 운영자가 실제 배포 후 DB 사용자·schema·grant, JWT 두 버전·키쌍·active-kid 정합을 검증한다.
- PROJ-230에서 최소 권한과 지정 버전의 ECS 파일 전달을, PROJ-231에서 EKS Pod Identity·SPC·mount를 구현한다.
- 자동 회전·customer managed KMS key·원본 삭제가 필요해지면 동기화·보존 책임을 별도 결정한다.

## Acceptance Criteria

로컬 검증은 dev template에 기존 세 개와 신규 여섯 개가 있고, 신규 이름·DB username·생성 설정·JWT 값 부재·
두 Retain 정책이 일치함을 확인한다. 기존 세 Secret의 logical ID·속성, prod·cicd와 기존 앱 IAM·설정이
변하지 않았는지 대조한다. Secret 값·계정 ID를 문서·output·테스트에 추가하지 않는다.
실제 DB 권한·JWT 등록과 기능 수락은 별도 운영 기록이며 build·test·synth 성공으로 대신하지 않는다.

## References

- [ADR-0030 사용자 JWT 키 공급](0030-dev-user-jwt-keys-from-secrets-manager.md), [dashboard 배포 ADR-0029](0029-dev-dashboard-api-ecs-and-eks-deployment.md)
- [허브 JWT 키 공급 ADR](../../../docs/adr/0022-user-jwt-key-provisioning.md), [공통 dashboard 계약](../../../docs/contracts/dashboard-api.md)
- [공통 저장소·인증 수동 준비 런북](../runbooks/dev-dashboard-prerequisites.md)
- [CloudFormation Secret 속성](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-secretsmanager-secret.html), [비밀번호 생성 설정](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-secretsmanager-secret-generatesecretstring.html)
- [DeletionPolicy](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-attribute-deletionpolicy.html), [UpdateReplacePolicy](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-attribute-updatereplacepolicy.html)
