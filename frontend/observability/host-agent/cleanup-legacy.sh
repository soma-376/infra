#!/bin/bash
# ECS 전환용: 이 설치기가 소유한 기존 컨테이너 하나만 정리한다.
set -euo pipefail
exec 9>/var/lock/pulsemetry-host-agent-install.lock
flock -w 600 9
for attempt in $(seq 1 60); do
  if docker info >/dev/null 2>&1; then break; fi
  sleep 5
done
docker info >/dev/null
# 새 수집기에 필요한 cloud-init 호스트 식별자를 먼저 확인한다.
grep -Eq '^i-[a-f0-9]{17}$' /var/lib/cloud/data/instance-id
name=pulsemetry-dev-host-agent
# inspect 오류를 미존재로 취급하지 않는다.
existing=$(docker container ls -a --filter "name=^/$name$" --format '{{.Names}}')
if [[ -z "$existing" ]]; then exit 0; fi
[[ "$existing" == "$name" ]]
[[ $(docker inspect --format '{{index .Config.Labels "pulsemetry.owner"}}' "$name") == frontend-host-agent ]] || {
  echo '다른 소유자의 컨테이너이므로 정리하지 않습니다.' >&2
  exit 1
}
docker rm -f "$name"
