provider "aws" {
  region              = "ap-northeast-2"
  allowed_account_ids = [var.aws_account_id]
}

locals {
  environments = toset(["dev", "prod"])
  state_scopes = toset(["bootstrap", "dev", "prod"])
  tags         = { Org = "soma-376", Project = "pulsemetry-frontend", ManagedBy = "terraform" }
}

resource "aws_s3_bucket" "state" {
  for_each      = local.state_scopes
  bucket        = "${var.state_bucket_prefix}-${var.aws_account_id}-${each.key}"
  force_destroy = false
  tags          = merge(local.tags, { Env = each.key })
  lifecycle { prevent_destroy = true }
}

resource "aws_s3_bucket_versioning" "state" {
  for_each = local.state_scopes
  bucket   = aws_s3_bucket.state[each.key].id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  for_each = local.state_scopes
  bucket   = aws_s3_bucket.state[each.key].id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  for_each                = local.state_scopes
  bucket                  = aws_s3_bucket.state[each.key].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "state" {
  for_each = local.state_scopes
  bucket   = aws_s3_bucket.state[each.key].id
  rule { object_ownership = "BucketOwnerEnforced" }
}

resource "aws_s3_bucket_policy" "state" {
  for_each = local.state_scopes
  bucket   = aws_s3_bucket.state[each.key].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.state[each.key].arn, "${aws_s3_bucket.state[each.key].arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}

resource "aws_ecr_repository" "frontend" {
  for_each             = local.environments
  name                 = "soma-376/pulsemetry-frontend-${each.key}"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false
  encryption_configuration { encryption_type = "AES256" }
  image_scanning_configuration { scan_on_push = true }
  tags = merge(local.tags, { Env = each.key })
  lifecycle { prevent_destroy = true }
}

# 계정 전역 OIDC provider는 기존 CDK 소유다. 새로 만들거나 import하지 않는다.
data "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"
}

locals {
  roles = {
    for entry in flatten([
      for env in local.environments : [
        { key = "${env}-plan", env = env, mode = "plan", github_environment = "frontend-${env}-plan" },
        { key = "${env}-apply", env = env, mode = "apply", github_environment = "frontend-${env}" }
      ]
    ]) : entry.key => entry
  }
}

resource "aws_iam_role" "terraform" {
  for_each             = local.roles
  name                 = "soma-376-frontend-${each.key}"
  max_session_duration = 3600
  tags                 = merge(local.tags, { Env = each.value.env })
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRoleWithWebIdentity"
      Principal = { Federated = data.aws_iam_openid_connect_provider.github.arn }
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:sub" = "${var.github_subject_prefix}:environment:${each.value.github_environment}"
        }
      }
    }]
  })
}

resource "aws_iam_role_policy" "state" {
  for_each = local.roles
  role     = aws_iam_role.terraform[each.key].id
  name     = "frontend-state"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = aws_s3_bucket.state[each.value.env].arn
      },
      {
        Effect   = "Allow"
        Action   = each.value.mode == "apply" ? ["s3:GetObject", "s3:PutObject"] : ["s3:GetObject"]
        Resource = "${aws_s3_bucket.state[each.value.env].arn}/network/terraform.tfstate"
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
        Resource = "${aws_s3_bucket.state[each.value.env].arn}/network/terraform.tfstate.tflock"
      }
    ]
  })
}

resource "aws_iam_role_policy" "network_read" {
  for_each = local.roles
  role     = aws_iam_role.terraform[each.key].id
  name     = "frontend-network-read"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "ec2:DescribeVpcs", "ec2:DescribeVpcAttribute", "ec2:DescribeSubnets",
        "ec2:DescribeRouteTables", "ec2:DescribeInternetGateways",
        "ec2:DescribeNatGateways", "ec2:DescribeAddresses", "ec2:DescribeAddressesAttribute",
        "ec2:DescribeNetworkAcls", "ec2:DescribeSecurityGroups",
        "ec2:DescribeAvailabilityZones", "ec2:DescribeTags", "ec2:DescribeNetworkInterfaces"
      ]
      Resource  = "*"
      Condition = { StringEquals = { "aws:RequestedRegion" = "ap-northeast-2" } }
    }]
  })
}
