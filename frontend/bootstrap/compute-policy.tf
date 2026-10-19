resource "aws_iam_policy" "security_groups" {
  for_each    = local.environments
  name        = "${local.runtime_names[each.key]}-security-groups"
  description = "Manage security groups owned by one frontend environment"
  tags        = merge(local.tags, { Env = each.key })
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Allow"
        Action    = ["ec2:CreateSecurityGroup"]
        Resource  = "arn:aws:ec2:ap-northeast-2:${var.aws_account_id}:security-group/*"
        Condition = { StringEquals = { "aws:RequestTag/Project" = "pulsemetry-frontend", "aws:RequestTag/Env" = each.key, "aws:RequestTag/ManagedBy" = "terraform" } }
      },
      {
        Effect    = "Allow"
        Action    = ["ec2:CreateSecurityGroup"]
        Resource  = "arn:aws:ec2:ap-northeast-2:${var.aws_account_id}:vpc/*"
        Condition = { StringEquals = { "ec2:ResourceTag/Project" = "pulsemetry-frontend", "ec2:ResourceTag/Env" = each.key, "ec2:ResourceTag/ManagedBy" = "terraform" } }
      },
      {
        Effect    = "Allow"
        Action    = ["ec2:DeleteSecurityGroup", "ec2:AuthorizeSecurityGroupIngress", "ec2:AuthorizeSecurityGroupEgress", "ec2:RevokeSecurityGroupIngress", "ec2:RevokeSecurityGroupEgress", "ec2:ModifySecurityGroupRules", "ec2:UpdateSecurityGroupRuleDescriptionsIngress", "ec2:UpdateSecurityGroupRuleDescriptionsEgress"]
        Resource  = ["arn:aws:ec2:ap-northeast-2:${var.aws_account_id}:security-group/*", "arn:aws:ec2:ap-northeast-2:${var.aws_account_id}:security-group-rule/*"]
        Condition = { StringEquals = { "ec2:ResourceTag/Project" = "pulsemetry-frontend", "ec2:ResourceTag/Env" = each.key, "ec2:ResourceTag/ManagedBy" = "terraform" } }
      },
      {
        Effect    = "Allow"
        Action    = ["ec2:CreateTags"]
        Resource  = ["arn:aws:ec2:ap-northeast-2:${var.aws_account_id}:security-group/*", "arn:aws:ec2:ap-northeast-2:${var.aws_account_id}:security-group-rule/*"]
        Condition = { StringEquals = { "ec2:CreateAction" = ["CreateSecurityGroup", "AuthorizeSecurityGroupIngress", "AuthorizeSecurityGroupEgress"], "aws:RequestTag/Project" = "pulsemetry-frontend", "aws:RequestTag/Env" = each.key, "aws:RequestTag/ManagedBy" = "terraform" } }
      },
      {
        Effect   = "Allow"
        Action   = ["ec2:CreateTags", "ec2:DeleteTags"]
        Resource = ["arn:aws:ec2:ap-northeast-2:${var.aws_account_id}:security-group/*", "arn:aws:ec2:ap-northeast-2:${var.aws_account_id}:security-group-rule/*"]
        Condition = {
          StringEquals                   = { "ec2:ResourceTag/Project" = "pulsemetry-frontend", "ec2:ResourceTag/Env" = each.key, "ec2:ResourceTag/ManagedBy" = "terraform" }
          "ForAllValues:StringNotEquals" = { "aws:TagKeys" = ["Project", "Env", "ManagedBy"] }
          Null                           = { "aws:TagKeys" = "false" }
        }
      }
    ]
  })
}
resource "aws_iam_role_policy_attachment" "security_groups" {
  for_each   = local.environments
  role       = aws_iam_role.terraform["${each.key}-apply"].name
  policy_arn = aws_iam_policy.security_groups[each.key].arn
}

# 운영 역할에는 EC2 RunInstances 권한이 없다.
resource "aws_iam_policy" "dev_compute" {
  name        = "soma-376-frontend-dev-compute"
  description = "Launch the frontend development instance with a fixed IAM role"
  tags        = merge(local.tags, { Env = "dev" })
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Allow"
        Action    = ["ec2:RunInstances"]
        Resource  = ["arn:aws:ec2:ap-northeast-2:${var.aws_account_id}:instance/*", "arn:aws:ec2:ap-northeast-2:${var.aws_account_id}:volume/*"]
        Condition = { StringEquals = { "aws:RequestTag/Project" = "pulsemetry-frontend", "aws:RequestTag/Env" = "dev", "aws:RequestTag/ManagedBy" = "terraform" } }
      },
      {
        Effect   = "Allow"
        Action   = ["ec2:RunInstances"]
        Resource = ["arn:aws:ec2:ap-northeast-2::image/*", "arn:aws:ec2:ap-northeast-2:${var.aws_account_id}:network-interface/*"]
      },
      {
        Effect    = "Allow"
        Action    = ["ec2:RunInstances"]
        Resource  = ["arn:aws:ec2:ap-northeast-2:${var.aws_account_id}:subnet/*", "arn:aws:ec2:ap-northeast-2:${var.aws_account_id}:security-group/*"]
        Condition = { StringEquals = { "ec2:ResourceTag/Project" = "pulsemetry-frontend", "ec2:ResourceTag/Env" = "dev", "ec2:ResourceTag/ManagedBy" = "terraform" } }
      },
      {
        Effect    = "Allow"
        Action    = ["ec2:TerminateInstances", "ec2:StartInstances", "ec2:StopInstances", "ec2:ModifyInstanceAttribute", "ec2:ModifyInstanceMetadataOptions", "ec2:ModifyInstanceCreditSpecification", "ec2:MonitorInstances", "ec2:UnmonitorInstances", "ec2:ModifyVolume"]
        Resource  = ["arn:aws:ec2:ap-northeast-2:${var.aws_account_id}:instance/*", "arn:aws:ec2:ap-northeast-2:${var.aws_account_id}:volume/*"]
        Condition = { StringEquals = { "ec2:ResourceTag/Project" = "pulsemetry-frontend", "ec2:ResourceTag/Env" = "dev", "ec2:ResourceTag/ManagedBy" = "terraform" } }
      },
      {
        Effect    = "Allow"
        Action    = ["ec2:CreateTags"]
        Resource  = ["arn:aws:ec2:ap-northeast-2:${var.aws_account_id}:instance/*", "arn:aws:ec2:ap-northeast-2:${var.aws_account_id}:volume/*"]
        Condition = { StringEquals = { "ec2:CreateAction" = "RunInstances", "aws:RequestTag/Project" = "pulsemetry-frontend", "aws:RequestTag/Env" = "dev", "aws:RequestTag/ManagedBy" = "terraform" } }
      },
      {
        Effect   = "Allow"
        Action   = ["ec2:CreateTags", "ec2:DeleteTags"]
        Resource = ["arn:aws:ec2:ap-northeast-2:${var.aws_account_id}:instance/*", "arn:aws:ec2:ap-northeast-2:${var.aws_account_id}:volume/*"]
        Condition = {
          StringEquals                   = { "ec2:ResourceTag/Project" = "pulsemetry-frontend", "ec2:ResourceTag/Env" = "dev", "ec2:ResourceTag/ManagedBy" = "terraform" }
          "ForAllValues:StringNotEquals" = { "aws:TagKeys" = ["Project", "Env", "ManagedBy"] }
          Null                           = { "aws:TagKeys" = "false" }
        }
      },
      { Effect = "Allow", Action = ["iam:GetInstanceProfile"], Resource = aws_iam_instance_profile.dev.arn },
      {
        Effect    = "Allow"
        Action    = ["iam:PassRole"]
        Resource  = aws_iam_role.instance.arn
        Condition = { StringEquals = { "iam:PassedToService" = "ec2.amazonaws.com" } }
      }
    ]
  })
}
resource "aws_iam_role_policy_attachment" "dev_compute" {
  role       = aws_iam_role.terraform["dev-apply"].name
  policy_arn = aws_iam_policy.dev_compute.arn
}
