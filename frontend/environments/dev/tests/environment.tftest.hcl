mock_provider "aws" {}
variables {
  aws_account_id             = "111111111111"
  frontend_telemetry_enabled = false
  runtime                    = null
  observability              = null
}
run "environment_contract" {
  command = plan
  assert {
    condition     = length(aws_ssm_association.host_agent) == 0 && length(aws_ssm_document.host_agent) == 0
    error_message = "관측 비활성 상태에서는 호스트 설치 작업을 만들지 않습니다."
  }
  assert {
    condition     = output.network.vpc_cidr == "10.2.0.0/16" && length(output.network.public_subnet_cidrs) == 2 && length(output.network.private_subnet_cidrs) == 0
    error_message = "dev 환경의 CIDR 또는 서브넷 개수가 잘못되었습니다."
  }
}

run "dev_otlp_security_boundary" {
  command = plan
  variables {
    frontend_telemetry_enabled = true
    observability              = { ami_id = "ami-0123456789abcdef0" }
    runtime = {
      domain_name        = "frontend.example.com"
      certificate_arn    = "arn:aws:acm:ap-northeast-2:111111111111:certificate/00000000-0000-0000-0000-000000000001"
      image_digest       = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      enrollment_api_url = "https://api.example.com"
      dashboard_api_url  = "https://api.example.com"
      dev_ami_id         = "ami-0123456789abcdef0"
    }
  }
  override_module {
    target  = module.application[0]
    outputs = { security_group_id = "sg-00000000000000001", dev_instance_id = "i-0123456789abcdef0" }
  }
  override_module {
    target  = module.observability[0]
    outputs = { security_group_id = "sg-00000000000000002", otlp_endpoint = "http://10.2.0.142:4318" }
  }
  assert {
    condition     = aws_vpc_security_group_ingress_rule.frontend_otlp[0].security_group_id == "sg-00000000000000002" && aws_vpc_security_group_ingress_rule.frontend_otlp[0].referenced_security_group_id == "sg-00000000000000001" && aws_vpc_security_group_ingress_rule.frontend_otlp[0].cidr_ipv4 == null && aws_vpc_security_group_ingress_rule.frontend_otlp[0].from_port == 4318 && aws_vpc_security_group_ingress_rule.frontend_otlp[0].to_port == 4318
    error_message = "OTLP 수신은 dev 앱 SG에서 오는 TCP 4318만 허용해야 합니다."
  }
  assert {
    condition     = aws_vpc_security_group_egress_rule.frontend_otlp[0].security_group_id == "sg-00000000000000001" && aws_vpc_security_group_egress_rule.frontend_otlp[0].referenced_security_group_id == "sg-00000000000000002" && aws_vpc_security_group_egress_rule.frontend_otlp[0].cidr_ipv4 == null && aws_vpc_security_group_egress_rule.frontend_otlp[0].to_port == 4318
    error_message = "OTLP 송신은 관측 SG의 TCP 4318로만 제한해야 합니다."
  }
  assert {
    condition     = length(aws_ssm_document.host_agent) == 1 && one(aws_ssm_association.host_agent[0].targets).values == tolist(["i-0123456789abcdef0"]) && aws_ssm_association.host_agent[0].wait_for_success_timeout_seconds == 900
    error_message = "호스트 수집기는 dev EC2 ID만 대상으로 설치 성공을 기다려야 합니다."
  }
  assert {
    condition     = strcontains(aws_ssm_document.host_agent[0].content, "http://10.2.0.142:4318") && !strcontains(aws_ssm_document.host_agent[0].content, "AWS-RunShellScript")
    error_message = "고정 설치 문서는 관측 서버의 사설 OTLP 주소를 사용해야 합니다."
  }

}
