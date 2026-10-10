mock_provider "aws" {}
variables {
  aws_account_id = "111111111111"
  runtime        = null
}
run "environment_contract" {
  command = plan
  assert {
    condition     = output.network.vpc_cidr == "10.3.0.0/16" && length(output.network.public_subnet_cidrs) == 2 && length(output.network.private_subnet_cidrs) == 2
    error_message = "prod 환경의 CIDR 또는 서브넷 개수가 잘못되었습니다."
  }
}
