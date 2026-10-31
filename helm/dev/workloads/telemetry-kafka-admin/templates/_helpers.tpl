{{- define "kafkaAdmin.labels" -}}
app.kubernetes.io/name: telemetry-kafka-admin
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: pulsemetry
{{- end -}}
{{- define "kafkaAdmin.validate" -}}
{{- $perf := eq (.Values.environment | default "dev") "perf" -}}
{{- $namespace := ternary "pulsemetry-perf" "pulsemetry-dev" $perf -}}
{{- if ne .Release.Namespace $namespace -}}{{- fail "namespace는 pulsemetry-dev여야 한다" -}}{{- end -}}
{{- if ne .Values.topic (ternary "pulsemetry-perf-telemetry-ingress" (printf "pulsemetry-dev-telemetry-ingress-%s" .Values.stage) $perf) -}}{{- fail "topic은 stage와 같은 ingress 이름이어야 한다" -}}{{- end -}}
{{- if ne .Values.consumerGroup (ternary "pulsemetry-perf-telemetry-ingest" (printf "pulsemetry-dev-telemetry-ingest-%s" .Values.stage) $perf) -}}{{- fail "consumer group은 stage와 같은 ingest 이름이어야 한다" -}}{{- end -}}
{{- if eq .Values.provider "strimzi" -}}
{{- if .Values.topicInit.enabled -}}{{- fail "Strimzi topic은 KafkaTopic이 소유하며 init Job은 금지한다" -}}{{- end -}}
{{- if ne .Values.tls.userSecretName (printf "pulsemetry-offset-admin-%s" .Values.stage) -}}{{- fail "offset TLS Secret의 stage가 다르다" -}}{{- end -}}
{{- else -}}
{{- if eq .Values.topicAdmin.roleArn .Values.offsetAdmin.roleArn -}}{{- fail "topic 관리와 offset 재처리는 서로 다른 MSK 역할을 쓴다" -}}{{- end -}}
{{- end -}}
{{- if and .Values.topicInit.enabled .Values.offsets.enabled -}}{{- fail "topic 초기화와 offset 재처리는 같은 실행에서 함께 켜지 않는다" -}}{{- end -}}
{{- if and (ne .Values.provider "strimzi") (not (or .Values.topicInit.enabled .Values.offsets.enabled)) -}}{{- fail "topicInit 또는 offsets 중 하나를 켜야 한다" -}}{{- end -}}
{{- end -}}
{{/* aws-msk-iam-auth가 Pod Identity 자격으로 전용 MSK 역할을 고정 세션 이름으로 assume한다. */}}
{{- define "kafkaAdmin.clientProperties" -}}
security.protocol=SASL_SSL
sasl.mechanism=AWS_MSK_IAM
sasl.jaas.config=software.amazon.msk.auth.iam.IAMLoginModule required awsRoleArn="{{ .role.roleArn }}" awsRoleSessionName="{{ .role.sessionName }}" awsStsRegion="{{ .region }}";
sasl.client.callback.handler.class=software.amazon.msk.auth.iam.IAMClientCallbackHandler
{{- end -}}
{{/* 공통 Pod: 같은 고정 이미지로 jar를 받아 SHA256을 대조한 뒤 Kafka CLI를 실행한다. */}}
{{- define "kafkaAdmin.podSpec" -}}
{{- $root := .root -}}
serviceAccountName: {{ .serviceAccount }}
restartPolicy: Never
securityContext:
  runAsNonRoot: true
  runAsUser: 10001
  runAsGroup: 10001
  fsGroup: 10001
  seccompProfile:
    type: RuntimeDefault
nodeSelector:
  kubernetes.io/arch: arm64
  karpenter.sh/nodepool: {{ if eq ($root.Values.environment | default "dev") "perf" }}perf-system{{ else }}pulsemetry-dev-apps{{ end }}
initContainers:
  - name: fetch-msk-iam-auth
    image: {{ printf "%s@%s" $root.Values.image.repository $root.Values.image.digest | quote }}
    imagePullPolicy: IfNotPresent
    command: ["/bin/sh", "-ec"]
    args:
      - |
        wget -q -O /opt/msk/aws-msk-iam-auth.jar.download "$JAR_URL"
        echo "$JAR_SHA256  /opt/msk/aws-msk-iam-auth.jar.download" | sha256sum -c -
        mv /opt/msk/aws-msk-iam-auth.jar.download /opt/msk/aws-msk-iam-auth.jar
    env:
      - name: JAR_URL
        value: {{ $root.Values.iamAuthJar.url | quote }}
      - name: JAR_SHA256
        value: {{ $root.Values.iamAuthJar.sha256 | quote }}
      # GNU wget의 HSTS 파일 등 쓰기는 읽기 전용 root 대신 emptyDir에 둔다.
      - name: HOME
        value: /tmp
    securityContext:
      allowPrivilegeEscalation: false
      readOnlyRootFilesystem: true
      capabilities:
        drop: [ALL]
    resources:
      requests:
        cpu: 50m
        memory: 64Mi
      limits:
        cpu: 200m
        memory: 128Mi
    volumeMounts:
      - name: msk-lib
        mountPath: /opt/msk
      - name: tmp
        mountPath: /tmp
containers:
  - name: {{ .container }}
    image: {{ printf "%s@%s" $root.Values.image.repository $root.Values.image.digest | quote }}
    imagePullPolicy: IfNotPresent
    command: ["/bin/sh", "-ec"]
    args:
      - |
{{ .script | trimSuffix "\n" | indent 8 }}
    env:
      - name: KAFKA_BIN
        value: /opt/kafka/bin
      - name: CLIENT_CONFIG
        value: /etc/kafka-client/client.properties
      - name: CLASSPATH
        value: /opt/msk/aws-msk-iam-auth.jar
      - name: LOG_DIR
        value: /tmp/kafka-logs
      - name: KAFKA_HEAP_OPTS
        value: "-Xms128m -Xmx256m"
      - name: HOME
        value: /tmp
      - name: PULSEMETRY_KAFKA_BOOTSTRAP_SERVERS
        value: {{ $root.Values.bootstrapServers | quote }}
      - name: PULSEMETRY_KAFKA_TOPIC
        value: {{ $root.Values.topic | quote }}
      - name: PULSEMETRY_KAFKA_CONSUMER_GROUP
        value: {{ $root.Values.consumerGroup | quote }}
      {{- range $name, $value := .env }}
      - name: {{ $name }}
        value: {{ $value | quote }}
      {{- end }}
    securityContext:
      allowPrivilegeEscalation: false
      readOnlyRootFilesystem: true
      capabilities:
        drop: [ALL]
    resources:
      requests:
        cpu: 100m
        memory: 384Mi
      limits:
        cpu: 500m
        memory: 512Mi
    volumeMounts:
      - name: msk-lib
        mountPath: /opt/msk
        readOnly: true
      - name: client-config
        mountPath: /etc/kafka-client
        readOnly: true
      - name: tmp
        mountPath: /tmp
volumes:
  - name: msk-lib
    emptyDir:
      sizeLimit: 64Mi
  - name: tmp
    emptyDir:
      sizeLimit: 128Mi
  - name: client-config
    configMap:
      name: {{ .configMap }}
{{- end -}}
