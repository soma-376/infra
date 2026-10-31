"""정리의 소유권·기한·재진입·삭제 순서를 AWS 호출 없이 검증한다."""
import datetime as dt
import importlib.util
import json
import io
from pathlib import Path
import unittest
import urllib.parse
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('perf_cleanup_driver', ROOT / 'lib/perf/cleanup/driver.py')
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)
ENV = 'perf-unit-cleanup'
ACCOUNT = '111111111111'
NODE_ROLE = 'PerfEksStack-NodeRoleB5643E21-unit'
NODE_ROLE_OUTPUTS = [{'OutputKey': 'EksNodeRoleName', 'OutputValue': NODE_ROLE},
                     {'OutputKey': 'EksNodeRoleArn', 'OutputValue': 'arn:aws:iam::' + ACCOUNT + ':role/' + NODE_ROLE}]
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
        clients = {name: MagicMock(name=name) for name in ['cloudformation', 'ssm', 'ecr', 'ec2', 'eks', 's3', 'iam']}
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
        clients['ec2'].get_paginator.return_value.paginate.return_value = [{'Reservations': [], 'Volumes': [], 'LaunchTemplates': []}]
        clients['ec2'].meta.service_model.operation_model.return_value.input_shape.members = {
            'IncludeManagedResources': type('BooleanShape', (), {'type_name': 'boolean'})()}
        clients['iam'].get_paginator.return_value.paginate.return_value = [{'InstanceProfiles': []}]
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
        eks = stack('PerfEksStack', Outputs=NODE_ROLE_OUTPUTS + [{'OutputKey': 'EksRelayInstanceId', 'OutputValue': 'i-owned'}])
        state = {'version': 1, 'environment_id': ENV, 'command_id': 'old'}
        for status in ['InProgress', 'Success', 'Failed']:
            c, a = self.setup_cleaner(hours=22, stacks={'PerfEksStack': eks}, state=state)
            a['ec2'].describe_instances.return_value = {'Reservations': [{'Instances': [{'InstanceId': 'i-owned', 'State': {'Name': 'running'}, 'Tags': [{'Key': driver.OWNER, 'Value': ENV}]}]}]}
            a['ssm'].get_command_invocation.return_value = {'Status': status, 'StandardOutputContent': json.dumps({'environment_id': ENV, 'complete': True, 'cleanup_contract': 2, 'node_role_name': NODE_ROLE})}
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
            self.assertFalse(helper.cleanup(ENV, NODE_ROLE))
        self.assertIn(('DELETE', 'https://private.example/apis/policy/v1/namespaces/kube-system/poddisruptionbudgets/coredns'), calls)
        self.assertTrue(any('persistentvolumes' in url for _, url in calls))
        self.assertFalse(any('/nodepools' in url for _, url in calls))

    def test_auto_mode_residual_pages_block_stack_delete_until_both_empty(self):
        for profiles, templates in [(1, 0), (0, 1), (0, 0)]:
            with self.subTest(profiles=profiles, templates=templates):
                c, a = self.setup_cleaner(hours=22, stacks={'PerfEksStack': stack('PerfEksStack', Outputs=NODE_ROLE_OUTPUTS)},
                                         state={'version': 1, 'environment_id': ENV, 'kubernetes_complete': True, 'kubernetes_cleanup_contract': 2})
                a['iam'].get_paginator.return_value.paginate.return_value = [{'InstanceProfiles': []}, {'InstanceProfiles': [{}] * profiles}]
                template = {'LaunchTemplateId': 'lt-owned', 'Tags': [{'Key': driver.OWNER, 'Value': ENV}, {'Key': 'eks:eks-cluster-name', 'Value': driver.CLUSTER}]}
                a['ec2'].get_paginator.return_value.paginate.return_value = [{'LaunchTemplates': []}, {'LaunchTemplates': [template] * templates}]
                result = c.tick()
                self.assertEqual(result['auto_mode_residual_counts'], {'instance_profiles': profiles, 'launch_templates': templates})
                self.assertEqual(a['cloudformation'].delete_stack.called, profiles == templates == 0)
                a['iam'].get_paginator.assert_called_once_with('list_instance_profiles_for_role')
                a['iam'].get_paginator.return_value.paginate.assert_called_once_with(RoleName=NODE_ROLE)
                a['ec2'].get_paginator.return_value.paginate.assert_called_once_with(Filters=[
                    {'Name': 'tag:' + driver.OWNER, 'Values': [ENV]},
                    {'Name': 'tag:eks:eks-cluster-name', 'Values': [driver.CLUSTER]}], IncludeManagedResources=True)
                a['iam'].delete_instance_profile.assert_not_called()
                a['iam'].remove_role_from_instance_profile.assert_not_called()
                a['ec2'].delete_launch_template.assert_not_called()

    def test_auto_mode_identity_and_query_errors_fail_closed(self):
        for fault in ['role', 'owner', 'cluster', 'query']:
            with self.subTest(fault=fault):
                outputs = NODE_ROLE_OUTPUTS if fault != 'role' else [{'OutputKey': 'EksNodeRoleName', 'OutputValue': 'DevEksStack-NodeRole-unit'}]
                c, a = self.setup_cleaner(hours=22, stacks={'PerfEksStack': stack('PerfEksStack', Outputs=outputs)},
                                         state={'version': 1, 'environment_id': ENV, 'kubernetes_complete': True, 'kubernetes_cleanup_contract': 2})
                if fault == 'query':
                    a['iam'].get_paginator.return_value.paginate.side_effect = AwsError('AccessDenied', 'private AWS detail')
                elif fault in ['owner', 'cluster']:
                    a['ec2'].get_paginator.return_value.paginate.return_value = [{'LaunchTemplates': [{'Tags': [
                        {'Key': driver.OWNER, 'Value': 'dev' if fault == 'owner' else ENV},
                        {'Key': 'eks:eks-cluster-name', 'Value': 'dev' if fault == 'cluster' else driver.CLUSTER}]}]}]
                result = c.tick()
                self.assertEqual(result['phase'], 'ERROR')
                self.assertNotIn('private AWS detail', result['error'])
                a['cloudformation'].delete_stack.assert_not_called()

    def test_hidden_managed_resources_prevent_false_completion(self):
        c, a = self.setup_cleaner(hours=22)
        def paginator(operation):
            value = MagicMock()
            def pages(**kwargs):
                if not kwargs.get('IncludeManagedResources'):
                    return [{'Reservations': [], 'Volumes': []}]
                if operation == 'describe_instances':
                    return [{'Reservations': [{'Instances': [{'InstanceId': 'i-managed', 'State': {'Name': 'shutting-down'},
                        'Tags': [{'Key': driver.OWNER, 'Value': ENV}]}]}]}]
                return [{'Volumes': [{'VolumeId': 'vol-managed', 'State': 'in-use', 'Attachments': [{}],
                    'Tags': [{'Key': driver.OWNER, 'Value': ENV}]}]}]
            value.paginate.side_effect = pages
            return value
        a['ec2'].get_paginator.side_effect = paginator
        result = c.tick()
        self.assertEqual(result['phase'], 'RESIDUALS')
        self.assertEqual(result['residual_counts']['ec2'], 2)
        a['cloudformation'].delete_stack.assert_not_called()
        a['ec2'].terminate_instances.assert_not_called()
        a['ec2'].delete_volume.assert_not_called()

    def test_hidden_launch_template_blocks_eks_and_role_deletion(self):
        c, a = self.setup_cleaner(hours=22, stacks={'PerfEksStack': stack('PerfEksStack', Outputs=NODE_ROLE_OUTPUTS)},
                                 state={'version': 1, 'environment_id': ENV, 'kubernetes_complete': True, 'kubernetes_cleanup_contract': 2})
        template = {'Tags': [{'Key': driver.OWNER, 'Value': ENV}, {'Key': 'eks:eks-cluster-name', 'Value': driver.CLUSTER}]}
        a['ec2'].get_paginator.return_value.paginate.side_effect = lambda **kw: [
            {'LaunchTemplates': [template] if kw.get('IncludeManagedResources') else []}]
        self.assertEqual(c.tick()['phase'], 'AUTO_MODE_FINALIZATION')
        a['cloudformation'].delete_stack.assert_not_called()
        a['ec2'].delete_launch_template.assert_not_called()

    def test_unsupported_sdk_fails_before_any_resource_mutation(self):
        for shape in [{}, {'IncludeManagedResources': type('WrongShape', (), {'type_name': 'string'})()}]:
            c, a = self.setup_cleaner(hours=22)
            a['ec2'].meta.service_model.operation_model.return_value.input_shape.members = shape
            result = c.tick()
            self.assertEqual(result['error'], 'managed_resource_visibility_sdk_unsupported')
            self.assertEqual(result['phase'], 'ERROR')
            a['cloudformation'].describe_stacks.assert_not_called()
            a['cloudformation'].delete_stack.assert_not_called()
            a['ec2'].get_paginator.assert_not_called()
            a['ssm'].put_parameter.assert_called_once()

    def test_sdk_probe_is_exact_environment_and_does_not_start_cleanup(self):
        _, clients = self.setup_cleaner()
        modules = {'boto3': SimpleNamespace(__version__='test-boto3', client=lambda name, **kw: clients[name]),
                   'botocore': SimpleNamespace(__version__='test-botocore'),
                   'botocore.config': SimpleNamespace(Config=lambda **kw: object())}
        with patch.dict('sys.modules', modules), patch.dict(driver.os.environ, {'CLEANUP_CONFIG': json.dumps(CONFIG)}), patch.object(driver, 'Cleaner') as cleaner:
            result = driver.handler({'action': 'sdk_capabilities', 'environment_id': ENV}, None)
            self.assertTrue(all(result['managed_resource_visibility'].values()))
            self.assertEqual(result['cloud_mutations'], 0)
            self.assertEqual(result['botocore'], 'test-botocore')
            cleaner.assert_not_called()
            with self.assertRaisesRegex(ValueError, 'unsupported_cleanup_event'):
                driver.handler({'action': 'sdk_capabilities', 'environment_id': 'dev'}, None)
            cleaner.assert_not_called()
        clients['ssm'].get_parameter.assert_not_called()
        clients['ssm'].put_parameter.assert_not_called()
        clients['ec2'].get_paginator.assert_not_called()

    def test_old_kubernetes_completion_is_not_reused_and_role_parameter_is_exact(self):
        eks = stack('PerfEksStack', Outputs=NODE_ROLE_OUTPUTS + [{'OutputKey': 'EksRelayInstanceId', 'OutputValue': 'i-owned'}])
        c, a = self.setup_cleaner(hours=22, stacks={'PerfEksStack': eks},
                                 state={'version': 1, 'environment_id': ENV, 'kubernetes_complete': True})
        a['ec2'].describe_instances.return_value = {'Reservations': [{'Instances': [{'State': {'Name': 'running'}, 'Tags': [{'Key': driver.OWNER, 'Value': ENV}]}]}]}
        a['ssm'].send_command.return_value = {'Command': {'CommandId': 'new'}}
        self.assertEqual(c.tick()['phase'], 'KUBERNETES')
        a['ssm'].send_command.assert_called_once_with(InstanceIds=['i-owned'], DocumentName=CONFIG['document_name'],
                                                    Parameters={'nodeRoleName': [NODE_ROLE]}, TimeoutSeconds=120)
        a['cloudformation'].delete_stack.assert_not_called()

    def test_old_or_wrong_role_helper_response_does_not_authorize_cfn_delete(self):
        eks = stack('PerfEksStack', Outputs=NODE_ROLE_OUTPUTS + [{'OutputKey': 'EksRelayInstanceId', 'OutputValue': 'i-owned'}])
        for additional in [{}, {'cleanup_contract': 2, 'node_role_name': 'wrong'}]:
            c, a = self.setup_cleaner(hours=22, stacks={'PerfEksStack': eks}, state={'version': 1, 'environment_id': ENV, 'command_id': 'old'})
            a['ec2'].describe_instances.return_value = {'Reservations': [{'Instances': [{'State': {'Name': 'running'}, 'Tags': [{'Key': driver.OWNER, 'Value': ENV}]}]}]}
            a['ssm'].get_command_invocation.return_value = {'Status': 'Success', 'StandardOutputContent': json.dumps({'environment_id': ENV, 'complete': True, **additional})}
            self.assertEqual(c.tick()['error'], 'kubernetes_cleanup_contract_mismatch')
            a['cloudformation'].delete_stack.assert_not_called()

    def test_partial_stack_role_comes_only_from_its_cfn_resource_inventory(self):
        eks = stack('PerfEksStack', StackStatus='CREATE_FAILED')
        c, a = self.setup_cleaner(stacks={'PerfEksStack': eks})
        a['cloudformation'].get_paginator.return_value.paginate.return_value = [
            {'StackResourceSummaries': []}, {'StackResourceSummaries': [
                {'ResourceType': 'AWS::IAM::Role', 'LogicalResourceId': 'NodeRoleB5643E21', 'PhysicalResourceId': NODE_ROLE}]}]
        self.assertEqual(c.node_role(eks), NODE_ROLE)
        a['cloudformation'].get_paginator.return_value.paginate.assert_called_once_with(StackName=eks['StackId'])

    def test_partial_stack_without_role_or_cluster_does_not_invent_profile_count(self):
        eks = stack('PerfEksStack', StackStatus='CREATE_FAILED')
        c, a = self.setup_cleaner(hours=22, stacks={'PerfEksStack': eks})
        a['eks'].describe_cluster.side_effect = AwsError('ResourceNotFoundException')
        result = c.tick()
        self.assertEqual(result['auto_mode_node_role'], 'NOT_CREATED')
        self.assertIsNone(result['auto_mode_residual_counts']['instance_profiles'])
        a['iam'].get_paginator.assert_not_called()
        a['cloudformation'].delete_stack.assert_called_once_with(StackName=eks['StackId'])

    def test_deleted_cfn_role_is_absent_but_access_denied_is_not(self):
        c, a = self.setup_cleaner()
        a['iam'].get_paginator.return_value.paginate.side_effect = AwsError('NoSuchEntity')
        self.assertTrue(c.auto_mode_finalized(stack('PerfEksStack', Outputs=NODE_ROLE_OUTPUTS)))
        self.assertEqual(c.state['auto_mode_residual_counts']['instance_profiles'], 0)

    def test_role_missing_while_cluster_exists_is_not_assumed_uncreated(self):
        c, a = self.setup_cleaner()
        with self.assertRaisesRegex(ValueError, 'cleanup_node_role_identity_mismatch'):
            c.auto_mode_finalized(stack('PerfEksStack'))
        a['iam'].get_paginator.assert_not_called()


class KubernetesCleanupTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('perf_cleanup_kubernetes_nodes', ROOT / 'lib/perf/cleanup/kubernetes.py')
        self.helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.helper)
        self.calls = []

    def run_helper(self, inventories, role=NODE_ROLE):
        responses = [{'cluster': {'tags': {driver.OWNER: ENV}, 'certificateAuthority': {'data': 'Y2E=',}, 'endpoint': 'https://private.example'}}, {'status': {'token': 'not-printed'}}]
        def http(req, **kwargs):
            parsed = urllib.parse.urlparse(req.full_url)
            cursor = urllib.parse.parse_qs(parsed.query).get('continue', [''])[0]
            self.calls.append((req.method, parsed.path, json.loads(req.data) if req.data else None))
            value = inventories.get((parsed.path, cursor), inventories.get(parsed.path, {'items': []})) if req.method == 'GET' else {}
            return io.BytesIO(json.dumps(value).encode())
        with patch.object(self.helper, 'aws', side_effect=responses), patch.object(self.helper.ssl, 'create_default_context'), patch.object(self.helper.urllib.request, 'urlopen', side_effect=http):
            return self.helper.cleanup(ENV, role)

    def test_pool_nodes_claims_classes_and_finalizers_are_ordered(self):
        pool_path, class_path = '/apis/karpenter.sh/v1/nodepools', '/apis/eks.amazonaws.com/v1/nodeclasses'
        pool = {'metadata': {'name': 'perf-system', 'uid': 'pool-uid'}, 'spec': {'template': {'spec': {'nodeClassRef': {'group': 'eks.amazonaws.com', 'kind': 'NodeClass', 'name': 'perf-system'}}}}}
        klass = {'metadata': {'name': 'perf-system', 'uid': 'class-uid', 'finalizers': ['eks.amazonaws.com/termination']},
                 'spec': {'role': NODE_ROLE, 'tags': {driver.OWNER: ENV}}}
        cases = [({pool_path: {'items': [pool]}}, pool_path + '/perf-system'),
                 ({'/api/v1/nodes': {'items': [{}]}}, None),
                 ({'/apis/karpenter.sh/v1/nodeclaims': {'items': [{}]}}, None),
                 ({class_path: {'items': [klass]}}, class_path + '/perf-system')]
        for inventory, deleted in cases:
            with self.subTest(inventory=inventory):
                self.calls = []
                self.assertFalse(self.run_helper(inventory))
                deletes = [entry for entry in self.calls if entry[0] == 'DELETE']
                self.assertEqual([entry[1] for entry in deletes], [deleted] if deleted else [])
                for _, _, body in deletes:
                    self.assertEqual(body['propagationPolicy'], 'Foreground')
                    self.assertIn(body['preconditions']['uid'], ['pool-uid', 'class-uid'])
                    self.assertNotIn('finalizers', json.dumps(body))
        self.calls = []
        self.assertTrue(self.run_helper({}))
        self.assertTrue(any(path == class_path for _, path, _ in self.calls))

    def test_foreign_nodeclass_on_later_page_blocks_all_class_deletes(self):
        path = '/apis/eks.amazonaws.com/v1/nodeclasses'
        owned = {'metadata': {'name': 'perf-system', 'uid': 'class-uid'}, 'spec': {'role': NODE_ROLE, 'tags': {driver.OWNER: ENV}}}
        for foreign in [dict(owned, spec={'role': NODE_ROLE, 'tags': {driver.OWNER: 'dev'}}),
                        dict(owned, spec={'role': 'DevRole', 'tags': {driver.OWNER: ENV}}),
                        dict(owned, metadata={'name': 'perf-other', 'uid': 'foreign-uid'})]:
            with self.subTest(foreign=foreign):
                self.calls = []
                with self.assertRaisesRegex(ValueError, 'nodeclass_identity_mismatch'):
                    self.run_helper({(path, ''): {'items': [owned], 'metadata': {'continue': 'next'}}, (path, 'next'): {'items': [foreign]}})
                self.assertFalse(any(method == 'DELETE' for method, _, _ in self.calls))

    def test_claim_on_later_page_keeps_nodeclass_controller_alive(self):
        path = '/apis/karpenter.sh/v1/nodeclaims'
        self.assertFalse(self.run_helper({(path, ''): {'items': [], 'metadata': {'continue': 'next'}}, (path, 'next'): {'items': [{}]}}))
        self.assertFalse(any('nodeclasses' in path for _, path, _ in self.calls))

    def test_untrusted_role_is_rejected_before_kubernetes_http(self):
        with self.assertRaisesRegex(ValueError, 'invalid_cleanup_node_role'):
            self.run_helper({}, role='DevEksStack-NodeRole-test')
        self.assertEqual(self.calls, [])


if __name__ == '__main__':
    unittest.main()
