output "cache" {
  description = "BFF 연결 준비용 메타데이터. 토큰이나 비밀번호는 출력하지 않는다."
  value = {
    name              = aws_elasticache_serverless_cache.bff.name
    arn               = aws_elasticache_serverless_cache.bff.arn
    endpoint          = aws_elasticache_serverless_cache.bff.endpoint
    security_group_id = aws_security_group.cache.id
    vpc_id            = aws_vpc.cache.id
    tls_required      = true
    users = { for env, user in aws_elasticache_user.bff : env => {
      username      = user.user_name
      key_prefix    = "${env}:"
      task_role_arn = aws_iam_role.bff[env].arn
    } }
  }
}
output "notification_enabled" { value = var.alarm_topic_arn != null }
