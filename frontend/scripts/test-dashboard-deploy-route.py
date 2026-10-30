#!/usr/bin/env python3
"""단독 JSON 배포와 bootstrap/runtime 동반 변경의 순서를 검증한다."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("route", Path(__file__).with_name("dashboard-deploy-route.py"))
route = importlib.util.module_from_spec(spec)
spec.loader.exec_module(route)


class DeploymentRouteTest(unittest.TestCase):
    def test_json_only_push(self):
        self.assertTrue(route.should_deploy("push", False, ["frontend/observability/dashboards/rum.json"]))

    def test_apply_changes_defer(self):
        for path in ["frontend/bootstrap/dashboards.tf", "frontend/environments/dev/faro.tf",
                     "frontend/scripts/dashboard-release.py", ".github/workflows/frontend-terraform-apply.yml"]:
            with self.subTest(path=path):
                self.assertFalse(route.should_deploy("push", False, ["frontend/observability/dashboards/rum.json", path]))

    def test_pr_never_deploys(self):
        self.assertFalse(route.should_deploy("pull_request", False, []))
        self.assertFalse(route.should_deploy("pull_request", True, []))

    def test_after_apply_and_manual_recovery(self):
        self.assertTrue(route.should_deploy("push", True, ["frontend/bootstrap/dashboards.tf"]))
        self.assertTrue(route.should_deploy("workflow_dispatch", False, []))

    def test_dashboard_script_only_does_not_need_apply(self):
        self.assertFalse(route.requires_apply(["frontend/scripts/deploy-dashboards.py", "frontend/scripts/test-dashboards.py"]))


if __name__ == "__main__":
    unittest.main()
