{{- define "pulsemetry.observability.validate" -}}
{{- if ne .Release.Namespace "pulsemetry-observability" -}}{{ fail "관측 release namespace는 pulsemetry-observability여야 한다" }}{{- end -}}
{{- $p := .Values.global.pulsemetry -}}
{{- range $key := list "environment" "targetNamespace" "clusterName" "grafanaAdminSecretArn" "controlPlaneLogGroup" "applicationLogGroup" "observabilityLogGroup" "kubernetesEventsLogGroup" "diagnosticsBucket" "topic" "consumerGroup" -}}
{{- $_ := required (printf "global.pulsemetry.%s는 generated values에서 공급한다" $key) (index $p $key) -}}
{{- end -}}
{{- if not (has $p.environment (list "dev" "perf")) -}}{{ fail "environment는 dev 또는 perf다" }}{{- end -}}
{{- if ne $p.targetNamespace (printf "pulsemetry-%s" $p.environment) -}}{{ fail "targetNamespace와 environment가 다르다" }}{{- end -}}
{{- if not (regexMatch "^[a-z]{2}-[a-z]+-[0-9]$" $p.region) -}}{{ fail "AWS region 형식이 유효하지 않다" }}{{- end -}}
{{- if not (regexMatch (printf "^arn:aws:secretsmanager:%s:[0-9]{12}:secret:.+$" $p.region) $p.grafanaAdminSecretArn) -}}{{ fail "Grafana Secret ARN이 유효하지 않다" }}{{- end -}}
{{- if eq $p.kafkaProvider "msk" -}}
{{- $_ := required "MSK cluster 이름이 필요하다" $p.mskClusterName -}}
{{- $_ := required "MSK broker 로그 그룹이 필요하다" $p.brokerLogGroup -}}
{{- if ne (len $p.mskBrokers) 3 -}}{{ fail "list-nodes로 확인한 MSK broker DNS 3개가 필요하다" }}{{- end -}}
{{- if ne (len (uniq $p.mskBrokers)) 3 -}}{{ fail "MSK broker DNS가 중복됐다" }}{{- end -}}
{{- range $p.mskBrokers -}}
{{- if not (regexMatch (printf "^b-[1-3]\\.[a-z0-9.-]+\\.kafka\\.%s\\.amazonaws\\.com$" $p.region) .) -}}{{ fail "MSK broker는 포트가 없는 입력 리전의 private DNS여야 한다" }}{{- end -}}
{{- end -}}
{{- else -}}
{{- $_ := required "Strimzi Kafka cluster 이름이 필요하다" $p.kafkaClusterName -}}
{{- end -}}
{{- $m := .Values.monitoring -}}
{{- if or $m.grafana.ingress.enabled $m.prometheus.ingress.enabled (ne $m.grafana.service.type "ClusterIP") (ne $m.prometheus.service.type "ClusterIP") -}}{{ fail "Grafana·Prometheus는 private ClusterIP만 허용한다" }}{{- end -}}
{{- if or $m.grafana.adminPassword $m.grafana.env.GF_SECURITY_ADMIN_PASSWORD $m.grafana.admin.existingSecret -}}{{ fail "Grafana password는 CSI 파일로만 공급한다" }}{{- end -}}
{{- if ne $m.grafana.env.GF_SECURITY_ADMIN_PASSWORD__FILE "/mnt/grafana-admin/admin-password" -}}{{ fail "Grafana password 파일 계약이 다르다" }}{{- end -}}
{{- if or (ne (int $m.grafana.replicas) 1) (ne (int $m.prometheus.prometheusSpec.replicas) 1) -}}{{ fail "이 차트는 단일 replica 영속 볼륨 구성을 사용한다" }}{{- end -}}
{{- end -}}

{{- define "pulsemetry.events.config" -}}
[SERVICE]
    Flush 5
    Log_Level info
    HTTP_Server On
    HTTP_Listen 0.0.0.0
    HTTP_Port 2020
    storage.path /var/lib/fluent-bit/buffer
    storage.sync normal
    storage.checksum on
    storage.metrics On
    storage.backlog.mem_limit 16M
[INPUT]
    Name kubernetes_events
    Tag kubernetes.events
    kube_url https://kubernetes.default.svc:443
    kube_ca_file /var/run/secrets/kubernetes.io/serviceaccount/ca.crt
    kube_token_file /var/run/secrets/kubernetes.io/serviceaccount/token
    interval_sec 10
    db /var/lib/fluent-bit/events.db
    kube_retention_time 1h
    storage.type filesystem
[OUTPUT]
    Name cloudwatch_logs
    Match kubernetes.events
    region {{ .Values.global.pulsemetry.region }}
    log_group_name {{ .Values.global.pulsemetry.kubernetesEventsLogGroup }}
    log_stream_prefix events-
    auto_create_group false
    Retry_Limit False
    storage.total_limit_size 256M
{{- end -}}
