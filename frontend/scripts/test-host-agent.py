#!/usr/bin/env python3
"""SSM 배포 래퍼를 가짜 Docker/IMDS로 실행해 대상·설정·실패 전파를 검증한다."""
import base64
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class HostAgentDeploymentTest(unittest.TestCase):
    def execute(self, metadata_failure=False, running=True):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            log = root / 'docker.log'
            config = root / 'config.alloy'
            config.write_text((ROOT / 'observability/host-agent/config.alloy').read_text())
            # 실제 설치기 대신 인수와 전달된 설정을 검증한다. 실제 호스트는 수정하지 않는다.
            installer = '''set -eu
 test "$1" = http://10.2.0.142:4318
 test "$2" = i-0123456789abcdef0
 cmp "$(dirname "$0")/config.alloy" "$EXPECTED_CONFIG"
 echo installer-ok
'''
            template = (ROOT / 'observability/host-agent/deploy.sh.tftpl').read_text()
            for key, value in {'installer': base64.b64encode(installer.encode()).decode(), 'config': base64.b64encode(config.read_bytes()).decode(), 'endpoint': 'http://10.2.0.142:4318'}.items():
                template = template.replace('${' + key + '}', value)
            template = template.replace('/var/lock/pulsemetry-host-agent-install.lock', str(root / 'install.lock'))
            scripts = {
                'curl': 'exit 22' if metadata_failure else 'case "$*" in *api/token*) echo token;; *) echo i-0123456789abcdef0;; esac',
                'docker': 'echo "$*" >> "$DOCKER_LOG"\ncase "$1" in inspect) echo ' + ('true' if running else 'false') + ';; esac',
                'sleep': 'exit 0',
                'flock': 'exit 0',
            }
            for name, body in scripts.items():
                file = root / name
                file.write_text('#!/bin/bash\n' + body + '\n')
                file.chmod(0o755)
            env = dict(os.environ, PATH=str(root) + ':' + os.environ['PATH'], DOCKER_LOG=str(log), EXPECTED_CONFIG=str(config))
            result = subprocess.run(['bash', '-c', template], env=env, capture_output=True, text=True)
            return result, log.read_text() if log.exists() else ''

    def test_installs_on_current_instance_without_app_restart(self):
        result, log = self.execute()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('installer-ok', result.stdout)
        self.assertIn('pulsemetry-dev-host-agent', log)
        self.assertNotIn('restart', log)
        self.assertNotIn('ecs', log)

    def test_imds_failure_stops_before_install(self):
        result, log = self.execute(metadata_failure=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('installer-ok', result.stdout)
        self.assertEqual(log, '')

    def test_stopped_collector_fails_association(self):
        result, _ = self.execute(running=False)
        self.assertNotEqual(result.returncode, 0)


if __name__ == '__main__':
    unittest.main()
