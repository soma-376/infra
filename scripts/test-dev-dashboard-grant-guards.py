#!/usr/bin/env python3
"""DB 연결 없이 과다 권한·SQL delimiter 회귀를 검증한다."""
import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('grants', Path(__file__).with_name('dev-dashboard-read-grants.py'))
grants = importlib.util.module_from_spec(spec)
spec.loader.exec_module(grants)


class GuardTests(unittest.TestCase):
    def setUp(self):
        self.state = {'roles': [[10,grants.SOURCE,False,True,False,False,True,False],
                              [11,grants.CACHE,False,True,False,False,True,False],
                              [12,'enrollment',False,True,False,False,True,False]],
            'memberships': [], 'acl': [], 'default_grants': [], 'columns': [],
            'schemas': [[20,'enrollment',12],[21,'telemetry_ops',12],[22,'dashboard_cache',11]],
            'checks': [[list(k),False] for k in grants.required('enrollment')]}

    def reject(self, mutated):
        with self.assertRaises(ValueError):
            grants.validate(mutated, 'enrollment')

    def test_missing_permissions_are_planned(self):
        self.assertEqual(53, len(grants.validate(self.state, 'enrollment')))

    def test_membership_even_without_inherit_is_rejected(self):
        state = copy.deepcopy(self.state)
        state['roles'][0][3] = False
        state['memberships'] = [{'roleid':99,'member':10,'inherit_option':False,'set_option':True}]
        self.reject(state)

    def test_cache_membership_is_rejected(self):
        state = copy.deepcopy(self.state)
        state['memberships'] = [{'roleid':99,'member':11}]
        self.reject(state)

    def test_allowed_select_with_grant_option_is_rejected(self):
        state = copy.deepcopy(self.state)
        state['acl'] = [['table','enrollment.teams','',12,10,'SELECT',True]]
        self.reject(state)

    def test_future_source_default_select_is_rejected(self):
        state = copy.deepcopy(self.state)
        state['default_grants'] = [[12,20,'r',12,10,'SELECT',False]]
        self.reject(state)

    def test_global_public_default_select_is_rejected(self):
        state = copy.deepcopy(self.state)
        state['default_grants'] = [[12,0,'r',12,0,'SELECT',False]]
        self.reject(state)

    def test_database_grant_option_is_rejected(self):
        state = copy.deepcopy(self.state)
        state['acl'] = [['database','controlplane','',12,10,'CONNECT',True]]
        self.reject(state)

    def test_source_future_cache_select_is_rejected(self):
        state = copy.deepcopy(self.state)
        state['default_grants'] = [[11,22,'r',11,10,'SELECT',False]]
        self.reject(state)

    def test_public_future_cache_select_is_rejected(self):
        state = copy.deepcopy(self.state)
        state['default_grants'] = [[11,22,'r',11,0,'SELECT',False]]
        self.reject(state)

    def test_cache_source_default_select_is_rejected(self):
        state = copy.deepcopy(self.state)
        state['default_grants'] = [[12,21,'r',12,11,'SELECT',False]]
        self.reject(state)

    def test_vendor_ciphertext_access_is_rejected(self):
        state = copy.deepcopy(self.state)
        state['checks'].append([[grants.SOURCE,'column','enrollment.vendor_connections','credential_ciphertext','SELECT'],True])
        self.reject(state)

    def test_legacy_password_schema_is_rejected(self):
        state = copy.deepcopy(self.state)
        state['columns'] = [[1,1,'enrollment.members','password_hash',25]]
        self.reject(state)

    def test_delimiter_is_absent_from_block_body(self):
        import re
        hostile = "$guard$ $check$ $proj262$ $proj262_x$ '; RAISE EXCEPTION 'oops'; --"
        sql = grants.transaction('SELECT NULL', {'executor':hostile}, [], [grants.predicate((hostile,'schema','enrollment','','USAGE'))])
        blocks = re.findall(r'DO (\$[a-z0-9_]+\$) (.*?) \1;', sql, flags=re.DOTALL)
        self.assertEqual(2, len(blocks))
        for delimiter, body in blocks:
            self.assertNotIn(delimiter, body)


if __name__ == '__main__':
    unittest.main()
