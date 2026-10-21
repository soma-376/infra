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

variable "frontend_github_subject_prefix" {
  type        = string
  default     = null
  description = "프론트 저장소의 실제 OIDC sub에서 :environment: 앞부분. null이면 게시 역할을 만들지 않는다."
  validation {
    condition     = var.frontend_github_subject_prefix == null ? true : can(regex("^repo:soma-376(@[0-9]+)?/pulsemetry-frontend(@[0-9]+)?$", var.frontend_github_subject_prefix))
    error_message = "soma-376/pulsemetry-frontend의 실제 OIDC subject prefix를 입력하세요. wildcard는 허용하지 않습니다."
  }
}
