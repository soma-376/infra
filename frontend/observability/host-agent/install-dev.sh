#!/usr/bin/env bash
# dev EC2에서 root로 실행한다. 앱·ECS Agent·관측 서버는 재시작하지 않는다.
set -euo pipefail
endpoint=${1:?사설 OTLP endpoint 필요}
instance_id=${2:?dev EC2 instance ID 필요}
[[ "$endpoint" =~ ^http://10\.2\.[0-9]+\.[0-9]+:4318$ ]] || { echo 'dev 사설 OTLP 주소만 허용합니다.' >&2; exit 1; }
[[ "$instance_id" =~ ^i-[a-f0-9]{17}$ ]] || { echo 'EC2 ID를 확인하세요.' >&2; exit 1; }
[[ $(id -u) == 0 ]] || { echo 'root로 실행하세요.' >&2; exit 1; }
source_dir=$(cd -- "$(dirname -- "$0")" && pwd)
name=pulsemetry-dev-host-agent
image=grafana/alloy:v1.21.2@sha256:89a5a320168387336b9ac3c850609c3ba7757eadd4ae5f1d819deb35e9854b18
config_hash=$(sha256sum "$source_dir/config.alloy" | cut -d' ' -f1)
if docker container inspect "$name" >/dev/null 2>&1; then
  [[ $(docker inspect --format '{{index .Config.Labels "pulsemetry.owner"}}' "$name") == frontend-host-agent ]] || { echo '동일 이름의 다른 컨테이너가 있습니다.' >&2; exit 1; }
fi
docker pull "$image"
docker run --rm -e HOST_INSTANCE_ID="$instance_id" -e HOST_ENVIRONMENT=dev -e HOST_ROLE=frontend-dev \
  -e OTEL_EXPORTER_OTLP_ENDPOINT="$endpoint" -v "$source_dir/config.alloy:/etc/alloy/config.alloy:ro" \
  "$image" validate /etc/alloy/config.alloy
install -d -m 755 /opt/pulsemetry-host-agent
if [[ "$source_dir/config.alloy" != /opt/pulsemetry-host-agent/config.alloy ]]; then
  install -m 644 "$source_dir/config.alloy" /opt/pulsemetry-host-agent/config.alloy
fi
# 재실행 시 이 스크립트가 소유한 수집기만 교체한다. 영속 데이터 볼륨은 사용하지 않는다.
if docker container inspect "$name" >/dev/null 2>&1; then docker rm -f "$name"; fi
docker run -d --name "$name" --restart unless-stopped --pid host --user 0:0 \
  --read-only --cap-drop ALL --security-opt no-new-privileges:true --memory 256m --cpus 0.25 \
  --label pulsemetry.owner=frontend-host-agent --label "pulsemetry.config-sha=$config_hash" \
  -e HOST_INSTANCE_ID="$instance_id" -e HOST_ENVIRONMENT=dev -e HOST_ROLE=frontend-dev \
  -e OTEL_EXPORTER_OTLP_ENDPOINT="$endpoint" \
  -v /opt/pulsemetry-host-agent/config.alloy:/etc/alloy/config.alloy:ro \
  -v /proc:/host/proc:ro -v /sys:/host/sys:ro -v /:/host/root:ro,rslave \
  --tmpfs /var/lib/alloy:rw,nosuid,nodev,size=64m,mode=0755 \
  --log-driver local --log-opt max-size=10m --log-opt max-file=3 \
  "$image" run --server.http.listen-addr=127.0.0.1:12345 --storage.path=/var/lib/alloy /etc/alloy/config.alloy
