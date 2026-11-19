{{- define "loadtest.fail" -}}{{- fail (printf "loadtest values: %s" .) -}}{{- end -}}

{{- /* 이 namespace 에만 설치한다(ADR-0064). PSA restricted 라벨은 런북이 namespace 생성 때 붙인다. */ -}}
{{- define "loadtest.namespace" -}}pulsemetry-loadtest{{- end -}}

{{- /* telemetry JWT 수명 3h(10800s) − 여유 600s. k6 lib/config.js 의 MAX_TOTAL_SECONDS 와 같다. */ -}}
{{- define "loadtest.maxPlannedSeconds" -}}10200{{- end -}}

{{- /* "90"·90·"30s"·"5m"·"1h"·"1m30s" → 초. k6 lib/config.js parseDuration 과 같은 규칙이다. */ -}}
{{- define "loadtest.seconds" -}}
{{- $text := toString .value -}}
{{- if regexMatch "^[0-9]+$" $text -}}
{{- $text -}}
{{- else if and (ne $text "") (regexMatch "^([0-9]+h)?([0-9]+m)?([0-9]+s)?$" $text) -}}
{{- $h := regexFind "[0-9]+h" $text | trimSuffix "h" | default "0" | int -}}
{{- $m := regexFind "[0-9]+m" $text | trimSuffix "m" | default "0" | int -}}
{{- $s := regexFind "[0-9]+s" $text | trimSuffix "s" | default "0" | int -}}
{{- add (mul $h 3600) (mul $m 60) $s -}}
{{- else -}}
{{- include "loadtest.fail" (printf "%s=%s 는 90·30s·5m·1h·1m30s 꼴이어야 한다" .name $text) -}}
{{- end -}}
{{- end -}}

{{- /*
계획 시간(초). k6 lib/schedule.js buildPlan 과 같은 계산이다.
  smoke 60 · stair 단계 수 × (ramp + stepHold) + cooldown · hold holdDuration
*/ -}}
{{- define "loadtest.plannedSeconds" -}}
{{- $v := .Values -}}
{{- if eq $v.scenario "smoke" -}}
60
{{- else if eq $v.scenario "stair" -}}
{{- if gt (int $v.startRps) (int $v.maxRps) -}}{{- include "loadtest.fail" (printf "startRps(%v)가 maxRps(%v)보다 크다" $v.startRps $v.maxRps) -}}{{- end -}}
{{- $ramp := include "loadtest.seconds" (dict "name" "ramp" "value" $v.ramp) | int -}}
{{- $hold := include "loadtest.seconds" (dict "name" "stepHold" "value" $v.stepHold) | int -}}
{{- $cooldown := include "loadtest.seconds" (dict "name" "cooldown" "value" $v.cooldown) | int -}}
{{- if lt $ramp 1 -}}{{- include "loadtest.fail" "ramp 는 1초 이상이다" -}}{{- end -}}
{{- if lt $hold 1 -}}{{- include "loadtest.fail" "stepHold 는 1초 이상이다" -}}{{- end -}}
{{- $steps := add (div (sub (int $v.maxRps) (int $v.startRps)) (int $v.stepRps)) 1 -}}
{{- add (mul $steps (add $ramp $hold)) $cooldown -}}
{{- else -}}
{{- if not $v.holdRps -}}{{- include "loadtest.fail" "scenario=hold 에는 holdRps 가 필요하다" -}}{{- end -}}
{{- $seconds := include "loadtest.seconds" (dict "name" "holdDuration" "value" $v.holdDuration) | int -}}
{{- if lt $seconds 1 -}}{{- include "loadtest.fail" "holdDuration 은 1초 이상이다" -}}{{- end -}}
{{- $seconds -}}
{{- end -}}
{{- end -}}

{{- define "loadtest.validate" -}}
{{- $v := .Values -}}
{{- if ne .Release.Namespace (include "loadtest.namespace" .) -}}
{{- include "loadtest.fail" (printf "namespace 는 %s 이어야 한다: %s" (include "loadtest.namespace" .) .Release.Namespace) -}}
{{- end -}}
{{- if not (regexMatch "^[a-z0-9-]{3,40}$" ($v.testid | default "")) -}}{{- include "loadtest.fail" "testid 가 필요하다(^[a-z0-9-]{3,40}$)" -}}{{- end -}}
{{- if not $v.configMapName -}}{{- include "loadtest.fail" "configMapName 이 필요하다" -}}{{- end -}}
{{- range $name, $image := $v.images -}}
{{- if not (regexMatch "@sha256:[a-f0-9]{64}$" $image) -}}{{- include "loadtest.fail" (printf "images.%s 는 digest 로 고정한다: %s" $name $image) -}}{{- end -}}
{{- end -}}
{{- range $key := list "startRps" "stepRps" "maxRps" -}}
{{- if gt (int (index $v $key)) 1000 -}}{{- include "loadtest.fail" (printf "%s 는 1000 이하다" $key) -}}{{- end -}}
{{- end -}}
{{- $planned := include "loadtest.plannedSeconds" . | int -}}
{{- if gt $planned (int (include "loadtest.maxPlannedSeconds" .)) -}}
{{- include "loadtest.fail" (printf "계획 시간 %ds 가 %ss(telemetry JWT 3h − 600s)를 넘는다" $planned (include "loadtest.maxPlannedSeconds" .)) -}}
{{- end -}}
{{- if and $v.activeDeadlineSeconds (lt (int $v.activeDeadlineSeconds) (add $planned 600)) -}}
{{- include "loadtest.fail" (printf "activeDeadlineSeconds(%v)는 계획 시간 + 600(%d) 이상이다" $v.activeDeadlineSeconds (add $planned 600)) -}}
{{- end -}}
{{- end -}}

{{- define "loadtest.activeDeadlineSeconds" -}}
{{- .Values.activeDeadlineSeconds | default (add (include "loadtest.plannedSeconds" . | int) 600) -}}
{{- end -}}

{{- define "loadtest.name" -}}loadtest-{{ .Values.testid }}{{- end -}}

{{- define "loadtest.labels" -}}
app.kubernetes.io/name: pulsemetry-loadtest-k6
app.kubernetes.io/part-of: pulsemetry
pulsemetry.io/testid: {{ .Values.testid | quote }}
{{- end -}}
