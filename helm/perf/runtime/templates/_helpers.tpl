{{- define "perfRuntime.validate" -}}
{{- if ne .Release.Namespace "pulsemetry-perf" -}}{{- fail "perf runtime release namespace는 pulsemetry-perf다" -}}{{- end -}}
{{- $seen := dict -}}
{{- range $name, $arn := .Values.secrets -}}
{{- if hasKey $seen $arn -}}{{- fail "Secret 원본은 서로 달라야 한다" -}}{{- end -}}
{{- $_ := set $seen $arn true -}}
{{- end -}}
{{- $environments := dict -}}
{{- range $arn := values .Values.secrets -}}
{{- $_ := set $environments (index (splitList "/" $arn) 2) true -}}
{{- end -}}
{{- if ne (len $environments) 1 -}}{{- fail "모든 Secret은 같은 perf environment의 원본이어야 한다" -}}{{- end -}}
{{- $kids := dict -}}
{{- $aliases := dict -}}
{{- range .Values.telemetryJwt.publicKeys -}}
{{- if or (hasKey $kids .kid) (hasKey $aliases .alias) (eq .alias "private.pem") (eq .alias "telemetry-jwt-public.pem") -}}
{{- fail "telemetry JWT kid·alias는 중복하거나 예약 파일과 충돌할 수 없다" -}}
{{- end -}}
{{- $_ := set $kids .kid true -}}
{{- $_ := set $aliases .alias true -}}
{{- end -}}
{{- if not (hasKey $kids .Values.telemetryJwt.activeKid) -}}{{- fail "telemetry JWT active-kid가 공개키 파일 맵에 없다" -}}{{- end -}}
{{- end -}}
{{- define "perfRuntime.labels" -}}
app.kubernetes.io/part-of: pulsemetry
pulsemetry.io/environment: perf
{{- end -}}
