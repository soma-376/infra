# 앱 이미지 게시와 기존 서비스 재배포만 허용한다. Terraform 역할과 분리한다.
resource "aws_iam_role" "frontend_image_push" {
  for_each             = var.frontend_github_subject_prefix == null ? toset([]) : local.environments
  name                 = "soma-376-frontend-${each.key}-image-push"
  max_session_duration = 3600
  tags                 = merge(local.tags, { Env = each.key })
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRoleWithWebIdentity"
      Principal = { Federated = data.aws_iam_openid_connect_provider.github.arn }
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:sub" = "${var.frontend_github_subject_prefix}:environment:${each.key}"
        }
      }
    }]
  })
}

resource "aws_iam_role_policy" "frontend_image_push" {
  for_each = aws_iam_role.frontend_image_push
  name     = "frontend-image-push"
  role     = each.value.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability", "ecr:InitiateLayerUpload",
          "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:PutImage",
          "ecr:BatchGetImage", "ecr:DescribeImages"
        ]
        Resource = aws_ecr_repository.frontend[each.key].arn
      }
    ]
  })
}
