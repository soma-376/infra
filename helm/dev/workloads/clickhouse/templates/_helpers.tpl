{{- define "pulsemetry.clickhouse.labels" -}}
app.kubernetes.io/name: clickhouse
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}
{{- define "pulsemetry.clickhouse.selector" -}}
app.kubernetes.io/name: clickhouse
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
{{- define "pulsemetry.clickhouse.perf" -}}{{ if eq (.Values.environment | default "dev") "perf" }}true{{ end }}{{- end -}}
{{- define "pulsemetry.clickhouse.validate" -}}
{{- $perf := eq (include "pulsemetry.clickhouse.perf" .) "true" -}}
{{- $namespace := ternary "pulsemetry-perf" "pulsemetry-dev" $perf -}}
{{- if ne .Release.Namespace $namespace -}}{{- fail (printf "namespace는 %s여야 한다" $namespace) -}}{{- end -}}
{{- end -}}
