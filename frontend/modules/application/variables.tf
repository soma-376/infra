variable "environment" {
  type = string
  validation {
    condition     = contains(["dev", "prod"], var.environment)
    error_message = "dev 또는 prod를 지정하세요."
  }
}
variable "aws_account_id" { type = string }
variable "vpc_id" { type = string }
variable "public_subnet_ids" { type = list(string) }
variable "private_subnet_ids" { type = list(string) }
variable "runtime" {
  description = "비밀 값을 포함하지 않는 실행 설정. 인증서는 같은 계정·서울 리전에서 발급하고 DNS는 외부에서 관리한다."
  type = object({
    domain_name                = string
    certificate_arn            = string
    image_digest               = string
    automatic_image_deployment = optional(bool, false)
    enrollment_api_url         = string
    dashboard_api_url          = string
    bff_local_origins          = optional(list(string), [])
    dev_ami_id                 = optional(string)
    valkey = optional(object({
      host       = string
      cache_name = string
    }))
  })
  validation {
    condition     = length(var.runtime.bff_local_origins) == 0 || (var.environment == "dev" && var.runtime.valkey != null)
    error_message = "BFF localhost 허용 목록은 Valkey가 설정된 dev 환경에서만 사용할 수 있습니다."
  }
  validation {
    condition     = alltrue([for origin in var.runtime.bff_local_origins : can(regex("^https?://localhost(:([1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5]))?$", origin))])
    error_message = "BFF 허용 출처는 경로 없는 정확한 HTTP(S) localhost origin이어야 합니다."
  }
  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", var.runtime.domain_name))
    error_message = "소문자 FQDN(와일드카드·끝 마침표 제외)을 입력하세요."
  }
  validation {
    condition     = can(regex("^arn:aws:acm:ap-northeast-2:${var.aws_account_id}:certificate/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", var.runtime.certificate_arn))
    error_message = "같은 AWS 계정의 서울 리전 ACM 인증서 ARN을 입력하세요."
  }
  validation {
    condition     = can(regex("^sha256:[0-9a-f]{64}$", var.runtime.image_digest))
    error_message = "태그 대신 환경별 ECR 이미지의 sha256 digest를 입력하세요."
  }
  validation {
    condition     = alltrue([for url in [var.runtime.enrollment_api_url, var.runtime.dashboard_api_url] : can(regex("^https://[a-zA-Z0-9.-]+(:443)?$", url))])
    error_message = "백엔드 URL은 경로와 끝 슬래시 없는 HTTPS origin(443)이어야 합니다."
  }
  validation {
    condition     = var.runtime.valkey == null ? true : (can(regex("^[a-z0-9.-]+\\.cache\\.amazonaws\\.com$", var.runtime.valkey.host)) && var.runtime.valkey.cache_name == "pulsemetry-frontend-shared")
    error_message = "공유 Valkey의 TLS endpoint와 pulsemetry-frontend-shared 캐시 이름을 지정하세요."
  }
  validation {
    condition     = var.environment != "dev" || can(regex("^ami-[0-9a-f]{17}$", var.runtime.dev_ami_id))
    error_message = "개발 환경에는 서울 리전 ECS optimized AL2023 ARM64 AMI ID를 고정하세요."
  }
}

variable "telemetry" {
  description = "null이면 기존 환경 변수를 유지한다. dev 사설 관측 endpoint만 허용한다."
  type        = object({ endpoint = string })
  default     = null
  validation {
    condition     = var.telemetry == null ? true : (var.environment == "dev" && can(regex("^http://10\\.2\\.[0-9]+\\.[0-9]+:4318$", var.telemetry.endpoint)))
    error_message = "관측 연결은 dev VPC의 사설 OTLP HTTP 4318 endpoint만 허용합니다."
  }
}
