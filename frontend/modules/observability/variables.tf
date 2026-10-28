variable "vpc_id" { type = string }
variable "subnet_id" { type = string }
variable "ami_id" {
  type        = string
  description = "서울 리전 AL2023 ARM64 AMI를 고정한다. 변경 시 EC2 교체 계획을 검토한다."
  validation {
    condition     = can(regex("^ami-[0-9a-f]{17}$", var.ami_id))
    error_message = "고정 AMI ID가 필요합니다."
  }
}
