{{- define "perfJobs.fail" -}}{{- fail (printf "perf job values: %s" .) -}}{{- end -}}

{{- /* Kubernetes 이름: 소문자 DNS-1123, 63자 이하. load-tests job_values.k8s_name과 같은 규칙이다. */ -}}
{{- define "perfJobs.name" -}}
{{- $root := .root -}}
{{- $name := "" -}}
{{- if eq $root.Values.job "seed" -}}
{{- $name = "perf-seed" -}}
{{- else -}}
{{- $given := (index ($root.Values.jobs | default dict) $root.Values.job) | default "" -}}
{{- $prefix := get (dict "prepare" "prepare" "smoke" "smoke" "sentinel" "sentinel" "runner" "k6" "verify" "verify") $root.Values.job -}}
{{- $derived := regexReplaceAll "[^a-z0-9-]" (lower (printf "%s-%s" $prefix $root.Values.run.runId)) "-" | trimAll "-" -}}
{{- if and $given (ne $given $derived) -}}{{- include "perfJobs.fail" (printf "jobs.%s(%s)가 규칙 이름 %s와 다르다" $root.Values.job $given $derived) -}}{{- end -}}
{{- $name = $derived -}}
{{- end -}}
{{- if or (gt (len $name) 63) (not (regexMatch "^[a-z0-9]([a-z0-9-]*[a-z0-9])?$" $name)) -}}{{- include "perfJobs.fail" (printf "Job 이름 %s가 63자 DNS 이름이 아니다" $name) -}}{{- end -}}
{{- $name -}}
{{- end -}}

{{- define "perfJobs.validate" -}}
{{- $v := .Values -}}
{{- $infra := $v.infra -}}
{{- $bootstrap := $v.bootstrapMode | default false -}}
{{- if $bootstrap -}}
{{- if or (ne (int $v.contractVersion) 3) (not (has $v.job (list "prepare" "smoke"))) (ne $v.ingressPath "internal") $v.pathPair -}}{{- include "perfJobs.fail" "bootstrap은 v3 내부 prepare·smoke에만 허용한다" -}}{{- end -}}
{{- range $key := list "requestSha256" "provisionalSha256" "metadataSha256" -}}
{{- if not (regexMatch "^[a-f0-9]{64}$" (index ($v.bootstrap | default dict) $key | default "")) -}}{{- include "perfJobs.fail" (printf "bootstrap.%s SHA-256이 필요하다" $key) -}}{{- end -}}
{{- end -}}
{{- else if and (eq (int $v.contractVersion) 3) (ne $v.job "seed") -}}
{{- $pair := $v.pathPair | default dict -}}
{{- if or (not (regexMatch "^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$" ($pair.pairId | default ""))) (not (regexMatch "^[a-f0-9]{64}$" ($pair.sha256 | default ""))) -}}{{- include "perfJobs.fail" "v3 실행에는 pathPair ID·SHA-256이 필요하다" -}}{{- end -}}
{{- if ne $pair.evidenceUri (printf "s3://%s/%spairs/%s/" $infra.evidenceBucket $infra.evidencePrefix $pair.pairId) -}}{{- include "perfJobs.fail" "pathPair.evidenceUri가 환경의 pair 경로와 다르다" -}}{{- end -}}
{{- if or (lt (int $v.deadlines.drainDeadlineSeconds) 1) (gt (int $v.deadlines.drainDeadlineSeconds) 900) (lt (int $v.deadlines.verifyPollDeadlineSeconds) 1) (gt (int $v.deadlines.verifyPollDeadlineSeconds) 900) (lt (int $v.deadlines.verifyActiveDeadlineSeconds) (add (int $v.deadlines.drainDeadlineSeconds) (int $v.deadlines.verifyPollDeadlineSeconds) 120)) -}}{{- include "perfJobs.fail" "drain·최종 검증은 각각 900초 이하이며 Job은 두 단계와 업로드 120초를 수용해야 한다" -}}{{- end -}}
{{- end -}}
{{- if and (eq (int $v.contractVersion) 3) (ne $v.job "seed") -}}
{{- $budget := ternary ($v.bootstrap | default dict) ($v.pathPair | default dict) $bootstrap -}}
{{- range $key := list "smokeRequestReserve" "smokeSlotStart" -}}
{{- if not (regexMatch "^[0-9]+$" (toString (index $budget $key))) -}}{{- include "perfJobs.fail" (printf "%s 정수 입력이 필요하다" $key) -}}{{- end -}}
{{- end -}}
{{- if or (lt (int $budget.smokeRequestReserve) 1) (gt (int $budget.smokeRequestReserve) 10000) (gt (int $budget.smokeSlotStart) (int $budget.smokeRequestReserve)) -}}{{- include "perfJobs.fail" "smoke 요청 예약 또는 시작 slot이 범위 밖이다" -}}{{- end -}}
{{- end -}}
{{- if $v.contractVersion -}}
{{- if ne (int $infra.contractVersion) 3 -}}{{- include "perfJobs.fail" "v3 Job과 infra 계약 버전이 다르다" -}}{{- end -}}
{{- $actual := $infra.kafka | default $infra.msk -}}
{{- $provider := ternary "strimzi" "msk" (hasKey $infra "kafka") -}}
{{- if ne $v.kafka.provider $provider -}}{{- include "perfJobs.fail" "Kafka provider가 이 환경과 다르다" -}}{{- end -}}
{{- range $key := list "clusterName" "topic" "consumerGroup" "partitions" -}}
{{- if ne (toString (index $v.kafka $key)) (toString (index $actual $key)) -}}{{- include "perfJobs.fail" (printf "kafka.%s가 이 환경과 다르다" $key) -}}{{- end -}}
{{- end -}}
{{- if and (eq $provider "strimzi") (ne $v.kafka.namespace $actual.namespace) -}}{{- include "perfJobs.fail" "Kafka namespace가 이 환경과 다르다" -}}{{- end -}}
{{- else if $infra.contractVersion -}}{{- include "perfJobs.fail" "v3 infra에는 v3 Job 입력이 필요하다" -}}
{{- end -}}

{{- if not (has $v.job (list "seed" "prepare" "smoke" "sentinel" "runner" "verify")) -}}{{- include "perfJobs.fail" "job은 seed|prepare|smoke|sentinel|runner|verify다" -}}{{- end -}}
{{- if ne .Release.Namespace $infra.namespaces.runner -}}{{- include "perfJobs.fail" (printf "Job은 %s namespace에 만든다" $infra.namespaces.runner) -}}{{- end -}}
{{- if or (ne $v.environmentId $infra.environmentId) (ne $v.cluster $infra.cluster) -}}{{- include "perfJobs.fail" "environmentId·cluster가 이 환경과 다르다" -}}{{- end -}}
{{- if or (ne $v.namespaces.app $infra.namespaces.app) (ne $v.namespaces.runner $infra.namespaces.runner) -}}{{- include "perfJobs.fail" "namespaces가 이 환경과 다르다" -}}{{- end -}}
{{- $image := ternary $v.images.k6Runner $v.images.perfTools (eq $v.job "runner") -}}
{{- $repository := ternary $infra.imageRepositories.k6Runner $infra.imageRepositories.perfTools (eq $v.job "runner") -}}
{{- if not (regexMatch (printf "^%s@sha256:[a-f0-9]{64}$" (regexQuoteMeta $repository)) $image) -}}{{- include "perfJobs.fail" (printf "image는 %s@sha256:<digest>여야 한다" $repository) -}}{{- end -}}
{{- $evidence := printf "s3://%s/%s" $infra.evidenceBucket $infra.evidencePrefix -}}
{{- if eq $v.job "seed" -}}
{{- if ne $v.evidenceUri (printf "%sseed/" $evidence) -}}{{- include "perfJobs.fail" (printf "seed evidenceUri는 %sseed/다" $evidence) -}}{{- end -}}
{{- else if $bootstrap -}}
{{- $root := printf "%sbootstrap/%s/%s/%s/" $evidence $v.environmentId $v.bootstrap.requestSha256 $v.bootstrap.provisionalSha256 -}}
{{- if or (ne $v.bootstrap.evidenceUri $root) (ne $v.evidenceUri (printf "%sexecutions/%s/" $root $v.run.runId)) (ne $v.run.experimentId "bootstrap") -}}{{- include "perfJobs.fail" "bootstrap evidence는 request·provisional SHA와 실행 ID에 귀속돼야 한다" -}}{{- end -}}
{{- else -}}
{{- if not (and $v.run $v.run.runId $v.run.experimentId) -}}{{- include "perfJobs.fail" "run.experimentId·run.runId가 필요하다" -}}{{- end -}}
{{- if ne $v.evidenceUri (printf "%s%s/%s/" $evidence $v.run.experimentId $v.run.runId) -}}{{- include "perfJobs.fail" (printf "evidenceUri는 %s<experiment>/<run>/이다" $evidence) -}}{{- end -}}
{{- end -}}
{{- $ingress := $v.ingressPath | default "internal" -}}
{{- if not (has $ingress (list "internal" "alb_https")) -}}{{- include "perfJobs.fail" "ingressPath는 internal 또는 alb_https다" -}}{{- end -}}
{{- $gateway := $infra.endpoints.gateway -}}
{{- if eq $ingress "alb_https" -}}
{{- if ne (int $v.contractVersion) 3 -}}{{- include "perfJobs.fail" "공개 HTTPS 경로에는 v3 Job 입력이 필요하다" -}}{{- end -}}
{{- $gateway = required "공개 HTTPS 경로가 배포되지 않았다" $infra.endpoints.gatewayHttps -}}
{{- end -}}
{{- if ne $v.endpoints.gateway $gateway -}}{{- include "perfJobs.fail" "선택한 ingressPath의 gateway endpoint와 다르다" -}}{{- end -}}
{{- range $key := list "enrollment" "clickhouse" "prometheus" "remoteWrite" -}}
{{- if ne (index $v.endpoints $key) (index $infra.endpoints $key) -}}{{- include "perfJobs.fail" (printf "endpoints.%s가 이 환경의 Service 주소와 다르다" $key) -}}{{- end -}}
{{- end -}}
{{- if and (eq $v.job "verify") (ne $v.rawArchiveUri $infra.rawArchiveUri) -}}{{- include "perfJobs.fail" "rawArchiveUri가 이 환경의 raw prefix와 다르다" -}}{{- end -}}
{{- with $v.previousEvidenceUri -}}
{{- if or (not (hasPrefix $evidence .)) (eq . $v.evidenceUri) -}}{{- include "perfJobs.fail" (printf "previousEvidenceUri는 %s 아래의 다른 run이다" $evidence) -}}{{- end -}}
{{- end -}}
{{- if eq $v.job "prepare" -}}
{{- if ne $v.enrollment.jwtKid $infra.telemetryJwtActiveKid -}}{{- include "perfJobs.fail" "enrollment.jwtKid가 runtime의 telemetry JWT active kid와 다르다" -}}{{- end -}}
{{- if ne $v.enrollment.deployment "enrollment-api" -}}{{- include "perfJobs.fail" "prepare의 scale 권한은 enrollment-api뿐이다" -}}{{- end -}}
{{- end -}}
{{- if eq $v.job "runner" -}}
{{- if eq (int $v.contractVersion) 3 -}}
{{- $policy := $v.objects.generatorPolicyConfigMap | default "" -}}
{{- if or (gt (len $policy) 63) (not (regexMatch "^[a-z0-9]([a-z0-9-]*[a-z0-9])?$" $policy)) -}}{{- include "perfJobs.fail" "발생기 policy ConfigMap 이름이 필요하다" -}}{{- end -}}
{{- end -}}
{{- if lt (int $v.deadlines.terminationGracePeriodSeconds) (add (int $v.deadlines.gracefulStopSeconds) 120) -}}{{- include "perfJobs.fail" "terminationGracePeriodSeconds는 gracefulStop + 120초 이상이다" -}}{{- end -}}
{{- /* /out sizeLimit은 예상 journal bytes의 2배 이상이다(perf-jobs.md runner). */ -}}
{{- with $v.runner.journalBytesEstimate -}}
{{- $limit := $v.runner.outputSizeLimit -}}
{{- $bytes := mul (int64 (regexFind "^[0-9]+" $limit)) (ternary 1073741824 1048576 (hasSuffix "Gi" $limit)) -}}
{{- if lt (int64 $bytes) (mul 2 (int64 .)) -}}{{- include "perfJobs.fail" "runner.outputSizeLimit은 journalBytesEstimate의 2배 이상이다" -}}{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- /* Job별 activeDeadlineSeconds. job values에 없으면(seed·smoke) infra 기본값을 쓴다. */ -}}
{{- define "perfJobs.deadline" -}}
{{- $d := .Values.deadlines | default dict -}}
{{- $value := get (dict "prepare" $d.prepareActiveDeadlineSeconds "smoke" $d.smokeActiveDeadlineSeconds "sentinel" $d.sentinelActiveDeadlineSeconds "runner" $d.runnerActiveDeadlineSeconds "verify" $d.verifyActiveDeadlineSeconds) .Values.job | default (index .Values.infra.jobs .Values.job).activeDeadlineSeconds -}}
{{- if not (and $value (gt (int $value) 0)) -}}{{- include "perfJobs.fail" (printf "%s의 activeDeadlineSeconds가 필요하다" .Values.job) -}}{{- end -}}
{{- int $value -}}
{{- end -}}

{{- define "perfJobs.envVar" -}}
- name: {{ .name }}
  {{- if .fieldPath }}
  valueFrom:
    fieldRef:
      fieldPath: {{ .fieldPath | quote }}
  {{- else }}
  value: {{ .value | toString | quote }}
  {{- end }}
{{- end -}}
