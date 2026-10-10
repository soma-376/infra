variable "aws_account_id" {
  type = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "AWS 계정 ID 12자리를 지정하세요."
  }
}

variable "github_subject_prefix" {
  type        = string
  description = "실제 GitHub OIDC sub의 :environment: 앞부분. 저장소 이름/immutable ID 형식을 추측하지 않는다."
  validation {
    condition     = can(regex("^repo:soma-376(@[0-9]+)?/infra(@[0-9]+)?$", var.github_subject_prefix))
    error_message = "soma-376/infra의 실제 OIDC subject prefix가 필요합니다. wildcard는 허용하지 않습니다."
  }
}

variable "state_bucket_prefix" {
  type    = string
  default = "soma-376-frontend-tfstate"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,29}$", var.state_bucket_prefix))
    error_message = "버킷 접두사는 영문 소문자로 시작하는 3~30자의 소문자/숫자/하이픈이어야 합니다."
  }
}

variable "frontend_dns" {
  description = "환경별 public DNS 권한 범위. runtime 활성화 전에 domain_name/zone_id를 지정해 bootstrap을 적용한다."
  type        = map(object({ domain_name = string, zone_id = string }))
  default     = {}
  validation {
    condition     = alltrue([for env, dns in var.frontend_dns : contains(["dev", "prod"], env) && can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", dns.domain_name)) && can(regex("^Z[A-Z0-9]+$", dns.zone_id))])
    error_message = "dev/prod별 소문자 FQDN과 public Route 53 zone ID를 입력하세요."
  }
  validation {
    condition     = length(distinct([for dns in values(var.frontend_dns) : dns.domain_name])) == length(var.frontend_dns)
    error_message = "개발과 운영 도메인은 서로 달라야 합니다."
  }
}
