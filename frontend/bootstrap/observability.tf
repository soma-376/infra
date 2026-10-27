# 역할은 관리자 bootstrap에서만 생성한다. 환경 CI에는 IAM 생성 권한을 주지 않는다.
resource "aws_iam_role" "observability" {
  name = "soma-376-frontend-observability"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
  tags = merge(local.tags, { Env = "dev", Component = "observability" })
}
resource "aws_iam_instance_profile" "observability" {
  name = aws_iam_role.observability.name
  role = aws_iam_role.observability.name
  tags = merge(local.tags, { Env = "dev", Component = "observability" })
}
resource "aws_iam_role_policy_attachment" "observability_ssm" {
  role       = aws_iam_role.observability.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}
resource "aws_iam_role_policy" "observability_read" {
  for_each = toset(["dev-plan", "dev-apply"])
  name     = "frontend-observability-read"
  role     = aws_iam_role.terraform[each.key].id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = ["iam:GetInstanceProfile"], Resource = aws_iam_instance_profile.observability.arn }]
  })
}
resource "aws_iam_policy" "observability_write" {
  name = "soma-376-frontend-observability-write"
  tags = merge(local.tags, { Env = "dev" })
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Allow"
        Action    = ["iam:PassRole"]
        Resource  = aws_iam_role.observability.arn
        Condition = { StringEquals = { "iam:PassedToService" = "ec2.amazonaws.com" } }
      },
      {
        Effect    = "Allow"
        Action    = ["ec2:CreateVolume"]
        Resource  = "arn:aws:ec2:ap-northeast-2:${var.aws_account_id}:volume/*"
        Condition = { StringEquals = { "aws:RequestTag/Project" = "pulsemetry-frontend", "aws:RequestTag/Env" = "dev", "aws:RequestTag/ManagedBy" = "terraform", "aws:RequestTag/Component" = "observability" }, Bool = { "ec2:Encrypted" = "true" } }
      },
      {
        Effect    = "Allow"
        Action    = ["ec2:CreateTags"]
        Resource  = "arn:aws:ec2:ap-northeast-2:${var.aws_account_id}:volume/*"
        Condition = { StringEquals = { "ec2:CreateAction" = "CreateVolume", "aws:RequestTag/Project" = "pulsemetry-frontend", "aws:RequestTag/Env" = "dev", "aws:RequestTag/ManagedBy" = "terraform", "aws:RequestTag/Component" = "observability" } }
      },
      {
        Effect    = "Allow"
        Action    = ["ec2:AttachVolume", "ec2:DetachVolume"]
        Resource  = ["arn:aws:ec2:ap-northeast-2:${var.aws_account_id}:instance/*", "arn:aws:ec2:ap-northeast-2:${var.aws_account_id}:volume/*"]
        Condition = { StringEquals = { "ec2:ResourceTag/Project" = "pulsemetry-frontend", "ec2:ResourceTag/Env" = "dev", "ec2:ResourceTag/ManagedBy" = "terraform", "ec2:ResourceTag/Component" = "observability" } }
      }
    ]
  })
}
resource "aws_iam_role_policy_attachment" "observability_write" {
  role       = aws_iam_role.terraform["dev-apply"].name
  policy_arn = aws_iam_policy.observability_write.arn
}
