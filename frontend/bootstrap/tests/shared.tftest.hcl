mock_provider "aws" {
  override_during = plan
}
variables {
  aws_account_id        = "111111111111"
  github_subject_prefix = "repo:soma-376/infra"
}
override_resource {
  target          = aws_s3_bucket.state["bootstrap"]
  override_during = plan
  values          = { arn = "arn:aws:s3:::mock-bootstrap", id = "mock-bootstrap" }
}
run "shared_ci_boundaries" {
  command = plan
  assert {
    condition     = alltrue([for mode, role in aws_iam_role.shared : jsondecode(role.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"] == "repo:soma-376/infra:environment:frontend-bootstrap-${mode}"])
    error_message = "shared 역할은 기존 bootstrap 승인 환경의 정확한 subject를 사용해야 합니다."
  }
  assert {
    condition     = alltrue([for mode, policy in aws_iam_role_policy.shared_state : jsondecode(policy.policy).Statement[1].Resource == "arn:aws:s3:::mock-bootstrap/shared-valkey/terraform.tfstate" && (mode == "apply" || !contains(jsondecode(policy.policy).Statement[1].Action, "s3:PutObject"))])
    error_message = "shared state만 허용하며 plan은 state 본문을 쓰지 못해야 합니다."
  }
  assert {
    condition     = alltrue([for policy in [aws_iam_policy.shared_read, aws_iam_policy.shared_services, aws_iam_policy.shared_network, aws_iam_policy.shared_peers] : length(policy.policy) <= 6144])
    error_message = "IAM managed policy 크기 한도를 넘으면 안 됩니다."
  }
  assert {
    condition     = aws_iam_role_policy_attachment.shared_network.role == aws_iam_role.shared["apply"].name && aws_iam_role_policy_attachment.shared_services.role == aws_iam_role.shared["apply"].name && aws_iam_role_policy_attachment.shared_peers.role == aws_iam_role.shared["apply"].name && !strcontains(aws_iam_policy.shared_read.policy, "GetSecretValue") && !strcontains(aws_iam_policy.shared_read.policy, "CreateVpc")
    error_message = "plan에는 쓰기나 secret 값 조회를 허용하지 않습니다."
  }
  assert {
    condition     = !strcontains(aws_iam_policy.shared_services.policy, "AdministratorAccess") && !strcontains(aws_iam_policy.shared_services.policy, "iam:PassRole") && !strcontains(aws_iam_policy.shared_peers.policy, "ec2:DeleteVpc") && !strcontains(aws_iam_policy.shared_peers.policy, "ec2:AuthorizeSecurityGroupIngress")
    error_message = "shared 역할은 기존 앱 VPC 삭제·수신 허용·PassRole 권한을 가져서는 안 됩니다."
  }
}
