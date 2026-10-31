# 별도 수신기 컨테이너만 갱신한다. 기존 관측 EC2·스토리지·OTLP 수신기는 교체하지 않는다.
resource "aws_ssm_document" "faro" {
  count           = var.frontend_telemetry_enabled ? 1 : 0
  name            = "soma-376-frontend-dev-faro"
  document_type   = "Command"
  document_format = "JSON"
  tags            = merge(local.telemetry_tags, { Component = "faro" })
  content = jsonencode({
    schemaVersion = "2.2"
    description   = "관측 EC2에 사설 Faro 수신기를 배포한다."
    mainSteps = [{
      action = "aws:runShellScript", name = "installFaro"
      inputs = {
        timeoutSeconds = "600"
        runCommand = [templatefile("${path.module}/../../observability/faro/install.sh.tftpl", {
          compose = filebase64("${path.module}/../../observability/faro/compose.yaml")
          config  = filebase64("${path.module}/../../observability/faro/config.alloy")
        })]
      }
    }]
  })
}
resource "aws_ssm_association" "faro" {
  count                            = var.frontend_telemetry_enabled ? 1 : 0
  name                             = aws_ssm_document.faro[0].name
  association_name                 = "soma-376-frontend-dev-faro"
  document_version                 = aws_ssm_document.faro[0].latest_version
  wait_for_success_timeout_seconds = 900
  tags                             = merge(local.telemetry_tags, { Component = "faro" })
  targets {
    key    = "InstanceIds"
    values = [module.observability[0].instance_id]
  }
}
resource "aws_vpc_security_group_ingress_rule" "frontend_faro" {
  count                        = var.frontend_telemetry_enabled ? 1 : 0
  security_group_id            = module.observability[0].security_group_id
  referenced_security_group_id = module.application[0].security_group_id
  ip_protocol                  = "tcp"
  from_port                    = 12347
  to_port                      = 12347
  description                  = "Faro from dev frontend relay only"
  tags                         = local.telemetry_tags
}
resource "aws_vpc_security_group_egress_rule" "frontend_faro" {
  count                        = var.frontend_telemetry_enabled ? 1 : 0
  security_group_id            = module.application[0].security_group_id
  referenced_security_group_id = module.observability[0].security_group_id
  ip_protocol                  = "tcp"
  from_port                    = 12347
  to_port                      = 12347
  description                  = "Faro to observability only"
  tags                         = local.telemetry_tags
}
