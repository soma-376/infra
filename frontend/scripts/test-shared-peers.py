#!/usr/bin/env python3
"""AWS 없이 discovery의 오인식·기존 peer 삭제 방어를 검사한다."""
import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('shared_peers', Path(__file__).with_name('shared-peers.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def fixture(prod=True, duplicates=False, missing_route=False):
    def query(operation, **filters):
        env = filters['tag:Env']
        name = filters['tag:Name']
        if operation == 'describe-vpcs':
            records = [{'VpcId': 'vpc-' + env}]
            if env == 'prod' and not prod:
                records = []
            if duplicates:
                records *= 2
            return {'Vpcs': records}
        if operation == 'describe-security-groups':
            assert name == f'soma-376-frontend-{env}-app'
            return {'SecurityGroups': [{'GroupId': 'sg-' + env}]}
        return {'RouteTables': [] if missing_route else [{'RouteTableId': 'rtb-' + name}]}
    return query


class DiscoveryTests(unittest.TestCase):
    def test_both_environments(self):
        peers = m.discover(fixture())
        self.assertEqual(set(peers), {'dev', 'prod'})
        self.assertEqual(len(peers['prod']['route_table_ids']), 2)
        self.assertEqual(peers['dev']['security_group_id'], 'sg-dev')

    def test_prod_not_yet_created(self):
        self.assertEqual(set(m.discover(fixture(prod=False))), {'dev'})

    def test_duplicates_fail(self):
        with self.assertRaises(ValueError):
            m.discover(fixture(duplicates=True))

    def test_missing_route_fails(self):
        with self.assertRaises(ValueError):
            m.discover(fixture(missing_route=True))

    def test_existing_prod_never_silently_removed(self):
        state = {'values': {'root_module': {'resources': [{'type': 'aws_vpc_peering_connection', 'name': 'app', 'index': 'prod'}]}}}
        with self.assertRaises(ValueError):
            m.guard_existing({'dev': {}}, state)

    def test_empty_state(self):
        m.guard_existing({'dev': {}}, {'format_version': '1.0'})


if __name__ == '__main__':
    unittest.main()
