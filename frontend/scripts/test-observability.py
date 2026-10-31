#!/usr/bin/env python3
"""AWS 호출 없이 격리된 Compose에서 인증·OTLP 3종·OS 지표·재시작 보존을 검증한다."""
import base64
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
FILES = ROOT / 'modules/observability/files'


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def run(*args, **kwargs):
    return subprocess.run(args, check=True, text=True, **kwargs)


def eventually(check):
    deadline = time.monotonic() + 60
    while True:
        try:
            result = check()
            assert result, '데이터 미수신'
            return result
        except (AssertionError, IndexError, urllib.error.URLError, TimeoutError):
            if time.monotonic() >= deadline:
                raise
            time.sleep(2)


with tempfile.TemporaryDirectory(prefix='proj260-observability-') as directory:
    temp = Path(directory)
    dashboards = temp / 'dashboards'
    dashboards.mkdir()
    shutil.copy2(ROOT / 'observability/dashboards/observability.json', dashboards / 'observability.json')
    env = dict(os.environ, HOST_INSTANCE_ID='validation', HOST_PRIVATE_IP='127.0.0.1')
    data = json.loads(run('docker', 'compose', '-f', str(FILES / 'compose.yaml'), 'config', '--format', 'json', env=env, capture_output=True).stdout)
    project = 'proj260-validation-' + secrets.token_hex(4)
    data['name'] = project
    data['networks']['default']['name'] = project + '-network'
    data['volumes'] = {}
    grafana_port, otlp_port = free_port(), free_port()
    while grafana_port == otlp_port:
        otlp_port = free_port()
    password = secrets.token_hex(32)
    secret = temp / 'password'
    secret.write_text(password)
    secret.chmod(0o444)  # 임시 테스트용 비밀번호. 실제 부팅 스크립트는 UID 10001 / 0400.
    for name, service in data['services'].items():
        for volume in service.get('volumes', []):
            if volume['source'].startswith('/srv/pulsemetry-observability/'):
                suffix = volume['source'].split('/srv/pulsemetry-observability/')[1]
                if suffix == 'dashboards':
                    volume['source'] = str(dashboards)
                elif suffix.startswith('secrets/'):
                    volume['source'] = str(secret)
                else:
                    volume['source'] = suffix
                    volume['type'] = 'volume'
                    volume.pop('bind', None)
                    data['volumes'][suffix] = {}
        for port in service.get('ports', []):
            port['published'] = str(grafana_port if name == 'grafana' else otlp_port)
    # dev 호스트는 Prometheus 직접 접근 없이 앱과 같은 OTLP 경로를 사용한다.
    host = json.loads(run('docker', 'compose', '-f', str(ROOT / 'observability/host-agent/compose.yaml'),
                         'config', '--format', 'json', env=dict(env, HOST_INSTANCE_ID='i-0123456789abcdef0',
                         HOST_ENVIRONMENT='dev', HOST_ROLE='frontend-dev',
                         OTEL_EXPORTER_OTLP_ENDPOINT='http://alloy:4318'), capture_output=True).stdout)
    data['services']['dev-host'] = host['services']['alloy-host']
    dev_host = data['services']['dev-host']
    instance_file = temp / 'instance-id'
    instance_file.write_text('i-0123456789abcdef0\n')
    dev_host['volumes'].append({'type': 'bind', 'source': str(instance_file), 'target': '/host/instance-id', 'read_only': True})
    # 실제 ECS 태스크와 동일하게 실행 호스트의 AZ 매핑을 전달한다.
    dev_host['environment']['HOST_AZ_MAP'] = 'i-0123456789abcdef0:ap-northeast-2a'
    dev_host['environment']['ALLOY_CONFIG'] = (ROOT / 'observability/host-agent/config.alloy').read_text()
    dev_host['entrypoint'] = ['/bin/sh', '-ec']
    # Compose의 $ 보간을 피하고 태스크 정의와 같은 시작 스크립트를 실행한다.
    dev_host['command'] = [(ROOT / 'observability/host-agent/start-ecs.sh').read_text().replace('$', '$$')]

    config = temp / 'compose.json'
    config.write_text(json.dumps(data))
    compose = ['docker', 'compose', '-f', str(config)]
    auth = {'Authorization': 'Basic ' + base64.b64encode(('admin:' + password).encode()).decode()}

    def get(path, authenticated=True):
        request = urllib.request.Request(f'http://127.0.0.1:{grafana_port}' + path, headers=auth if authenticated else {})
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.load(response)

    def post(signal, payload):
        request = urllib.request.Request(f'http://127.0.0.1:{otlp_port}/v1/' + signal, data=json.dumps(payload).encode(), headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=10) as response:
            result = json.load(response)
            assert not any(result.get('partialSuccess', {}).values()), result

    def query(uid, path):
        return get('/api/datasources/proxy/uid/' + uid + path)

    def metric(expression):
        return query('prometheus', '/api/v1/query?query=' + urllib.parse.quote(expression))['data']['result']

    def logs():
        return query('loki', '/loki/api/v1/query_range?query=' + urllib.parse.quote('{service_name="proj260-validation"}'))['data']['result']

    def trace():
        return query('tempo', '/api/traces/12345678901234567890123456789012')['batches']

    try:
        run(*compose, 'up', '-d', '--wait', '--wait-timeout', '180', stdout=subprocess.DEVNULL)
        assert len(get('/api/dashboards/uid/pulsemetry-frontend-hosts')['dashboard']['panels']) == 9
        # 기존 API 관리 대시보드를 같은 UID의 파일 관리로 전환한다.
        dev = json.loads((ROOT / 'observability/dashboards/dev-frontend.json').read_text())
        def grafana_post(path, body):
            request = urllib.request.Request(f'http://127.0.0.1:{grafana_port}' + path,
                data=json.dumps(body).encode(), headers=dict(auth, **{'Content-Type': 'application/json'}))
            with urllib.request.urlopen(request, timeout=15) as response:
                return json.load(response)
        grafana_post('/api/dashboards/db', {'dashboard': dev, 'overwrite': True})
        assert not get('/api/dashboards/uid/pulsemetry-dev-overview')['meta']['provisioned']
        shutil.copy2(ROOT / 'observability/dashboards/dev-frontend.json', dashboards / 'dev-frontend.json')
        grafana_post('/api/admin/provisioning/dashboards/reload', {})
        actual = get('/api/dashboards/uid/pulsemetry-dev-overview')
        assert actual['meta']['provisioned'] and actual['dashboard']['panels'] == dev['panels']
        print('PASS: 기존 DB 대시보드의 UID를 유지하며 파일 provisioning 전환', flush=True)
        assert {s['uid'] for s in get('/api/datasources')} == {'prometheus', 'loki', 'tempo'}
        try:
            get('/api/datasources', authenticated=False)
            raise AssertionError('익명 접근이 허용되었습니다.')
        except urllib.error.HTTPError as error:
            assert error.code == 401
        attrs = [{'key': 'service.name', 'value': {'stringValue': 'proj260-validation'}}, {'key': 'deployment.environment.name', 'value': {'stringValue': 'dev'}}]
        now = time.time_ns()
        post('metrics', {'resourceMetrics': [{'resource': {'attributes': attrs}, 'scopeMetrics': [{'metrics': [{'name': 'proj260.validation', 'gauge': {'dataPoints': [{'timeUnixNano': str(now), 'asDouble': 7}]}}]}]}]})
        post('logs', {'resourceLogs': [{'resource': {'attributes': attrs}, 'scopeLogs': [{'logRecords': [{'timeUnixNano': str(now), 'severityNumber': 9, 'severityText': 'INFO', 'body': {'stringValue': 'proj260-stack-validation'}}]}]}]})
        post('traces', {'resourceSpans': [{'resource': {'attributes': attrs}, 'scopeSpans': [{'spans': [{'traceId': '12345678901234567890123456789012', 'spanId': '1234567890123456', 'name': 'proj260-stack-validation', 'kind': 2, 'startTimeUnixNano': str(now - 1000000), 'endTimeUnixNano': str(now), 'status': {'code': 1}}]}]}]})
        eventually(lambda: metric('proj260_validation{deployment_environment_name="dev"}'))
        eventually(lambda: metric('up{job="frontend-host",host_role="observability"}')[0]['value'][1] == '1')
        eventually(lambda: metric('up{job="frontend-host",host_role="frontend-dev",environment="dev",instance="i-0123456789abcdef0",availability_zone="ap-northeast-2a"}')[0]['value'][1] == '1')
        eventually(lambda: metric('node_memory_MemTotal_bytes{job="frontend-host",host_role="frontend-dev",environment="dev",instance="i-0123456789abcdef0",availability_zone="ap-northeast-2a"}'))
        eventually(logs)
        eventually(trace)
        print('PASS: 인증, 데이터 소스, OS 대시보드, metrics/logs/traces와 dev 라벨', flush=True)
        run(*compose, 'stop', stdout=subprocess.DEVNULL)
        run(*compose, 'up', '-d', '--wait', '--wait-timeout', '180', stdout=subprocess.DEVNULL)
        # 재전송 없이 기존 시점 데이터 조회. 현재 instant vector의 lookback에 의존하지 않는다.
        expression = f'proj260_validation{{deployment_environment_name="dev"}} @ {now / 1e9 + 1}'
        eventually(lambda: metric(expression))
        eventually(logs)
        eventually(trace)
        print('PASS: 컨테이너 재시작 후 로그인과 저장 데이터 유지', flush=True)
    except Exception:
        # 수신 실패 시 정리 전에 수집기의 기동 오류를 남긴다.
        subprocess.run([*compose, 'logs', '--no-color', '--tail', '80', 'dev-host'], check=False)
        raise
    finally:
        run(*compose, 'down', '--volumes', '--remove-orphans', stdout=subprocess.DEVNULL)
