"""실제 서비스 연결 없이 관측 불명·계약 위반·freshness·자격 경계를 검증한다."""
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from snapshot import Failed, Unknown, SPCS, Sources, canonical, digest, mounted_versions, schema_fingerprint, validate_migrations, selected_secret_versions
from strict_yaml import parse as parse_yaml
from verify import Verifier, receipt, validate_inputs, validate_vector, validate_exporter
from oidc import LoginForm


class VerificationTests(unittest.TestCase):
    def binding_contract(self):
        compat = {'postgres': {}, 'clickhouse': {}, 'envelope': {'version': 1, 'schemaSha256': 'a' * 64}, 'assetsLockSha256': 'b' * 64}
        contract = canonical({'schemaVersion': 1, 'app': 'enrollment-api', 'backendCommit': 'c' * 40,
                              'compatibility': compat, 'compatibilitySha256': hashlib.sha256(canonical(compat) + b'\n').hexdigest()}) + b'\n'
        binding = {'schemaVersion': 1, 'stage': 'enrollment-api', 'operationNonce': 'a' * 32, 'infraCommit': 'd' * 40,
                   'imageDigest': 'sha256:' + 'e' * 64, 'bundleManifestSha256': 'f' * 64,
                   'contractSha256': hashlib.sha256(contract).hexdigest()}
        return binding, contract

    def test_contract_bytes_and_app_binding_are_exact(self):
        binding, contract = self.binding_contract()
        self.assertEqual(validate_inputs(binding, contract, {'schemaVersion': 1})['app'], 'enrollment-api')
        for bad in (contract.rstrip(), contract.replace(b'enrollment-api', b'dashboard-api')):
            with self.assertRaisesRegex(Unknown, 'contract_hash_mismatch'):
                validate_inputs(binding, bad, {'schemaVersion': 1})
        other = {**binding, 'stage': 'dashboard-api'}
        with self.assertRaisesRegex(Unknown, 'contract_app_mismatch'):
            validate_inputs(other, contract, {'schemaVersion': 1})

    def test_flyway_unknown_failed_success_and_signed_checksums(self):
        row = {'version': '2', 'script': 'V2__x.sql', 'checksum': -123}
        validate_migrations({'enrollment': [{**row, 'success': True}]}, {'enrollment': [row]}, ['enrollment'])
        for change in ({'checksum': 123}, {'success': False}, {'version': '3'}):
            with self.assertRaises(Failed):
                validate_migrations({'enrollment': [{**row, 'success': True, **change}]}, {'enrollment': [row]}, ['enrollment'])

    def test_actual_catalog_changes_change_schema_fingerprint(self):
        class Catalog:
            changed = False
            def pg(self, query):
                return [{'kind': 'column', 'identity': 'enrollment.t.1', 'definition': ['a', 'bigint' if self.changed else 'integer']}] if 'pg_attribute' in query else []
            def ch(self, *args):
                return [{'name': 'telemetry_events', 'create_table_query': 'CREATE TABLE telemetry_events (x Int64)'}]
            config = {'clickhouse': {'database': 'default'}}
        source = Catalog()
        first = schema_fingerprint(source)
        source.changed = True
        self.assertNotEqual(first, schema_fingerprint(source))

    def series(self, value=5, stamp=None, count=6):
        stamp = stamp or time.time()
        return [{'metric': {'topic': 'main', 'job': 'exporter', 'instance': 'one', 'partition': str(i)}, 'value': [stamp, str(value)]} for i in range(count)]

    def test_offset_vector_requires_all_fresh_partitions_and_same_exporter(self):
        now = time.time()
        vector, instance = validate_vector(self.series(), self.series(now), partitions=6, fresh_after=now - 1)
        self.assertEqual(vector, dict.fromkeys(range(6), 5))
        self.assertEqual(instance, 'one')
        cases = [(self.series(count=5), self.series(now)), (self.series(), self.series(now - 10)),
                 (self.series(-1), self.series(now))]
        for values, timestamps in cases:
            with self.assertRaises(Unknown):
                validate_vector(values, timestamps, partitions=6, fresh_after=now - 1)
        with self.assertRaisesRegex(Unknown, 'exporter_changed'):
            validate_vector(self.series(), self.series(now), partitions=6, fresh_after=now - 1, expected_instance='two')

    def test_exporter_up_and_partition_count_must_be_fresh_and_unambiguous(self):
        now = time.time()
        self.assertEqual(validate_exporter(self.series(6, count=1), self.series(now, count=1), now - 1), (6, 'one'))
        for values, stamps in [(self.series(0, count=1), self.series(now, count=1)),
                               (self.series(1, count=1), self.series(now - 10, count=1)),
                               (self.series(1, count=2), self.series(now, count=2))]:
            with self.assertRaises(Unknown):
                validate_exporter(values, stamps, now - 1, expect_up=True)

    def test_pod_mounted_versions_bind_uid_and_reject_missing_or_mixed_versions(self):
        pod = {'metadata': {'uid': 'p1'}, 'spec': {'volumes': [{'csi': {'volumeAttributes': {'secretProviderClass': spc}}} for spc in SPCS]}}
        statuses = [{'metadata': {'ownerReferences': [{'kind': 'Pod', 'uid': 'p1'}]},
                     'status': {'mounted': True, 'podName': 'pod1', 'secretProviderClassName': spc,
                                'objects': [{'id': 'secret-a', 'version': 'version-1'}]}} for spc in SPCS]
        self.assertEqual(set(mounted_versions({'pod1': pod}, statuses)), set(SPCS))
        for bad in (statuses[:-1], [*statuses, statuses[0]]):
            with self.assertRaises(Unknown):
                mounted_versions({'pod1': pod}, bad)
        statuses[0]['metadata']['ownerReferences'][0]['uid'] = 'old-pod'
        with self.assertRaisesRegex(Unknown, 'unbound'):
            mounted_versions({'pod1': pod}, statuses)

    def test_metadata_full_secret_fallback_is_rejected(self):
        with patch.dict(os.environ, {'VERIFIER_KUBERNETES_PROXY_URL': 'http://127.0.0.1:1234'}), patch('snapshot.http', return_value=(200, b'{"kind":"Secret","data":{"token":"sensitive"}}', {})):
            with self.assertRaisesRegex(Unknown, 'metadata_only'):
                Sources({}, {}).kube('/api/v1/namespaces/pulsemetry-dev/secrets/test', metadata=True)

    def test_proxy_external_origin_is_rejected(self):
        with patch.dict(os.environ, {'VERIFIER_KUBERNETES_PROXY_URL': 'http://attacker.example:1234'}):
            with self.assertRaisesRegex(Unknown, 'loopback'):
                Sources({}, {}).kube('/api/v1/namespaces/pulsemetry-dev/pods')

    def test_missing_credentials_emit_sanitized_unknown_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            binding, contract = self.binding_contract()
            (root / 'binding.json').write_bytes(canonical(binding))
            (root / 'contract.json').write_bytes(contract)
            (root / 'config.json').write_text('{"schemaVersion":1}')
            result = subprocess.run([sys.executable, str(Path(__file__).with_name('verify.py')), '--input-dir', directory,
                                     '--probe-file', str(root / 'missing.json'), '--termination-file', str(root / 'termination')], capture_output=True)
            self.assertEqual(result.returncode, 2)
            self.assertEqual(result.stderr, b'')
            record = json.loads((root / 'termination').read_bytes())
            self.assertEqual(record['result'], 'unknown')
            self.assertLess(len((root / 'termination').read_bytes()), 4096)
            self.assertEqual(record['operationNonce'], binding['operationNonce'])

    def test_receipt_is_bounded_and_hashes_only_sanitized_evidence(self):
        binding, _ = self.binding_contract()
        evidence = {key: 'a' * 64 for key in ('schemaFingerprint', 'runtimeFingerprint', 'keyTlsFingerprint', 'envelopeFingerprint')}
        raw = receipt(binding, 'passed', ['flyway_history_checksums'], evidence, 'all_checks_passed')
        self.assertLess(len(raw), 4096)
        self.assertEqual(json.loads(raw)['evidenceSha256'], digest(evidence))

    def test_hosted_login_form_extracts_hidden_csrf_without_execution(self):
        parser = LoginForm()
        parser.feed('<form method="post" action="/login"><input type="hidden" name="_csrf" value="opaque"><input name="username"><input name="password" type="password"></form>')
        self.assertEqual(parser.forms[0]['fields'], {'_csrf': 'opaque'})
        self.assertEqual(parser.forms[0]['names'], {'_csrf', 'username', 'password'})

    def test_yaml_duplicate_keys_and_aliases_are_rejected(self):
        for text in ('key: first\nkey: second', 'key: &shared [a]\nother: *shared', 'object: !!python/object/new:tuple []'):
            with self.assertRaises(Exception):
                parse_yaml(text)

    def test_aws_current_version_must_match_original_and_jmespath_mounted_aliases(self):
        arn = 'arn:aws:secretsmanager:ap-northeast-2:111111111111:secret:fixture-abcdef'
        first, second = 'a' * 32, 'b' * 32
        class Metadata:
            current = first
            def describe_secret(self, name):
                self_name = name
                return {'ARN': self_name, 'VersionIdsToStages': {first: ['AWSCURRENT'] if self.current == first else ['AWSPREVIOUS'], second: ['AWSCURRENT'] if self.current == second else ['AWSPENDING']}}
        source = Metadata()
        spec = {'provider': 'aws', 'parameters': {'objects': '- objectName: "' + arn + '"\n  objectType: secretsmanager\n  objectAlias: _source\n  jmesPath:\n    - path: username\n      objectAlias: DB_USERNAME\n    - path: password\n      objectAlias: DB_PASSWORD\n'}}
        mounted = {'fixture': [{'id': alias, 'version': first} for alias in ['_source', 'DB_USERNAME', 'DB_PASSWORD']]}
        selected = selected_secret_versions(source, {'fixture': spec}, mounted)
        self.assertEqual(selected['fixture'][0]['versionId'], first)
        source.current = second
        with self.assertRaisesRegex(Unknown, 'selected_secret_version_not_mounted'):
            selected_secret_versions(source, {'fixture': spec}, mounted)
        # 고정 VersionId는 AWSCURRENT 교체와 독립적이다. 실제 고정 원본의 존재·mount는 계속 확인한다.
        spec['parameters']['objects'] += '  objectVersion: "' + first + '"\n'
        self.assertEqual(selected_secret_versions(source, {'fixture': spec}, mounted)['fixture'][0]['versionId'], first)
        mounted['fixture'][0]['version'] = second
        with self.assertRaisesRegex(Unknown, 'selected_secret_version_not_mounted'):
            selected_secret_versions(source, {'fixture': spec}, mounted)


if __name__ == '__main__':
    unittest.main()
