#!/usr/bin/env python3
"""SSM 정리의 컨테이너 소유권과 ECS 호스트·AZ 식별을 검증한다."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class LegacyCleanupTest(unittest.TestCase):
    def execute(self, existing=True, owner='frontend-host-agent', docker_failure=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            log = root / 'docker.log'
            instance = root / 'instance-id'
            instance.write_text('i-0123456789abcdef0\n')
            script = (ROOT / 'observability/host-agent/cleanup-legacy.sh').read_text()
            script = script.replace('/var/lock/pulsemetry-host-agent-install.lock', str(root / 'lock'))
            script = script.replace('/var/lib/cloud/data/instance-id', str(instance))
            docker = root / 'docker'
            docker.write_text('#!/bin/bash\necho "$*" >> "$DOCKER_LOG"\n' +
                'case "$1" in\ninfo) exit 0;;\ncontainer) ' +
                ('exit 1' if docker_failure else ('echo pulsemetry-dev-host-agent' if existing else 'exit 0')) +
                ';;\ninspect) echo ' + owner + ';;\nesac\n')
            docker.chmod(0o755)
            flock = root / 'flock'
            flock.write_text('#!/bin/sh\nexit 0\n')
            flock.chmod(0o755)
            result = subprocess.run(['bash', '-c', script], env=dict(os.environ, PATH=str(root)+':'+os.environ['PATH'], DOCKER_LOG=str(log)), capture_output=True, text=True)
            return result, log.read_text()

    def test_removes_only_owned_legacy_container(self):
        result, log = self.execute()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('rm -f pulsemetry-dev-host-agent', log)
        self.assertNotIn('restart', log)

    def test_missing_legacy_container_is_idempotent(self):
        result, log = self.execute(existing=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('rm -f', log)

    def test_foreign_container_is_not_removed(self):
        result, log = self.execute(owner='someone-else')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('rm -f', log)

    def test_docker_failure_is_not_treated_as_absent(self):
        result, log = self.execute(docker_failure=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('rm -f', log)


class EcsAvailabilityZoneTest(unittest.TestCase):
    def execute(self, instance):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'instance-id').write_text(instance)
            alloy = root / 'alloy'
            alloy.write_text('#!/bin/sh\nif [ "$1" = run ]; then printf "%s %s" "$HOST_INSTANCE_ID" "$HOST_AVAILABILITY_ZONE"; fi\n')
            alloy.chmod(0o755)
            script = (ROOT / 'observability/host-agent/start-ecs.sh').read_text()
            script = script.replace('/host/instance-id', str(root / 'instance-id')).replace('/var/lib/alloy', str(root)).replace('/bin/alloy', str(alloy))
            env = dict(os.environ, ALLOY_CONFIG='test', HOST_AZ_MAP='i-0123456789abcdef0:ap-northeast-2a i-0123456789abcdef1:ap-northeast-2c')
            return subprocess.run(['sh', '-c', script], env=env, capture_output=True, text=True)

    def test_each_host_gets_its_own_zone(self):
        for instance, zone in [('i-0123456789abcdef0', 'ap-northeast-2a'), ('i-0123456789abcdef1', 'ap-northeast-2c')]:
            result = self.execute(instance)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, instance + ' ' + zone)

    def test_unknown_host_fails_instead_of_mislabeling(self):
        self.assertNotEqual(self.execute('i-0123456789abcdef2').returncode, 0)


if __name__ == '__main__':
    unittest.main()
