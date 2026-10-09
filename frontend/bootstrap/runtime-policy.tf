locals {
  runtime_names = { for env in local.environments : env => "soma-376-frontend-${env}" }
}

# 상태 refresh를 위한 메타데이터 조회만 허용한다. GetSecretValue/로그 본문 조회는 없다.
resource "aws_iam_role_policy" "runtime_read" {
  for_each = local.roles
  name     = "frontend-runtime-read"
  role     = aws_iam_role.terraform[each.key].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat([
      {
        Effect = "Allow"
        Action = ["ec2:DescribeInstances", "ec2:DescribeInstanceAttribute", "ec2:DescribeInstanceCreditSpecifications", "ec2:DescribeVolumes", "ec2:DescribeImages", "ec2:DescribeSecurityGroupRules", "ec2:DescribeIamInstanceProfileAssociations", "ec2:DescribeInstanceTypes",
        "elasticloadbalancing:DescribeLoadBalancers", "elasticloadbalancing:DescribeLoadBalancerAttributes", "elasticloadbalancing:DescribeTargetGroups", "elasticloadbalancing:DescribeTargetGroupAttributes", "elasticloadbalancing:DescribeListeners", "elasticloadbalancing:DescribeListenerAttributes", "elasticloadbalancing:DescribeTags", "logs:DescribeLogGroups"]
        Resource  = "*"
        Condition = { StringEquals = { "aws:RequestedRegion" = "ap-northeast-2" } }
      },
      {
        Effect   = "Allow"
        Action   = ["ecs:DescribeClusters", "ecs:DescribeServices", "ecs:DescribeTaskDefinition", "ecs:ListTagsForResource", "ecs:ListServiceDeployments", "ecs:DescribeServiceDeployments"]
        Resource = ["arn:aws:ecs:ap-northeast-2:${var.aws_account_id}:cluster/${local.runtime_names[each.value.env]}", "arn:aws:ecs:ap-northeast-2:${var.aws_account_id}:service/${local.runtime_names[each.value.env]}/*", "arn:aws:ecs:ap-northeast-2:${var.aws_account_id}:task-definition/${local.runtime_names[each.value.env]}:*", "arn:aws:ecs:ap-northeast-2:${var.aws_account_id}:service-deployment/${local.runtime_names[each.value.env]}/${local.runtime_names[each.value.env]}/*"]
      },
      {
        Effect    = "Allow"
        Action    = ["acm:DescribeCertificate", "acm:ListTagsForCertificate"]
        Resource  = "arn:aws:acm:ap-northeast-2:${var.aws_account_id}:certificate/*"
        Condition = { StringEquals = { "aws:ResourceTag/Project" = "pulsemetry-frontend", "aws:ResourceTag/Env" = each.value.env } }
      },
      { Effect = "Allow", Action = ["secretsmanager:DescribeSecret"], Resource = aws_secretsmanager_secret.bff[each.value.env].arn },
      { Effect = "Allow", Action = ["logs:ListTagsForResource", "logs:ListTagsLogGroup"], Resource = ["arn:aws:logs:ap-northeast-2:${var.aws_account_id}:log-group:/ecs/${local.runtime_names[each.value.env]}", "arn:aws:logs:ap-northeast-2:${var.aws_account_id}:log-group:/ecs/${local.runtime_names[each.value.env]}:*"] }
      ], contains(keys(var.frontend_dns), each.value.env) ? [
      { Effect = "Allow", Action = ["route53:GetHostedZone", "route53:ListResourceRecordSets", "route53:ListTagsForResource"], Resource = "arn:aws:route53:::hostedzone/${var.frontend_dns[each.value.env].zone_id}" },
      { Effect = "Allow", Action = ["route53:GetChange"], Resource = "arn:aws:route53:::change/*" }
    ] : [])
  })
}

# IAM inline 합계 한도를 피하도록 서비스별 managed policy로 분리한다.
resource "aws_iam_policy" "runtime_write" {
  for_each    = local.environments
  name        = "${local.runtime_names[each.key]}-runtime-write"
  description = "Manage only the frontend runtime for one environment"
  tags        = merge(local.tags, { Env = each.key })
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["elasticloadbalancing:CreateLoadBalancer", "elasticloadbalancing:DeleteLoadBalancer", "elasticloadbalancing:ModifyLoadBalancerAttributes", "elasticloadbalancing:SetSecurityGroups", "elasticloadbalancing:SetSubnets", "elasticloadbalancing:SetIpAddressType", "elasticloadbalancing:CreateTargetGroup", "elasticloadbalancing:ModifyTargetGroup", "elasticloadbalancing:ModifyTargetGroupAttributes", "elasticloadbalancing:DeleteTargetGroup", "elasticloadbalancing:CreateListener", "elasticloadbalancing:ModifyListener", "elasticloadbalancing:ModifyListenerAttributes", "elasticloadbalancing:DeleteListener", "elasticloadbalancing:AddTags", "elasticloadbalancing:RemoveTags"]
        Resource = ["arn:aws:elasticloadbalancing:ap-northeast-2:${var.aws_account_id}:loadbalancer/app/${local.runtime_names[each.key]}/*", "arn:aws:elasticloadbalancing:ap-northeast-2:${var.aws_account_id}:targetgroup/${local.runtime_names[each.key]}/*", "arn:aws:elasticloadbalancing:ap-northeast-2:${var.aws_account_id}:listener/app/${local.runtime_names[each.key]}/*/*"]
      },
      {
        Effect   = "Allow"
        Action   = ["ecs:CreateCluster", "ecs:DeleteCluster", "ecs:UpdateCluster", "ecs:UpdateClusterSettings", "ecs:DeleteService", "ecs:DeregisterTaskDefinition", "ecs:TagResource", "ecs:UntagResource"]
        Resource = ["arn:aws:ecs:ap-northeast-2:${var.aws_account_id}:cluster/${local.runtime_names[each.key]}", "arn:aws:ecs:ap-northeast-2:${var.aws_account_id}:service/${local.runtime_names[each.key]}/${local.runtime_names[each.key]}", "arn:aws:ecs:ap-northeast-2:${var.aws_account_id}:task-definition/${local.runtime_names[each.key]}:*"]
      },
      {
        Effect    = "Allow"
        Action    = ["ecs:CreateService", "ecs:UpdateService"]
        Resource  = "arn:aws:ecs:ap-northeast-2:${var.aws_account_id}:service/${local.runtime_names[each.key]}/${local.runtime_names[each.key]}"
        Condition = { ArnLikeIfExists = { "ecs:task-definition" = "arn:aws:ecs:ap-northeast-2:${var.aws_account_id}:task-definition/${local.runtime_names[each.key]}:*" } }
      },
      {
        Effect    = "Allow"
        Action    = ["ecs:RegisterTaskDefinition"]
        Resource  = "arn:aws:ecs:ap-northeast-2:${var.aws_account_id}:task-definition/${local.runtime_names[each.key]}:*"
        Condition = { StringEquals = { "aws:RequestedRegion" = "ap-northeast-2", "aws:RequestTag/Project" = "pulsemetry-frontend", "aws:RequestTag/Env" = each.key, "aws:RequestTag/ManagedBy" = "terraform" } }
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:DeleteLogGroup", "logs:PutRetentionPolicy", "logs:DeleteRetentionPolicy", "logs:TagResource", "logs:UntagResource", "logs:TagLogGroup", "logs:UntagLogGroup"]
        Resource = ["arn:aws:logs:ap-northeast-2:${var.aws_account_id}:log-group:/ecs/${local.runtime_names[each.key]}", "arn:aws:logs:ap-northeast-2:${var.aws_account_id}:log-group:/ecs/${local.runtime_names[each.key]}:*"]
      },
      {
        Effect    = "Allow"
        Action    = ["iam:PassRole"]
        Resource  = aws_iam_role.execution[each.key].arn
        Condition = { StringEquals = { "iam:PassedToService" = "ecs-tasks.amazonaws.com" } }
      }
    ]
  })
}
resource "aws_iam_role_policy_attachment" "runtime_write" {
  for_each   = local.environments
  role       = aws_iam_role.terraform["${each.key}-apply"].name
  policy_arn = aws_iam_policy.runtime_write[each.key].arn
}

resource "aws_iam_policy" "dns_write" {
  for_each    = var.frontend_dns
  name        = "${local.runtime_names[each.key]}-dns-write"
  description = "Manage one frontend domain and its certificate"
  tags        = merge(local.tags, { Env = each.key })
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["route53:ChangeResourceRecordSets"]
        Resource = "arn:aws:route53:::hostedzone/${each.value.zone_id}"
        Condition = {
          "ForAllValues:StringLike"   = { "route53:ChangeResourceRecordSetsNormalizedRecordNames" = [each.value.domain_name, "_*.${each.value.domain_name}"] }
          "ForAllValues:StringEquals" = { "route53:ChangeResourceRecordSetsRecordTypes" = ["A", "CNAME"] }
          Null                        = { "route53:ChangeResourceRecordSetsNormalizedRecordNames" = "false", "route53:ChangeResourceRecordSetsRecordTypes" = "false" }
        }
      },
      {
        Effect   = "Allow"
        Action   = ["acm:RequestCertificate"]
        Resource = "*"
        Condition = {
          StringEquals                = { "aws:RequestedRegion" = "ap-northeast-2", "aws:RequestTag/Project" = "pulsemetry-frontend", "aws:RequestTag/Env" = each.key, "aws:RequestTag/ManagedBy" = "terraform" }
          "ForAllValues:StringEquals" = { "acm:DomainNames" = [each.value.domain_name] }
          Null                        = { "acm:DomainNames" = "false" }
        }
      },
      {
        Sid      = "TagNewUnownedCertificate"
        Effect   = "Allow"
        Action   = ["acm:AddTagsToCertificate"]
        Resource = "arn:aws:acm:ap-northeast-2:${var.aws_account_id}:certificate/*"
        Condition = {
          StringEquals = { "aws:RequestTag/Project" = "pulsemetry-frontend", "aws:RequestTag/Env" = each.key, "aws:RequestTag/ManagedBy" = "terraform" }
          Null         = { "aws:ResourceTag/Project" = "true", "aws:ResourceTag/Env" = "true", "aws:ResourceTag/ManagedBy" = "true" }
        }
      },
      {
        Effect    = "Allow"
        Action    = ["acm:DeleteCertificate", "acm:AddTagsToCertificate", "acm:RemoveTagsFromCertificate"]
        Resource  = "arn:aws:acm:ap-northeast-2:${var.aws_account_id}:certificate/*"
        Condition = { StringEquals = { "aws:ResourceTag/Project" = "pulsemetry-frontend", "aws:ResourceTag/Env" = each.key, "aws:ResourceTag/ManagedBy" = "terraform" } }
      }
    ]
  })
}
resource "aws_iam_role_policy_attachment" "dns_write" {
  for_each   = var.frontend_dns
  role       = aws_iam_role.terraform["${each.key}-apply"].name
  policy_arn = aws_iam_policy.dns_write[each.key].arn
}
