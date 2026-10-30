#!/usr/bin/env python3
import importlib.util
from pathlib import Path
import unittest
import sys
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('plan_digest', Path(__file__).with_name('bootstrap-plan-digest.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PlanDigestTest(unittest.TestCase):
    def test_only_timestamp_is_ignored(self):
        self.assertEqual(module.digest({'timestamp': 'a', 'resource_changes': [1]}), module.digest({'resource_changes': [1], 'timestamp': 'b'}))

    def test_changed_resource_or_baseline_requires_new_approval(self):
        base = {'resource_changes': [1], 'prior_state': {'values': 'before'}, 'variables': {'input': 'a'}}
        for key, value in [('resource_changes', [2]), ('prior_state', {'values': 'after'}), ('variables', {'input': 'b'})]:
            self.assertNotEqual(module.digest(base), module.digest(dict(base, **{key: value})))


if __name__ == '__main__':
    unittest.main()
