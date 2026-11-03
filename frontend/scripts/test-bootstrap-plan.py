#!/usr/bin/env python3
import importlib.util
import copy
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

    def test_reference_order_is_ignored_without_mutating_input(self):
        references = [
            {'resource': 'terraform_data.b', 'attribute': ['output']},
            {'resource': 'terraform_data.a', 'attribute': ['output']},
        ]
        base = {'relevant_attributes': references}
        original = copy.deepcopy(base)
        self.assertEqual(module.digest(base), module.digest({'relevant_attributes': references[::-1]}))
        self.assertEqual(base, original)

    def test_changed_reference_or_attribute_path_requires_new_approval(self):
        base = {'relevant_attributes': [{'resource': 'a', 'attribute': ['x', 'y']}]}
        for reference in [
            {'resource': 'b', 'attribute': ['x', 'y']},
            {'resource': 'a', 'attribute': ['y', 'x']},
        ]:
            self.assertNotEqual(module.digest(base), module.digest({'relevant_attributes': [reference]}))
        self.assertNotEqual(module.digest(base), module.digest({'relevant_attributes': []}))

    def test_resource_value_and_action_order_remain_significant(self):
        for key, first, second in [
            ('after', {'items': ['a', 'b']}, {'items': ['b', 'a']}),
            ('actions', ['delete', 'create'], ['create', 'delete']),
        ]:
            self.assertNotEqual(
                module.digest({'resource_changes': [{'change': {key: first}}]}),
                module.digest({'resource_changes': [{'change': {key: second}}]}),
            )


if __name__ == '__main__':
    unittest.main()
