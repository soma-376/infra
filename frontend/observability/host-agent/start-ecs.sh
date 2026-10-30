#!/bin/sh
# ECS 태스크가 실행되는 호스트의 cloud-init ID를 읽어 교체/증설에도 라벨을 유지한다.
set -eu
HOST_INSTANCE_ID=$(cat /host/instance-id)
printf '%s\n' "$HOST_INSTANCE_ID" | grep -Eq '^i-[a-f0-9]{17}$'
export HOST_INSTANCE_ID
# Terraform이 전달한 ID/AZ 매핑을 사용한다. IMDS 접근 권한은 추가하지 않는다.
HOST_AVAILABILITY_ZONE=""
for entry in $HOST_AZ_MAP; do
  case "$entry" in
    "$HOST_INSTANCE_ID":*) HOST_AVAILABILITY_ZONE=$(printf '%s' "$entry" | cut -d: -f2) ;;
  esac
done
case "$HOST_AVAILABILITY_ZONE" in
  ap-northeast-2a|ap-northeast-2c) ;;
  *) echo '실행 호스트의 AZ 매핑이 없습니다.' >&2; exit 1 ;;
esac
export HOST_AVAILABILITY_ZONE
printf '%s\n' "$ALLOY_CONFIG" > /var/lib/alloy/config.alloy
/bin/alloy validate /var/lib/alloy/config.alloy
exec /bin/alloy run --server.http.listen-addr=127.0.0.1:12345 --storage.path=/var/lib/alloy /var/lib/alloy/config.alloy
