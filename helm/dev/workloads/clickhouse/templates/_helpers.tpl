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
{{- $stages := dict -}}
{{- $arns := dict -}}
{{- if .Values.targetGroupBindings -}}
{{- $_ := required "TGB에는 vpcId가 필요하다" .Values.vpcId -}}
{{- end -}}
{{- range .Values.targetGroupBindings -}}
{{- if hasKey $stages .stage -}}{{- fail "같은 stage의 TGB를 중복 선언할 수 없다" -}}{{- end -}}
{{- if hasKey $arns .targetGroupARN -}}{{- fail "validation/canary TG ARN은 서로 달라야 한다" -}}{{- end -}}
{{- $_ := set $stages .stage true -}}
{{- $_ := set $arns .targetGroupARN true -}}
{{- end -}}
{{- end -}}
