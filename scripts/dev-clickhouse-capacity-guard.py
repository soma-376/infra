#!/usr/bin/env python3
"""승인된 변경 직전의 읽기 전용 drift 검사. ALTER/Helm upgrade/Secret 조회는 하지 않는다."""
import argparse
import hashlib
import json
import re
import subprocess
import xml.etree.ElementTree as ET
from pathlib import Path


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def assert_original_metric_log(metadata, xml):
    # 현재 dev에서 검증한 기본 engine 전용이다. TTL·별도 engine·기존 override를 일반화하지 않는다.
    engine = re.search(r"ENGINE\s*=.*", metadata, re.S)
    if not engine:
        raise ValueError('metric_log ENGINE 누락')
    engine = engine.group().split('COMMENT', 1)[0].strip().rstrip(';')
    normalized = re.sub(r'\s+', '', engine)
    expected = 'ENGINE=MergeTreePARTITIONBYtoYYYYMM(event_date)ORDERBY(event_date,event_time)SETTINGSindex_granularity=8192'
    if normalized != expected:
        raise ValueError('metric_log engine/partition/order/TTL/명시 설정이 검증한 기본 구조와 다름')
    metric = ET.fromstring(xml).find('metric_log')
    if metric is None or metric.find('engine') is not None or metric.find('ttl') is not None:
        raise ValueError('기존 metric_log engine/TTL override는 별도 검토 필요')
    partition = metric.findtext('partition_by')
    # 생략하면 서버 기본 월 partition을 쓰며 실제 DDL을 위에서 함께 확인했다.
    if partition is not None and re.sub(r'\s+', '', partition) != 'toYYYYMM(event_date)':
        raise ValueError('기존 metric_log partition_by가 다름')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--before-dir', type=Path, required=True)
    parser.add_argument('--kubectl', default='kubectl')
    parser.add_argument('--helm', default='helm')
    parser.add_argument('--expected-image-digest', required=True)
    args = parser.parse_args()
    if not re.fullmatch(r'sha256:[a-f0-9]{64}', args.expected_image_digest):
        raise ValueError('검증한 현재 image digest가 필요함')
    before = args.before_dir
    def load(name):
        return json.loads((before / name).read_text())
    def read(argv):
        result = subprocess.run(argv, capture_output=True, text=True, timeout=30)
        if result.returncode:
            raise ValueError(f'읽기 전용 명령 실패: {argv[0]}, 원문 출력 생략')
        return result.stdout
    def kube(*argv):
        return [args.kubectl, '--request-timeout=10s', '-n', 'pulsemetry-dev', *argv]
    checks = []
    def check(label, condition):
        if not condition:
            raise ValueError(label + ': drift로 적용 보류')
        checks.append(label)
    original = (before / 'metric_log-before.sql').read_text()
    metadata = read(kube('exec', 'clickhouse-0', '--', 'cat', '/var/lib/clickhouse/metadata/system/metric_log.sql'))
    xml = read(kube('exec', 'clickhouse-0', '--', 'cat', '/var/lib/clickhouse/preprocessed_configs/config.xml'))
    assert_original_metric_log(metadata, xml)
    check('metricLogMetadataSameIncludingUUID', digest(metadata) == digest(original))
    check('preprocessedConfigUnchanged', digest(xml) == load('clickhouse-settings-baseline.json')['preprocessedConfigSha256'])
    for release, prefix in [('dashboard-api', 'dashboard'), ('clickhouse', 'clickhouse')]:
        values = json.loads(read([args.helm, 'get', 'values', release, '--all', '-o', 'json', '-n', 'pulsemetry-dev']))
        history = json.loads(read([args.helm, 'history', release, '-o', 'json', '-n', 'pulsemetry-dev']))
        check(release + 'ValuesUnchanged', values == load(prefix + '-values-all.json'))
        check(release + 'RevisionUnchanged', history[-1]['revision'] == load(prefix + '-history.json')[-1]['revision'])
        check(release + 'ReleaseDeployed', history[-1]['status'] == 'deployed')
    current = json.loads(read(kube('get', 'statefulset', 'clickhouse', '-o', 'json')))
    check('clickhouseSpecUnchanged', current['spec'] == load('clickhouse-statefulset.json')['spec'])
    pods = json.loads(read(kube('get', 'pods', '-o', 'json')))
    def running_images(document):
        return {item['metadata']['name']: [(s['name'], s['imageID'], s['ready']) for s in item.get('status', {}).get('containerStatuses', [])]
                for item in document['items'] if item['metadata']['name'] == 'clickhouse-0' or item['metadata']['name'].startswith('dashboard-api-')}
    check('runningImagesAndReadyUnchanged', running_images(pods) == running_images(load('pods.json')))
    targets = running_images(pods)
    check('allTargetContainersReady', len(targets) == 2 and all(items for items in targets.values()) and
          all(ready for items in targets.values() for _, _, ready in items))
    check('candidatePinMatchesCurrentClickhouseImage',
          len(targets['clickhouse-0']) == 1 and targets['clickhouse-0'][0][1].endswith('@' + args.expected_image_digest))
    print(json.dumps({'readOnly': True, 'allowedNextAction': 'Review current monitoring and explicit user approval before manual ALTER; this guard does not authorize or execute it', 'checks': checks}, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, OSError, subprocess.SubprocessError, ET.ParseError) as error:
        raise SystemExit('적용 보류: ' + str(error))
