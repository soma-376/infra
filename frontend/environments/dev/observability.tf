variable "observability" {
  description = "null이면 생성하지 않는다. 앱 연결은 별도 단계이며 여기서는 수신 기반만 배포한다."
  type        = object({ ami_id = string })
  default     = null
}
module "observability" {
  count      = var.observability == null ? 0 : 1
  source     = "../../modules/observability"
  vpc_id     = module.network.vpc_id
  subnet_id  = values(module.network.public_subnet_ids)[0]
  ami_id     = var.observability.ami_id
  depends_on = [module.network]
}
output "observability" { value = try(module.observability[0], null) }
