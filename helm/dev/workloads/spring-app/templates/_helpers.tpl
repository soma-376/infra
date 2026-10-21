{{- define "pulsemetry.app.labels" -}}
app.kubernetes.io/name: {{ .Values.workload }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}
{{- define "pulsemetry.app.selector" -}}
app.kubernetes.io/name: {{ .Values.workload }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
{{- define "pulsemetry.app.port" -}}
{{- if eq .Values.workload "telemetry-ingest" }}4316{{ else }}8080{{ end -}}
{{- end -}}
{{- define "pulsemetry.app.nodePort" -}}
{{- if eq .Values.workload "telemetry-ingest" }}30416{{ else }}30080{{ end -}}
{{- end -}}
{{- define "pulsemetry.app.validate" -}}
{{- if ne .Release.Namespace "pulsemetry-dev" -}}
{{- fail "namespace는 pulsemetry-dev여야 한다" -}}
{{- end -}}
{{- range $name, $value := .Values.env -}}
{{- if has $name (list "PULSEMETRY_DB_USERNAME" "PULSEMETRY_DB_PASSWORD" "PULSEMETRY_TOKEN_HASH_SECRET" "PULSEMETRY_ADMIN_API_TOKEN" "SPRING_CONFIG_IMPORT" "SPRING_DATASOURCE_USERNAME" "SPRING_DATASOURCE_PASSWORD" "SPRING_APPLICATION_JSON" "SERVER_PORT") -}}
{{- fail (printf "%s는 env가 아닌 runtime configtree로 공급해야 한다" $name) -}}
{{- end -}}
{{- end -}}
{{- if and (eq .Values.workload "telemetry-ingest") (hasKey .Values.env "PULSEMETRY_INGEST_PORT") (ne (index .Values.env "PULSEMETRY_INGEST_PORT") "4316") -}}
{{- fail "telemetry-ingest 포트는 4316이어야 한다" -}}
{{- end -}}
{{- if .Values.runtime.enabled -}}
{{- $_ := required "runtime.secretProviderClass가 필요하다" .Values.runtime.secretProviderClass -}}
{{- $files := list "PULSEMETRY_DB_USERNAME" "PULSEMETRY_DB_PASSWORD" "PULSEMETRY_TOKEN_HASH_SECRET" -}}
{{- if eq .Values.workload "enrollment-api" -}}
{{- $files = append $files "PULSEMETRY_ADMIN_API_TOKEN" -}}
{{- end -}}
{{- if ne (len .Values.runtime.requiredFiles) (len $files) -}}
{{- fail "runtime.requiredFiles는 workload의 필수 파일 전체여야 한다" -}}
{{- end -}}
{{- range $file := $files -}}
{{- if not (has $file $.Values.runtime.requiredFiles) -}}
{{- fail (printf "필수 configtree 파일 누락: %s" $file) -}}
{{- end -}}
{{- end -}}
{{- end -}}
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
