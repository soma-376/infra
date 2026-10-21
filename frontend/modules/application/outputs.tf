output "endpoint" { value = "https://${var.runtime.domain_name}" }
output "alb_dns_name" { value = aws_lb.frontend.dns_name }
output "certificate_arn" { value = var.runtime.certificate_arn }
output "cluster_name" { value = aws_ecs_cluster.frontend.name }
output "service_name" { value = aws_ecs_service.frontend.name }
output "dev_instance_id" { value = try(aws_instance.dev[0].id, null) }
