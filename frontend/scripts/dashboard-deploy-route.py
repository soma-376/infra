#!/usr/bin/env python3
"""Terraform과 함께 변경된 push의 대시보드 배포를 apply 뒤로 넘긴다."""
import fnmatch
import os
import re
import subprocess
from pathlib import Path


def requires_apply(paths):
    # frontend-terraform-apply.yml의 push paths와 같은 계약이다.
    return any(
        (path.startswith("frontend/")
         and not path.startswith("frontend/observability/dashboards/")
         and path not in {"frontend/scripts/deploy-dashboards.py", "frontend/scripts/test-dashboards.py"})
        or fnmatch.fnmatchcase(path, ".github/workflows/frontend-terraform-*.yml")
        for path in paths
    )


def should_deploy(event, after_apply, paths):
    if event == "pull_request":
        return False
    if after_apply or event == "workflow_dispatch":
        return True
    return event == "push" and not requires_apply(paths)


def main():
    event = os.environ["EVENT_NAME"]
    after_apply = os.environ.get("AFTER_APPLY") == "true"
    paths = []
    if event == "push" and not after_apply:
        before, after = os.environ["BEFORE_SHA"], os.environ["AFTER_SHA"]
        if not all(re.fullmatch(r"[a-f0-9]{40}", sha) and sha != "0" * 40 for sha in (before, after)):
            raise ValueError("push 비교 SHA가 유효하지 않습니다. 적용 후 수동 배포하세요.")
        paths = subprocess.check_output(
            ["git", "diff", "--name-only", "-z", before, after], text=True
        ).split("\0")
    deploy = should_deploy(event, after_apply, paths)
    with Path(os.environ["GITHUB_OUTPUT"]).open("a") as output:
        output.write(f"deploy={str(deploy).lower()}\n")
    print("대시보드 배포 진행" if deploy else "PR 검증 또는 Terraform apply 후 배포로 위임")


if __name__ == "__main__":
    main()
