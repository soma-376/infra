locals {
  host_agent_document_arn = "arn:aws:ssm:ap-northeast-2:${var.aws_account_id}:document/soma-376-frontend-dev-host-agent"
  host_agent_tags         = { Project = "pulsemetry-frontend", Env = "dev", ManagedBy = "terraform", Component = "host-agent" }
}
resource "aws_iam_role_policy" "host_agent_read" {
  for_each = toset(["dev-plan", "dev-apply"])
  name     = "frontend-host-agent-read"
  role     = aws_iam_role.terraform[each.key].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["ssm:GetDocument", "ssm:DescribeDocument", "ssm:ListDocumentVersions", "ssm:ListTagsForResource"], Resource = local.host_agent_document_arn },
      { Effect = "Allow", Action = ["ssm:DescribeAssociation", "ssm:DescribeAssociationExecutions", "ssm:DescribeAssociationExecutionTargets", "ssm:ListTagsForResource"], Resource = "arn:aws:ssm:ap-northeast-2:${var.aws_account_id}:association/*" }
    ]
  })
}
resource "aws_iam_policy" "host_agent_write" {
  name = "soma-376-frontend-dev-host-agent-write"
  tags = merge(local.tags, { Env = "dev" })
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ssm:CreateDocument", "ssm:UpdateDocument", "ssm:UpdateDocumentDefaultVersion", "ssm:DeleteDocument", "ssm:AddTagsToResource", "ssm:RemoveTagsFromResource", "ssm:CreateAssociation", "ssm:UpdateAssociation"]
        Resource = local.host_agent_document_arn
      },
      {
        Effect    = "Allow", Action = ["ssm:CreateAssociation"]
        Resource  = "arn:aws:ssm:ap-northeast-2:${var.aws_account_id}:association/*"
        Condition = { StringEquals = { for k, v in local.host_agent_tags : "aws:RequestTag/${k}" => v } }
      },
      {
        Effect    = "Allow", Action = ["ssm:UpdateAssociation", "ssm:DeleteAssociation", "ssm:AddTagsToResource", "ssm:RemoveTagsFromResource"]
        Resource  = "arn:aws:ssm:ap-northeast-2:${var.aws_account_id}:association/*"
        Condition = { StringEquals = { for k, v in local.host_agent_tags : "aws:ResourceTag/${k}" => v } }
      },
      {
        Effect    = "Allow", Action = ["ssm:AddTagsToResource"]
        Resource  = "arn:aws:ssm:ap-northeast-2:${var.aws_account_id}:association/*"
        Condition = { StringEquals = { for k, v in local.host_agent_tags : "aws:RequestTag/${k}" => v } }
      },
      {
        Effect    = "Allow", Action = ["ssm:CreateAssociation", "ssm:UpdateAssociation"]
        Resource  = "arn:aws:ec2:ap-northeast-2:${var.aws_account_id}:instance/*"
        Condition = { StringEquals = { "ssm:resourceTag/Project" = "pulsemetry-frontend", "ssm:resourceTag/Env" = "dev", "ssm:resourceTag/ManagedBy" = "terraform", "ssm:resourceTag/Name" = "soma-376-frontend-dev" } }
      }
    ]
  })
}
resource "aws_iam_role_policy_attachment" "host_agent_write" {
  role       = aws_iam_role.terraform["dev-apply"].name
  policy_arn = aws_iam_policy.host_agent_write.arn
}
