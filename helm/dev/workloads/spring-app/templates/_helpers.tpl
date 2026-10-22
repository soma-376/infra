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
{{- if eq .Values.workload "telemetry-ingest" }}4316{{ else if eq .Values.workload "enrollment-api" }}8080{{ else if eq .Values.workload "dashboard-api" }}8081{{ else if eq .Values.workload "telemetry-gateway" }}8082{{ else }}{{ fail "지원하지 않는 workload다" }}{{ end -}}
{{- end -}}
{{- define "pulsemetry.app.nodePort" -}}
{{- if eq .Values.workload "telemetry-ingest" }}30416{{ else if eq .Values.workload "enrollment-api" }}30080{{ else if eq .Values.workload "dashboard-api" }}{{ required "dashboard NodePort는 CDK output에서 전달해야 한다" .Values.nodePort }}{{ else if eq .Values.workload "telemetry-gateway" }}{{ required "Gateway NodePort는 CDK output에서 전달해야 한다" .Values.nodePort }}{{ else }}{{ fail "지원하지 않는 workload다" }}{{ end -}}
{{- end -}}
{{/* Gateway는 앱 종료 30s, Consumer는 컨테이너 종료 45s를 쓰므로 Kafka 소비 모드만 90s를 둔다. (ADR-0036) */}}
{{- define "pulsemetry.app.grace" -}}
{{- if and (eq .Values.workload "telemetry-ingest") (has .Values.ingestMode (list "dual" "kafka")) }}90{{ else }}60{{ end -}}
{{- end -}}
{{- define "pulsemetry.app.blockedCerts" -}}
{{- $content := .Files.Get "files/blocked.certs" -}}
{{- $_ := required "공식 files/blocked.certs가 없거나 비어 있다" (trim $content) -}}
{{- $content -}}
{{- end -}}
{{- define "pulsemetry.app.validate" -}}
{{- if ne .Release.Namespace "pulsemetry-dev" -}}
{{- fail "namespace는 pulsemetry-dev여야 한다" -}}
{{- end -}}
{{- $oidc := .Values.oidc | default (dict "enabled" false) -}}
{{- $telemetry := .Values.telemetryJwt | default (dict "enabled" false) -}}
{{- $kafka := .Values.kafka | default (dict "enabled" false) -}}
{{- $gateway := eq .Values.workload "telemetry-gateway" -}}
{{- $ingest := eq .Values.workload "telemetry-ingest" -}}
{{- if and (hasKey .Values "oidc") (ne .Values.workload "enrollment-api") -}}
{{- fail "OIDC 설정은 enrollment-api만 소비한다" -}}
{{- end -}}
{{- if $oidc.enabled -}}
{{- if not (and .Values.runtime.enabled .Values.jwt.enabled) -}}{{- fail "OIDC에는 runtime과 JWT 공급이 함께 필요하다" -}}{{- end -}}
{{- if not .Values.userAuth.allowedRedirectUris -}}{{- fail "OIDC에는 정확한 allowedRedirectUris가 필요하다" -}}{{- end -}}
{{- if and $oidc.failureRedirectUri (not (has $oidc.failureRedirectUri .Values.userAuth.allowedRedirectUris)) -}}{{- fail "OIDC failure URI는 allowedRedirectUris에 있어야 한다" -}}{{- end -}}
{{- $keys := list -}}
{{- $arns := dict -}}
{{- range $index, $client := $oidc.clients -}}
{{- if or (has $client.key $keys) (hasKey $arns $client.secretArn) -}}{{- fail "OIDC client key·Secret ARN은 중복할 수 없다" -}}{{- end -}}
{{- if ne $client.alias (printf "PULSEMETRY_OIDC_CLIENT_SECRET_%d" $index) -}}{{- fail "OIDC alias는 정렬한 client key의 순서와 같아야 한다" -}}{{- end -}}
{{- if not (regexMatch (printf "^arn:aws:secretsmanager:ap-northeast-2:[0-9]{12}:secret:soma-376/dev/oidc/clients/%s-[A-Za-z0-9]{6}$" $client.key) $client.secretArn) -}}{{- fail "OIDC Secret ARN의 client key가 다르다" -}}{{- end -}}
{{- $keys = append $keys $client.key -}}
{{- $_ := set $arns $client.secretArn true -}}
{{- end -}}
{{- if ne (toJson $keys) (toJson (sortAlpha $keys)) -}}{{- fail "OIDC client key는 정렬되어야 한다" -}}{{- end -}}
{{- end -}}
{{- range $name, $value := .Values.env -}}
{{- if regexMatch "^MANAGEMENT_" $name -}}
{{- fail "management 설정은 metrics.enabled와 backend 기본 계약을 사용한다" -}}
{{- end -}}
{{- if has $name (list "JDK_JAVA_OPTIONS" "JAVA_TOOL_OPTIONS") -}}
{{- fail "JVM 옵션은 jvm.gcSafepointLog의 고정 문자열로만 공급한다" -}}
{{- end -}}
{{- if or (regexMatch "^PULSEMETRY_(OIDC|COGNITO_)" $name) (regexMatch "^PULSEMETRY_DASHBOARD_(RDS|CLICKHOUSE)_(SOURCE|CACHE)_(USERNAME|PASSWORD)$" $name) (has $name (list "PULSEMETRY_DB_USERNAME" "PULSEMETRY_DB_PASSWORD" "PULSEMETRY_TOKEN_HASH_SECRET" "PULSEMETRY_ADMIN_API_TOKEN" "SPRING_CONFIG_IMPORT" "SPRING_DATASOURCE_USERNAME" "SPRING_DATASOURCE_PASSWORD" "SPRING_APPLICATION_JSON" "SERVER_PORT" "PULSEMETRY_USER_AUTH_ENABLED" "PULSEMETRY_USER_AUTH_ISSUER" "PULSEMETRY_USER_AUTH_AUDIENCE" "PULSEMETRY_USER_AUTH_ALLOWED_ORIGINS" "PULSEMETRY_USER_AUTH_ALLOWED_REDIRECT_URIS" "PULSEMETRY_USER_AUTH_ACTIVE_KID" "PULSEMETRY_USER_AUTH_PRIVATE_KEY_FILE" "PULSEMETRY_USER_AUTH_PUBLIC_KEY_FILE")) -}}
{{- fail (printf "%s는 env가 아닌 runtime configtree로 공급해야 한다" $name) -}}
{{- end -}}
{{- /* Kafka·모드·telemetry JWT는 구조화된 values에서만 만든다. 정적 AWS 자격은 Pod Identity로 대체한다. */ -}}
{{- if or (regexMatch "^PULSEMETRY_(KAFKA_|INGEST_MODE$|TELEMETRY_?JWT)" $name) (regexMatch "^AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|ROLE_ARN|ROLE_SESSION_NAME|WEB_IDENTITY_TOKEN_FILE|PROFILE|SHARED_CREDENTIALS_FILE|CONFIG_FILE|CONTAINER_.*)$" $name) -}}
{{- fail (printf "%s는 env가 아닌 kafka·ingestMode·telemetryJwt values 또는 Pod Identity로 공급해야 한다" $name) -}}
{{- end -}}
{{- if and $gateway (regexMatch "^PULSEMETRY_(DB|ARCHIVE|CLICKHOUSE|DASHBOARD|TOKEN_HASH|ADMIN|USER_AUTH)_" $name) -}}
{{- fail (printf "Gateway에는 %s를 공급하지 않는다" $name) -}}
{{- end -}}
{{- end -}}
{{- if and (eq .Values.workload "telemetry-ingest") (hasKey .Values.env "PULSEMETRY_INGEST_PORT") (ne (index .Values.env "PULSEMETRY_INGEST_PORT") "4316") -}}
{{- fail "telemetry-ingest 포트는 4316이어야 한다" -}}
{{- end -}}
{{- if and (eq .Values.workload "dashboard-api") (hasKey .Values.env "PULSEMETRY_DASHBOARD_PORT") (ne (index .Values.env "PULSEMETRY_DASHBOARD_PORT") "8081") -}}
{{- fail "dashboard-api 포트는 8081이어야 한다" -}}
{{- end -}}
{{- if $gateway -}}
{{- /* Gateway의 DB 미접근은 DB 의존성·설정·Secret 권한·mount 부재로 보장한다. (PLAN-INFRA §3) */ -}}
{{- if .Values.runtime.enabled -}}{{- fail "Gateway에는 DB·HMAC configtree SPC를 공급하지 않는다" -}}{{- end -}}
{{- if or .Values.jwt.enabled .Values.userAuth -}}{{- fail "Gateway에는 사용자 JWT 설정을 공급하지 않는다" -}}{{- end -}}
{{- if not $telemetry.enabled -}}{{- fail "Gateway에는 telemetry JWT 공개키가 필요하다" -}}{{- end -}}
{{- if not $kafka.enabled -}}{{- fail "Gateway에는 Kafka 발행 설정이 필요하다" -}}{{- end -}}
{{- if hasKey $kafka "consumerGroup" -}}{{- fail "Gateway에는 consumer group을 공급하지 않는다" -}}{{- end -}}
{{- if ne (.Values.service.type | default "NodePort") "NodePort" -}}{{- fail "Gateway Service는 NodePort여야 한다" -}}{{- end -}}
{{- end -}}
{{- if and (hasKey .Values "ingestMode") (not $ingest) -}}
{{- fail "ingestMode는 telemetry-ingest만 사용한다" -}}
{{- end -}}
{{- if $ingest -}}
{{- $mode := required "telemetry-ingest에는 ingestMode(http|dual|kafka)가 필요하다" .Values.ingestMode -}}
{{- if and (has $mode (list "dual" "kafka")) (not $kafka.enabled) -}}{{- fail "dual·kafka 모드에는 Kafka consumer 설정이 필요하다" -}}{{- end -}}
{{- if and (eq $mode "http") $kafka.enabled -}}{{- fail "http 모드에는 Kafka 설정을 공급하지 않는다" -}}{{- end -}}
{{- if and $kafka.enabled (not $kafka.consumerGroup) -}}{{- fail "ingest Kafka 설정에는 consumer group이 필요하다" -}}{{- end -}}
{{- if and (eq $mode "kafka") (ne .Values.service.type "ClusterIP") -}}{{- fail "kafka 모드는 외부 OTLP 노출 없이 ClusterIP health Service를 쓴다" -}}{{- end -}}
{{- end -}}
{{- if and (eq .Values.service.type "ClusterIP") (not (and $ingest (eq .Values.ingestMode "kafka"))) -}}
{{- fail "ClusterIP Service는 telemetry-ingest kafka 모드 전용이다" -}}
{{- end -}}
{{- if and (eq .Values.service.type "ClusterIP") .Values.targetGroupBindings -}}
{{- fail "ClusterIP Service에는 TargetGroupBinding을 선언할 수 없다" -}}
{{- end -}}
{{- if and $kafka.enabled (not (or $gateway $ingest)) -}}
{{- fail "Kafka 설정은 Gateway와 telemetry-ingest만 소비한다" -}}
{{- end -}}
{{- if $kafka.enabled -}}
{{- $session := printf "pulsemetry-dev-telemetry-%s" (ternary "gateway" "ingest" $gateway) -}}
{{- if ne $kafka.iamSessionName $session -}}{{- fail (printf "MSK 세션 이름은 %s여야 한다" $session) -}}{{- end -}}
{{- end -}}
{{- if .Values.runtime.enabled -}}
{{- $_ := required "runtime.secretProviderClass가 필요하다" .Values.runtime.secretProviderClass -}}
{{- $files := list "PULSEMETRY_DB_USERNAME" "PULSEMETRY_DB_PASSWORD" "PULSEMETRY_TOKEN_HASH_SECRET" -}}
{{- if eq .Values.workload "enrollment-api" -}}
{{- $files = append $files "PULSEMETRY_ADMIN_API_TOKEN" -}}
{{- if $oidc.enabled -}}
{{- range $oidc.clients -}}{{- $files = append $files .alias -}}{{- end -}}
{{- end -}}
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
{{- if $telemetry.enabled -}}
{{- if eq .Values.workload "dashboard-api" -}}{{- fail "dashboard에는 telemetry JWT 키를 공급하지 않는다" -}}{{- end -}}
{{- if ne $telemetry.secretProviderClass (printf "%s-telemetry-jwt" .Values.workload) -}}{{- fail "telemetry JWT SPC는 workload 전용이어야 한다" -}}{{- end -}}
{{- $kids := dict -}}
{{- $aliases := dict -}}
{{- range $telemetry.publicKeys -}}
{{- if or (hasKey $kids .kid) (hasKey $aliases .alias) (eq .alias "private.pem") -}}{{- fail "telemetry JWT kid·alias가 중복하거나 개인키 파일과 충돌한다" -}}{{- end -}}
{{- $_ := set $kids .kid true -}}
{{- $_ := set $aliases .alias true -}}
{{- end -}}
{{- if eq .Values.workload "enrollment-api" -}}
{{- $_ := required "telemetry JWT 서명 private VersionId가 필요하다" $telemetry.privateVersionId -}}
{{- $_ := required "telemetry JWT active-kid가 필요하다" $telemetry.activeKid -}}
{{- if not (hasKey $kids $telemetry.activeKid) -}}{{- fail "telemetry JWT active-kid가 공개키 파일 맵에 없다" -}}{{- end -}}
{{- if not (hasKey $telemetry "issueEnabled") -}}{{- fail "telemetry JWT issueEnabled를 명시해야 한다" -}}{{- end -}}
{{- else if or (hasKey $telemetry "privateVersionId") (hasKey $telemetry "activeKid") (hasKey $telemetry "issueEnabled") -}}
{{- fail "telemetry JWT 개인키·발급 설정은 enrollment만 받는다" -}}
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
