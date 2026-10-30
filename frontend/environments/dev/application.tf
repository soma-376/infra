variable "runtime" {
  description = "null이면 기반 네트워크만 생성. 준비된 실제 설정은 runtime.auto.tfvars.json으로 커밋하여 PR에서 검토한다. 비밀 값을 넣지 않는다."
  type = object({
    domain_name                = string
    certificate_arn            = string
    image_digest               = string
    automatic_image_deployment = optional(bool, false)
    enrollment_api_url         = string
    dashboard_api_url          = string
    dev_ami_id                 = optional(string)
  })
  default = null
}
module "application" {
  count              = var.runtime == null ? 0 : 1
  source             = "../../modules/application"
  environment        = "dev"
  aws_account_id     = var.aws_account_id
  vpc_id             = module.network.vpc_id
  public_subnet_ids  = [module.network.public_subnet_ids["ap-northeast-2a"], module.network.public_subnet_ids["ap-northeast-2c"]]
  private_subnet_ids = values(module.network.private_subnet_ids)
  runtime            = var.runtime
  telemetry          = var.frontend_telemetry_enabled ? { endpoint = module.observability[0].otlp_endpoint } : null
  depends_on         = [module.network]
}
output "application" { value = try(module.application[0], null) }
