locals {
  host_agent_name     = "soma-376-frontend-dev-host-agent"
  host_agent_ecs_tags = merge(local.telemetry_tags, { Component = "host-agent" })
}

resource "aws_ecs_task_definition" "host_agent" {
  count                    = var.frontend_telemetry_enabled ? 1 : 0
  family                   = local.host_agent_name
  skip_destroy             = true
  requires_compatibilities = ["EC2"]
  network_mode             = "bridge"
  pid_mode                 = "host"
  cpu                      = "256"
  memory                   = "256"
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }
  dynamic "volume" {
    for_each = { proc = "/proc", sys = "/sys", root = "/", instance = "/var/lib/cloud/data/instance-id" }
    content {
      name      = volume.key
      host_path = volume.value
    }
  }
  # 공개 이미지와 로컬 순환 로그만 사용하므로 execution/task IAM 역할은 필요 없다.
  container_definitions = jsonencode([{
    name                   = "host-alloy"
    image                  = "grafana/alloy:v1.21.2@sha256:89a5a320168387336b9ac3c850609c3ba7757eadd4ae5f1d819deb35e9854b18"
    essential              = true
    cpu                    = 256
    memory                 = 256
    user                   = "0:0"
    readonlyRootFilesystem = true
    privileged             = false
    entryPoint             = ["/bin/sh", "-ec"]
    command                = [file("${path.module}/../../observability/host-agent/start-ecs.sh")]
    stopTimeout            = 30
    environment = [
      { name = "ALLOY_CONFIG", value = file("${path.module}/../../observability/host-agent/config.alloy") },
      { name = "HOST_ENVIRONMENT", value = "dev" },
      { name = "HOST_ROLE", value = "frontend-dev" },
      { name = "OTEL_EXPORTER_OTLP_ENDPOINT", value = module.observability[0].otlp_endpoint }
    ]
    mountPoints = [
      { sourceVolume = "proc", containerPath = "/host/proc", readOnly = true },
      { sourceVolume = "sys", containerPath = "/host/sys", readOnly = true },
      { sourceVolume = "root", containerPath = "/host/root", readOnly = true },
      { sourceVolume = "instance", containerPath = "/host/instance-id", readOnly = true }
    ]
    linuxParameters = {
      capabilities = { drop = ["ALL"] }
      tmpfs        = [{ containerPath = "/var/lib/alloy", size = 64, mountOptions = ["rw", "nosuid", "nodev", "mode=0755"] }]
    }
    logConfiguration = { logDriver = "json-file", options = { "max-size" = "10m", "max-file" = "3" } }
  }])
  tags = local.host_agent_ecs_tags
}

resource "aws_ecs_service" "host_agent" {
  count                              = var.frontend_telemetry_enabled ? 1 : 0
  name                               = local.host_agent_name
  cluster                            = module.application[0].cluster_name
  task_definition                    = aws_ecs_task_definition.host_agent[0].arn
  launch_type                        = "EC2"
  scheduling_strategy                = "DAEMON"
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100
  wait_for_steady_state              = true
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  lifecycle {
    postcondition {
      condition     = self.task_definition == aws_ecs_task_definition.host_agent[0].arn
      error_message = "Alloy 서비스가 요청한 revision에 도달하지 못했습니다. ECS rollback/events를 확인하세요."
    }
  }
  tags = local.host_agent_ecs_tags
  # 기존 Docker 수집기 정리가 성공하기 전에는 중복 수집을 시작하지 않는다.
  depends_on = [aws_ssm_association.host_agent, aws_vpc_security_group_ingress_rule.frontend_otlp, aws_vpc_security_group_egress_rule.frontend_otlp]
}

output "host_agent_service_name" { value = try(aws_ecs_service.host_agent[0].name, null) }
