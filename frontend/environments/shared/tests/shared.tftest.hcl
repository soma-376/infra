mock_provider "aws" {
  override_during = plan
}

variables {
  aws_account_id = "111111111111"
  peers = {
    dev = {
      vpc_id          = "vpc-00000000000000001", security_group_id = "sg-00000000000000001"
      route_table_ids = ["rtb-00000000000000001"]
    }
    prod = {
      vpc_id          = "vpc-00000000000000002", security_group_id = "sg-00000000000000002"
      route_table_ids = ["rtb-00000000000000002", "rtb-00000000000000003"]
    }
  }
}
override_data {
  target = data.aws_vpc.peer["dev"]
  values = {
    cidr_block              = "10.2.0.0/16"
    cidr_block_associations = [{ association_id = "vpc-cidr-assoc-dev", cidr_block = "10.2.0.0/16", state = "associated" }]
  }
}
override_data {
  target = data.aws_vpc.peer["prod"]
  values = {
    cidr_block              = "10.3.0.0/16"
    cidr_block_associations = [{ association_id = "vpc-cidr-assoc-prod", cidr_block = "10.3.0.0/16", state = "associated" }]
  }
}
override_data {
  target = data.aws_security_group.peer["dev"]
  values = { vpc_id = "vpc-00000000000000001" }
}
override_data {
  target = data.aws_security_group.peer["prod"]
  values = { vpc_id = "vpc-00000000000000002" }
}
override_data {
  target = data.aws_route_table.peer["dev-rtb-00000000000000001"]
  values = { vpc_id = "vpc-00000000000000001" }
}
override_data {
  target = data.aws_route_table.peer["prod-rtb-00000000000000002"]
  values = { vpc_id = "vpc-00000000000000002" }
}
override_data {
  target = data.aws_route_table.peer["prod-rtb-00000000000000003"]
  values = { vpc_id = "vpc-00000000000000002" }
}
override_resource {
  target          = aws_security_group.cache
  override_during = plan
  values          = { id = "sg-00000000000000003" }
}
override_resource {
  target          = aws_elasticache_serverless_cache.bff
  override_during = plan
  values          = { arn = "arn:aws:elasticache:ap-northeast-2:111111111111:serverlesscache:pulsemetry-frontend-shared" }
}
override_resource {
  target          = aws_elasticache_user.bff["dev"]
  override_during = plan
  values          = { arn = "arn:aws:elasticache:ap-northeast-2:111111111111:user:pulsemetry-bff-dev" }
}
override_resource {
  target          = aws_elasticache_user.bff["prod"]
  override_during = plan
  values          = { arn = "arn:aws:elasticache:ap-northeast-2:111111111111:user:pulsemetry-bff-prod" }
}
run "private_shared_cache" {
  command = plan
  assert {
    condition     = length(aws_subnet.cache) == 2 && alltrue([for subnet in aws_subnet.cache : !subnet.map_public_ip_on_launch]) && length(aws_route.to_cache) == 3 && length(aws_route.to_app) == 2
    error_message = "두 격리 서브넷 및 dev/prod 모든 route table의 왕복 경로가 필요합니다."
  }
  assert {
    condition     = alltrue([for env, rule in aws_vpc_security_group_ingress_rule.bff : rule.referenced_security_group_id == var.peers[env].security_group_id && rule.from_port == 6379 && rule.to_port == 6379]) && alltrue([for rule in aws_vpc_security_group_egress_rule.bff : rule.referenced_security_group_id == aws_security_group.cache.id && rule.from_port == 6379 && rule.to_port == 6379])
    error_message = "BFF SG와 cache SG 사이 primary 포트만 열어야 합니다."
  }
  assert {
    condition     = aws_elasticache_serverless_cache.bff.engine == "valkey" && aws_elasticache_serverless_cache.bff.cache_usage_limits[0].data_storage[0].maximum == 1 && aws_elasticache_serverless_cache.bff.cache_usage_limits[0].ecpu_per_second[0].maximum == 1000
    error_message = "Valkey 기본 최소 과금을 유지하고 사용량 최대값만 지정해야 합니다."
  }
  assert {
    condition     = alltrue([for env, user in aws_elasticache_user.bff : user.user_id == user.user_name && user.authentication_mode[0].type == "iam" && strcontains(user.access_string, "~${env}:* -@all") && !strcontains(user.access_string, "+@all") && !strcontains(user.access_string, "+flush") && !strcontains(user.access_string, "+scan")])
    error_message = "IAM 사용자와 환경별 키/명령 제한을 유지해야 합니다."
  }
  assert {
    condition     = alltrue([for env, policy in aws_iam_role_policy.connect : toset(jsondecode(policy.policy).Statement[0].Resource) == toset([aws_elasticache_serverless_cache.bff.arn, aws_elasticache_user.bff[env].arn]) && jsondecode(policy.policy).Statement[0].Action == ["elasticache:Connect"]])
    error_message = "태스크 역할은 캐시와 자기 환경 사용자에만 Connect 권한을 가져야 합니다."
  }
  assert {
    condition     = !output.notification_enabled && alltrue([for alarm in aws_cloudwatch_metric_alarm.cache : length(alarm.alarm_actions) == 0]) && aws_cloudwatch_metric_alarm.cache["compute"].threshold == 45000
    error_message = "미등록 수신처에는 알림을 발송하지 않고 ECPU 합계에 분당 환산을 적용해야 합니다."
  }
}
run "reject_wrong_sg_vpc" {
  command = plan
  override_data {
    target = data.aws_security_group.peer["dev"]
    values = { vpc_id = "vpc-00000000000000002" }
  }
  expect_failures = [aws_vpc_security_group_ingress_rule.bff["dev"]]
}
run "reject_wrong_route_vpc" {
  command = plan
  override_data {
    target = data.aws_route_table.peer["dev-rtb-00000000000000001"]
    values = { vpc_id = "vpc-00000000000000002" }
  }
  expect_failures = [aws_route.to_cache["dev-rtb-00000000000000001"]]
}
run "reject_changed_network" {
  command = plan
  override_data {
    target = data.aws_vpc.peer["dev"]
    values = { cidr_block = "10.4.0.0/16" }
  }
  expect_failures = [aws_vpc.cache]
}
run "reject_unbounded_compute" {
  command = plan
  variables { max_ecpu_per_second = 100000 }
  expect_failures = [var.max_ecpu_per_second]
}
run "dev_before_prod_ready" {
  command = plan
  variables {
    peers = {
      dev = {
        vpc_id          = "vpc-00000000000000001", security_group_id = "sg-00000000000000001"
        route_table_ids = ["rtb-00000000000000001"]
      }
    }
  }
  assert {
    condition     = length(aws_vpc_peering_connection.app) == 1 && length(aws_elasticache_user.bff) == 2
    error_message = "prod 미준비 시 dev 연결만 생성하되 두 환경 사용자 분리는 유지합니다."
  }
}
