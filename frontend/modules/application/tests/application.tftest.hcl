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
  assert {
    condition     = aws_instance.dev[0].subnet_id == var.public_subnet_ids[0] && aws_instance.dev[1].subnet_id == var.public_subnet_ids[1] && aws_instance.dev[0].user_data == aws_instance.dev[1].user_data
    error_message = "기존 [0] 호스트를 유지하며 두 번째 서브넷에 같은 ECS 부팅 설정으로 추가해야 합니다."
  }
  assert {
    condition     = aws_ecs_task_definition.frontend.memory == "512" && jsondecode(aws_ecs_task_definition.frontend.container_definitions)[0].memory == 512 && one(aws_ecs_service.frontend.placement_constraints).expression == "attribute:ecs.availability-zone == ap-northeast-2a"
    error_message = "dev 앱은 512MiB이며 롤링 전환 전까지 2a에 고정해야 합니다."
  }
  assert {
    condition     = aws_lb_target_group.frontend.health_check[0].path == "/health" && aws_lb_target_group.frontend.health_check[0].matcher == "200"
    error_message = "인증이 필요 없는 전용 /health 경로의 200 응답으로 상태를 검사해야 합니다."
  }
  assert {
    condition     = aws_ecs_task_definition.frontend.skip_destroy
    error_message = "태스크 정의 revision을 보관하여 CI에 계정 전체 등록 해제 권한을 주지 않아야 합니다."
  }
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
    condition     = length(aws_instance.dev) == 2 && aws_instance.dev[0].associate_public_ip_address && aws_instance.dev[0].metadata_options[0].http_tokens == "required" && aws_instance.dev[0].root_block_device[0].encrypted && aws_ecs_task_definition.frontend.network_mode == "bridge" && aws_lb_target_group.frontend.target_type == "instance"
    error_message = "개발은 암호화·IMDSv2를 설정한 public EC2 두 대와 bridge 컨테이너를 사용합니다."
  }
  assert {
    condition     = aws_instance.dev[0].volume_tags["Project"] == "pulsemetry-frontend" && aws_instance.dev[0].volume_tags["Env"] == "dev" && aws_instance.dev[0].volume_tags["ManagedBy"] == "terraform"
    error_message = "RunInstances 권한 조건을 위해 EBS 소유권 태그를 생성 요청에 포함해야 합니다."
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
  assert {
    condition     = aws_ecs_task_definition.frontend.memory == "1024" && jsondecode(aws_ecs_task_definition.frontend.container_definitions)[0].memory == 1024 && length(aws_ecs_service.frontend.placement_constraints) == 0
    error_message = "prod Fargate 메모리와 배치 설정은 변경하지 않습니다."
  }
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

run "automatic_image_delivery" {
  command = plan
  variables {
    runtime = {
      domain_name                = "frontend.example.com"
      certificate_arn            = "arn:aws:acm:ap-northeast-2:111111111111:certificate/00000000-0000-0000-0000-000000000001"
      image_digest               = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      automatic_image_deployment = true
      enrollment_api_url         = "https://enrollment.example.com"
      dashboard_api_url          = "https://dashboard.example.com"
      dev_ami_id                 = "ami-0123456789abcdef0"
    }
  }
  assert {
    condition     = jsondecode(aws_ecs_task_definition.frontend.container_definitions)[0].image == "111111111111.dkr.ecr.ap-northeast-2.amazonaws.com/soma-376/pulsemetry-frontend-dev:deploy" && jsondecode(aws_ecs_task_definition.frontend.container_definitions)[0].versionConsistency == "enabled"
    error_message = "자동 배포는 환경별 deploy 태그와 ECS digest 해석을 사용해야 합니다."
  }
  assert {
    condition     = strcontains(aws_instance.dev[0].user_data, "ECS_IMAGE_PULL_BEHAVIOR=always")
    error_message = "이미지 pull 실패를 캐시 이미지로 숨기면 안 됩니다."
  }
}

run "dev_telemetry_environment" {
  command = plan
  variables { telemetry = { endpoint = "http://10.2.0.142:4318" } }
  assert {
    condition = alltrue([for name, value in {
      OTEL_SDK_DISABLED           = "false"
      OTEL_DEPLOYMENT_ENVIRONMENT = "dev"
      OTEL_SERVICE_NAME           = "pulsemetry-frontend"
      OTEL_EXPORTER_OTLP_ENDPOINT = "http://10.2.0.142:4318"
    } : contains(jsondecode(aws_ecs_task_definition.frontend.container_definitions)[0].environment, { name = name, value = value })])
    error_message = "dev 태스크에는 SDK 활성화와 정확한 환경·서비스·OTLP 주소가 전달되어야 합니다."
  }
}
run "telemetry_disabled_by_default" {
  command = plan
  assert {
    condition     = alltrue([for item in jsondecode(aws_ecs_task_definition.frontend.container_definitions)[0].environment : !startswith(item.name, "OTEL_")])
    error_message = "명시적으로 활성화하지 않은 환경의 기존 OTel 설정을 변경하지 않습니다."
  }
}
run "reject_prod_dev_telemetry" {
  command = plan
  variables {
    environment = "prod"
    telemetry   = { endpoint = "http://10.2.0.142:4318" }
  }
  expect_failures = [var.telemetry]
}
