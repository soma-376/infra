{{- define "perfPlatform.validate" -}}
{{- if ne .Values.pools.system.dedicated false -}}{{- fail "system pool은 taint 없이 시스템 구성요소·준비 도구가 함께 쓴다" -}}{{- end -}}
{{- range $id, $pool := .Values.pools -}}
{{- if and (ne $id "system") (not $pool.dedicated) -}}{{- fail (printf "%s pool은 전용 taint가 필요하다" $id) -}}{{- end -}}
{{- if eq $pool.securityGroupId $.Values.nodeSecurityGroupId -}}{{- fail "pool SG와 공통 노드 SG는 달라야 한다" -}}{{- end -}}
{{- end -}}
{{- end -}}
{{- define "perfPlatform.keep" -}}
annotations:
  helm.sh/resource-policy: keep
{{- end -}}
