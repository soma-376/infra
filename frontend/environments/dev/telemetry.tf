variable "frontend_telemetry_enabled" {
  description = "프론트 SDK 이미지 배포 후 활성화한다."
  type        = bool
  default     = false
  validation {
    condition     = !var.frontend_telemetry_enabled || (var.runtime != null && var.observability != null)
    error_message = "프론트 관측 연결에는 runtime과 observability 설정이 모두 필요합니다."
  }
}

locals {
  telemetry_tags = { Org = "soma-376", Project = "pulsemetry-frontend", Env = "dev", ManagedBy = "terraform", Component = "observability" }
}

resource "aws_vpc_security_group_ingress_rule" "frontend_otlp" {
  count                        = var.frontend_telemetry_enabled ? 1 : 0
  security_group_id            = module.observability[0].security_group_id
  referenced_security_group_id = module.application[0].security_group_id
  ip_protocol                  = "tcp"
  from_port                    = 4318
  to_port                      = 4318
  description                  = "OTLP HTTP from dev frontend only"
  tags                         = local.telemetry_tags
}
resource "aws_vpc_security_group_egress_rule" "frontend_otlp" {
  count                        = var.frontend_telemetry_enabled ? 1 : 0
  security_group_id            = module.application[0].security_group_id
  referenced_security_group_id = module.observability[0].security_group_id
  ip_protocol                  = "tcp"
  from_port                    = 4318
  to_port                      = 4318
  description                  = "OTLP HTTP to observability only"
  tags                         = local.telemetry_tags
}
