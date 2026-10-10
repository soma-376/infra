mock_provider "aws" {
  override_during = plan
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::111111111111:role/mock-frontend-role" }
  }
  mock_resource "aws_iam_instance_profile" {
    defaults = { arn = "arn:aws:iam::111111111111:instance-profile/mock-frontend-profile" }
  }
  mock_resource "aws_secretsmanager_secret" {
    defaults = { arn = "arn:aws:secretsmanager:ap-northeast-2:111111111111:secret:mock-frontend-secret-123456" }
  }
  mock_data "aws_iam_openid_connect_provider" {
    defaults = { arn = "arn:aws:iam::111111111111:oidc-provider/token.actions.githubusercontent.com" }
  }
}

variables {
  aws_account_id        = "111111111111"
  github_subject_prefix = "repo:soma-376/infra"
  frontend_dns          = { dev = { domain_name = "dev.frontend.example.com", zone_id = "ZEXAMPLE" }, prod = { domain_name = "frontend.example.com", zone_id = "ZEXAMPLE" } }
}

override_resource {
  target          = aws_s3_bucket.state["bootstrap"]
  override_during = plan
  values          = { arn = "arn:aws:s3:::mock-bootstrap", id = "mock-bootstrap" }
}

override_resource {
  target          = aws_s3_bucket.state["dev"]
  override_during = plan
  values          = { arn = "arn:aws:s3:::mock-dev", id = "mock-dev" }
}

override_resource {
  target          = aws_s3_bucket.state["prod"]
  override_during = plan
  values          = { arn = "arn:aws:s3:::mock-prod", id = "mock-prod" }
}

run "separate_state_and_ci_privileges" {
  command = plan
  assert {
    condition     = length(aws_s3_bucket.state) == 3 && length(aws_ecr_repository.frontend) == 2 && alltrue([for bucket in aws_s3_bucket.state : !bucket.force_destroy])
    error_message = "부트스트랩·개발·운영 상태를 분리하고 ECR 두 개를 만들어야 합니다."
  }
  assert {
    condition     = alltrue([for block in aws_s3_bucket_public_access_block.state : block.block_public_acls && block.block_public_policy && block.ignore_public_acls && block.restrict_public_buckets]) && alltrue([for v in aws_s3_bucket_versioning.state : v.versioning_configuration[0].status == "Enabled"])
    error_message = "모든 상태 버킷은 공개 차단과 버전 관리가 필요합니다."
  }
  assert {
    condition     = alltrue([for role in aws_iam_role.terraform : jsondecode(role.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:aud"] == "sts.amazonaws.com"]) && alltrue([for key, role in aws_iam_role.terraform : jsondecode(role.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"] == "repo:soma-376/infra:environment:frontend-${key}"])
    error_message = "OIDC는 정확한 저장소·Environment와 audience를 검증해야 합니다."
  }
  assert {
    condition     = !contains(jsondecode(aws_iam_role_policy.state["dev-plan"].policy).Statement[1].Action, "s3:PutObject") && contains(jsondecode(aws_iam_role_policy.state["dev-apply"].policy).Statement[1].Action, "s3:PutObject") && length(aws_iam_role_policy.network_write) == 2
    error_message = "plan 역할은 상태/네트워크를 변경하지 못하고 apply 역할만 변경할 수 있어야 합니다."
  }
  assert {
    condition     = alltrue([for repo in aws_ecr_repository.frontend : repo.image_tag_mutability == "IMMUTABLE" && !repo.force_delete])
    error_message = "ECR은 이미지 태그 덮어쓰기와 강제 삭제를 허용하지 않습니다."
  }
}

run "runtime_privileges_and_policy_quotas" {
  command = plan
  assert {
    condition     = length(aws_iam_role_policy_attachment.runtime_write) == 2 && aws_iam_role_policy_attachment.dev_compute.role == aws_iam_role.terraform["dev-apply"].name && alltrue([for env, p in aws_iam_role_policy_attachment.runtime_write : p.role == aws_iam_role.terraform["${env}-apply"].name])
    error_message = "실행 환경 쓰기는 apply 역할만 가지며 EC2 실행 권한은 dev에만 부여해야 합니다."
  }
  assert {
    condition     = alltrue([for env in ["dev", "prod"] : length(aws_iam_role_policy.state["${env}-apply"].policy) + length(aws_iam_role_policy.network_read["${env}-apply"].policy) + length(aws_iam_role_policy.network_write[env].policy) + length(aws_iam_role_policy.runtime_read["${env}-apply"].policy) <= 10240]) && alltrue([for p in concat(values(aws_iam_policy.runtime_write), values(aws_iam_policy.dns_write), values(aws_iam_policy.security_groups), [aws_iam_policy.dev_compute]) : length(p.policy) <= 6144])
    error_message = "IAM inline 합계 10240자와 managed policy 6144자 한도를 넘으면 bootstrap을 적용할 수 없습니다."
  }
  assert {
    condition     = alltrue([for p in aws_iam_role_policy.runtime_read : !strcontains(p.policy, "GetSecretValue") && !strcontains(p.policy, "PassRole") && !strcontains(p.policy, "RegisterTaskDefinition")]) && alltrue([for p in aws_iam_policy.runtime_write : !strcontains(p.policy, "iam:Create") && !strcontains(p.policy, "iam:Put") && !strcontains(p.policy, "GetSecretValue")])
    error_message = "CI는 IAM을 변경하거나 secret 값을 직접 읽을 수 없습니다."
  }
  assert {
    condition     = jsondecode(aws_iam_policy.dns_write["dev"].policy).Statement[0].Resource == "arn:aws:route53:::hostedzone/ZEXAMPLE" && jsondecode(aws_iam_policy.dns_write["dev"].policy).Statement[0].Condition["ForAllValues:StringLike"]["route53:ChangeResourceRecordSetsNormalizedRecordNames"][0] == "dev.frontend.example.com"
    error_message = "DNS 수정 권한은 지정된 zone과 환경 도메인에 한정해야 합니다."
  }
}
