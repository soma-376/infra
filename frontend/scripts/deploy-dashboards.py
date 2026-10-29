#!/usr/bin/env python3
"""기본은 로컬 검증만. --deploy로 고정 SSM 문서 실행을 요청한다."""
import argparse
import base64
import gzip
import importlib.util
import json
from pathlib import Path
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('release', Path(__file__).with_name('dashboard-release.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


def aws(*args):
    return json.loads(subprocess.check_output(['aws', '--region', 'ap-northeast-2', *args, '--output', 'json'], text=True))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--deploy', action='store_true')
    args = parser.parse_args()
    files = ROOT / 'observability/dashboards'
    bundle = {p.name: json.loads(p.read_text()) for p in files.glob('*.json')}
    release.validate(bundle)
    payload = base64.b64encode(gzip.compress(json.dumps(bundle).encode(), mtime=0)).decode()
    if len(payload) > 24000:
        raise ValueError('SSM payload 크기 제한 초과')
    print('대시보드 2개 검증 완료', flush=True)
    if not args.deploy:
        return
    result = aws('ec2', 'describe-instances', '--filters',
        'Name=tag:Name,Values=soma-376-frontend-observability',
        'Name=tag:Project,Values=pulsemetry-frontend', 'Name=tag:Env,Values=dev',
        'Name=tag:Component,Values=observability', 'Name=instance-state-name,Values=running')
    instances = [i['InstanceId'] for r in result['Reservations'] for i in r['Instances']]
    if len(instances) != 1:
        raise RuntimeError('관측 인스턴스가 정확히 한 대여야 합니다: ' + str(instances))
    command = aws('ssm', 'send-command', '--document-name', 'soma-376-frontend-dashboards',
        '--instance-ids', instances[0], '--parameters', json.dumps({'DashboardBundle': [payload]}),
        '--timeout-seconds', '600')['Command']['CommandId']
    print('SSM command=' + command, flush=True)
    for _ in range(120):
        time.sleep(5)
        try:
            result = aws('ssm', 'get-command-invocation', '--command-id', command, '--instance-id', instances[0])
        except subprocess.CalledProcessError:
            continue
        if result['Status'] in ['Pending', 'InProgress', 'Delayed']:
            continue
        if result['Status'] != 'Success':
            raise RuntimeError('SSM 배포 실패: ' + result['Status'] + '\n' + result.get('StandardErrorContent', ''))
        print(result['StandardOutputContent'])
        return
    raise RuntimeError('SSM 대기 시간 초과. 재실행 전에 command 상태를 확인하세요: ' + command)


if __name__ == '__main__':
    main()
