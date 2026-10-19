# 기존 image-push 역할 ARN을 유지하며 해당 환경 서비스의 이미지 교체만 연결한다.
# UpdateService는 forceNewDeployment 외 필드도 바꿀 수 있다. 서비스 ARN을 고정하고
# 다른 태스크 family 참조와 ECS Exec 활성화를 제한하며 PassRole·Terraform 권한은 주지 않는다.
resource "aws_iam_role_policy" "frontend_image_deploy" {
  for_each = aws_iam_role.frontend_image_push
  name     = "frontend-image-deploy"
  role     = each.value.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ecs:DescribeServices", "ecs:UpdateService"]
        Resource = "arn:aws:ecs:ap-northeast-2:${var.aws_account_id}:service/soma-376-frontend-${each.key}/soma-376-frontend-${each.key}"
        Condition = {
          ArnLikeIfExists      = { "ecs:task-definition" = "arn:aws:ecs:ap-northeast-2:${var.aws_account_id}:task-definition/soma-376-frontend-${each.key}:*" }
          StringEqualsIfExists = { "ecs:enable-execute-command" = "false" }
          ArnEquals            = { "ecs:cluster" = "arn:aws:ecs:ap-northeast-2:${var.aws_account_id}:cluster/soma-376-frontend-${each.key}" }
        }
      },
      {
        Effect    = "Allow"
        Action    = ["ecs:ListTasks"]
        Resource  = "*"
        Condition = { ArnEquals = { "ecs:cluster" = "arn:aws:ecs:ap-northeast-2:${var.aws_account_id}:cluster/soma-376-frontend-${each.key}" } }
      },
      {
        Effect    = "Allow"
        Action    = ["ecs:DescribeTasks"]
        Resource  = "arn:aws:ecs:ap-northeast-2:${var.aws_account_id}:task/soma-376-frontend-${each.key}/*"
        Condition = { ArnEquals = { "ecs:cluster" = "arn:aws:ecs:ap-northeast-2:${var.aws_account_id}:cluster/soma-376-frontend-${each.key}" } }
      },
      {
        Effect    = "Allow"
        Action    = ["ecs:DescribeTaskDefinition"]
        Resource  = "*"
        Condition = { StringEquals = { "aws:RequestedRegion" = "ap-northeast-2" } }
      }
    ]
  })
}
