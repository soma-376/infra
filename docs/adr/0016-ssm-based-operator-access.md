# 0016. 운영자 접속은 SSM 기반으로 (EC2는 Session Manager, Fargate는 ECS Exec)

## Status

Accepted

## Context

ClickHouse EC2 인스턴스에 접속할 수단이 없었다. 로그 확인, 디스크 사용량 점검, ClickHouse 프로세스 상태 확인 같은 기본 운영 작업조차 불가능한 상태다.

원인은 두 가지가 겹친 것이다.

- **인스턴스 역할에 SSM 권한이 없다.** `ClickhouseAsg`는 `role` prop을 넘기지 않아 CDK가 역할을 자동 생성하는데, 여기에는 ECS 컨테이너 인스턴스 등록에 필요한 권한(`ecs:RegisterContainerInstance`, `ecs:Poll`, `ecr:GetAuthorizationToken`, `logs:PutLogEvents` 등)만 붙는다.
- **네트워크 경로도 없다.** 인스턴스는 [ADR-0014](0014-keep-clickhouse-in-app-subnet-for-mvp.md)에 따라 app subnet(private)에 있고, [ADR-0011](0011-single-az-topology.md)의 단일 AZ 구성상 퍼블릭 노출이 없다. SSH 인그레스 규칙도 키페어도 설정한 적이 없다.

즉 접속하려면 새 접근 경로를 하나 열어야 하며, 어떤 경로를 열지는 보안 표면을 결정하는 문제라 기록이 필요하다.

**Fargate 쪽도 사정은 같았다.** `post-processor`와 `api-server`는 Fargate라 들어갈 EC2 인스턴스 자체가 없고, EC2용 정책을 붙여봐야 의미가 없다. 실제로 `DashboardTaskTaskRole`은 권한이 하나도 없는 빈 역할이었다. `api-server`가 DB 자격 증명을 받긴 하지만 그것은 execution role이 시크릿을 읽어 컨테이너에 주입하는 방식이라 task role과 무관하다.

따라서 이 ADR은 EC2와 Fargate 두 경로를 함께 다룬다.

## Decision

운영자 접속을 **SSM 채널로 일원화한다.** 실행 환경에 따라 수단이 갈린다.

| 대상 | 수단 | 설정 |
|---|---|---|
| `clickhouse` (EC2) | SSM Session Manager | 인스턴스 역할에 `AmazonSSMManagedInstanceCore` |
| `post-processor`, `api-server` (Fargate) | ECS Exec | 서비스에 `enableExecuteCommand: true` |

두 경로 모두 SSM 채널을 쓰므로 접근 통제 지점이 IAM 하나로 모인다. 별도의 키 체계나 bastion을 두지 않는다.

### EC2 (ClickHouse): Session Manager

인스턴스 역할에 AWS 관리형 정책 `AmazonSSMManagedInstanceCore`를 부여하고, **Session Manager로 접속한다.** 근거는 세 가지다.

**1. 인바운드를 열지 않는다**

SSM Agent가 아웃바운드로 연결을 맺는 구조라 SG에 인그레스 규칙을 추가할 필요가 없다. SSH를 쓰려면 22번 인그레스, 키페어 배포와 회수, 또는 bastion 인스턴스가 필요한데 셋 다 공격 표면과 운영 부담을 늘린다.

**2. 접근이 IAM으로 통제되고 CloudTrail에 남는다**

키 파일이라는 별도 자격 증명 체계를 만들지 않고 기존 IAM 주체를 그대로 쓴다. 세션 시작과 종료는 CloudTrail의 `StartSession` 이벤트로 기록된다.

**3. 추가 인프라가 필요 없다**

app subnet이 `PRIVATE_WITH_EGRESS`이고 NAT gateway가 이미 1대 있어 SSM 엔드포인트에 도달할 수 있다. SG는 `allowAllOutbound: true`다. 따라서 이 결정으로 추가되는 리소스는 관리형 정책 참조 하나뿐이며, SG와 VPC 구성은 그대로다.

### Fargate (post-processor, api-server): ECS Exec

두 Fargate 서비스에 `enableExecuteCommand: true`를 설정한다. CDK `BaseService`가 task role에 필요한 정책을 **자동으로 부여**하므로 수동 `PolicyStatement`가 필요 없다.

```
ssmmessages:CreateControlChannel
ssmmessages:CreateDataChannel
ssmmessages:OpenControlChannel
ssmmessages:OpenDataChannel
```

**ClickHouse `Ec2Service`는 제외한다.** 두 가지 이유다. 첫째, SSM으로 호스트에 들어가면 `docker exec`으로 컨테이너에 접근할 수 있어 경로가 중복된다. 둘째, ClickHouse 서비스는 인스턴스 1대와 awsvpc ENI 한도 때문에 `minHealthyPercent: 0`으로 강제 교체 배포만 가능해(ADR-0003, ADR-0004의 제약) 서비스 속성을 바꾸는 비용이 크다.

이 결정의 범위는 **접속 경로 확보까지**다. 세션 감사 로그는 아래 Follow-up으로 남긴다.

## Constraints

- **SSM Agent가 설치·구동 중이어야 한다.** AWS가 공개한 사전 설치 AMI 목록에는 Amazon Linux 2023과 Amazon Linux 2 ECS-Optimized가 있으나 **Amazon Linux 2023 ECS-Optimized는 명시되어 있지 않다.** 현재 쓰는 AMI는 `EcsOptimizedImage.amazonLinux2023(AmiHardwareType.ARM)`으로 AL2023 기반이라 설치돼 있을 가능성이 높지만, AWS 문서도 "처음 사용 전 에이전트 상태를 확인하라"고 권고하므로 배포 후 검증이 필요하다. 미설치로 확인되면 user data에 설치 명령을 추가해야 하는데, user data 변경은 launch template을 바꿔 **인스턴스 교체**를 유발하고 로컬 EBS의 ClickHouse 데이터가 사라질 수 있다([ADR-0006](0006-accept-local-ebs-durability-for-mvp.md)). 그 경우 별도 판단이 필요하다.
- **SSM 엔드포인트로의 아웃바운드 443이 필요하다.** 현재 NAT gateway로 충족된다.
- `requireImdsv2: true`가 이미 설정되어 있고 SSM Agent는 IMDSv2를 지원하므로 충돌하지 않는다.
- **ECS Exec은 컨테이너 이미지에 셸이 있어야 동작한다.** distroless나 JRE-slim 기반 이미지는 `/bin/sh`가 없어 권한이 갖춰져도 접속되지 않는다. 이는 인프라가 아니라 앱 레포의 Dockerfile이 결정한다.
- **운영자 로컬에 Session Manager plugin이 설치되어 있어야 한다.** 없으면 `aws ssm start-session`과 `aws ecs execute-command` 모두 실패한다.
- `enableExecuteCommand`는 서비스 속성이라 켜는 순간 **새 배포가 발생하고 실행 중인 태스크가 교체된다.**

## Alternatives Considered

- **SSH + bastion 인스턴스**: 가장 표준적이지만 bastion 인스턴스 상시 비용, 키 배포와 회수 절차, 22번 인그레스 관리가 함께 온다. MVP 단계에 과한 구성이다.
- **ClickHouse SG에 22번 직접 개방**: private subnet이라 애초에 도달 경로가 없어 단독으로는 성립하지 않는다. 게다가 SG 5개를 `NetworkStack`에만 두는 불변 규칙과도 충돌한다.
- **EC2 Instance Connect Endpoint**: 인바운드 없이 SSH를 쓸 수 있어 매력적이지만 VPC endpoint를 추가해야 한다. "추가 VPC endpoint는 도입하지 않는다"는 [ADR-0014](0014-keep-clickhouse-in-app-subnet-for-mvp.md)의 결정과 충돌하므로 기각한다.
- **SSM 인터페이스 VPC endpoint 추가**: NAT를 우회해 보안과 비용 면에서 유리할 수 있으나, 마찬가지로 ADR-0014와 충돌한다. NAT가 이미 있어 기능상 필요하지도 않다.

## Consequences/Tradeoffs

### Positive

- 이 결정의 이점(SSH 키페어와 인바운드 규칙 없이 접속 경로를 확보한다)은 Context와 Decision에 서술되어 있고, 결과 항목으로는 따로 기록되지 않았다.

### Negative

- **접근 통제의 실체는 인스턴스가 아니라 운영자 IAM에 있다.** 이 정책이 정하는 것은 "이 인스턴스가 SSM에 관리될 수 있다"까지이며, 실제로 누가 들어올 수 있는지는 `ssm:StartSession` 권한을 가진 주체가 결정한다. 그 IAM 정책은 이 레포가 관리하지 않으므로 **계정 차원에서 따로 통제해야 한다.** 이 ADR만으로 접근이 안전해졌다고 볼 수 없다.
- **Session Manager의 기본 세션 사용자 `ssm-user`는 passwordless sudo 권한을 가진다.** 접속 = 사실상 root다. 읽기 전용 접근이 필요하다면 별도 설정이 필요하다.
- **세션 중 실행한 명령의 내용은 기본적으로 기록되지 않는다.** CloudTrail에는 세션 시작과 종료만 남고, 무엇을 했는지는 남지 않는다.
- 세션 트래픽이 NAT를 통과하므로 데이터 처리 요금이 발생한다. 대화형 사용 수준에서는 무시할 만하다.
- 이 레포에 처음으로 `aws-cdk-lib/aws-iam` import가 들어온다.
- **Fargate 쪽 접근 통제도 운영자 IAM에 있다.** EC2가 `ssm:StartSession`이라면 Fargate는 `ecs:ExecuteCommand`이며, 역시 이 레포가 관리하지 않는다.
- **ECS Exec 세션 출력은 기본적으로 컨테이너의 awslogs 설정을 따른다.** 별도 감사 로그를 남기려면 Cluster의 `executeCommandConfiguration`을 설정해야 하며 이번 범위가 아니다.
- task role에 붙는 `ssmmessages:*`는 `resources: ['*']`다. CDK 기본 동작이고 해당 액션들은 리소스 수준 제한이 불가능하다.

## Follow-up

- 세션 감사 로그를 CloudWatch Logs 또는 S3로 남길 것인가. 남긴다면 KMS 암호화 여부, 보존 기간, 그리고 로그 그룹 정책 전반을 다룰 ADR-0019와 함께 결정한다.
- `ssm-user`의 sudo 권한을 제한할 것인가. 운영자가 늘어나면 읽기 전용 세션과 관리 세션을 나눌 필요가 생길 수 있다.
- 배포와 조회에 쓰는 `cfn-user`에 `ssm:DescribeInstanceInformation`과 `ssm:StartSession` 권한을 어떤 범위로 부여할 것인가.

- 운영자가 늘어 접속 이력 추적이 필요해질 때.
- 규제나 보안 요건으로 세션 기록이 요구될 때.
- ClickHouse 전용 subnet이나 VPC endpoint 정책을 재검토하게 될 때(ADR-0014의 Follow-up과 함께 다룬다).

## References

- [Find AMIs with the SSM Agent preinstalled](https://docs.aws.amazon.com/systems-manager/latest/userguide/ami-preinstalled-agent.html)
- [AWS Systems Manager Session Manager](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager.html)
