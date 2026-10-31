#!/usr/bin/env python3
"""실제 AWS 없이 payload 경계·배포·실패 복구를 검증한다."""
import base64
import copy
import gzip
import importlib.util
import io
import http.client
import urllib.error
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('release', Path(__file__).with_name('dashboard-release.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
BUNDLE = {p.name: json.loads(p.read_text()) for p in (Path(__file__).resolve().parents[1] / 'observability/dashboards').glob('*.json')}


class ReleaseTests(unittest.TestCase):
    def test_payload_boundaries(self):
        encoded = base64.b64encode(gzip.compress(json.dumps(BUNDLE).encode())).decode()
        self.assertEqual(release.decode(encoded), BUNDLE)
        for mutate in [lambda b: b.update({'../compose.yaml': {}}),
                       lambda b: b['observability.json'].update(uid='unrelated'),
                       lambda b: b['observability.json']['panels'][0].update(datasource={'uid': 'unknown'})]:
            invalid = copy.deepcopy(BUNDLE)
            mutate(invalid)
            with self.assertRaises(ValueError):
                release.validate(invalid)
        with self.assertRaises(ValueError):
            release.decode(base64.b64encode(gzip.compress(b'x' * (1024 * 1024 + 1))).decode())

    def test_collapsed_rows_cannot_hide_duplicate_panel_ids(self):
        invalid = copy.deepcopy(BUNDLE)
        panels = invalid['dev-frontend.json']['panels']
        panels.append({'id': 9999, 'type': 'row', 'collapsed': True,
                       'panels': [copy.deepcopy(panels[0])]})
        with self.assertRaisesRegex(ValueError, '중복 패널 ID'):
            release.validate(invalid)

    def test_restart_connection_errors_are_retried(self):
        check = Mock(side_effect=[ConnectionResetError(104, 'reset'),
            http.client.RemoteDisconnected('closed'),
            urllib.error.HTTPError('http://localhost', 503, 'starting', {}, None), None])
        with patch.object(release.time, 'sleep'):
            release.wait_for_grafana(check)
        self.assertEqual(check.call_count, 4)

    def test_auth_failure_is_not_retried(self):
        check = Mock(side_effect=urllib.error.HTTPError('http://localhost', 401, 'unauthorized', {}, None))
        with self.assertRaises(urllib.error.HTTPError):
            release.wait_for_grafana(check)
        self.assertEqual(check.call_count, 1)

    def test_startup_wait_is_bounded(self):
        check = Mock(side_effect=ConnectionResetError())
        with patch.object(release.time, 'monotonic', side_effect=[0, 0, 121]), patch.object(release.time, 'sleep'):
            with self.assertRaisesRegex(RuntimeError, '시간 초과'):
                release.wait_for_grafana(check)

    def simulate(self, fail=False, migrate=True):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / 'opt'
            data = Path(temp) / 'data'
            root.mkdir()
            (data / 'secrets').mkdir(parents=True)
            (data / 'secrets/grafana-admin-password').write_text('test-only')
            target = data / 'dashboards'
            target.mkdir()
            old = copy.deepcopy(BUNDLE)
            old['observability.json']['title'] = '이전 대시보드'
            for name, obj in old.items():
                (target / name).write_text(json.dumps(obj))
            mount = './hosts.json:/etc/grafana/dashboards/hosts.json:ro' if migrate else '/srv/pulsemetry-observability/dashboards:/etc/grafana/dashboards:ro'
            (root / 'compose.yaml').write_text(mount)
            reloads = []
            def response(req, **kwargs):
                path = req.full_url.split(':3000')[1]
                if path.endswith('/reload'):
                    reloads.append(1)
                    if fail and len(reloads) == 1:
                        raise RuntimeError('검증용 reload 실패')
                    obj = {}
                elif '/dashboards/uid/' in path:
                    uid = path.rsplit('/', 1)[1]
                    name = next(k for k, v in release.EXPECTED.items() if v == uid)
                    obj = {'dashboard': json.loads((target / name).read_text()), 'meta': {'provisioned': True}}
                else:
                    obj = {}
                return io.BytesIO(json.dumps(obj).encode())
            def mapped(path):
                return {'/opt/pulsemetry-observability': root, '/srv/pulsemetry-observability': data}.get(path, Path(path))
            with patch.object(release, 'Path', side_effect=mapped), patch.object(release.subprocess, 'run') as run, patch.object(release.urllib.request, 'urlopen', side_effect=response):
                if fail:
                    with self.assertRaises(RuntimeError):
                        release.deploy(BUNDLE)
                    self.assertEqual((root / 'compose.yaml').read_text(), mount)
                    self.assertEqual(json.loads((target / 'observability.json').read_text()), old['observability.json'])
                else:
                    release.deploy(BUNDLE)
                    self.assertEqual(json.loads((target / 'dev-frontend.json').read_text()), BUNDLE['dev-frontend.json'])
                for call in run.call_args_list:
                    if 'up' in call.args[0]:
                        self.assertEqual(call.args[0][-1], 'grafana')
                if not migrate:
                    self.assertFalse(any('up' in c.args[0] for c in run.call_args_list))
    def test_first_migration_only_recreates_grafana(self):
        self.simulate()
    def test_regular_release_does_not_restart(self):
        self.simulate(migrate=False)
    def test_failure_rolls_back_files_and_mount(self):
        self.simulate(fail=True)


if __name__ == '__main__':
    unittest.main()
