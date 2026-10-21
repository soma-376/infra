# 0034. dev EKS API는 SSM 릴레이 터널을 통해 private endpoint로 접근한다

## Status

Accepted (PROJ-244; 로컬 구현·검증 대상, AWS 배포·SSM·Kubernetes 접속 증거 별도)

[ADR-0028](0028-dev-eks-auto-mode-transition.md)의 public+private API endpoint·필수 API CIDR과
operator IAM을 `eks:DescribeCluster`로 한정한 결정을 부분 대체한다. 기존 cluster/node/operator
역할과 AccessEntry, Auto Mode, CDK/Helm 소유권, ECS·prod·cicd 결정은 유지한다.
[ADR-0016](0016-ssm-based-operator-access.md)의 SSM·SSH 인바운드 금지 원칙을 계승하며,
dev EKS 접근에는 별도 EC2 릴레이를 추가한다.

## Context

기존 EKS public API는 `devEksApiAllowedCidrs`에 운영자 IP를 등록해야 접근할 수 있다.
성능 테스트 담당자가 로컬 `kubectl`과 Helm을 사용하려면 담당자가 바뀔 때마다 인프라 설정을
갱신해야 한다. PROJ-244는 이 접근 경로를 IAM으로 통제하는 SSM 릴레이로 전환한다.

로컬 도구를 유지하므로 릴레이는 TCP 중계만 맡긴다. Kubernetes 인증은 로컬 AWS 프로필이
기존 operator 역할로 수행한다. 릴레이에 별도 관리자 AccessEntry를 만들거나 operator 역할을
EC2 instance profile로 재사용하지 않는다. 이 결정은 infra만 변경하며 앱 API·Helm workload·
레포 간 계약은 바꾸지 않는다.

## Decision

### 1. 활성화와 네트워크

- `devEksEnabled=false`의 기존 4스택은 유지한다. `true`에서만 기존 DevEksStack 안에 릴레이를
  추가하므로 활성 구성은 5스택이다. 별도의 릴레이 활성화 context는 만들지 않는다.
- EKS는 `endpointPrivateAccess=true`, `endpointPublicAccess=false`다. `DevEksConfig.publicAccessCidrs`와
  사용자 CIDR 파서를 제거한다. 폐기된 `devEksApiAllowedCidrs`가 입력되면 EKS 활성화 여부와 무관하게
  제거 안내 오류를 낸다. 기존 배포 설정에서도 해당 키를 삭제해야 한다.
- CloudFormation은 이전 템플릿에 있던 `EndpointPrivateAccess`·`EndpointPublicAccess`·
  `PublicAccessCidrs`를 업데이트에서도 요구한다. 따라서 템플릿의 `PublicAccessCidrs`는 제거하지 않고
  IPv4 기본값 `['0.0.0.0/0']`을 명시한다. `EndpointPublicAccess=false`와 함께 고정하므로 public API를
  열지 않으며 private endpoint의 접근 제어는 SG가 담당한다. public API를 다시 활성화하려면 먼저
  허용 CIDR을 제한하는 별도 설계가 필요하다. 이전 public 구성으로 복구할 때는 보관한 템플릿과 CIDR을 쓴다.
- NetworkStack이 전용 릴레이 SG와 모든 cross-SG 규칙을 소유한다. 릴레이 SG는 인바운드가 없고
  IPv4 TCP 443 아웃바운드만 허용한다. 기존 control-plane SG에 릴레이 SG의 TCP 443을 허용한다.
  VPC의 AmazonProvidedDNS를 사용하며 기존 node·앱·DB·ALB 규칙은 유지한다.
- 기존 public subnet·NAT 0을 유지한다. public IPv4는 SSM 서비스로 나가는 경로이며 SSH 등
  외부에서 릴레이로 직접 접속하는 포트를 열지 않는다. EIP·NAT·추가 VPC endpoint는 만들지 않는다.

### 2. 릴레이 EC2와 IAM

- DevEksStack에 AL2023 ARM64 `t4g.micro` 한 대를 첫 번째 public subnet에 생성한다.
  public IPv4, 암호화된 8 GiB gp3 root volume, IMDSv2 필수, 키페어 없음으로 구성한다.
  root volume은 인스턴스 삭제 시 삭제한다. SSM Agent를 활성화하고 업무 파일을 저장하지 않는다.
- EC2 전용 역할은 `ec2.amazonaws.com`만 신뢰하며 `AmazonSSMManagedInstanceCore`를 연결한다.
  EKS 권한·AccessEntry, operator AssumeRole, 앱 Secret·S3 권한을 추가하지 않는다.
- 기존 operator 역할의 이름·trust·`eks:DescribeCluster`와 cluster 범위
  `AmazonEKSClusterAdminPolicy` AccessEntry를 유지한다. 실제 담당자의 `sts:AssumeRole`
  권한은 계정 IAM에서 관리한다. node/operator AccessEntry는 기존 2개다.
- operator에 추가하는 `ssm:StartSession`은 릴레이 인스턴스 ARN과 아래 전용 문서 ARN만
  허용한다. 인스턴스 statement에는 AWS 예시의 `BoolIfExists`로
  `ssm:SessionDocumentAccessCheck=true`를 적용한다. 조건 키가 있으면 `true`만 일치하고,
  키가 없으면 이 조건은 통과한다. `Bool`은 키가 없는 평가에서도 불일치하므로 사용하지 않는다.
  전용 문서 ARN 허용은 별도 statement로 유지한다. 셸·SSH 문서, `SendCommand`, 문서 수정 권한은
  추가하지 않는다. 문서 생략 시 기본 셸 거부와 다른 문서 거부는 배포 후 실제로 검증한다.
- `ssmmessages:OpenDataChannel`은 해당 계정·리전의 `session/${aws:userid}-*`에 한정한다.
  `ssm:ResumeSession`·`ssm:TerminateSession`은 같은 계정·리전의 session ARN에 대해
  `ssm:resourceTag/aws:ssmmessages:session-id=${aws:userid}`와
  `ssm:resourceTag/aws:ssmmessages:target-id=<relay instance ID>`를 함께 검사한다.
  이 SSM tag 조건을 다른 서비스인 `ssmmessages`에 복사하지 않는다.
- `${aws:userid}`는 AssumeRole의 role ID와 role session name 기준이다. 담당자마다 구분되는
  role session name을 사용한다. 같은 역할·session name을 공유하면 사람별 격리가 되지 않는다.

### 3. EKS 전용 Session 문서와 로컬 도구

- CDK가 `soma-376-dev-eks-api-tunnel` Session 문서를 소유한다. schema `1.0`, sessionType
  `Port`, 갱신 방식 `NewVersion`을 사용한다. `properties.host`는 cluster endpoint의 hostname,
  `properties.portNumber`는 `443`으로 고정한다. parameter는 `localPortNumber` 하나이고
  기본값은 `8443`이다. 허용 포트는 1~65535다.
- 범용 `AWS-StartPortForwardingSessionToRemoteHost`는 호출자가 host·port를 고를 수 있으므로
  operator에 허용하지 않는다. 전용 문서에 원격 host·port override parameter를 두지 않는다.
- 신규 output `EksRelayInstanceId`, `EksRelaySessionDocumentName`과 기존
  `EksOperatorRoleArn`·`EksClusterName`·`EksClusterEndpoint`를 사용한다.
- 로컬 AWS CLI v2·Session Manager plugin·kubectl·Helm을 사용한다. SSM Agent는 원격 포워딩을
  지원하는 `3.1.1374.0` 이상이어야 한다. EC2에는 kubectl·Helm·레포 파일을 설치하지 않는다.
- 전용 operator AWS 프로필로 터널과 EKS 인증을 수행하며, 이미 AssumeRole한 프로필에 다시
  `--role-arn`·`--assume-role-arn`을 지정하지 않는다. 배포·CloudFormation 조회는 원래 배포 프로필이다.
- 별도 kubeconfig의 server를 `https://127.0.0.1:<localPortNumber>`로 설정한다. EKS CA와
  원래 hostname의 `tls-server-name`을 유지하며 TLS 검증을 끄거나 `/etc/hosts`를 수정하지 않는다.

## Alternatives Considered

- **담당자 IP를 계속 추가**: IP 변경 때마다 배포 설정을 갱신해야 하므로 채택하지 않는다.
- **릴레이 셸에서 kubectl·Helm 실행**: EC2에 Kubernetes 관리자 권한·도구·작업 파일이 필요하다.
  로컬 도구 사용 요구와 맞지 않아 채택하지 않는다.
- **범용 SSM 포워딩 문서**: StartSession의 IAM 조건으로 host·port parameter를 제한할 수 없다.
  릴레이가 도달 가능한 다른 서비스로 연결할 수 있으므로 EKS 목적지를 고정한 문서를 사용한다.
- **VPN 또는 전용 private subnet·NAT**: 현재 dev public subnet·NAT 0 구조를 유지하는 작업 범위를 넘는다.

## Consequences/Tradeoffs

### Positive

- 운영자 IP 등록 없이 로컬 도구를 사용할 수 있고, EC2 중계와 Kubernetes 인가를 분리한다.
- 기존 앱 트래픽·워크로드 배포 계약과 운영자 역할의 식별자를 유지한다.

### Negative

- EC2·EBS·public IPv4 비용과 SSM Agent 관리가 추가된다. 단일 릴레이 장애 시 운영자 API 접속이
  중단된다. 노드의 private API 접근과 앱 트래픽은 릴레이를 경유하지 않는다.
- public API 비활성화와 릴레이 생성은 같은 EKS 스택 업데이트다. CloudFormation 완료가
  SSM Online·실제 터널 준비를 증명하지 않으며 전환 중 운영자 접근 공백이 생길 수 있다.
- SSM 포트 포워딩 내용은 Session Manager 세션 로그에 기록되지 않는다. 세션 API 호출의
  CloudTrail 기록과 EKS의 기존 API·audit·authenticator 로그를 구분해서 조사한다.
- 로컬 IAM·TLS·SSM·네트워크 오류를 구분해야 하며, 합성 테스트만으로 실제 세션 인가를 증명할 수 없다.

## Acceptance Criteria

- EKS 활성화 시 private-only API·전용 릴레이·SG 9개·기존 AccessEntry 2개, 비활성 시 기존
  4스택을 합성한다. 기존 리소스 logical ID·SG description·prod/cicd·의존 방향을 보존한다.
- 기존 클러스터 업데이트 호환성을 위해 endpoint 두 flag와 비어 있지 않은 `PublicAccessCidrs`를
  함께 검증한다. 신규 템플릿 합성만으로 CloudFormation 업데이트 성공을 증명하지 않는다.
- template assertion으로 EC2 보안 설정, 릴레이→control-plane 443, 전용 문서의 목적지와
  operator IAM 범위, EC2의 EKS 권한 부재를 검증한다.
- build·전체 Jest·환경별 synth·문서 shell 문법 검사를 수행한다. 문서와 구현은 별도 커밋이다.
- 실제 배포는 [EKS 런북](../runbooks/dev-eks-manual-deployment.md)의 기존 템플릿·CIDR 보관,
  Network 선행 적용, 접속 전환·SSM 준비 확인·복구 절차를 따른다. 실제 터널·TLS·kubectl/Helm·
  잘못된 대상/문서 및 다른 role session의 종료 거부는 별도 live 수락 관문이다.

## References

- [PROJ-244](https://team376.atlassian.net/browse/PROJ-244)
- [EKS cluster endpoint](https://docs.aws.amazon.com/eks/latest/userguide/cluster-endpoint.html)
- [CloudFormation EKS ResourcesVpcConfig 업데이트 제약](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-eks-cluster-resourcesvpcconfig.html)
- [SSM remote-host port forwarding](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-sessions-start.html)
- [SSM Session document schema](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-schema.html)
- [SSM IAM actions and condition keys](https://docs.aws.amazon.com/service-authorization/latest/reference/list_ssm.html)
- [SSM IAM examples](https://docs.aws.amazon.com/systems-manager/latest/userguide/getting-started-restrict-access-quickstart.html)
- [AWS StartSession BoolIfExists 예시](https://aws.amazon.com/blogs/security/how-to-enable-secure-seamless-single-sign-on-to-amazon-ec2-windows-instances-with-aws-sso/)
- [IAM IfExists 조건 평가](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_elements_condition_operators.html#Conditions_IfExists)
- [Assumed-role session ownership example](https://aws.amazon.com/blogs/mt/how-to-grant-least-privilege-access-to-third-parties-on-your-private-ec2-instances-with-aws-systems-manager/)
- [kubectl config set-cluster](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_config/kubectl_config_set-cluster/)
