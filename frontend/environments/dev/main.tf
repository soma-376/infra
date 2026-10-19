provider "aws" {
  region              = "ap-northeast-2"
  allowed_account_ids = [var.aws_account_id]
}

variable "aws_account_id" {
  type        = string
  description = "적용 대상 AWS 계정 ID"
  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "AWS 계정 ID 12자리를 지정하세요."
  }
}

variable "vpc_cidr" {
  type    = string
  default = "10.2.0.0/16"
}

module "network" {
  source      = "../../modules/network"
  environment = "dev"
  vpc_cidr    = var.vpc_cidr
}

output "network" {
  value = {
    vpc_id               = module.network.vpc_id
    vpc_cidr             = module.network.vpc_cidr
    public_subnet_ids    = module.network.public_subnet_ids
    private_subnet_ids   = module.network.private_subnet_ids
    public_subnet_cidrs  = module.network.public_subnet_cidrs
    private_subnet_cidrs = module.network.private_subnet_cidrs
    nat_gateway_id       = module.network.nat_gateway_id
  }
}
