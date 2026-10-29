{{/* PKCS12 비밀번호는 Pod 내부에서만 읽어 메모리 볼륨의 0600 파일에 쓴다. */}}
{{- define "kafkaAdmin.tlsPodSpec" -}}
{{- $root := .root -}}
serviceAccountName: {{ .serviceAccount }}
automountServiceAccountToken: false
restartPolicy: Never
securityContext:
  runAsNonRoot: true
  runAsUser: 10001
  runAsGroup: 10001
  fsGroup: 10001
  seccompProfile: {type: RuntimeDefault}
nodeSelector:
  kubernetes.io/arch: arm64
  karpenter.sh/nodepool: pulsemetry-dev-apps
containers:
  - name: {{ .container }}
    image: quay.io/strimzi/kafka@sha256:b9b9e37491ce17c1b2722b3668661de91430d9437acf18c5f5bafaef38138652
    command: ["/bin/bash", "-ec"]
    args:
      - |
{{ $root.Files.Get "scripts/client-tls.sh" | trimSuffix "\n" | indent 8 }}
{{ .script | trimSuffix "\n" | indent 8 }}
    env:
      - {name: KAFKA_BIN, value: /opt/kafka/bin}
      - {name: CLIENT_CONFIG, value: /run/kafka-client/client.properties}
      - {name: LOG_DIR, value: /tmp/kafka-logs}
      - {name: KAFKA_HEAP_OPTS, value: "-Xms128m -Xmx256m"}
      - {name: HOME, value: /tmp}
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
      capabilities: {drop: [ALL]}
    resources:
      requests: {cpu: 100m, memory: 384Mi}
      limits: {cpu: 500m, memory: 512Mi}
    volumeMounts:
      - {name: kafka-ca, mountPath: /mnt/kafka-tls/cluster, readOnly: true}
      - {name: kafka-user, mountPath: /mnt/kafka-tls/user, readOnly: true}
      - {name: client-config, mountPath: /run/kafka-client}
      - {name: tmp, mountPath: /tmp}
volumes:
  - name: kafka-ca
    secret:
      secretName: {{ $root.Values.tls.clusterCaSecretName }}
      defaultMode: 288
      items:
        - {key: ca.p12, path: ca.p12}
        - {key: ca.password, path: ca.password}
  - name: kafka-user
    secret:
      secretName: {{ $root.Values.tls.userSecretName }}
      defaultMode: 288
      items:
        - {key: user.p12, path: user.p12}
        - {key: user.password, path: user.password}
  - name: client-config
    emptyDir: {medium: Memory, sizeLimit: 1Mi}
  - name: tmp
    emptyDir: {sizeLimit: 128Mi}
{{- end -}}
