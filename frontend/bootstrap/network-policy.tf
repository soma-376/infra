locals {
  network_arns = [
    for kind in ["vpc", "subnet", "route-table", "internet-gateway", "elastic-ip", "natgateway"] :
    "arn:aws:ec2:ap-northeast-2:${var.aws_account_id}:${kind}/*"
  ]
  create_targets = {
    CreateVpc             = "vpc"
    CreateSubnet          = "subnet"
    CreateRouteTable      = "route-table"
    CreateInternetGateway = "internet-gateway"
    AllocateAddress       = "elastic-ip"
    CreateNatGateway      = "natgateway"
  }
}

# 네트워크 리소스의 소유권 경계. 앱 실행 권한은 별도 runtime/compute 정책에서 제한한다.
resource "aws_iam_role_policy" "network_write" {
  for_each = local.environments
  role     = aws_iam_role.terraform["${each.key}-apply"].id
  name     = "frontend-network-write"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat([
      # 생성 대상 ARN만 RequestTag로 허용한다. 기존 부모 VPC는 아래 ResourceTag로 검증한다.
      for action, kind in local.create_targets : {
        Sid      = "CreateTagged${action}"
        Effect   = "Allow"
        Action   = ["ec2:${action}"]
        Resource = ["arn:aws:ec2:ap-northeast-2:${var.aws_account_id}:${kind}/*"]
        Condition = {
          StringEquals = {
            "aws:RequestedRegion"      = "ap-northeast-2"
            "aws:RequestTag/Project"   = "pulsemetry-frontend"
            "aws:RequestTag/Env"       = each.key
            "aws:RequestTag/ManagedBy" = "terraform"
          }
        }
      }
      ], [
      {
        Sid    = "UseAndManageOwnedNetwork"
        Effect = "Allow"
        Action = [
          "ec2:CreateSubnet", "ec2:CreateRouteTable", "ec2:CreateNatGateway",
          "ec2:ModifyVpcAttribute", "ec2:DeleteVpc",
          "ec2:ModifySubnetAttribute", "ec2:DeleteSubnet",
          "ec2:AttachInternetGateway", "ec2:DetachInternetGateway", "ec2:DeleteInternetGateway",
          "ec2:CreateRoute", "ec2:ReplaceRoute", "ec2:DeleteRoute",
          "ec2:AssociateRouteTable", "ec2:DisassociateRouteTable", "ec2:ReplaceRouteTableAssociation",
          "ec2:DeleteRouteTable", "ec2:DeleteNatGateway", "ec2:ReleaseAddress"
        ]
        Resource = local.network_arns
        Condition = {
          StringEquals = {
            "aws:RequestedRegion"       = "ap-northeast-2"
            "ec2:ResourceTag/Project"   = "pulsemetry-frontend"
            "ec2:ResourceTag/Env"       = each.key
            "ec2:ResourceTag/ManagedBy" = "terraform"
          }
        }
      },
      {
        Sid      = "TagDuringCreation"
        Effect   = "Allow"
        Action   = ["ec2:CreateTags"]
        Resource = local.network_arns
        Condition = {
          StringEquals = {
            "ec2:CreateAction"         = ["CreateVpc", "CreateSubnet", "CreateRouteTable", "CreateInternetGateway", "AllocateAddress", "CreateNatGateway"]
            "aws:RequestTag/Project"   = "pulsemetry-frontend"
            "aws:RequestTag/Env"       = each.key
            "aws:RequestTag/ManagedBy" = "terraform"
          }
        }
      },
      {
        Sid      = "UpdateNonOwnershipTags"
        Effect   = "Allow"
        Action   = ["ec2:CreateTags", "ec2:DeleteTags"]
        Resource = local.network_arns
        Condition = {
          StringEquals = {
            "ec2:ResourceTag/Project"   = "pulsemetry-frontend"
            "ec2:ResourceTag/Env"       = each.key
            "ec2:ResourceTag/ManagedBy" = "terraform"
          }
          "ForAllValues:StringNotEquals" = { "aws:TagKeys" = ["Project", "Env", "ManagedBy"] }
          Null                           = { "aws:TagKeys" = "false" }
        }
      }
    ])
  })
}
