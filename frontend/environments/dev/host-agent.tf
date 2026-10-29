# 기존 EC2와 Terraform으로 교체된 EC2에 동일한 설치 절차를 적용한다.
# user_data는 변경하지 않으므로 수집기 추가 때문에 앱 EC2를 교체하지 않는다.
resource "aws_ssm_document" "host_agent" {
  count           = var.frontend_telemetry_enabled ? 1 : 0
  name            = "soma-376-frontend-dev-host-agent"
  document_type   = "Command"
  document_format = "JSON"
  tags            = local.telemetry_tags
  content = jsonencode({
    schemaVersion = "2.2"
    description   = "dev 프론트 EC2의 OS Alloy 수집기를 설치한다."
    mainSteps = [{
      action = "aws:runShellScript", name = "installHostAgent"
      inputs = {
        timeoutSeconds = "600"
        runCommand = [templatefile("${path.module}/../../observability/host-agent/deploy.sh.tftpl", {
          installer = filebase64("${path.module}/../../observability/host-agent/install-dev.sh")
          config    = filebase64("${path.module}/../../observability/host-agent/config.alloy")
          endpoint  = module.observability[0].otlp_endpoint
        })]
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
