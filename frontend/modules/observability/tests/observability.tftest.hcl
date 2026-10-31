mock_provider "aws" {
  override_during = plan
  mock_data "aws_iam_instance_profile" {
    defaults = { name = "soma-376-frontend-observability" }
  }
  mock_data "aws_subnet" {
    defaults = { availability_zone = "ap-northeast-2a", vpc_id = "vpc-0123456789abcdef0" }
  }
  mock_data "aws_ami" {
    defaults = { id = "ami-0123456789abcdef0" }
  }
  mock_resource "aws_ebs_volume" {
    defaults = { id = "vol-0123456789abcdef0" }
  }
}
variables {
  vpc_id    = "vpc-0123456789abcdef0"
  subnet_id = "subnet-0123456789abcdef0"
  ami_id    = "ami-0123456789abcdef0"
}
run "isolated_host_and_durable_storage" {
  command = plan
  assert {
    condition     = aws_instance.this.instance_type == "t4g.medium" && aws_instance.this.credit_specification[0].cpu_credits == "standard" && aws_instance.this.root_block_device[0].volume_size == 20 && aws_instance.this.root_block_device[0].encrypted && aws_instance.this.metadata_options[0].http_tokens == "required" && aws_instance.this.metadata_options[0].http_put_response_hop_limit == 1
    error_message = "인스턴스 사양·암호화·IMDSv2 경계를 유지해야 합니다."
  }
  assert {
    condition     = aws_ebs_volume.data.size == 100 && aws_ebs_volume.data.encrypted && aws_ebs_volume.data.type == "gp3" && aws_volume_attachment.data.force_detach == false && aws_volume_attachment.data.stop_instance_before_detaching && aws_volume_attachment.data.volume_id == aws_ebs_volume.data.id
    error_message = "분리된 암호화 데이터 디스크를 강제 detach 없이 연결해야 합니다."
  }
  assert {
    condition     = aws_instance.this.iam_instance_profile == "soma-376-frontend-observability" && aws_vpc_security_group_egress_rule.https.to_port == 443 && aws_instance.this.user_data_replace_on_change
    error_message = "전용 profile·HTTPS egress·명시적 교체 설정을 보존해야 합니다."
  }
  assert {
    condition     = strcontains(local.boot, "RequiresMountsFor=/srv/pulsemetry-observability") && strcontains(local.boot, "mountpoint -q /srv/pulsemetry-observability") && strcontains(local.boot, "nvme-Amazon_Elastic_Block_Store_") && strcontains(local.boot, "sha256sum -c -") && !strcontains(local.boot, "mkfs.xfs -f")
    error_message = "데이터 디스크 식별·마운트 검사·배포 바이너리 검증 및 비파괴 초기화가 필요합니다."
  }
  assert {
    condition     = length(base64gzip(local.boot)) <= 21844
    error_message = "EC2 user data 크기 제한을 지켜야 합니다."
  }
}
run "dashboards_not_in_bootstrap" {
  command = plan
  assert {
    condition     = !contains(keys(local.files), "hosts.json") && !strcontains(local.boot, "pulsemetry-dev-overview") && strcontains(file("${path.module}/files/compose.yaml"), "/srv/pulsemetry-observability/dashboards:/etc/grafana/dashboards:ro")
    error_message = "대시보드 JSON을 user data에서 분리하고 EBS 디렉터리를 마운트해야 합니다."
  }
}
run "wrong_vpc_rejected" {
  command = plan
  variables { vpc_id = "vpc-00000000000000000" }
  expect_failures = [aws_instance.this]
}
