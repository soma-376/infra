locals {
  name         = "pulsemetry-frontend-shared"
  vpc_cidr     = "10.4.0.0/24"
  environments = toset(["dev", "prod"])
  zones        = { "ap-northeast-2a" = 0, "ap-northeast-2c" = 1 }
  tags         = { Org = "soma-376", Project = "pulsemetry-frontend", Env = "shared", ManagedBy = "terraform" }
  peer_routes = merge([for env, peer in var.peers : {
    for id in peer.route_table_ids : "${env}-${id}" => { environment = env, id = id }
  }]...)
}

data "aws_vpc" "peer" {
  for_each = var.peers
  id       = each.value.vpc_id
}
data "aws_security_group" "peer" {
  for_each = var.peers
  id       = each.value.security_group_id
}
data "aws_route_table" "peer" {
  for_each       = local.peer_routes
  route_table_id = each.value.id
}

resource "aws_vpc" "cache" {
  cidr_block           = local.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = merge(local.tags, { Name = local.name })
  lifecycle {
    prevent_destroy = true
    precondition {
      condition     = alltrue([for env, vpc in data.aws_vpc.peer : vpc.cidr_block == { dev = "10.2.0.0/16", prod = "10.3.0.0/16" }[env]]) && alltrue([for vpc in data.aws_vpc.peer : length(vpc.cidr_block_associations) == 1])
      error_message = "기존 frontend CIDR dev=10.2/16·prod=10.3/16 및 secondary CIDR 부재를 확인하세요. 변경된 망은 공유 CIDR 충돌을 재검토해야 합니다."
    }
  }
}
resource "aws_subnet" "cache" {
  for_each                = local.zones
  vpc_id                  = aws_vpc.cache.id
  availability_zone       = each.key
  cidr_block              = cidrsubnet(local.vpc_cidr, 2, each.value)
  map_public_ip_on_launch = false
  tags                    = merge(local.tags, { Name = "${local.name}-${each.key}" })
}
resource "aws_route_table" "cache" {
  vpc_id = aws_vpc.cache.id
  tags   = merge(local.tags, { Name = local.name })
}
resource "aws_route_table_association" "cache" {
  for_each       = aws_subnet.cache
  subnet_id      = each.value.id
  route_table_id = aws_route_table.cache.id
}
resource "aws_vpc_peering_connection" "app" {
  for_each    = var.peers
  vpc_id      = aws_vpc.cache.id
  peer_vpc_id = each.value.vpc_id
  auto_accept = true
  requester { allow_remote_vpc_dns_resolution = true }
  accepter { allow_remote_vpc_dns_resolution = true }
  tags = merge(local.tags, { Name = "${local.name}-${each.key}" })
}
resource "aws_route" "to_app" {
  for_each                  = var.peers
  route_table_id            = aws_route_table.cache.id
  destination_cidr_block    = data.aws_vpc.peer[each.key].cidr_block
  vpc_peering_connection_id = aws_vpc_peering_connection.app[each.key].id
}
# 기존 root는 이 목적지의 경로를 별도로 선언하지 않는다. 공유 root만 소유한다.
resource "aws_route" "to_cache" {
  for_each                  = local.peer_routes
  route_table_id            = each.value.id
  destination_cidr_block    = local.vpc_cidr
  vpc_peering_connection_id = aws_vpc_peering_connection.app[each.value.environment].id
  lifecycle {
    precondition {
      condition     = data.aws_route_table.peer[each.key].vpc_id == var.peers[each.value.environment].vpc_id
      error_message = "route table이 지정 환경의 VPC에 속하지 않습니다."
    }
  }
}
resource "aws_security_group" "cache" {
  name        = "${local.name}-valkey"
  description = "TLS Valkey access from frontend BFF security groups only"
  vpc_id      = aws_vpc.cache.id
  tags        = local.tags
  # 캐시는 외부로 연결을 시작하지 않는다. 응답 트래픽은 stateful SG가 허용한다.
}
resource "aws_vpc_security_group_ingress_rule" "bff" {
  for_each                     = var.peers
  security_group_id            = aws_security_group.cache.id
  referenced_security_group_id = each.value.security_group_id
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
  description                  = "${each.key} BFF primary endpoint"
  tags                         = local.tags
  depends_on                   = [aws_vpc_peering_connection.app]
  lifecycle {
    precondition {
      condition     = data.aws_security_group.peer[each.key].vpc_id == each.value.vpc_id
      error_message = "BFF SG가 지정 환경의 VPC에 속하지 않습니다."
    }
  }
}
resource "aws_elasticache_user" "bff" {
  for_each  = local.environments
  user_id   = "pulsemetry-bff-${each.key}"
  user_name = "pulsemetry-bff-${each.key}"
  engine    = "valkey"
  # Lua 잠금 해제와 버전 비교에 필요한 명령만 허용한다. 스크립트 내부도 ACL 검사를 받는다.
  access_string = "on ~${each.key}:* -@all +ping +hello +get +set +del +unlink +exists +expire +pexpire +ttl +pttl +eval +evalsha +script|load +cluster|slots +cluster|shards +client|setname +client|setinfo"
  authentication_mode { type = "iam" }
  tags = merge(local.tags, { Env = each.key })
}
resource "aws_elasticache_user_group" "bff" {
  engine        = "valkey"
  user_group_id = "pulsemetry-bff-shared"
  user_ids      = [for user in aws_elasticache_user.bff : user.user_id]
  tags          = local.tags
}
resource "aws_elasticache_serverless_cache" "bff" {
  engine                   = "valkey"
  major_engine_version     = "8"
  name                     = local.name
  subnet_ids               = [for subnet in aws_subnet.cache : subnet.id]
  security_group_ids       = [aws_security_group.cache.id]
  user_group_id            = aws_elasticache_user_group.bff.user_group_id
  snapshot_retention_limit = 0
  cache_usage_limits {
    data_storage {
      maximum = var.max_storage_gb
      unit    = "GB"
    }
    ecpu_per_second { maximum = var.max_ecpu_per_second }
  }
  tags = local.tags
  lifecycle { prevent_destroy = true }
}
resource "aws_iam_role" "bff" {
  for_each = local.environments
  name     = "soma-376-frontend-${each.key}-valkey-task"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow", Action = "sts:AssumeRole", Principal = { Service = "ecs-tasks.amazonaws.com" }
      Condition = {
        StringEquals = { "aws:SourceAccount" = var.aws_account_id }
        ArnLike      = { "aws:SourceArn" = "arn:aws:ecs:ap-northeast-2:${var.aws_account_id}:*" }
      }
    }]
  })
  tags = merge(local.tags, { Env = each.key })
}
resource "aws_iam_role_policy" "connect" {
  for_each = local.environments
  name     = "valkey-connect"
  role     = aws_iam_role.bff[each.key].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow", Action = ["elasticache:Connect"]
      Resource = [aws_elasticache_serverless_cache.bff.arn, aws_elasticache_user.bff[each.key].arn]
    }]
  })
}
resource "aws_vpc_security_group_egress_rule" "bff" {
  for_each                     = var.peers
  security_group_id            = each.value.security_group_id
  referenced_security_group_id = aws_security_group.cache.id
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
  description                  = "Shared Valkey primary endpoint"
  tags                         = local.tags
  depends_on                   = [aws_vpc_peering_connection.app]
}
