# ADR 0029: 이전 배포의 DNS·인증서는 삭제하지 않고 외부 관리로 전환한다.
# 기존 runtime을 null로 만들지 않고 기존 인증서 ARN을 입력한 채 전환한다.
removed {
  from = aws_acm_certificate.frontend
  lifecycle { destroy = false }
}
removed {
  from = aws_acm_certificate_validation.frontend
  lifecycle { destroy = false }
}
removed {
  from = aws_route53_record.validation
  lifecycle { destroy = false }
}
removed {
  from = aws_route53_record.frontend
  lifecycle { destroy = false }
}
