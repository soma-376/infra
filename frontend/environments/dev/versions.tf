terraform {
  required_version = ">= 1.13.5, < 2.0.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
  backend "s3" {
    region       = "ap-northeast-2"
    key          = "network/terraform.tfstate"
    encrypt      = true
    use_lockfile = true
  }
}
