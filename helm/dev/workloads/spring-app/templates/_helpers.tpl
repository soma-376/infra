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
{{- if eq .Values.workload "telemetry-ingest" }}4316{{ else if eq .Values.workload "enrollment-api" }}8080{{ else if eq .Values.workload "dashboard-api" }}8081{{ else }}{{ fail "지원하지 않는 workload다" }}{{ end -}}
{{- end -}}
{{- define "pulsemetry.app.nodePort" -}}
{{- if eq .Values.workload "telemetry-ingest" }}30416{{ else if eq .Values.workload "enrollment-api" }}30080{{ else if eq .Values.workload "dashboard-api" }}{{ required "dashboard NodePort는 CDK output에서 전달해야 한다" .Values.nodePort }}{{ else }}{{ fail "지원하지 않는 workload다" }}{{ end -}}
{{- end -}}
{{- define "pulsemetry.app.validate" -}}
{{- if ne .Release.Namespace "pulsemetry-dev" -}}
{{- fail "namespace는 pulsemetry-dev여야 한다" -}}
{{- end -}}
{{- range $name, $value := .Values.env -}}
{{- if or (regexMatch "^PULSEMETRY_DASHBOARD_(RDS|CLICKHOUSE)_(SOURCE|CACHE)_(USERNAME|PASSWORD)$" $name) (has $name (list "PULSEMETRY_DB_USERNAME" "PULSEMETRY_DB_PASSWORD" "PULSEMETRY_TOKEN_HASH_SECRET" "PULSEMETRY_ADMIN_API_TOKEN" "SPRING_CONFIG_IMPORT" "SPRING_DATASOURCE_USERNAME" "SPRING_DATASOURCE_PASSWORD" "SPRING_APPLICATION_JSON" "SERVER_PORT" "PULSEMETRY_USER_AUTH_ENABLED" "PULSEMETRY_USER_AUTH_ISSUER" "PULSEMETRY_USER_AUTH_AUDIENCE" "PULSEMETRY_USER_AUTH_ALLOWED_ORIGINS" "PULSEMETRY_USER_AUTH_ACTIVE_KID" "PULSEMETRY_USER_AUTH_PRIVATE_KEY_FILE" "PULSEMETRY_USER_AUTH_PUBLIC_KEY_FILE")) -}}
{{- fail (printf "%s는 env가 아닌 runtime configtree로 공급해야 한다" $name) -}}
{{- end -}}
{{- end -}}
{{- if and (eq .Values.workload "telemetry-ingest") (hasKey .Values.env "PULSEMETRY_INGEST_PORT") (ne (index .Values.env "PULSEMETRY_INGEST_PORT") "4316") -}}
{{- fail "telemetry-ingest 포트는 4316이어야 한다" -}}
{{- end -}}
{{- if and (eq .Values.workload "dashboard-api") (hasKey .Values.env "PULSEMETRY_DASHBOARD_PORT") (ne (index .Values.env "PULSEMETRY_DASHBOARD_PORT") "8081") -}}
{{- fail "dashboard-api 포트는 8081이어야 한다" -}}
{{- end -}}
{{- if .Values.runtime.enabled -}}
{{- $_ := required "runtime.secretProviderClass가 필요하다" .Values.runtime.secretProviderClass -}}
{{- $files := list "PULSEMETRY_DB_USERNAME" "PULSEMETRY_DB_PASSWORD" "PULSEMETRY_TOKEN_HASH_SECRET" -}}
{{- if eq .Values.workload "enrollment-api" -}}
{{- $files = append $files "PULSEMETRY_ADMIN_API_TOKEN" -}}
{{- end -}}
{{- if eq .Values.workload "dashboard-api" -}}
{{- $files = list "PULSEMETRY_DASHBOARD_RDS_SOURCE_USERNAME" "PULSEMETRY_DASHBOARD_RDS_SOURCE_PASSWORD" "PULSEMETRY_DASHBOARD_RDS_CACHE_USERNAME" "PULSEMETRY_DASHBOARD_RDS_CACHE_PASSWORD" "PULSEMETRY_DASHBOARD_CLICKHOUSE_SOURCE_USERNAME" "PULSEMETRY_DASHBOARD_CLICKHOUSE_SOURCE_PASSWORD" "PULSEMETRY_DASHBOARD_CLICKHOUSE_CACHE_USERNAME" "PULSEMETRY_DASHBOARD_CLICKHOUSE_CACHE_PASSWORD" -}}
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
{{- if .Values.jwt.enabled -}}
{{- if eq .Values.workload "telemetry-ingest" -}}{{- fail "ingest에는 JWT mount를 공급하지 않는다" -}}{{- end -}}
{{- if ne .Values.jwt.secretProviderClass (printf "%s-jwt" .Values.workload) -}}{{- fail "JWT SPC는 workload 전용이어야 한다" -}}{{- end -}}
{{- $kids := dict -}}
{{- $aliases := dict -}}
{{- range .Values.jwt.publicKeys -}}
{{- if or (hasKey $kids .kid) (hasKey $aliases .alias) (eq .alias "private.pem") -}}{{- fail "JWT kid·alias가 중복하거나 개인키 파일과 충돌한다" -}}{{- end -}}
{{- $_ := set $kids .kid true -}}
{{- $_ := set $aliases .alias true -}}
{{- end -}}
{{- if eq .Values.workload "enrollment-api" -}}
{{- $_ := required "enrollment private VersionId가 필요하다" .Values.jwt.privateVersionId -}}
{{- $_ := required "enrollment active-kid가 필요하다" .Values.jwt.activeKid -}}
{{- if not (hasKey $kids .Values.jwt.activeKid) -}}{{- fail "active-kid가 공개키 파일 맵에 없다" -}}{{- end -}}
{{- else if or (hasKey .Values.jwt "privateVersionId") (hasKey .Values.jwt "activeKid") -}}
{{- fail "dashboard에는 개인키 참조·signer 설정을 공급하지 않는다" -}}
{{- end -}}
{{- else if .Values.userAuth -}}{{- fail "userAuth는 JWT mount와 함께 공급해야 한다" -}}
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
