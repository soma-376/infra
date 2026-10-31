#!/usr/bin/env python3
"""사용자 스택과 분리한 Faro → Loki 수집·조회 검증. 종료 시 테스트 컨테이너를 제거한다."""
import json, os, secrets, socket, subprocess, tempfile, time, urllib.request, urllib.parse
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
def port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0)); return s.getsockname()[1]
def run(*args, **kwargs):
    return subprocess.run(args, check=True, text=True, **kwargs)
def wait(check):
    deadline = time.monotonic() + 90
    while True:
        try:
            result = check()
            assert result
            return result
        except Exception:
            if time.monotonic() > deadline: raise
            time.sleep(1)
with tempfile.TemporaryDirectory(prefix='faro-check-') as directory:
    faro_port, loki_port, ready_port = port(), port(), port()
    source = ROOT / 'observability/faro'
    data = json.loads(run('docker','compose','-f',str(source/'compose.yaml'),'config','--format','json',env=dict(os.environ,HOST_PRIVATE_IP='127.0.0.1'),capture_output=True).stdout)
    data['name'] = 'faro-check-' + secrets.token_hex(4)
    data['networks'] = {'observability': {}}
    faro = data['services']['faro']
    faro['ports'] = [f'127.0.0.1:{faro_port}:12347', f'127.0.0.1:{ready_port}:12345']
    faro['volumes'] = [f'{source}/config.alloy:/etc/alloy/config.alloy:ro']
    faro['restart'] = 'no'
    data['services']['loki'] = {
        'image':'grafana/loki:3.7.9@sha256:0db216b630ae1f348a1584c67f3cead8b4c1fc839169a39501db664744158e28',
        'command':['-config.file=/etc/loki/config.yaml'],
        'volumes':[f'{ROOT}/modules/observability/files/loki.yaml:/etc/loki/config.yaml:ro'],
        'tmpfs':['/data:mode=1777'], 'networks':['observability'], 'ports':[f'127.0.0.1:{loki_port}:3100']}
    config = Path(directory)/'compose.json'; config.write_text(json.dumps(data))
    compose = ['docker','compose','-f',str(config)]
    try:
        run(*compose,'run','--rm','--no-deps','faro','validate','/etc/alloy/config.alloy')
        run(*compose,'up','-d')
        wait(lambda: urllib.request.urlopen(f'http://127.0.0.1:{ready_port}/-/ready',timeout=2).status == 200)
        wait(lambda: urllib.request.urlopen(f'http://127.0.0.1:{loki_port}/ready',timeout=2).status == 200)
        body = {'meta':{'app':{'name':'pulsemetry-browser','environment':'local'},'page':{'url':'/overview'}},
            'measurements':[{'type':'web-vitals','values':{key:value},'context':{'id':'v5-test-'+key},'timestamp':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())} for key,value in [('lcp',1234),('inp',80),('cls',0.02)]]}
        req = urllib.request.Request(f'http://127.0.0.1:{faro_port}/collect',data=json.dumps(body).encode(),headers={'Content-Type':'application/json'})
        assert urllib.request.urlopen(req).status in (200,202)
        def query(expression, instant=False):
            path = '/loki/api/v1/query' if instant else '/loki/api/v1/query_range'
            url=f'http://127.0.0.1:{loki_port}'+path+'?'+urllib.parse.urlencode({'query':expression})
            try:
                return json.load(urllib.request.urlopen(url))['data']['result']
            except urllib.error.HTTPError as error:
                raise RuntimeError(expression + ': ' + error.read().decode()) from error
        logs = wait(lambda: query('{job="frontend-rum"}'))
        print('FARO_LOG_FORMAT', logs, flush=True)
        # 대시보드 쿼리도 실제 Loki에서 평가한다.
        dashboard = ROOT/'observability/dashboards/rum.json'
        if dashboard.exists():
            for panel in json.loads(dashboard.read_text())['panels']:
                for target in panel.get('targets',[]):
                    expression=target['expr'].replace('$environment','local').replace('$page','.*').replace('$__range','5m')
                    result=query(expression, True)
                    if expression.startswith('quantile_over_time'):
                        assert result, expression
                        expected = 1234 if 'value_lcp' in expression else 80 if 'value_inp' in expression else 0.02
                        assert float(result[0]['value'][1]) == expected, result
        print('PASS Faro → Loki 및 대시보드 쿼리', flush=True)
    finally:
        run(*compose,'down','--volumes','--remove-orphans')
