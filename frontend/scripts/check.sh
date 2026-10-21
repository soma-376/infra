#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
TF_BIN="${TF_BIN:-terraform}"
export TF_IN_AUTOMATION=true AWS_EC2_METADATA_DISABLED=true
"$TF_BIN" fmt -check -recursive .
for root in bootstrap modules/network modules/application environments/dev environments/prod; do
  "$TF_BIN" -chdir="$root" init -backend=false -input=false -lockfile=readonly
  "$TF_BIN" -chdir="$root" validate -no-color
  # 모든 테스트는 mock_provider만 사용한다. 실제 AWS apply가 아니다.
  "$TF_BIN" -chdir="$root" test -no-color
done
