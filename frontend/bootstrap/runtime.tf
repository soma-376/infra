# 비밀 값은 Terraform 밖에서 입력한다. 여기에는 secret 컨테이너와 ARN만 있다.
resource "aws_secretsmanager_secret" "bff" {
  for_each                = local.environments
  name                    = "soma-376-frontend-${each.key}/bff-session-keys"
  description             = "Frontend BFF cookie encryption keys"
  recovery_window_in_days = 30
  tags                    = merge(local.tags, { Env = each.key })
  lifecycle { prevent_destroy = true }
}
resource "aws_iam_role" "execution" {
  for_each    = local.environments
  name        = "soma-376-frontend-${each.key}-execution"
  description = "Pull frontend images and inject runtime secrets"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = {
        StringEquals = { "aws:SourceAccount" = var.aws_account_id }
        ArnLike      = { "aws:SourceArn" = "arn:aws:ecs:ap-northeast-2:${var.aws_account_id}:*" }
      }
    }]
  })
  tags = merge(local.tags, { Env = each.key })
}
resource "aws_iam_role_policy" "execution" {
  for_each = local.environments
  name     = "frontend-execution"
  role     = aws_iam_role.execution[each.key].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["ecr:GetAuthorizationToken"], Resource = "*" },
      { Effect = "Allow", Action = ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"], Resource = aws_ecr_repository.frontend[each.key].arn },
      { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "arn:aws:logs:ap-northeast-2:${var.aws_account_id}:log-group:/ecs/soma-376-frontend-${each.key}:log-stream:*" },
      { Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = aws_secretsmanager_secret.bff[each.key].arn }
    ]
  })
}
resource "aws_iam_role" "instance" {
  name        = "soma-376-frontend-dev-instance"
  description = "Manage the frontend development ECS container instance"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
  tags = merge(local.tags, { Env = "dev" })
}
resource "aws_iam_instance_profile" "dev" {
  name = aws_iam_role.instance.name
  role = aws_iam_role.instance.name
  tags = merge(local.tags, { Env = "dev" })
}
resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.instance.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}
resource "aws_iam_role_policy" "instance" {
  name = "frontend-ecs-agent"
  role = aws_iam_role.instance.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["ecs:DiscoverPollEndpoint", "ecr:GetAuthorizationToken"], Resource = "*" },
      {
        Effect   = "Allow"
        Action   = ["ecs:RegisterContainerInstance", "ecs:DeregisterContainerInstance", "ecs:Poll", "ecs:StartTelemetrySession", "ecs:SubmitAttachmentStateChanges", "ecs:SubmitContainerStateChange", "ecs:SubmitTaskStateChange", "ecs:UpdateContainerInstancesState"]
        Resource = ["arn:aws:ecs:ap-northeast-2:${var.aws_account_id}:cluster/soma-376-frontend-dev", "arn:aws:ecs:ap-northeast-2:${var.aws_account_id}:container-instance/soma-376-frontend-dev/*"]
      },
      { Effect = "Allow", Action = ["ecs:TagResource"], Resource = "arn:aws:ecs:ap-northeast-2:${var.aws_account_id}:container-instance/soma-376-frontend-dev/*" },
      { Effect = "Allow", Action = ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"], Resource = aws_ecr_repository.frontend["dev"].arn }
    ]
  })
}
output "bff_secret_arns" { value = { for env, secret in aws_secretsmanager_secret.bff : env => secret.arn } }

# 기존 계정 공용 서비스 연결 역할은 CDK/AWS 소유다. CI에 IAM 생성 권한을 주지 않는다.
# 최초 활성화 전에 관리자가 AWSServiceRoleForECS, AWSServiceRoleForElasticLoadBalancing 존재를 확인한다.
