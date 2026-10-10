mock_provider "aws" {}

variables {
  environment = "dev"
  vpc_cidr    = "10.2.0.0/16"
}

run "dev_has_public_subnets_without_nat" {
  command = apply
  assert {
    condition     = length(aws_subnet.public) == 2 && length(aws_subnet.private) == 0 && length(aws_nat_gateway.this) == 0 && length(aws_eip.nat) == 0
    error_message = "개발은 public 두 개이고 private/NAT/EIP는 없어야 합니다."
  }
  assert {
    condition     = aws_subnet.public["ap-northeast-2a"].cidr_block == "10.2.0.0/24" && aws_subnet.public["ap-northeast-2c"].cidr_block == "10.2.1.0/24"
    error_message = "개발 서브넷 대역이 잘못되었습니다."
  }
  assert {
    condition     = aws_route.internet.gateway_id == aws_internet_gateway.this.id && aws_route.internet.route_table_id == aws_route_table.public.id && alltrue([for association in aws_route_table_association.public : association.route_table_id == aws_route_table.public.id])
    error_message = "모든 public 서브넷은 인터넷 게이트웨이 경로를 사용해야 합니다."
  }
  assert {
    condition     = aws_vpc.this.enable_dns_support && aws_vpc.this.enable_dns_hostnames && alltrue([for subnet in aws_subnet.public : !subnet.map_public_ip_on_launch])
    error_message = "DNS는 활성화하고 public IP는 실행 환경이 명시적으로 할당해야 합니다."
  }
}

run "prod_private_routes_use_single_nat" {
  command = apply
  variables {
    environment = "prod"
    vpc_cidr    = "10.3.0.0/16"
  }
  assert {
    condition     = length(aws_subnet.public) == 2 && length(aws_subnet.private) == 2 && length(aws_nat_gateway.this) == 1
    error_message = "운영은 public/private 각 두 개와 NAT 하나를 사용해야 합니다."
  }
  assert {
    condition     = aws_subnet.private["ap-northeast-2a"].cidr_block == "10.3.16.0/24" && aws_subnet.private["ap-northeast-2c"].cidr_block == "10.3.17.0/24"
    error_message = "운영 public/private 서브넷은 겹치면 안 됩니다."
  }
  assert {
    condition     = alltrue([for az, route in aws_route.nat : route.nat_gateway_id == aws_nat_gateway.this[0].id && route.route_table_id == aws_route_table.private[az].id]) && aws_nat_gateway.this[0].subnet_id == aws_subnet.public["ap-northeast-2a"].id
    error_message = "운영 private 라우팅은 첫 AZ public 서브넷의 NAT를 사용해야 합니다."
  }
  assert {
    condition     = alltrue([for az, association in aws_route_table_association.private : association.route_table_id == aws_route_table.private[az].id && association.subnet_id == aws_subnet.private[az].id]) && alltrue([for subnet in aws_subnet.private : !subnet.map_public_ip_on_launch])
    error_message = "private 서브넷 연결과 public IP 차단을 확인하세요."
  }
  assert {
    condition     = aws_vpc.this.tags.Project == "pulsemetry-frontend" && aws_vpc.this.tags.Env == "prod" && aws_vpc.this.tags.ManagedBy == "terraform"
    error_message = "소유권 태그는 CI IAM 경계와 일치해야 합니다."
  }
}

run "reject_backend_cidr" {
  command = plan
  variables { vpc_cidr = "10.1.0.0/16" }
  expect_failures = [var.vpc_cidr]
}

run "reject_noncanonical_cidr" {
  command = plan
  variables { vpc_cidr = "10.2.1.0/16" }
  expect_failures = [var.vpc_cidr]
}

run "reject_duplicate_az" {
  command = plan
  variables { availability_zones = ["ap-northeast-2a", "ap-northeast-2a"] }
  expect_failures = [var.availability_zones]
}

run "reject_invalid_environment" {
  command = plan
  variables { environment = "staging" }
  expect_failures = [var.environment]
}
