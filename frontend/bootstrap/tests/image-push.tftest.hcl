mock_provider "aws" {
  override_during = plan
  mock_data "aws_iam_openid_connect_provider" {
    defaults = { arn = "arn:aws:iam::111111111111:oidc-provider/token.actions.githubusercontent.com" }
  }
}

variables {
  aws_account_id        = "111111111111"
  github_subject_prefix = "repo:soma-376/infra"
}

override_resource {
  target          = aws_ecr_repository.frontend["dev"]
  override_during = plan
  values          = { arn = "arn:aws:ecr:ap-northeast-2:111111111111:repository/soma-376/pulsemetry-frontend-dev" }
}
override_resource {
  target          = aws_ecr_repository.frontend["prod"]
  override_during = plan
  values          = { arn = "arn:aws:ecr:ap-northeast-2:111111111111:repository/soma-376/pulsemetry-frontend-prod" }
}

run "disabled_without_subject" {
  command = plan
  variables {
    frontend_github_subject_prefix = null
  }
  assert {
    condition     = length(aws_iam_role.frontend_image_push) == 0
    error_message = "subject를 지정하지 않은 기존 bootstrap에는 게시 역할을 만들지 않아야 합니다."
  }
}

run "environment_scoped_publish" {
  command = plan
  variables {
    frontend_github_subject_prefix = "repo:soma-376/pulsemetry-frontend"
  }
  assert {
    condition     = length(aws_iam_role.frontend_image_push) == 2 && length(output.frontend_image_push_roles) == 2
    error_message = "dev/prod 게시 역할과 ARN 출력이 필요합니다."
  }
  assert {
    condition = alltrue([for env, role in aws_iam_role.frontend_image_push :
      jsondecode(role.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"] == "repo:soma-376/pulsemetry-frontend:environment:${env}" &&
      jsondecode(role.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:aud"] == "sts.amazonaws.com"
    ])
    error_message = "프론트 저장소의 정확한 Environment와 audience만 신뢰해야 합니다."
  }
  assert {
    condition = alltrue([for env, policy in aws_iam_role_policy.frontend_image_push :
      length(jsondecode(policy.policy).Statement) == 2 &&
      toset(jsondecode(policy.policy).Statement[0].Action) == toset(["ecr:GetAuthorizationToken"]) &&
      jsondecode(policy.policy).Statement[0].Resource == "*" &&
      jsondecode(policy.policy).Statement[1].Resource == aws_ecr_repository.frontend[env].arn &&
      toset(jsondecode(policy.policy).Statement[1].Action) == toset([
        "ecr:BatchCheckLayerAvailability", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload", "ecr:PutImage", "ecr:BatchGetImage", "ecr:DescribeImages"
      ])
    ])
    error_message = "자기 환경 ECR 게시·조회 이외의 권한이나 다른 저장소 접근을 허용하면 안 됩니다."
  }
}
