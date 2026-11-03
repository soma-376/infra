# shared는 기존 bootstrap 승인 환경을 쓰되 별도 역할·state key로 적용한다.
locals {
  shared_state = "${aws_s3_bucket.state["bootstrap"].arn}/shared-valkey/terraform.tfstate"
  shared_cache_arns = [
    "arn:aws:elasticache:ap-northeast-2:${var.aws_account_id}:serverlesscache:pulsemetry-frontend-shared",
    "arn:aws:elasticache:ap-northeast-2:${var.aws_account_id}:usergroup:pulsemetry-bff-shared",
    "arn:aws:elasticache:ap-northeast-2:${var.aws_account_id}:user:pulsemetry-bff-dev",
    "arn:aws:elasticache:ap-northeast-2:${var.aws_account_id}:user:pulsemetry-bff-prod"
  ]
  shared_task_arns    = [for env in local.environments : "arn:aws:iam::${var.aws_account_id}:role/soma-376-frontend-${env}-valkey-task"]
  shared_ec2_arns     = [for kind in ["vpc", "subnet", "route-table", "security-group", "security-group-rule", "vpc-peering-connection"] : "arn:aws:ec2:ap-northeast-2:${var.aws_account_id}:${kind}/*"]
  shared_request_tags = { "aws:RequestTag/Project" = "pulsemetry-frontend", "aws:RequestTag/Env" = "shared", "aws:RequestTag/ManagedBy" = "terraform" }
  shared_owned_tags   = { "ec2:ResourceTag/Project" = "pulsemetry-frontend", "ec2:ResourceTag/Env" = "shared", "ec2:ResourceTag/ManagedBy" = "terraform" }
}
resource "aws_iam_role" "shared" {
  for_each = toset(["plan", "apply"])
  name     = "soma-376-frontend-shared-${each.key}"
  tags     = merge(local.tags, { Env = "shared" })
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow", Action = "sts:AssumeRoleWithWebIdentity"
      Principal = { Federated = data.aws_iam_openid_connect_provider.github.arn }
      Condition = { StringEquals = {
        "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        "token.actions.githubusercontent.com:sub" = "${var.github_subject_prefix}:environment:frontend-bootstrap-${each.key}"
      } }
    }]
  })
}
resource "aws_iam_role_policy" "shared_state" {
  for_each = aws_iam_role.shared
  role     = each.value.name
  name     = "shared-state"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["s3:ListBucket", "s3:GetBucketLocation"], Resource = aws_s3_bucket.state["bootstrap"].arn },
      { Effect = "Allow", Action = each.key == "apply" ? ["s3:GetObject", "s3:PutObject"] : ["s3:GetObject"], Resource = local.shared_state },
      { Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], Resource = "${local.shared_state}.tflock" }
    ]
  })
}
resource "aws_iam_policy" "shared_read" {
  name = "soma-376-frontend-shared-read"
  tags = merge(local.tags, { Env = "shared" })
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["ec2:DescribeAvailabilityZones", "ec2:DescribeVpcs", "ec2:DescribeVpcAttribute", "ec2:DescribeSubnets", "ec2:DescribeRouteTables", "ec2:DescribeSecurityGroups", "ec2:DescribeSecurityGroupRules", "ec2:DescribeVpcPeeringConnections", "ec2:DescribeTags", "ec2:DescribeVpcEndpoints", "ec2:DescribeNetworkInterfaces", "elasticache:DescribeServerlessCaches", "elasticache:DescribeUsers", "elasticache:DescribeUserGroups", "cloudwatch:DescribeAlarms"], Resource = "*", Condition = { StringEquals = { "aws:RequestedRegion" = "ap-northeast-2" } } },
      { Effect = "Allow", Action = ["elasticache:ListTagsForResource"], Resource = local.shared_cache_arns },
      { Effect = "Allow", Action = ["cloudwatch:ListTagsForResource"], Resource = "arn:aws:cloudwatch:ap-northeast-2:${var.aws_account_id}:alarm:pulsemetry-frontend-shared-*" },
      { Effect = "Allow", Action = ["iam:GetRole", "iam:ListRolePolicies", "iam:GetRolePolicy", "iam:ListAttachedRolePolicies", "iam:ListInstanceProfilesForRole", "iam:ListRoleTags"], Resource = local.shared_task_arns }
    ]
  })
}
resource "aws_iam_role_policy_attachment" "shared_read" {
  for_each   = aws_iam_role.shared
  role       = each.value.name
  policy_arn = aws_iam_policy.shared_read.arn
}
resource "aws_iam_policy" "shared_services" {
  name = "soma-376-frontend-shared-services"
  tags = merge(local.tags, { Env = "shared" })
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["elasticache:CreateServerlessCache", "elasticache:ModifyServerlessCache", "elasticache:DeleteServerlessCache", "elasticache:CreateUser", "elasticache:ModifyUser", "elasticache:DeleteUser", "elasticache:CreateUserGroup", "elasticache:ModifyUserGroup", "elasticache:DeleteUserGroup", "elasticache:AddTagsToResource", "elasticache:RemoveTagsFromResource"], Resource = local.shared_cache_arns },
      { Effect = "Allow", Action = ["cloudwatch:PutMetricAlarm", "cloudwatch:DeleteAlarms", "cloudwatch:TagResource", "cloudwatch:UntagResource"], Resource = "arn:aws:cloudwatch:ap-northeast-2:${var.aws_account_id}:alarm:pulsemetry-frontend-shared-*" },
      { Effect = "Allow", Action = ["iam:CreateRole", "iam:DeleteRole", "iam:UpdateRole", "iam:UpdateRoleDescription", "iam:UpdateAssumeRolePolicy", "iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:TagRole", "iam:UntagRole"], Resource = local.shared_task_arns },
      { Effect = "Allow", Action = ["ec2:CreateVpcEndpoint"], Resource = "arn:aws:ec2:ap-northeast-2:${var.aws_account_id}:vpc-endpoint/*", Condition = { StringLike = { "ec2:VpceServiceName" = "com.amazonaws.elasticache.serverless.*" } } },
      { Effect = "Allow", Action = ["ec2:CreateVpcEndpoint"], Resource = [for kind in ["vpc", "subnet", "security-group"] : "arn:aws:ec2:ap-northeast-2:${var.aws_account_id}:${kind}/*"], Condition = { StringEquals = local.shared_owned_tags } },
      { Effect = "Allow", Action = ["ec2:CreateTags"], Resource = "arn:aws:ec2:ap-northeast-2:${var.aws_account_id}:vpc-endpoint/*", Condition = { StringEquals = { "ec2:CreateAction" = "CreateVpcEndpoint", "aws:RequestTag/AmazonElastiCacheManaged" = "true" } } },
      { Effect = "Allow", Action = ["ec2:DeleteVpcEndpoints"], Resource = "arn:aws:ec2:ap-northeast-2:${var.aws_account_id}:vpc-endpoint/*", Condition = { StringEquals = { "ec2:ResourceTag/AmazonElastiCacheManaged" = "true" } } },
      { Effect = "Allow", Action = ["iam:CreateServiceLinkedRole"], Resource = "arn:aws:iam::${var.aws_account_id}:role/aws-service-role/elasticache.amazonaws.com/AWSServiceRoleForElastiCache", Condition = { StringEquals = { "iam:AWSServiceName" = "elasticache.amazonaws.com" } } }
    ]
  })
}
resource "aws_iam_role_policy_attachment" "shared_services" {
  role       = aws_iam_role.shared["apply"].name
  policy_arn = aws_iam_policy.shared_services.arn
}
