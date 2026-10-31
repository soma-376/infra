#!/usr/bin/env python3
"""AWS 태그로 BFF peer 입력을 생성한다. 기존 peer 누락 시 자동 삭제하지 않는다."""
import argparse
import json
import subprocess
from pathlib import Path


def aws(operation, **filters):
    command = ['aws', 'ec2', operation, '--region', 'ap-northeast-2', '--output', 'json', '--filters']
    command += [f'Name={key},Values={value}' for key, value in filters.items()]
    return json.loads(subprocess.check_output(command))


def only(items, label):
    if len(items) != 1:
        raise ValueError(f'{label}: 정확히 하나가 필요하지만 {len(items)}개 발견')
    return items[0]


def discover(query=aws):
    peers = {}
    for env in ('dev', 'prod'):
        filters = {'tag:Project': 'pulsemetry-frontend', 'tag:Env': env, 'tag:ManagedBy': 'terraform'}
        vpcs = query('describe-vpcs', **filters, **{'tag:Name': f'pulsemetry-frontend-{env}'})['Vpcs']
        if env == 'prod' and not vpcs:
            continue
        vpc = only(vpcs, f'{env} VPC')
        groups = query('describe-security-groups', **filters, **{'vpc-id': vpc['VpcId'], 'tag:Name': f'soma-376-frontend-{env}-app'})['SecurityGroups']
        if env == 'prod' and not groups:
            continue
        group = only(groups, f'{env} BFF SG')
        names = [f'pulsemetry-frontend-{env}-public'] if env == 'dev' else [f'pulsemetry-frontend-prod-private-{az}' for az in ('ap-northeast-2a', 'ap-northeast-2c')]
        tables = [only(query('describe-route-tables', **filters, **{'vpc-id': vpc['VpcId'], 'tag:Name': name})['RouteTables'], name)['RouteTableId'] for name in names]
        peers[env] = {'vpc_id': vpc['VpcId'], 'security_group_id': group['GroupId'], 'route_table_ids': sorted(tables)}
    return peers


def guard_existing(peers, state):
    existing = {resource['index'] for resource in state.get('values', {}).get('root_module', {}).get('resources', []) if resource.get('type') == 'aws_vpc_peering_connection' and resource.get('name') == 'app'}
    if existing - peers.keys():
        raise ValueError(f'기존 peer가 조회에서 누락됨: {sorted(existing - peers.keys())}; 자동 제거 금지')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--state', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    peers = discover()
    guard_existing(peers, json.loads(Path(args.state).read_text()))
    Path(args.output).write_text(json.dumps({'peers': peers}, indent=2) + '\n')
    print('연결 대상: ' + ', '.join(sorted(peers)))
    if 'prod' not in peers:
        print('prod BFF 미준비: dev 연결만 생성. prod 준비 후 develop 배포를 다시 실행하세요.')


if __name__ == '__main__':
    main()
