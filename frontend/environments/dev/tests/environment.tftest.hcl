mock_provider "aws" {}
variables {
  aws_account_id             = "111111111111"
  frontend_telemetry_enabled = false
  runtime                    = null
  observability              = null
}
run "environment_contract" {
  command = plan
  assert {
    condition     = length(aws_ssm_association.faro) == 0 && length(aws_vpc_security_group_ingress_rule.frontend_faro) == 0 && length(aws_ssm_association.host_agent) == 0 && length(aws_ssm_document.host_agent) == 0 && length(aws_ecs_service.host_agent) == 0 && length(aws_ecs_task_definition.host_agent) == 0
    error_message = "관측 비활성 상태에서는 호스트 설치 작업을 만들지 않습니다."
  }
  assert {
    condition     = output.network.vpc_cidr == "10.2.0.0/16" && length(output.network.public_subnet_cidrs) == 2 && length(output.network.private_subnet_cidrs) == 0
    error_message = "dev 환경의 CIDR 또는 서브넷 개수가 잘못되었습니다."
  }
}

run "dev_otlp_security_boundary" {
  command = plan
  variables {
    frontend_telemetry_enabled = true
    observability              = { ami_id = "ami-0123456789abcdef0" }
    runtime = {
      domain_name        = "frontend.example.com"
      certificate_arn    = "arn:aws:acm:ap-northeast-2:111111111111:certificate/00000000-0000-0000-0000-000000000001"
      image_digest       = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      enrollment_api_url = "https://api.example.com"
      dashboard_api_url  = "https://api.example.com"
      dev_ami_id         = "ami-0123456789abcdef0"
    }
  }
  override_module {
    target  = module.application[0]
    outputs = { security_group_id = "sg-00000000000000001", dev_instance_id = "i-0123456789abcdef0", cluster_name = "soma-376-frontend-dev", dev_instance_zones = { "i-0123456789abcdef0" = "ap-northeast-2a", "i-0123456789abcdef1" = "ap-northeast-2c" } }
  }
  override_module {
    target  = module.observability[0]
    outputs = { instance_id = "i-0123456789abcdef1", security_group_id = "sg-00000000000000002", otlp_endpoint = "http://10.2.0.142:4318" }
  }
  assert {
    condition     = aws_vpc_security_group_ingress_rule.frontend_faro[0].from_port == 12347 && aws_vpc_security_group_ingress_rule.frontend_faro[0].referenced_security_group_id == "sg-00000000000000001" && aws_ssm_association.faro[0].targets[0].values == tolist(["i-0123456789abcdef1"])
    error_message = "Faro 수신은 앱 보안 그룹에만 허용하고 관측 EC2에 설치해야 합니다."
  }
  assert {
    condition     = aws_vpc_security_group_ingress_rule.frontend_otlp[0].security_group_id == "sg-00000000000000002" && aws_vpc_security_group_ingress_rule.frontend_otlp[0].referenced_security_group_id == "sg-00000000000000001" && aws_vpc_security_group_ingress_rule.frontend_otlp[0].cidr_ipv4 == null && aws_vpc_security_group_ingress_rule.frontend_otlp[0].from_port == 4318 && aws_vpc_security_group_ingress_rule.frontend_otlp[0].to_port == 4318
    error_message = "OTLP 수신은 dev 앱 SG에서 오는 TCP 4318만 허용해야 합니다."
  }
  assert {
    condition     = aws_vpc_security_group_egress_rule.frontend_otlp[0].security_group_id == "sg-00000000000000001" && aws_vpc_security_group_egress_rule.frontend_otlp[0].referenced_security_group_id == "sg-00000000000000002" && aws_vpc_security_group_egress_rule.frontend_otlp[0].cidr_ipv4 == null && aws_vpc_security_group_egress_rule.frontend_otlp[0].to_port == 4318
    error_message = "OTLP 송신은 관측 SG의 TCP 4318로만 제한해야 합니다."
  }
  assert {
    condition     = length(aws_ssm_document.host_agent) == 1 && one(aws_ssm_association.host_agent[0].targets).values == tolist(["i-0123456789abcdef0"]) && aws_ssm_association.host_agent[0].wait_for_success_timeout_seconds == 900
    error_message = "기존 수집기 정리는 dev EC2 ID만 대상으로 성공을 기다려야 합니다."
  }
  assert {
    condition     = strcontains(aws_ssm_document.host_agent[0].content, "removeLegacyHostAgent") && !strcontains(aws_ssm_document.host_agent[0].content, "docker run") && !strcontains(aws_ssm_document.host_agent[0].content, "AWS-RunShellScript")
    error_message = "SSM은 기존 수집기 정리만 수행하며 새 컨테이너를 설치하면 안 됩니다."
  }


  assert {
    condition     = aws_ecs_service.host_agent[0].scheduling_strategy == "DAEMON" && aws_ecs_service.host_agent[0].launch_type == "EC2" && aws_ecs_service.host_agent[0].deployment_maximum_percent == 100 && aws_ecs_service.host_agent[0].deployment_minimum_healthy_percent == 0
    error_message = "호스트마다 Alloy 하나를 실행하고 갱신 중 중복 수집을 방지해야 합니다."
  }
  assert {
    condition     = aws_ecs_task_definition.host_agent[0].network_mode == "bridge" && aws_ecs_task_definition.host_agent[0].pid_mode == "host" && aws_ecs_task_definition.host_agent[0].runtime_platform[0].cpu_architecture == "ARM64" && alltrue([for m in jsondecode(aws_ecs_task_definition.host_agent[0].container_definitions)[0].mountPoints : m.readOnly])
    error_message = "ARM64 호스트를 읽기 전용으로 수집하고 공개 포트를 만들지 않습니다."
  }
  assert {
    condition     = jsondecode(aws_ecs_task_definition.host_agent[0].container_definitions)[0].memory == 256 && jsondecode(aws_ecs_task_definition.host_agent[0].container_definitions)[0].readonlyRootFilesystem && !jsondecode(aws_ecs_task_definition.host_agent[0].container_definitions)[0].privileged && !can(jsondecode(aws_ecs_task_definition.host_agent[0].container_definitions)[0].portMappings)
    error_message = "Alloy는 256MiB 제한, 읽기 전용 루트, 비특권, 포트 미공개를 유지해야 합니다."
  }
  assert {
    condition     = contains(jsondecode(aws_ecs_task_definition.host_agent[0].container_definitions)[0].environment, { name = "OTEL_EXPORTER_OTLP_ENDPOINT", value = "http://10.2.0.142:4318" })
    error_message = "ECS 수집기는 기존 사설 OTLP endpoint를 사용해야 합니다."
  }
}

run "host_agent_two_az_mapping" {
  command = plan
  variables {
    frontend_telemetry_enabled = true
    observability              = { ami_id = "ami-0123456789abcdef0" }
    runtime = {
      domain_name        = "frontend.example.com"
      certificate_arn    = "arn:aws:acm:ap-northeast-2:111111111111:certificate/00000000-0000-0000-0000-000000000001"
      image_digest       = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      enrollment_api_url = "https://api.example.com"
      dashboard_api_url  = "https://api.example.com"
      dev_ami_id         = "ami-0123456789abcdef0"
    }
  }
  override_module {
    target  = module.application[0]
    outputs = { security_group_id = "sg-00000000000000001", dev_instance_id = "i-0123456789abcdef0", cluster_name = "soma-376-frontend-dev", dev_instance_zones = { "i-0123456789abcdef0" = "ap-northeast-2a", "i-0123456789abcdef1" = "ap-northeast-2c" } }
  }
  override_module {
    target  = module.observability[0]
    outputs = { instance_id = "i-0123456789abcdef1", security_group_id = "sg-00000000000000002", otlp_endpoint = "http://10.2.0.142:4318" }
  }
  assert {
    condition     = contains(jsondecode(aws_ecs_task_definition.host_agent[0].container_definitions)[0].environment, { name = "HOST_AZ_MAP", value = "i-0123456789abcdef0:ap-northeast-2a i-0123456789abcdef1:ap-northeast-2c" })
    error_message = "두 호스트의 ID와 AZ를 Alloy에 전달해야 합니다."
  }
}
