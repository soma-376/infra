#!/usr/bin/env python3
"""AWS 호출 없이 격리된 Compose에서 인증·OTLP 3종·OS 지표·재시작 보존을 검증한다."""
import base64
import json
import os
from pathlib import Path
import secrets
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
                if suffix.startswith('secrets/'):
                    volume['source'] = str(secret)
                else:
                    volume['source'] = suffix
                    volume['type'] = 'volume'
                    volume.pop('bind', None)
                    data['volumes'][suffix] = {}
        for port in service.get('ports', []):
            port['published'] = str(grafana_port if name == 'grafana' else otlp_port)
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
    finally:
        run(*compose, 'down', '--volumes', '--remove-orphans', stdout=subprocess.DEVNULL)
