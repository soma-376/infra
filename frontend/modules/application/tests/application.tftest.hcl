mock_provider "aws" {
  override_during = plan
  mock_data "aws_secretsmanager_secret" {
    defaults = { arn = "arn:aws:secretsmanager:ap-northeast-2:111111111111:secret:mock-bff-123456" }
  }
  mock_data "aws_ami" {
    defaults = { id = "ami-0123456789abcdef0" }
  }
  mock_resource "aws_security_group" {
    defaults = { id = "sg-0123456789abcdef0" }
  }
  mock_resource "aws_lb" {
    defaults = { arn = "arn:aws:elasticloadbalancing:ap-northeast-2:111111111111:loadbalancer/app/mock/1234567890123456", dns_name = "mock.ap-northeast-2.elb.amazonaws.com", zone_id = "ZALB" }
  }
  mock_resource "aws_lb_target_group" {
    defaults = { arn = "arn:aws:elasticloadbalancing:ap-northeast-2:111111111111:targetgroup/mock/1234567890123456" }
  }
  mock_resource "aws_ecs_cluster" {
    defaults = { id = "arn:aws:ecs:ap-northeast-2:111111111111:cluster/mock" }
  }
  mock_resource "aws_ecs_task_definition" {
    defaults = { arn = "arn:aws:ecs:ap-northeast-2:111111111111:task-definition/mock:1" }
  }
}
variables {
  aws_account_id     = "111111111111"
  environment        = "dev"
  vpc_id             = "vpc-0123456789abcdef0"
  public_subnet_ids  = ["subnet-00000000000000001", "subnet-00000000000000002"]
  private_subnet_ids = ["subnet-00000000000000003", "subnet-00000000000000004"]
  runtime = {
    domain_name        = "frontend.example.com"
    certificate_arn    = "arn:aws:acm:ap-northeast-2:111111111111:certificate/00000000-0000-0000-0000-000000000001"
    image_digest       = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    enrollment_api_url = "https://enrollment.example.com"
    dashboard_api_url  = "https://dashboard.example.com"
    dev_ami_id         = "ami-0123456789abcdef0"
  }
}
run "dev_https_and_single_process" {
  command = plan
  assert {
    condition     = aws_lb_listener.http.default_action[0].redirect[0].protocol == "HTTPS" && aws_lb_listener.https.protocol == "HTTPS" && aws_lb_listener.https.certificate_arn == var.runtime.certificate_arn && output.certificate_arn == var.runtime.certificate_arn
    error_message = "HTTP는 입력한 기존 인증서가 연결된 HTTPS로 전환해야 합니다."
  }
  assert {
    condition     = output.alb_dns_name == "mock.ap-northeast-2.elb.amazonaws.com" && output.endpoint == "https://frontend.example.com"
    error_message = "외부 DNS 연결용 ALB 주소와 사용자 HTTPS 주소를 출력해야 합니다."
  }
  assert {
    condition     = aws_vpc_security_group_ingress_rule.app.referenced_security_group_id == aws_security_group.alb.id && aws_vpc_security_group_ingress_rule.app.cidr_ipv4 == null && aws_vpc_security_group_ingress_rule.app.from_port == 3000 && aws_vpc_security_group_egress_rule.app_https.to_port == 443
    error_message = "앱 직접 노출 없이 ALB에서만 3000 포트에 접근해야 합니다."
  }
  assert {
    condition     = length(aws_instance.dev) == 1 && aws_instance.dev[0].associate_public_ip_address && aws_instance.dev[0].metadata_options[0].http_tokens == "required" && aws_instance.dev[0].root_block_device[0].encrypted && aws_ecs_task_definition.frontend.network_mode == "bridge" && aws_lb_target_group.frontend.target_type == "instance"
    error_message = "개발은 암호화·IMDSv2를 설정한 public EC2 한 대와 bridge 컨테이너를 사용합니다."
  }
  assert {
    condition     = aws_ecs_service.frontend.desired_count == 1 && aws_ecs_service.frontend.deployment_minimum_healthy_percent == 0 && aws_ecs_service.frontend.deployment_maximum_percent == 100 && length(aws_ecs_service.frontend.network_configuration) == 0
    error_message = "BFF는 EC2에서 복제 없이 기존 태스크를 중지한 뒤 교체해야 합니다."
  }
  assert {
    condition     = strcontains(jsondecode(aws_ecs_task_definition.frontend.container_definitions)[0].image, "pulsemetry-frontend-dev@sha256:") && jsondecode(aws_ecs_task_definition.frontend.container_definitions)[0].secrets[0].name == "BFF_SESSION_KEYS" && !contains([for v in jsondecode(aws_ecs_task_definition.frontend.container_definitions)[0].environment : v.name], "BFF_SESSION_KEYS")
    error_message = "환경별 digest와 secret ARN 참조를 사용하고 키 값을 일반 환경 변수에 넣지 않습니다."
  }
}
run "prod_private_fargate_single_process" {
  command = plan
  variables { environment = "prod" }
  assert {
    condition     = length(aws_instance.dev) == 0 && aws_ecs_service.frontend.launch_type == "FARGATE" && aws_ecs_task_definition.frontend.network_mode == "awsvpc" && aws_ecs_task_definition.frontend.runtime_platform[0].cpu_architecture == "ARM64" && aws_lb_target_group.frontend.target_type == "ip"
    error_message = "운영은 EC2 없이 ARM64 Fargate와 IP target을 사용해야 합니다."
  }
  assert {
    condition     = !aws_ecs_service.frontend.network_configuration[0].assign_public_ip && toset(aws_ecs_service.frontend.network_configuration[0].subnets) == toset(var.private_subnet_ids) && aws_ecs_service.frontend.desired_count == 1 && aws_ecs_service.frontend.deployment_maximum_percent == 100 && aws_ecs_service.frontend.deployment_minimum_healthy_percent == 0
    error_message = "운영 태스크는 private subnet에 한 개만 실행하며 public IP를 갖지 않습니다."
  }
}
run "reject_mutable_image_tag" {
  command = plan
  variables {
    runtime = {
      domain_name        = "frontend.example.com"
      certificate_arn    = "arn:aws:acm:ap-northeast-2:111111111111:certificate/00000000-0000-0000-0000-000000000001"
      image_digest       = "latest"
      enrollment_api_url = "https://enrollment.example.com"
      dashboard_api_url  = "https://dashboard.example.com"
      dev_ami_id         = "ami-0123456789abcdef0"
    }
  }
  expect_failures = [var.runtime]
}
run "reject_plain_http_backend" {
  command = plan
  variables {
    runtime = {
      domain_name        = "frontend.example.com"
      certificate_arn    = "arn:aws:acm:ap-northeast-2:111111111111:certificate/00000000-0000-0000-0000-000000000001"
      image_digest       = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      enrollment_api_url = "http://enrollment.example.com"
      dashboard_api_url  = "https://dashboard.example.com"
      dev_ami_id         = "ami-0123456789abcdef0"
    }
  }
  expect_failures = [var.runtime]
}

run "reject_certificate_other_account" {
  command = plan
  variables {
    runtime = {
      domain_name        = "frontend.example.com"
      certificate_arn    = "arn:aws:acm:ap-northeast-2:222222222222:certificate/00000000-0000-0000-0000-000000000001"
      image_digest       = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      enrollment_api_url = "https://enrollment.example.com"
      dashboard_api_url  = "https://dashboard.example.com"
      dev_ami_id         = "ami-0123456789abcdef0"
    }
  }
  expect_failures = [var.runtime]
}

run "reject_certificate_other_region" {
  command = plan
  variables {
    runtime = {
      domain_name        = "frontend.example.com"
      certificate_arn    = "arn:aws:acm:us-east-1:111111111111:certificate/00000000-0000-0000-0000-000000000001"
      image_digest       = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      enrollment_api_url = "https://enrollment.example.com"
      dashboard_api_url  = "https://dashboard.example.com"
      dev_ami_id         = "ami-0123456789abcdef0"
    }
  }
  expect_failures = [var.runtime]
}
