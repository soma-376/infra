locals {
  name  = "soma-376-frontend-observability"
  tags  = { Org = "soma-376", Project = "pulsemetry-frontend", Env = "dev", ManagedBy = "terraform", Component = "observability" }
  files = { for name in fileset("${path.module}/files", "**") : name => filebase64("${path.module}/files/${name}") }
  boot = templatefile("${path.module}/bootstrap.sh.tftpl", {
    files     = local.files
    volume_id = aws_ebs_volume.data.id
  })
}
data "aws_iam_instance_profile" "this" { name = local.name }
data "aws_subnet" "this" { id = var.subnet_id }
data "aws_ami" "this" {
  owners = ["amazon"]
  filter {
    name   = "image-id"
    values = [var.ami_id]
  }
  filter {
    name   = "architecture"
    values = ["arm64"]
  }
  filter {
    name   = "name"
    values = ["al2023-ami-*-arm64"]
  }
}
resource "aws_security_group" "this" {
  name        = local.name
  description = "Observability: no ingress until client connection is configured"
  vpc_id      = var.vpc_id
  tags        = local.tags
}
resource "aws_vpc_security_group_egress_rule" "https" {
  security_group_id = aws_security_group.this.id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
  tags              = local.tags
}
resource "aws_ebs_volume" "data" {
  availability_zone = data.aws_subnet.this.availability_zone
  type              = "gp3"
  size              = 100
  encrypted         = true
  tags              = merge(local.tags, { Name = "${local.name}-data" })
  lifecycle { prevent_destroy = true }
}
resource "aws_instance" "this" {
  ami                         = data.aws_ami.this.id
  instance_type               = "t4g.medium"
  subnet_id                   = var.subnet_id
  associate_public_ip_address = true
  vpc_security_group_ids      = [aws_security_group.this.id]
  iam_instance_profile        = data.aws_iam_instance_profile.this.name
  user_data_base64            = base64gzip(local.boot)
  user_data_replace_on_change = true
  # 초기 비용을 제한한다. 크레딧 소진 시 CPU가 baseline으로 제한된다.
  credit_specification {
    cpu_credits = "standard"
  }
  metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }
  root_block_device {
    volume_type = "gp3"
    volume_size = 20
    encrypted   = true
  }
  tags        = merge(local.tags, { Name = local.name })
  volume_tags = local.tags
  lifecycle {
    # 별도 aws_ebs_volume이 연결된 데이터 볼륨의 태그를 소유한다.
    # EC2의 volume_tags refresh가 데이터 볼륨 Name까지 합쳐 반환하므로 덮어쓰지 않는다.
    ignore_changes = [volume_tags]
    precondition {
      condition     = data.aws_subnet.this.vpc_id == var.vpc_id
      error_message = "관측 서브넷은 지정한 VPC에 속해야 합니다."
    }
    precondition {
      condition     = length(base64gzip(local.boot)) <= 21844
      error_message = "압축 user data가 EC2 16KiB 한도를 초과했습니다."
    }
  }
}
resource "aws_volume_attachment" "data" {
  device_name                    = "/dev/sdf"
  volume_id                      = aws_ebs_volume.data.id
  instance_id                    = aws_instance.this.id
  force_detach                   = false
  stop_instance_before_detaching = true
}
output "instance_id" { value = aws_instance.this.id }
output "private_ip" { value = aws_instance.this.private_ip }
output "data_volume_id" { value = aws_ebs_volume.data.id }
output "security_group_id" { value = aws_security_group.this.id }
output "otlp_endpoint" { value = "http://${aws_instance.this.private_ip}:4318" }
