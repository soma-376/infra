#!/bin/sh
# ECS 태스크가 실행되는 호스트의 cloud-init ID를 읽어 교체/증설에도 라벨을 유지한다.
set -eu
HOST_INSTANCE_ID=$(cat /host/instance-id)
printf '%s\n' "$HOST_INSTANCE_ID" | grep -Eq '^i-[a-f0-9]{17}$'
export HOST_INSTANCE_ID
printf '%s\n' "$ALLOY_CONFIG" > /var/lib/alloy/config.alloy
/bin/alloy validate /var/lib/alloy/config.alloy
exec /bin/alloy run --server.http.listen-addr=127.0.0.1:12345 --storage.path=/var/lib/alloy /var/lib/alloy/config.alloy
