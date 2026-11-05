# 런타임 Secret resolver

`asm-exec`는 작업 환경의 `aws-secrets-manager` 스킬에 포함된 표준 라이브러리 전용 resolver를
수정 없이 고정한 것이다. 원본 SHA-256은
`05a9f8164b63b286bcf88bf4223c95b799e0ecaada45ddcd805567f57b20299f`다.
갱신할 때 파일과 checksum을 함께 검토한다.

승격기는 `{{resolve:secretsmanager:...}}`를 자식 환경에서만 해석하며 Secret 원문을
Git·파일·stdout·예외에 기록하지 않는다. CLI `get-secret-value` fallback은 없다.
DB reader의 고정 version stage와 VersionId를 실행 전후 metadata 조회로 대조한다.
운영 수락에는 AWS MCP 접근과 해당 Secret의 정확한 읽기 권한 검증이 포함된다.
