// dev 메일 권한·runtime 입력이 공유하는 비밀 없는 계약이다. (ADR-0043·0046)
module.exports = Object.freeze({
  domain: 'pulsemetry.co.kr', from: 'no-reply@pulsemetry.co.kr', region: 'ap-northeast-2',
  recipientApprovalTag: Object.freeze({ key: 'pulsemetry:dev-mail-recipient', value: 'true' }),
  managementSecretName: 'soma-376/dev/management/response-encryption-key',
  mailSecretName: 'soma-376/dev/mail/encryption-key',
});
