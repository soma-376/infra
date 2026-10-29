# 관리자 bootstrap 전용. 환경 apply 역할에는 SSM 실행 권한을 추가하지 않는다.
resource "aws_ssm_document" "dashboards" {
  name            = "soma-376-frontend-dashboards"
  document_type   = "Command"
  document_format = "JSON"
  tags            = merge(local.tags, { Env = "dev", Component = "observability" })
  content = jsonencode({
    schemaVersion = "2.2"
    description   = "고정된 프론트 관측 대시보드 두 개만 갱신한다."
    parameters = {
      DashboardBundle = {
        type = "String", interpolationType = "ENV_VAR", allowedPattern = "^[A-Za-z0-9+/=]+$"
      }
    }
    mainSteps = [{
      action = "aws:runShellScript", name = "deployDashboards"
      inputs = {
        timeoutSeconds = "540"
        runCommand     = ["set -eu", "test -n \"$SSM_DashboardBundle\"", "python3 - <<'PULSEMETRY_DASHBOARD_SCRIPT'\n${file("${path.module}/../scripts/dashboard-release.py")}\nPULSEMETRY_DASHBOARD_SCRIPT"]
      }
    }]
  })
}
resource "aws_iam_role" "dashboards" {
  name = "soma-376-frontend-dashboards-deploy"
  tags = merge(local.tags, { Env = "dev", Component = "observability" })
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow", Action = "sts:AssumeRoleWithWebIdentity"
      Principal = { Federated = data.aws_iam_openid_connect_provider.github.arn }
      Condition = { StringEquals = {
        "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        "token.actions.githubusercontent.com:sub" = "${var.github_subject_prefix}:environment:frontend-dashboards"
      } }
    }]
  })
}
resource "aws_iam_role_policy" "dashboards" {
  name = "frontend-dashboards-deploy"
  role = aws_iam_role.dashboards.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["ec2:DescribeInstances", "ssm:GetCommandInvocation"], Resource = "*" },
      { Effect = "Allow", Action = ["ssm:SendCommand"], Resource = aws_ssm_document.dashboards.arn },
      {
        Effect   = "Allow", Action = ["ssm:SendCommand"]
        Resource = "arn:aws:ec2:ap-northeast-2:${var.aws_account_id}:instance/*"
        Condition = { StringEquals = {
          "ssm:resourceTag/Project"   = "pulsemetry-frontend", "ssm:resourceTag/Env" = "dev",
          "ssm:resourceTag/Component" = "observability", "ssm:resourceTag/ManagedBy" = "terraform"
        } }
      }
    ]
  })
}
output "dashboard_deploy_role_arn" { value = aws_iam_role.dashboards.arn }
