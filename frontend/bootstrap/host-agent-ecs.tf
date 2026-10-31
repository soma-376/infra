locals {
  host_agent_task_arn    = "arn:aws:ecs:ap-northeast-2:${var.aws_account_id}:task-definition/soma-376-frontend-dev-host-agent:*"
  host_agent_service_arn = "arn:aws:ecs:ap-northeast-2:${var.aws_account_id}:service/soma-376-frontend-dev/soma-376-frontend-dev-host-agent"
}

resource "aws_iam_policy" "host_agent_ecs_write" {
  name = "soma-376-frontend-dev-host-agent-ecs-write"
  tags = merge(local.tags, { Env = "dev" })
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Allow"
        Action    = ["ecs:RegisterTaskDefinition"]
        Resource  = local.host_agent_task_arn
        Condition = { StringEquals = { "aws:RequestedRegion" = "ap-northeast-2", "aws:RequestTag/Project" = "pulsemetry-frontend", "aws:RequestTag/Env" = "dev", "aws:RequestTag/ManagedBy" = "terraform" } }
      },
      {
        Effect    = "Allow"
        Action    = ["ecs:CreateService", "ecs:UpdateService"]
        Resource  = local.host_agent_service_arn
        Condition = { ArnLikeIfExists = { "ecs:task-definition" = local.host_agent_task_arn } }
      },
      { Effect = "Allow", Action = ["ecs:DeleteService"], Resource = local.host_agent_service_arn },
      { Effect = "Allow", Action = ["ecs:TagResource", "ecs:UntagResource"], Resource = [local.host_agent_task_arn, local.host_agent_service_arn] }
    ]
  })
}
resource "aws_iam_role_policy_attachment" "host_agent_ecs_write" {
  role       = aws_iam_role.terraform["dev-apply"].name
  policy_arn = aws_iam_policy.host_agent_ecs_write.arn
}
resource "aws_iam_role_policy" "host_agent_ecs_read" {
  for_each = toset(["dev-plan", "dev-apply"])
  name     = "frontend-host-agent-ecs-read"
  role     = aws_iam_role.terraform[each.key].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["ecs:ListTagsForResource", "ecs:ListServiceDeployments", "ecs:DescribeServiceDeployments"]
      Resource = [local.host_agent_task_arn, local.host_agent_service_arn, "arn:aws:ecs:ap-northeast-2:${var.aws_account_id}:service-deployment/soma-376-frontend-dev/soma-376-frontend-dev-host-agent/*"]
    }]
  })
}
