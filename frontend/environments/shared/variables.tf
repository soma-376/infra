variable "aws_account_id" {
  type        = string
  description = "dev/prod와 동일한 AWS 계정"
  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "AWS 계정 ID 12자리를 지정하세요."
  }
}
variable "peers" {
  description = "기존 dev/prod BFF 네트워크. SG는 dev EC2/운영 task SG이며, 경로는 BFF가 쓰는 모든 route table을 지정한다."
  type = map(object({
    vpc_id            = string
    security_group_id = string
    route_table_ids   = set(string)
  }))
  validation {
    condition     = contains(keys(var.peers), "dev") && alltrue([for env in keys(var.peers) : contains(["dev", "prod"], env)]) && alltrue([for peer in var.peers : length(peer.route_table_ids) > 0])
    error_message = "dev는 필수이고 prod는 선택입니다. 각 환경에 VPC·BFF SG·route table이 필요합니다."
  }
  validation {
    condition     = length(distinct([for peer in var.peers : peer.vpc_id])) == length(var.peers)
    error_message = "dev/prod는 서로 다른 VPC여야 합니다."
  }
}
variable "max_storage_gb" {
  type        = number
  default     = 1
  description = "저장 용량 상한. 최소 저장 용량 예약이 아니다."
  validation {
    condition     = var.max_storage_gb >= 1 && var.max_storage_gb <= 5 && floor(var.max_storage_gb) == var.max_storage_gb
    error_message = "초기 공유 저장소는 1~5GB의 정수로 제한합니다."
  }
}
variable "max_ecpu_per_second" {
  type        = number
  default     = 1000
  description = "처리량 상한. 도달하면 요청이 제한될 수 있으며 월 비용 상한은 아니다."
  validation {
    condition     = var.max_ecpu_per_second >= 1000 && var.max_ecpu_per_second <= 5000 && floor(var.max_ecpu_per_second) == var.max_ecpu_per_second
    error_message = "초기 처리량 상한은 1,000~5,000 ECPU/s 정수로 지정하세요."
  }
}
variable "alarm_topic_arn" {
  type        = string
  default     = null
  nullable    = true
  description = "기존 서울 SNS topic ARN. null이면 CloudWatch 상태만 기록하며 알림은 발송하지 않는다. 월 예산 알림과는 별개다."
  validation {
    condition     = var.alarm_topic_arn == null ? true : can(regex("^arn:aws:sns:ap-northeast-2:[0-9]{12}:[A-Za-z0-9_-]+$", var.alarm_topic_arn))
    error_message = "서울 리전 SNS topic ARN이 필요합니다."
  }
}
