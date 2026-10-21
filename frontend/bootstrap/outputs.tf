output "state_buckets" { value = { for env, bucket in aws_s3_bucket.state : env => bucket.id } }
output "ecr_repositories" { value = { for env, repo in aws_ecr_repository.frontend : env => repo.repository_url } }
output "github_roles" { value = { for name, role in aws_iam_role.terraform : name => role.arn } }
output "frontend_image_push_roles" { value = { for env, role in aws_iam_role.frontend_image_push : env => role.arn } }
