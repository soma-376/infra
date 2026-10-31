output "endpoint" { value = "https://${var.runtime.domain_name}" }
output "alb_dns_name" { value = aws_lb.frontend.dns_name }
output "certificate_arn" { value = var.runtime.certificate_arn }
output "cluster_name" { value = aws_ecs_cluster.frontend.name }
output "service_name" { value = aws_ecs_service.frontend.name }
output "dev_instance_id" { value = try(aws_instance.dev[0].id, null) }

output "security_group_id" { value = aws_security_group.app.id }

# 기존 단일 ID 출력은 전환 정리 Association 호환성을 위해 유지한다.
output "dev_instance_zones" {
  value = { for instance in aws_instance.dev : instance.id => instance.availability_zone }
}
