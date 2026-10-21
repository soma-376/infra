{{- define "pulsemetry.runtime.oidc.validate" -}}
{{- if .Values.oidc.enabled -}}
{{- $keys := list -}}
{{- $arns := dict -}}
{{- range $arn := values .Values.secrets -}}
{{- $_ := set $arns $arn true -}}
{{- end -}}
{{- $account := index (splitList ":" .Values.secrets.dbArn) 4 -}}
{{- range $index, $client := .Values.oidc.clients -}}
{{- if or (has $client.key $keys) (hasKey $arns $client.secretArn) -}}
{{- fail "OIDC client key·Secret ARN은 중복하거나 기존 Secret과 같을 수 없다" -}}
{{- end -}}
{{- if ne $client.alias (printf "PULSEMETRY_OIDC_CLIENT_SECRET_%d" $index) -}}
{{- fail "OIDC alias는 정렬한 client key의 순서와 같아야 한다" -}}
{{- end -}}
{{- if not (regexMatch (printf "^arn:aws:secretsmanager:ap-northeast-2:%s:secret:soma-376/dev/oidc/clients/%s-[A-Za-z0-9]{6}$" $account $client.key) $client.secretArn) -}}
{{- fail "OIDC는 같은 계정의 CDK 소유 client Secret ARN만 허용한다" -}}
{{- end -}}
{{- $keys = append $keys $client.key -}}
{{- $_ := set $arns $client.secretArn true -}}
{{- end -}}
{{- if ne (toJson $keys) (toJson (sortAlpha $keys)) -}}
{{- fail "OIDC client key는 정렬되어야 한다" -}}
{{- end -}}
{{- end -}}
{{- end -}}
