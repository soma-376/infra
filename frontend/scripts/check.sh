#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
TF_BIN="${TF_BIN:-terraform}"
export TF_IN_AUTOMATION=true AWS_EC2_METADATA_DISABLED=true
python3 scripts/test-bootstrap-plan.py
"$TF_BIN" fmt -check -recursive .
for root in bootstrap modules/network modules/application modules/observability environments/dev environments/prod environments/shared; do
  "$TF_BIN" -chdir="$root" init -backend=false -input=false -lockfile=readonly
  "$TF_BIN" -chdir="$root" validate -no-color
  # 모든 테스트는 mock_provider만 사용한다. 실제 AWS apply가 아니다.
  "$TF_BIN" -chdir="$root" test -no-color
done
