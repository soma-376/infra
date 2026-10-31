# bootstrap은 IAM 정책을 수정하는 관리자 경계다. 일반 runtime 역할과 분리한다.
locals {
  bootstrap_ci_modes     = toset(["plan", "apply"])
  bootstrap_iam_roles    = "arn:aws:iam::${var.aws_account_id}:role/soma-376-frontend-*"
  bootstrap_iam_policies = "arn:aws:iam::${var.aws_account_id}:policy/soma-376-frontend-*"
  bootstrap_iam_profiles = "arn:aws:iam::${var.aws_account_id}:instance-profile/soma-376-frontend-*"
  bootstrap_buckets      = [for scope in local.state_scopes : "arn:aws:s3:::${var.state_bucket_prefix}-${var.aws_account_id}-${scope}"]
  bootstrap_state_object = "${aws_s3_bucket.state["bootstrap"].arn}/bootstrap/terraform.tfstate"
  bootstrap_document     = "arn:aws:ssm:ap-northeast-2:${var.aws_account_id}:document/soma-376-frontend-dashboards"
  bootstrap_repositories = [for env in local.environments : "arn:aws:ecr:ap-northeast-2:${var.aws_account_id}:repository/soma-376/pulsemetry-frontend-${env}"]
  bootstrap_secrets      = [for env in local.environments : "arn:aws:secretsmanager:ap-northeast-2:${var.aws_account_id}:secret:soma-376-frontend-${env}/bff-session-keys-??????"]
}

resource "aws_iam_role" "bootstrap_ci" {
  for_each             = local.bootstrap_ci_modes
  name                 = "soma-376-frontend-bootstrap-${each.key}"
  max_session_duration = 3600
  tags                 = merge(local.tags, { Env = "bootstrap" })
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRoleWithWebIdentity"
      Principal = { Federated = data.aws_iam_openid_connect_provider.github.arn }
      Condition = { StringEquals = {
        "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        "token.actions.githubusercontent.com:sub" = "${var.github_subject_prefix}:environment:frontend-bootstrap-${each.key}"
      } }
    }]
  })
}

resource "aws_iam_policy" "bootstrap_ci_read" {
  name = "soma-376-frontend-bootstrap-read"
  tags = merge(local.tags, { Env = "bootstrap" })
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["iam:ListOpenIDConnectProviders"], Resource = "*" },
      { Effect = "Allow", Action = ["iam:GetRole", "iam:GetRolePolicy", "iam:ListRolePolicies", "iam:ListAttachedRolePolicies", "iam:ListInstanceProfilesForRole", "iam:ListRoleTags"], Resource = local.bootstrap_iam_roles },
      { Effect = "Allow", Action = ["iam:GetPolicy", "iam:GetPolicyVersion", "iam:ListPolicyVersions", "iam:ListPolicyTags"], Resource = local.bootstrap_iam_policies },
      { Effect = "Allow", Action = ["iam:GetInstanceProfile", "iam:ListInstanceProfileTags"], Resource = local.bootstrap_iam_profiles },
      { Effect = "Allow", Action = ["iam:GetOpenIDConnectProvider", "iam:ListOpenIDConnectProviderTags"], Resource = data.aws_iam_openid_connect_provider.github.arn },
      {
        Effect   = "Allow"
        Action   = ["s3:ListBucket", "s3:GetBucketLocation", "s3:GetBucketTagging", "s3:GetBucketVersioning", "s3:GetEncryptionConfiguration", "s3:GetBucketPublicAccessBlock", "s3:GetBucketOwnershipControls", "s3:GetBucketPolicy", "s3:GetBucketAcl", "s3:GetBucketCORS", "s3:GetBucketWebsite", "s3:GetBucketLogging", "s3:GetAccelerateConfiguration", "s3:GetBucketRequestPayment", "s3:GetBucketObjectLockConfiguration", "s3:GetLifecycleConfiguration", "s3:GetReplicationConfiguration"]
        Resource = local.bootstrap_buckets
      },
      { Effect = "Allow", Action = ["s3:GetObject"], Resource = local.bootstrap_state_object },
      # plan도 state lock을 사용할 수 있지만 state 본문을 쓰거나 삭제할 수 없다.
      { Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], Resource = "${local.bootstrap_state_object}.tflock" },
      { Effect = "Allow", Action = ["ecr:DescribeRepositories", "ecr:ListTagsForResource", "ecr:GetRepositoryPolicy", "ecr:GetLifecyclePolicy"], Resource = local.bootstrap_repositories },
      { Effect = "Allow", Action = ["secretsmanager:DescribeSecret", "secretsmanager:GetResourcePolicy"], Resource = local.bootstrap_secrets },
      { Effect = "Allow", Action = ["ssm:GetDocument", "ssm:DescribeDocument", "ssm:DescribeDocumentPermission", "ssm:ListDocumentVersions", "ssm:ListTagsForResource"], Resource = local.bootstrap_document }
    ]
  })
}
resource "aws_iam_role_policy_attachment" "bootstrap_ci_read" {
  for_each   = local.bootstrap_ci_modes
  role       = aws_iam_role.bootstrap_ci[each.key].name
  policy_arn = aws_iam_policy.bootstrap_ci_read.arn
}

resource "aws_iam_policy" "bootstrap_ci_iam_write" {
  name = "soma-376-frontend-bootstrap-iam-write"
  tags = merge(local.tags, { Env = "bootstrap" })
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["iam:CreateRole", "iam:DeleteRole", "iam:UpdateRole", "iam:UpdateRoleDescription", "iam:UpdateAssumeRolePolicy", "iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:TagRole", "iam:UntagRole"]
        Resource = local.bootstrap_iam_roles
      },
      {
        Effect    = "Allow", Action = ["iam:AttachRolePolicy", "iam:DetachRolePolicy"], Resource = local.bootstrap_iam_roles
        Condition = { ArnLike = { "iam:PolicyARN" = [local.bootstrap_iam_policies, "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"] } }
      },
      { Effect = "Allow", Action = ["iam:CreatePolicy", "iam:DeletePolicy", "iam:CreatePolicyVersion", "iam:DeletePolicyVersion", "iam:SetDefaultPolicyVersion", "iam:TagPolicy", "iam:UntagPolicy"], Resource = local.bootstrap_iam_policies },
      { Effect = "Allow", Action = ["iam:CreateInstanceProfile", "iam:DeleteInstanceProfile", "iam:AddRoleToInstanceProfile", "iam:RemoveRoleFromInstanceProfile", "iam:TagInstanceProfile", "iam:UntagInstanceProfile"], Resource = local.bootstrap_iam_profiles },
      { Effect = "Allow", Action = ["iam:PassRole"], Resource = [aws_iam_role.instance.arn, aws_iam_role.observability.arn], Condition = { StringEquals = { "iam:PassedToService" = "ec2.amazonaws.com" } } }
    ]
  })
}
resource "aws_iam_role_policy_attachment" "bootstrap_ci_iam_write" {
  role       = aws_iam_role.bootstrap_ci["apply"].name
  policy_arn = aws_iam_policy.bootstrap_ci_iam_write.arn
}

resource "aws_iam_policy" "bootstrap_ci_resource_write" {
  name = "soma-376-frontend-bootstrap-resource-write"
  tags = merge(local.tags, { Env = "bootstrap" })
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["s3:PutObject"], Resource = local.bootstrap_state_object },
      { Effect = "Allow", Action = ["s3:CreateBucket", "s3:PutBucketVersioning", "s3:PutEncryptionConfiguration", "s3:PutBucketPublicAccessBlock", "s3:PutBucketOwnershipControls", "s3:PutBucketPolicy", "s3:PutBucketTagging"], Resource = local.bootstrap_buckets },
      { Effect = "Allow", Action = ["ecr:CreateRepository", "ecr:PutImageTagMutability", "ecr:PutImageScanningConfiguration", "ecr:TagResource", "ecr:UntagResource"], Resource = local.bootstrap_repositories },
      # Secret 값 조회 권한은 없다. UpdateSecret은 값 변경도 가능하므로 관리자 승인 경계로 취급한다.
      { Effect = "Allow", Action = ["secretsmanager:CreateSecret", "secretsmanager:UpdateSecret", "secretsmanager:TagResource", "secretsmanager:UntagResource"], Resource = local.bootstrap_secrets },
      { Effect = "Allow", Action = ["ssm:CreateDocument", "ssm:UpdateDocument", "ssm:UpdateDocumentDefaultVersion", "ssm:DeleteDocument", "ssm:AddTagsToResource", "ssm:RemoveTagsFromResource"], Resource = local.bootstrap_document }
    ]
  })
}
resource "aws_iam_role_policy_attachment" "bootstrap_ci_resource_write" {
  role       = aws_iam_role.bootstrap_ci["apply"].name
  policy_arn = aws_iam_policy.bootstrap_ci_resource_write.arn
}
output "bootstrap_ci_role_arns" { value = { for mode, role in aws_iam_role.bootstrap_ci : mode => role.arn } }
