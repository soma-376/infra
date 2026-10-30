"""정리의 소유권·기한·재진입·삭제 순서를 AWS 호출 없이 검증한다."""
import datetime as dt
import importlib.util
import json
import io
from pathlib import Path
import unittest
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('perf_cleanup_driver', ROOT / 'lib/perf/cleanup/driver.py')
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)
ENV = 'perf-unit-cleanup'
ACCOUNT = '111111111111'
BASE = dt.datetime(2026, 11, 1, tzinfo=dt.timezone.utc)
CONFIG = {'environment_id': ENV, 'account': ACCOUNT, 'region': 'ap-northeast-2', 'state_parameter': '/soma-376/perf/' + ENV + '/cleanup-state', 'document_name': 'soma-376-perf-cleanup'}


class AwsError(Exception):
    def __init__(self, code, message='missing'):
        super().__init__(message)
        self.response = {'Error': {'Code': code}}


def stack(name, **overrides):
    return {'StackName': name, 'StackId': 'arn:aws:cloudformation:ap-northeast-2:' + ACCOUNT + ':stack/' + name + '/id', 'StackStatus': 'CREATE_COMPLETE', 'CreationTime': BASE, 'RoleARN': 'arn:aws:iam::' + ACCOUNT + ':role/cdk-cfn-exec', 'Tags': [{'Key': driver.OWNER, 'Value': ENV}], 'Outputs': [], **overrides}


class CleanupTests(unittest.TestCase):
    def setUp(self):
        silent = patch('builtins.print')
        silent.start()
        self.addCleanup(silent.stop)

    def setup_cleaner(self, hours=1, stacks=None, state=None):
        clients = {name: MagicMock(name=name) for name in ['cloudformation', 'ssm', 'ecr', 'ec2', 'eks', 's3']}
        existing = {'PerfGuardrailStack': stack('PerfGuardrailStack'), **(stacks or {})}
        def describe(StackName):
            if StackName not in existing:
                raise AwsError('ValidationError', 'Stack does not exist')
            return {'Stacks': [existing[StackName]]}
        clients['cloudformation'].describe_stacks.side_effect = describe
        clients['cloudformation'].get_paginator.return_value.paginate.return_value = [{'StackResourceSummaries': []}]
        if state:
            clients['ssm'].get_parameter.return_value = {'Parameter': {'Value': json.dumps(state)}}
        else:
            clients['ssm'].get_parameter.side_effect = AwsError('ParameterNotFound')
        clients['ecr'].describe_repositories.side_effect = AwsError('RepositoryNotFoundException')
        clients['ec2'].get_paginator.return_value.paginate.return_value = [{'Reservations': [], 'Volumes': []}]
        clients['s3'].get_bucket_tagging.return_value = {'TagSet': [{'Key': driver.OWNER, 'Value': ENV}]}
        clients['s3'].list_multipart_uploads.return_value = {}
        clients['s3'].list_object_versions.return_value = {}
        return driver.Cleaner(clients, CONFIG, BASE.timestamp() + hours * 3600), clients

    def test_before_22h_does_not_delete(self):
        c, a = self.setup_cleaner()
        result = c.tick()
        self.assertEqual(result['phase'], 'WAITING')
        for method in [a['cloudformation'].delete_stack, a['ecr'].delete_repository, a['ec2'].terminate_instances]:
            method.assert_not_called()

    def test_22h_cleanup_starts_and_24h_only_changes_breach_state(self):
        for hours, breach in [(22, False), (24, True)]:
            c, a = self.setup_cleaner(hours=hours)
            result = c.tick()
            self.assertEqual(result['phase'], 'SELF_DELETE_REQUESTED')
            self.assertEqual(result['deadline_exceeded'], breach)
            self.assertIn('PerfGuardrailStack/', a['cloudformation'].delete_stack.call_args.kwargs['StackName'])

    def test_update_cannot_extend_earliest_creation(self):
        c, _ = self.setup_cleaner(hours=1, state={'version': 1, 'environment_id': ENV, 'created_epoch': BASE.timestamp() - 23 * 3600})
        result = c.tick()
        self.assertEqual(result['created_epoch'], BASE.timestamp() - 23 * 3600)
        self.assertTrue(result['deadline_exceeded'])

    def test_stack_wrong_owner_or_account_refuses_all_delete(self):
        for changed in [{'Tags': [{'Key': driver.OWNER, 'Value': 'dev'}]}, {'StackId': 'arn:aws:cloudformation:ap-northeast-2:222222222222:stack/PerfDataStack/id'}]:
            c, a = self.setup_cleaner(hours=22, stacks={'PerfDataStack': stack('PerfDataStack', **changed)})
            self.assertEqual(c.tick()['phase'], 'ERROR')
            a['cloudformation'].delete_stack.assert_not_called()

    def test_new_ecr_earlier_created_at_anchors_ttl_and_force_removes_images(self):
        c, a = self.setup_cleaner(hours=1)
        def repos(repositoryNames):
            name = repositoryNames[0]
            return {'repositories': [{'repositoryArn': 'arn:aws:ecr:ap-northeast-2:' + ACCOUNT + ':repository/' + name, 'createdAt': BASE - dt.timedelta(hours=22)}]}
        a['ecr'].describe_repositories.side_effect = repos
        a['ecr'].list_tags_for_resource.return_value = {'tags': [{'Key': driver.OWNER, 'Value': ENV}]}
        result = c.tick()
        self.assertEqual(result['phase'], 'RESIDUALS')
        self.assertEqual(a['ecr'].delete_repository.call_count, 2)
        self.assertTrue(all(call.kwargs['force'] for call in a['ecr'].delete_repository.call_args_list))
        a['cloudformation'].delete_stack.assert_not_called()

    def test_shared_ecr_with_same_name_is_not_adopted(self):
        c, a = self.setup_cleaner(hours=22)
        a['ecr'].describe_repositories.side_effect = None
        a['ecr'].describe_repositories.return_value = {'repositories': [{'repositoryArn': 'arn:aws:ecr:ap-northeast-2:' + ACCOUNT + ':repository/' + driver.REPOSITORIES[0], 'createdAt': BASE}]}
        a['ecr'].list_tags_for_resource.return_value = {'tags': []}
        self.assertIn('ownership_mismatch', c.tick()['error'])
        a['ecr'].delete_repository.assert_not_called()
        a['cloudformation'].delete_stack.assert_not_called()

    def test_stack_order_and_retry_delete_failed(self):
        for status in ['CREATE_COMPLETE', 'DELETE_FAILED']:
            c, a = self.setup_cleaner(hours=22, stacks={name: stack(name, StackStatus=status) for name in ['PerfEdgeStack', 'PerfDataStack']})
            c.tick()
            self.assertIn('PerfEdgeStack/', a['cloudformation'].delete_stack.call_args.kwargs['StackName'])
            self.assertEqual(a['cloudformation'].delete_stack.call_count, 1)

    def test_in_progress_waits_without_double_delete(self):
        c, a = self.setup_cleaner(hours=22, stacks={'PerfDataStack': stack('PerfDataStack', StackStatus='DELETE_IN_PROGRESS')})
        self.assertEqual(c.tick()['waiting_stack'], 'PerfDataStack')
        a['cloudformation'].delete_stack.assert_not_called()

    def test_eks_without_relay_does_not_skip_kubernetes(self):
        c, a = self.setup_cleaner(hours=22, stacks={'PerfEksStack': stack('PerfEksStack')})
        self.assertEqual(c.tick()['error'], 'eks_exists_without_cleanup_relay')
        a['cloudformation'].delete_stack.assert_not_called()

    def test_ssm_retry_waits_for_success_and_complete_before_cfn(self):
        eks = stack('PerfEksStack', Outputs=[{'OutputKey': 'EksRelayInstanceId', 'OutputValue': 'i-owned'}])
        state = {'version': 1, 'environment_id': ENV, 'command_id': 'old'}
        for status in ['InProgress', 'Success', 'Failed']:
            c, a = self.setup_cleaner(hours=22, stacks={'PerfEksStack': eks}, state=state)
            a['ec2'].describe_instances.return_value = {'Reservations': [{'Instances': [{'InstanceId': 'i-owned', 'State': {'Name': 'running'}, 'Tags': [{'Key': driver.OWNER, 'Value': ENV}]}]}]}
            a['ssm'].get_command_invocation.return_value = {'Status': status, 'StandardOutputContent': json.dumps({'environment_id': ENV, 'complete': True})}
            result = c.tick()
            self.assertEqual(a['cloudformation'].delete_stack.called, status == 'Success')
            if status == 'Failed':
                self.assertEqual(result['phase'], 'ERROR')
                self.assertNotIn('command_id', result)

    def test_bucket_versions_delete_markers_multipart_and_errors(self):
        c, a = self.setup_cleaner()
        name = 'perfevidencestack-owned'
        a['s3'].list_multipart_uploads.return_value = {'Uploads': [{'Key': 'pending', 'UploadId': 'u'}], 'IsTruncated': True}
        a['s3'].list_object_versions.return_value = {'Versions': [{'Key': 'a', 'VersionId': '1'}], 'DeleteMarkers': [{'Key': 'a', 'VersionId': '2'}], 'IsTruncated': True}
        a['s3'].delete_objects.return_value = {}
        self.assertTrue(c.empty_bucket(name, delete=True))
        self.assertEqual(a['s3'].delete_objects.call_args.kwargs['Delete']['Objects'], [{'Key': 'a', 'VersionId': '1'}, {'Key': 'a', 'VersionId': '2'}])
        a['s3'].abort_multipart_upload.assert_called_once()
        a['s3'].delete_bucket.assert_not_called()
        a['s3'].delete_objects.return_value = {'Errors': [{'Code': 'AccessDenied'}]}
        with self.assertRaisesRegex(ValueError, 'delete_objects_failed'):
            c.empty_bucket(name)

    def test_bucket_wrong_owner_no_delete_and_empty_owned_can_delete(self):
        c, a = self.setup_cleaner()
        a['s3'].get_bucket_tagging.return_value = {'TagSet': []}
        with self.assertRaisesRegex(ValueError, 'ownership'):
            c.empty_bucket('perfevidencestack-owned', True)
        a['s3'].delete_bucket.assert_not_called()
        a['s3'].get_bucket_tagging.return_value = {'TagSet': [{'Key': driver.OWNER, 'Value': ENV}]}
        c.empty_bucket('perfevidencestack-owned', True)
        a['s3'].delete_bucket.assert_called_once()

    def test_volume_and_instances_pages_are_fully_consumed_and_attached_volume_waits(self):
        c, a = self.setup_cleaner()
        inst = MagicMock(); vol = MagicMock()
        a['ec2'].get_paginator.side_effect = lambda name: inst if name == 'describe_instances' else vol
        inst.paginate.return_value = [{'Reservations': []}, {'Reservations': [{'Instances': [{'InstanceId': 'i-last-page', 'Tags': [{'Key': driver.OWNER, 'Value': ENV}], 'State': {'Name': 'running'}}]}]}]
        vol.paginate.return_value = [{'Volumes': [{'VolumeId': 'v-1', 'Tags': [{'Key': driver.OWNER, 'Value': ENV}], 'State': 'in-use', 'Attachments': [{}]}]}, {'Volumes': [{'VolumeId': 'v-2', 'Tags': [{'Key': driver.OWNER, 'Value': ENV}], 'State': 'available', 'Attachments': []}]}]
        self.assertEqual(c.volumes_and_instances(), ['i-last-page', 'v-1', 'v-2'])
        a['ec2'].delete_volume.assert_called_once_with(VolumeId='v-2')
        a['ec2'].terminate_instances.assert_called_once_with(InstanceIds=['i-last-page'])

    def test_errors_are_saved_and_never_include_aws_message(self):
        c, a = self.setup_cleaner(hours=22)
        a['cloudformation'].delete_stack.side_effect = AwsError('AccessDenied', 'private response content')
        result = c.tick()
        self.assertEqual(result['error'], 'AwsError:AccessDenied')
        self.assertNotIn('private response', json.dumps(result))
        self.assertTrue(a['ssm'].put_parameter.called)


    def test_cloudformation_without_service_role_is_refused(self):
        c, a = self.setup_cleaner(hours=22, stacks={'PerfDataStack': stack('PerfDataStack', RoleARN='')})
        self.assertEqual(c.tick()['error'], 'cloudformation_service_role_required:PerfDataStack')
        a['cloudformation'].delete_stack.assert_not_called()

    def test_failure_after_budget_expiry_records_retry_without_deleting(self):
        c, a = self.setup_cleaner(hours=22)
        c.stop_at = 0
        self.assertEqual(c.tick()['error'], 'operation_budget_exhausted_retry')
        a['cloudformation'].delete_stack.assert_not_called()

    def test_incomplete_stack_bucket_inventory_uses_all_resource_pages(self):
        c, a = self.setup_cleaner(stacks={'PerfDataStack': stack('PerfDataStack', StackStatus='CREATE_FAILED')})
        a['cloudformation'].get_paginator.return_value.paginate.return_value = [
            {'StackResourceSummaries': []}, {'StackResourceSummaries': [{'ResourceType': 'AWS::S3::Bucket', 'PhysicalResourceId': 'perfdatastack-partial'}]}]
        self.assertEqual(c.tick()['buckets'], ['perfdatastack-partial'])

    def test_kubernetes_helper_checks_cluster_owner_before_token_or_http(self):
        spec = importlib.util.spec_from_file_location('perf_cleanup_kubernetes', ROOT / 'lib/perf/cleanup/kubernetes.py')
        helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(helper)
        with patch.object(helper, 'aws', return_value={'cluster': {'tags': {driver.OWNER: 'dev'}}}) as aws, patch.object(helper.urllib.request, 'urlopen') as http:
            with self.assertRaisesRegex(ValueError, 'ownership_mismatch'):
                helper.cleanup(ENV)
            self.assertEqual(aws.call_count, 1)
            http.assert_not_called()



    def test_pdb_is_removed_only_after_data_cleanup_and_before_final_nodepool(self):
        spec = importlib.util.spec_from_file_location('perf_cleanup_kubernetes_pdb', ROOT / 'lib/perf/cleanup/kubernetes.py')
        helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(helper)
        calls = []
        def http(req, **kwargs):
            calls.append((req.method, req.full_url))
            result = {'items': []}
            if req.full_url.endswith('/poddisruptionbudgets?limit=100'):
                result = {'items': [{'metadata': {'name': 'coredns', 'namespace': 'kube-system'}}]}
            return io.BytesIO(json.dumps(result).encode())
        responses = [{'cluster': {'tags': {driver.OWNER: ENV}, 'certificateAuthority': {'data': 'Y2E='}, 'endpoint': 'https://private.example'}}, {'status': {'token': 'not-printed'}}]
        with patch.object(helper, 'aws', side_effect=responses), patch.object(helper.ssl, 'create_default_context'), patch.object(helper.urllib.request, 'urlopen', side_effect=http):
            self.assertFalse(helper.cleanup(ENV))
        self.assertIn(('DELETE', 'https://private.example/apis/policy/v1/namespaces/kube-system/poddisruptionbudgets/coredns'), calls)
        self.assertTrue(any('persistentvolumes' in url for _, url in calls))
        self.assertFalse(any('/nodepools' in url for _, url in calls))


if __name__ == '__main__':
    unittest.main()
