resource "aws_iam_policy" "shared_network" {
  name = "soma-376-frontend-shared-network"
  tags = merge(local.tags, { Env = "shared" })
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat([
      for pair in [
        { action = "CreateVpc", kind = "vpc" },
        { action = "CreateSubnet", kind = "subnet" },
        { action = "CreateRouteTable", kind = "route-table" },
        { action = "CreateSecurityGroup", kind = "security-group" },
        { action = "CreateVpcPeeringConnection", kind = "vpc-peering-connection" }
        ] : {
        Effect    = "Allow", Action = ["ec2:${pair.action}"]
        Resource  = "arn:aws:ec2:ap-northeast-2:${var.aws_account_id}:${pair.kind}/*"
        Condition = { StringEquals = local.shared_request_tags }
      }
      ], [
      {
        Effect    = "Allow"
        Action    = ["ec2:CreateSubnet", "ec2:CreateRouteTable", "ec2:CreateSecurityGroup", "ec2:CreateVpcPeeringConnection", "ec2:ModifyVpcAttribute", "ec2:DeleteVpc", "ec2:ModifySubnetAttribute", "ec2:DeleteSubnet", "ec2:CreateRoute", "ec2:ReplaceRoute", "ec2:DeleteRoute", "ec2:AssociateRouteTable", "ec2:DisassociateRouteTable", "ec2:ReplaceRouteTableAssociation", "ec2:DeleteRouteTable", "ec2:DeleteSecurityGroup", "ec2:AuthorizeSecurityGroupIngress", "ec2:AuthorizeSecurityGroupEgress", "ec2:RevokeSecurityGroupIngress", "ec2:RevokeSecurityGroupEgress", "ec2:ModifySecurityGroupRules", "ec2:UpdateSecurityGroupRuleDescriptionsIngress", "ec2:UpdateSecurityGroupRuleDescriptionsEgress", "ec2:AcceptVpcPeeringConnection", "ec2:DeleteVpcPeeringConnection", "ec2:ModifyVpcPeeringConnectionOptions"]
        Resource  = local.shared_ec2_arns
        Condition = { StringEquals = local.shared_owned_tags }
      },
      {
        Effect    = "Allow", Action = ["ec2:CreateTags"], Resource = local.shared_ec2_arns
        Condition = { StringEquals = merge(local.shared_request_tags, { "ec2:CreateAction" = ["CreateVpc", "CreateSubnet", "CreateRouteTable", "CreateSecurityGroup", "CreateVpcPeeringConnection", "AuthorizeSecurityGroupIngress", "AuthorizeSecurityGroupEgress"] }) }
      },
      {
        Effect    = "Allow", Action = ["ec2:CreateTags", "ec2:DeleteTags"], Resource = local.shared_ec2_arns
        Condition = { StringEquals = local.shared_owned_tags, "ForAllValues:StringNotEquals" = { "aws:TagKeys" = ["Project", "Env", "ManagedBy"] }, Null = { "aws:TagKeys" = "false" } }
      },
      {
        Effect    = "Allow", Action = ["ec2:AuthorizeSecurityGroupIngress", "ec2:AuthorizeSecurityGroupEgress"]
        Resource  = "arn:aws:ec2:ap-northeast-2:${var.aws_account_id}:security-group-rule/*"
        Condition = { StringEquals = local.shared_request_tags }
      }
    ])
  })
}
resource "aws_iam_role_policy_attachment" "shared_network" {
  role       = aws_iam_role.shared["apply"].name
  policy_arn = aws_iam_policy.shared_network.arn
}
# 공유 연결에 필요한 기존 환경 리소스만 수정한다. 다른 앱 SG/경로·VPC 삭제는 허용하지 않는다.
resource "aws_iam_policy" "shared_peers" {
  name = "soma-376-frontend-shared-peers"
  tags = merge(local.tags, { Env = "shared" })
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Allow", Action = ["ec2:CreateVpcPeeringConnection", "ec2:AcceptVpcPeeringConnection"]
        Resource  = "arn:aws:ec2:ap-northeast-2:${var.aws_account_id}:vpc/*"
        Condition = { StringEquals = { "ec2:ResourceTag/Project" = "pulsemetry-frontend", "ec2:ResourceTag/ManagedBy" = "terraform", "ec2:ResourceTag/Env" = ["dev", "prod"], "ec2:ResourceTag/Name" = ["pulsemetry-frontend-dev", "pulsemetry-frontend-prod"] } }
      },
      {
        Effect    = "Allow", Action = ["ec2:CreateRoute", "ec2:ReplaceRoute", "ec2:DeleteRoute"]
        Resource  = "arn:aws:ec2:ap-northeast-2:${var.aws_account_id}:route-table/*"
        Condition = { StringEquals = { "ec2:ResourceTag/Project" = "pulsemetry-frontend", "ec2:ResourceTag/ManagedBy" = "terraform", "ec2:ResourceTag/Name" = ["pulsemetry-frontend-dev-public", "pulsemetry-frontend-prod-private-ap-northeast-2a", "pulsemetry-frontend-prod-private-ap-northeast-2c"] } }
      },
      {
        Effect    = "Allow", Action = ["ec2:AuthorizeSecurityGroupEgress", "ec2:RevokeSecurityGroupEgress", "ec2:UpdateSecurityGroupRuleDescriptionsEgress", "ec2:ModifySecurityGroupRules"]
        Resource  = "arn:aws:ec2:ap-northeast-2:${var.aws_account_id}:security-group/*"
        Condition = { StringEquals = { "ec2:ResourceTag/Project" = "pulsemetry-frontend", "ec2:ResourceTag/ManagedBy" = "terraform", "ec2:ResourceTag/Name" = ["soma-376-frontend-dev-app", "soma-376-frontend-prod-app"] } }
      }
    ]
  })
}
resource "aws_iam_role_policy_attachment" "shared_peers" {
  role       = aws_iam_role.shared["apply"].name
  policy_arn = aws_iam_policy.shared_peers.arn
}
