{{- define "pulsemetry.clickhouse.labels" -}}
app.kubernetes.io/name: clickhouse
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}
{{- define "pulsemetry.clickhouse.selector" -}}
app.kubernetes.io/name: clickhouse
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
{{- define "pulsemetry.clickhouse.validate" -}}
{{- if ne .Release.Namespace "pulsemetry-dev" -}}{{- fail "namespace는 pulsemetry-dev여야 한다" -}}{{- end -}}
{{- end -}}
