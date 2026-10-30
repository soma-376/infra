# 기존 리소스 주소를 유지해 설치 Association을 정리 작업으로 갱신한다.
# ECS 서비스는 이 작업의 성공 후 시작한다. 전환 완료 후 별도 변경으로 제거할 수 있다.
resource "aws_ssm_document" "host_agent" {
  count           = var.frontend_telemetry_enabled ? 1 : 0
  name            = "soma-376-frontend-dev-host-agent"
  document_type   = "Command"
  document_format = "JSON"
  tags            = local.telemetry_tags
  content = jsonencode({
    schemaVersion = "2.2"
    description   = "ECS DAEMON 전환 전에 기존 Docker Alloy만 정리한다."
    mainSteps = [{
      action = "aws:runShellScript", name = "removeLegacyHostAgent"
      inputs = {
        timeoutSeconds = "600"
        runCommand     = [file("${path.module}/../../observability/host-agent/cleanup-legacy.sh")]
      }
    }]
  })
}
resource "aws_ssm_association" "host_agent" {
  count                            = var.frontend_telemetry_enabled ? 1 : 0
  name                             = aws_ssm_document.host_agent[0].name
  association_name                 = "soma-376-frontend-dev-host-agent"
  document_version                 = aws_ssm_document.host_agent[0].latest_version
  wait_for_success_timeout_seconds = 900
  tags                             = merge(local.telemetry_tags, { Component = "host-agent" })
  targets {
    key    = "InstanceIds"
    values = [module.application[0].dev_instance_id]
  }
  depends_on = [aws_vpc_security_group_ingress_rule.frontend_otlp, aws_vpc_security_group_egress_rule.frontend_otlp]
}
output "host_agent_association_id" { value = try(aws_ssm_association.host_agent[0].association_id, null) }
