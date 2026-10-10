locals {
  name               = "soma-376-frontend-${var.environment}"
  region             = "ap-northeast-2"
  tags               = { Org = "soma-376", Project = "pulsemetry-frontend", Env = var.environment, ManagedBy = "terraform" }
  is_dev             = var.environment == "dev"
  execution_role_arn = "arn:aws:iam::${var.aws_account_id}:role/${local.name}-execution"
  image              = "${var.aws_account_id}.dkr.ecr.${local.region}.amazonaws.com/soma-376/pulsemetry-frontend-${var.environment}@${var.runtime.image_digest}"
}

data "aws_secretsmanager_secret" "bff" {
  name = "${local.name}/bff-session-keys"
}

data "aws_route53_zone" "frontend" {
  zone_id      = var.runtime.route53_zone_id
  private_zone = false
  lifecycle {
    postcondition {
      condition     = !self.private_zone && (var.runtime.domain_name == trimsuffix(self.name, ".") || endswith(var.runtime.domain_name, ".${trimsuffix(self.name, ".")}"))
      error_message = "도메인을 관리하는 public zone을 지정하세요."
    }
  }
}

resource "aws_security_group" "alb" {
  name        = "${local.name}-alb"
  description = "Public frontend HTTPS load balancer"
  vpc_id      = var.vpc_id
  tags        = merge(local.tags, { Name = "${local.name}-alb" })
}
resource "aws_security_group" "app" {
  name        = "${local.name}-app"
  description = "Frontend container accepts only the ALB"
  vpc_id      = var.vpc_id
  tags        = merge(local.tags, { Name = "${local.name}-app" })
}
resource "aws_vpc_security_group_ingress_rule" "https" {
  security_group_id = aws_security_group.alb.id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
  tags              = local.tags
}
resource "aws_vpc_security_group_ingress_rule" "http_redirect" {
  security_group_id = aws_security_group.alb.id
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  cidr_ipv4         = "0.0.0.0/0"
  tags              = local.tags
}
resource "aws_vpc_security_group_ingress_rule" "app" {
  security_group_id            = aws_security_group.app.id
  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
  tags                         = local.tags
}
resource "aws_vpc_security_group_egress_rule" "alb" {
  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = aws_security_group.app.id
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
  tags                         = local.tags
}
resource "aws_vpc_security_group_egress_rule" "app_https" {
  security_group_id = aws_security_group.app.id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
  tags              = local.tags
}

resource "aws_acm_certificate" "frontend" {
  domain_name       = var.runtime.domain_name
  validation_method = "DNS"
  tags              = local.tags
  lifecycle { create_before_destroy = true }
}
resource "aws_route53_record" "validation" {
  for_each = {
    for dvo in aws_acm_certificate.frontend.domain_validation_options : dvo.domain_name => dvo
  }
  zone_id = data.aws_route53_zone.frontend.zone_id
  name    = each.value.resource_record_name
  type    = each.value.resource_record_type
  records = [each.value.resource_record_value]
  ttl     = 60
}
resource "aws_acm_certificate_validation" "frontend" {
  certificate_arn         = aws_acm_certificate.frontend.arn
  validation_record_fqdns = [for record in aws_route53_record.validation : record.fqdn]
  timeouts { create = "30m" }
}
resource "aws_lb" "frontend" {
  name                       = local.name
  internal                   = false
  load_balancer_type         = "application"
  ip_address_type            = "ipv4"
  subnets                    = var.public_subnet_ids
  security_groups            = [aws_security_group.alb.id]
  drop_invalid_header_fields = true
  enable_deletion_protection = var.environment == "prod"
  tags                       = local.tags
}
resource "aws_lb_target_group" "frontend" {
  name                 = local.name
  vpc_id               = var.vpc_id
  target_type          = local.is_dev ? "instance" : "ip"
  port                 = 3000
  protocol             = "HTTP"
  deregistration_delay = 30
  health_check {
    path                = "/"
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
  tags = local.tags
}
resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.frontend.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.frontend.certificate_arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.frontend.arn
  }
  tags = local.tags
}
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.frontend.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
  tags = local.tags
}
resource "aws_route53_record" "frontend" {
  zone_id = data.aws_route53_zone.frontend.zone_id
  name    = var.runtime.domain_name
  type    = "A"
  alias {
    name                   = aws_lb.frontend.dns_name
    zone_id                = aws_lb.frontend.zone_id
    evaluate_target_health = true
  }
}

resource "aws_cloudwatch_log_group" "frontend" {
  skip_destroy      = true
  name              = "/ecs/${local.name}"
  retention_in_days = var.environment == "prod" ? 30 : 14
  tags              = local.tags
}
resource "aws_ecs_cluster" "frontend" {
  name = local.name
  tags = local.tags
}
resource "aws_ecs_task_definition" "frontend" {
  family                   = local.name
  requires_compatibilities = [local.is_dev ? "EC2" : "FARGATE"]
  network_mode             = local.is_dev ? "bridge" : "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = local.execution_role_arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }
  container_definitions = jsonencode([{
    name         = "frontend"
    image        = local.image
    essential    = true
    cpu          = 512
    memory       = 1024
    portMappings = [{ containerPort = 3000, hostPort = 3000, protocol = "tcp" }]
    stopTimeout  = 30
    environment = [
      { name = "NODE_ENV", value = "production" },
      { name = "PORT", value = "3000" },
      { name = "HOSTNAME", value = "0.0.0.0" },
      { name = "BFF_ORIGIN", value = "https://${var.runtime.domain_name}" },
      { name = "ENROLLMENT_API_URL", value = var.runtime.enrollment_api_url },
      { name = "DASHBOARD_API_URL", value = var.runtime.dashboard_api_url }
    ]
    secrets = [{ name = "BFF_SESSION_KEYS", valueFrom = data.aws_secretsmanager_secret.bff.arn }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.frontend.name
        awslogs-region        = local.region
        awslogs-stream-prefix = "frontend"
      }
    }
  }])
  tags = local.tags
}

# AMI 변경은 PR에서 고정 ID를 갱신한다. latest 조회로 인한 예기치 않은 EC2 교체를 피한다.
data "aws_ami" "dev" {
  count  = local.is_dev ? 1 : 0
  owners = ["amazon"]
  filter {
    name   = "image-id"
    values = [var.runtime.dev_ami_id]
  }
  filter {
    name   = "architecture"
    values = ["arm64"]
  }
  filter {
    name   = "name"
    values = ["al2023-ami-ecs-hvm-*-arm64"]
  }
}
resource "aws_instance" "dev" {
  count                       = local.is_dev ? 1 : 0
  ami                         = data.aws_ami.dev[0].id
  instance_type               = "t4g.small"
  subnet_id                   = var.public_subnet_ids[0]
  associate_public_ip_address = true
  vpc_security_group_ids      = [aws_security_group.app.id]
  iam_instance_profile        = "${local.name}-instance"
  user_data_replace_on_change = true
  user_data                   = <<-EOT
    #!/bin/bash
    set -euo pipefail
    cat >> /etc/ecs/ecs.config <<'EOF'
    ECS_CLUSTER=${aws_ecs_cluster.frontend.name}
    ECS_ENABLE_AWSLOGS_EXECUTIONROLE_OVERRIDE=true
    EOF
    # 앱 bridge 네트워크에서 호스트 IAM 자격증명 접근을 차단한다.
    cat > /etc/systemd/system/frontend-imds-guard.service <<'EOF'
    [Unit]
    After=docker.service
    Requires=docker.service
    PartOf=docker.service
    Before=ecs.service
    [Service]
    Type=oneshot
    ExecStart=/usr/sbin/iptables -I DOCKER-USER -d 169.254.169.254/32 -j REJECT
    RemainAfterExit=yes
    [Install]
    WantedBy=multi-user.target
    EOF
    mkdir -p /etc/systemd/system/ecs.service.d
    cat > /etc/systemd/system/ecs.service.d/frontend-guard.conf <<'EOF'
    [Unit]
    Requires=frontend-imds-guard.service
    After=frontend-imds-guard.service
    EOF
    systemctl daemon-reload
    systemctl enable frontend-imds-guard.service
    systemctl start --no-block frontend-imds-guard.service
  EOT
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 2
  }
  root_block_device {
    volume_type           = "gp3"
    volume_size           = 30
    encrypted             = true
    delete_on_termination = true
    tags                  = local.tags
  }
  credit_specification { cpu_credits = "standard" }
  tags = merge(local.tags, { Name = local.name })
}

resource "aws_ecs_service" "frontend" {
  name                               = local.name
  cluster                            = aws_ecs_cluster.frontend.id
  task_definition                    = aws_ecs_task_definition.frontend.arn
  launch_type                        = local.is_dev ? "EC2" : "FARGATE"
  platform_version                   = local.is_dev ? null : "1.4.0"
  desired_count                      = 1
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100
  health_check_grace_period_seconds  = 120
  wait_for_steady_state              = true
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  dynamic "network_configuration" {
    for_each = local.is_dev ? [] : [true]
    content {
      subnets          = var.private_subnet_ids
      security_groups  = [aws_security_group.app.id]
      assign_public_ip = false
    }
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.frontend.arn
    container_name   = "frontend"
    container_port   = 3000
  }
  lifecycle {
    postcondition {
      condition     = self.task_definition == aws_ecs_task_definition.frontend.arn
      error_message = "ECS가 요청한 task definition에 도달하지 못했습니다. 서비스 event와 rollback 상태를 확인하세요."
    }
  }
  tags       = local.tags
  depends_on = [aws_lb_listener.https, aws_instance.dev]
  timeouts {
    create = "20m"
    update = "20m"
    delete = "20m"
  }
}
