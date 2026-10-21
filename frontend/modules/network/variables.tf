variable "environment" {
  type = string
  validation {
    condition     = contains(["dev", "prod"], var.environment)
    error_message = "환경은 dev 또는 prod여야 합니다."
  }
}

variable "vpc_cidr" {
  type = string
  validation {
    condition     = can(regex("^10\\.([2-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])\\.0\\.0/16$", var.vpc_cidr))
    error_message = "기존 CDK 대역을 제외한 정규화된 10.2.0.0/16~10.255.0.0/16 대역이 필요합니다."
  }
}

variable "availability_zones" {
  type    = list(string)
  default = ["ap-northeast-2a", "ap-northeast-2c"]
  validation {
    condition     = length(var.availability_zones) == 2 && length(distinct(var.availability_zones)) == 2 && alltrue([for az in var.availability_zones : can(regex("^ap-northeast-2[a-d]$", az))])
    error_message = "서울 리전의 서로 다른 AZ 두 개를 지정하세요."
  }
}
