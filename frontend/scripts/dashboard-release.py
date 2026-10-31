#!/usr/bin/env python3
"""SSM 전용 문서에서 실행하는 고정 대시보드 배포기. 비밀 값은 출력하지 않는다."""
import base64
import fcntl
import gzip
import io
import http.client
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import urllib.error
import urllib.request

EXPECTED = {'dev-frontend.json': 'pulsemetry-dev-overview', 'observability.json': 'pulsemetry-frontend-hosts', 'rum.json': 'pulsemetry-browser-rum'}
SOURCES = {'prometheus', 'loki', 'tempo'}


def validate(bundle):
    if not isinstance(bundle, dict) or set(bundle) != set(EXPECTED):
        raise ValueError('대시보드 파일 허용목록 불일치')
    for name, dashboard in bundle.items():
        if dashboard.get('uid') != EXPECTED[name] or not dashboard.get('title'):
            raise ValueError('대시보드 UID/제목 오류')
        panels = dashboard.get('panels')
        if not isinstance(panels, list) or not panels:
            raise ValueError('빈 패널 목록')
        def panel_ids(items):
            for panel in items:
                yield panel['id']
                yield from panel_ids(panel.get('panels', []))
        ids = list(panel_ids(panels))
        if len(ids) != len(set(ids)):
            raise ValueError('중복 패널 ID')
        def walk(obj):
            if isinstance(obj, dict):
                ds = obj.get('datasource')
                if ds is not None and (not isinstance(ds, dict) or ds.get('uid') not in SOURCES):
                    raise ValueError('허용하지 않은 데이터 소스')
                for value in obj.values():
                    walk(value)
            elif isinstance(obj, list):
                for value in obj:
                    walk(value)
        walk(dashboard)
    return bundle


def decode(payload):
    # 압축 폭탄 및 과도한 SSM payload 방지. shell에 값을 보간하지 않는다.
    compressed = base64.b64decode(payload, validate=True)
    with gzip.GzipFile(fileobj=io.BytesIO(compressed)) as stream:
        raw = stream.read(1024 * 1024 + 1)
    if len(raw) > 1024 * 1024:
        raise ValueError('대시보드 크기 제한 초과')
    return validate(json.loads(raw))


def wait_for_grafana(check, timeout=120):
    """재시작 중의 연결 종료/초기화 응답만 재시도한다. 인증 오류는 즉시 실패한다."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            check()
            return
        except urllib.error.HTTPError as error:
            if error.code not in (502, 503, 504):
                raise
        except (urllib.error.URLError, ConnectionError, TimeoutError, http.client.HTTPException):
            pass
        time.sleep(2)
    raise RuntimeError('Grafana 기동 시간 초과')


def deploy(bundle):
    root = Path('/opt/pulsemetry-observability')
    data = Path('/srv/pulsemetry-observability')
    subprocess.run(['mountpoint', '-q', str(data)], check=True)
    compose = root / 'compose.yaml'
    previous = compose.read_text()
    legacy = './hosts.json:/etc/grafana/dashboards/hosts.json:ro'
    mount = '/srv/pulsemetry-observability/dashboards:/etc/grafana/dashboards:ro'
    if legacy not in previous and mount not in previous:
        raise RuntimeError('알 수 없는 Grafana 마운트 구성')
    migrate = legacy in previous
    password = (data / 'secrets/grafana-admin-password').read_text().strip()
    auth = 'Basic ' + base64.b64encode(('admin:' + password).encode()).decode()

    def api(path, body=None):
        request = urllib.request.Request('http://127.0.0.1:3000' + path,
            data=json.dumps(body).encode() if body is not None else None,
            headers={'Authorization': auth, 'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=15) as response:
            return json.load(response)

    api('/api/org')  # 인증 실패는 파일 변경 전에 중단한다.
    old_api = {}
    for uid in EXPECTED.values():
        try:
            old_api[uid] = api('/api/dashboards/uid/' + uid)
        except urllib.error.HTTPError as error:
            if error.code != 404:
                raise
    target = data / 'dashboards'
    target.mkdir(mode=0o755, exist_ok=True)
    if any(p.name not in EXPECTED for p in target.glob('*.json')):
        raise RuntimeError('관리 대상 외 JSON이 있어 배포를 중단합니다.')
    backup = data / 'dashboard-backups' / str(time.time_ns())
    backup.mkdir(parents=True, mode=0o700)
    (backup / 'compose.yaml').write_text(previous)
    (backup / 'api.json').write_text(json.dumps(old_api))
    for name in EXPECTED:
        if (target / name).exists():
            shutil.copy2(target / name, backup / name)

    def recreate():
        subprocess.run(['docker', 'compose', 'up', '-d', '--no-deps', '--force-recreate', 'grafana'], cwd=root, check=True)
        wait_for_grafana(lambda: api('/api/org'))

    try:
        for name, dashboard in bundle.items():
            staging = target / (name + '.tmp')
            staging.write_text(json.dumps(dashboard, ensure_ascii=False, indent=2) + '\n')
            staging.chmod(0o644)
            staging.replace(target / name)
        if migrate:
            compose.write_text(previous.replace(legacy, mount))
            subprocess.run(['docker', 'compose', 'config', '--quiet'], cwd=root, check=True)
            recreate()
        api('/api/admin/provisioning/dashboards/reload', {})
        for name, uid in EXPECTED.items():
            actual = api('/api/dashboards/uid/' + uid)
            if not actual['meta']['provisioned'] or actual['dashboard']['title'] != bundle[name]['title'] or actual['dashboard']['panels'] != bundle[name]['panels']:
                raise RuntimeError('대시보드 반영 검증 실패: ' + uid)
    except Exception:
        for name in EXPECTED:
            if (backup / name).exists():
                shutil.copy2(backup / name, target / name)
            else:
                (target / name).unlink(missing_ok=True)
        compose.write_text(previous)
        if migrate:
            recreate()
        api('/api/admin/provisioning/dashboards/reload', {})
        for old in old_api.values():
            if not old['meta']['provisioned']:
                api('/api/dashboards/db', {'dashboard': old['dashboard'], 'folderUid': old['meta']['folderUid'], 'overwrite': True})
        raise
    print('대시보드 파일 provisioning 및 내용 검증 완료. backup=' + str(backup))


if __name__ == '__main__':
    bundle = decode(os.environ['SSM_DashboardBundle'])
    with open('/var/lock/pulsemetry-dashboard-deploy.lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        deploy(bundle)
