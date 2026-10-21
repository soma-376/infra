terraform {
  required_version = ">= 1.13.5, < 2.0.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}
# 최초 실행은 local backend다. 이전 후 backend.tf.example을 backend.tf로 복사한다.
