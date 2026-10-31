"""전용 perf 환경의 재진입 가능한 정리 드라이버. 비밀 값과 임의 명령은 받지 않는다."""
import datetime as dt
import json
import os
import re
import time

OWNER = 'pulsemetry:perf-environment'
STACKS = ['PerfEdgeStack', 'PerfEksStack', 'PerfDataStack', 'PerfNetworkStack', 'PerfEvidenceStack']
GUARD = 'PerfGuardrailStack'
REPOSITORIES = ['soma-376/perf-k6-runner', 'soma-376/perf-tools']
ACTIVE = ['pending', 'running', 'stopping', 'stopped', 'shutting-down']
CLUSTER = 'soma-376-perf-eks'
CLEANUP_CONTRACT = 2
MANAGED_READS = ('DescribeInstances', 'DescribeVolumes', 'DescribeLaunchTemplates')


def managed_visibility_capabilities(ec2):
    # 2026-04 이후 관리형 자원은 기본 목록에서 숨겨질 수 있다. 미지원 SDK로 조용히 재시도하지 않는다.
    supported = {}
    for operation in MANAGED_READS:
        member = ec2.meta.service_model.operation_model(operation).input_shape.members.get('IncludeManagedResources')
        supported[operation] = member is not None and member.type_name == 'boolean'
    return supported


def code(error):
    return getattr(error, 'response', {}).get('Error', {}).get('Code', '')


def epoch(value):
    return value.timestamp() if hasattr(value, 'timestamp') else dt.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()


def tags(value):
    return {item.get('Key', item.get('key')): item.get('Value', item.get('value')) for item in value}


class Cleaner:
    def __init__(self, clients, config, now):
        self.aws, self.config, self.now = clients, config, now
        self.env = config['environment_id']
        self.stop_at = time.monotonic() + 30
        self.state = {'version': 1, 'environment_id': self.env, 'phase': 'WAITING', 'buckets': [], 'attempts': 0}

    def check_time(self):
        if time.monotonic() >= self.stop_at:
            raise ValueError('operation_budget_exhausted_retry')

    def owned(self, values, label):
        self.check_time()
        if tags(values).get(OWNER) != self.env:
            raise ValueError('ownership_mismatch:' + label)

    def stack(self, name):
        try:
            value = self.aws['cloudformation'].describe_stacks(StackName=name)['Stacks'][0]
        except Exception as error:
            if code(error) == 'ValidationError' and 'does not exist' in str(error):
                return None
            raise
        if value['StackStatus'] == 'DELETE_COMPLETE':
            return None
        self.owned(value.get('Tags', []), name)
        role = value.get('RoleARN', '')
        if not role.startswith('arn:aws:iam::' + self.config['account'] + ':role/'):
            raise ValueError('cloudformation_service_role_required:' + name)
        expected = 'arn:aws:cloudformation:' + self.config['region'] + ':' + self.config['account'] + ':stack/' + name + '/'
        if not value['StackId'].startswith(expected):
            raise ValueError('stack_identity_mismatch:' + name)
        return value

    def load(self):
        try:
            state = json.loads(self.aws['ssm'].get_parameter(Name=self.config['state_parameter'])['Parameter']['Value'])
        except Exception as error:
            if code(error) == 'ParameterNotFound':
                return
            raise
        if state.get('environment_id') != self.env or state.get('version') != 1:
            raise ValueError('cleanup_state_identity_mismatch')
        self.state.update(state)

    def save(self):
        self.state['updated_at'] = dt.datetime.fromtimestamp(self.now, dt.timezone.utc).isoformat()
        self.state['attempts'] += 1
        encoded = json.dumps(self.state, separators=(',', ':'))
        if len(encoded.encode()) > 4096:
            raise ValueError('cleanup_state_too_large')
        self.aws['ssm'].put_parameter(Name=self.config['state_parameter'], Value=encoded, Type='String', Overwrite=True)
        print(encoded)
        return self.state

    def repositories(self, remove=False):
        created = []
        remaining = []
        for name in REPOSITORIES:
            try:
                repo = self.aws['ecr'].describe_repositories(repositoryNames=[name])['repositories'][0]
            except Exception as error:
                if code(error) == 'RepositoryNotFoundException':
                    continue
                raise
            expected = 'arn:aws:ecr:' + self.config['region'] + ':' + self.config['account'] + ':repository/' + name
            if repo['repositoryArn'] != expected:
                raise ValueError('ecr_identity_mismatch:' + name)
            self.owned(self.aws['ecr'].list_tags_for_resource(resourceArn=expected)['tags'], name)
            created.append(epoch(repo['createdAt']))
            remaining.append(name)
            if remove:
                self.aws['ecr'].delete_repository(repositoryName=name, force=True)
        return created, remaining

    def remember_buckets(self, stacks):
        known = set(self.state['buckets'])
        for stack in stacks.values():
            if stack:
                for output in stack.get('Outputs', []):
                    if output['OutputKey'] in ['RawSignalBucketName', 'EvidenceBucketName', 'DiagnosticsBucketName', 'PerfAlbAccessLogBucket']:
                        known.add(output['OutputValue'])
                # CREATE_FAILED 등 output이 아직 없을 때에도 CFN이 만든 bucket만 추적한다.
                for page in self.aws['cloudformation'].get_paginator('list_stack_resources').paginate(StackName=stack['StackId']):
                    for item in page.get('StackResourceSummaries', []):
                        if item['ResourceType'] == 'AWS::S3::Bucket' and item.get('PhysicalResourceId'):
                            known.add(item['PhysicalResourceId'])
        if len(known) > 8:
            raise ValueError('unexpected_bucket_count')
        self.state['buckets'] = sorted(known)

    def empty_bucket(self, name, delete=False):
        s3 = self.aws['s3']
        try:
            self.owned(s3.get_bucket_tagging(Bucket=name)['TagSet'], name)
        except Exception as error:
            if code(error) in ['NoSuchBucket', '404']:
                return False
            raise
        allowed = ('perfdatastack-', 'perfeksstack-', 'perfevidencestack-', 'perfedgestack-')
        if not name.startswith(allowed):
            raise ValueError('bucket_name_outside_allowlist')
        # 한 호출의 작업량을 제한한다. 다음 주기에 남은 첫 페이지부터 재개한다.
        uploads = s3.list_multipart_uploads(Bucket=name, MaxUploads=100)
        for upload in uploads.get('Uploads', []):
            self.check_time()
            s3.abort_multipart_upload(Bucket=name, Key=upload['Key'], UploadId=upload['UploadId'])
        versions = s3.list_object_versions(Bucket=name, MaxKeys=1000)
        objects = [{'Key': x['Key'], 'VersionId': x['VersionId']} for x in versions.get('Versions', []) + versions.get('DeleteMarkers', [])]
        if objects:
            result = s3.delete_objects(Bucket=name, Delete={'Objects': objects, 'Quiet': True})
            if result.get('Errors'):
                raise ValueError('bucket_delete_objects_failed:' + name)
        if objects or uploads.get('Uploads') or versions.get('IsTruncated') or uploads.get('IsTruncated'):
            return True
        # 버전 미사용 버킷의 null version도 위 조회에 포함된다. 빈지 확인 후에만 삭제한다.
        if delete:
            s3.delete_bucket(Bucket=name)
        return True

    def node_role(self, stack, allow_not_created=False):
        outputs = {x['OutputKey']: x['OutputValue'] for x in stack.get('Outputs', [])}
        name, arn = outputs.get('EksNodeRoleName', ''), outputs.get('EksNodeRoleArn', '')
        if not name and not arn:
            # 부분 생성 실패에는 output이 없다. 같은 CFN 스택의 실제 NodeRole만 대체 근거로 쓴다.
            roles = []
            for page in self.aws['cloudformation'].get_paginator('list_stack_resources').paginate(StackName=stack['StackId']):
                self.check_time()
                for item in page['StackResourceSummaries']:
                    if (item.get('ResourceType') == 'AWS::IAM::Role'
                            and re.fullmatch(r'NodeRole[A-Za-z0-9]+', item.get('LogicalResourceId', ''))
                            and item.get('PhysicalResourceId')):
                        roles.append(item['PhysicalResourceId'])
            if not roles and allow_not_created:
                # 역할/cluster가 모두 생성되지 않은 초기 실패는 정리를 진행할 수 있다.
                try:
                    self.aws['eks'].describe_cluster(name=CLUSTER)
                except Exception as error:
                    if code(error) == 'ResourceNotFoundException':
                        return None
                    raise
            if len(roles) == 1:
                name = roles[0]
                arn = 'arn:aws:iam::' + self.config['account'] + ':role/' + name
        if (not re.fullmatch(r'PerfEksStack-NodeRole[A-Za-z0-9-]+', name)
                or arn != 'arn:aws:iam::' + self.config['account'] + ':role/' + name):
            raise ValueError('cleanup_node_role_identity_mismatch')
        return name

    def kubernetes(self, stack):
        if self.state.get('kubernetes_complete') and self.state.get('kubernetes_cleanup_contract') == CLEANUP_CONTRACT:
            return True
        if not stack:
            self.state['kubernetes_complete'] = True
            self.state['kubernetes_cleanup_contract'] = CLEANUP_CONTRACT
            return True
        outputs = {x['OutputKey']: x['OutputValue'] for x in stack.get('Outputs', [])}
        relay = outputs.get('EksRelayInstanceId')
        if not relay:
            # 클러스터가 만들어졌으나 relay가 없으면 자동으로 EKS부터 지우지 않는다.
            try:
                self.aws['eks'].describe_cluster(name=CLUSTER)
            except Exception as error:
                if code(error) == 'ResourceNotFoundException':
                    self.state['kubernetes_complete'] = True
                    self.state['kubernetes_cleanup_contract'] = CLEANUP_CONTRACT
                    return True
                raise
            raise ValueError('eks_exists_without_cleanup_relay')
        node_role = self.node_role(stack)
        instances = self.aws['ec2'].describe_instances(InstanceIds=[relay], IncludeManagedResources=True)['Reservations']
        instance = instances[0]['Instances'][0]
        self.owned(instance.get('Tags', []), relay)
        if instance['State']['Name'] != 'running':
            raise ValueError('cleanup_relay_not_running')
        command = self.state.get('command_id')
        if command:
            try:
                result = self.aws['ssm'].get_command_invocation(CommandId=command, InstanceId=relay)
            except Exception as error:
                if code(error) == 'InvocationDoesNotExist':
                    return False
                raise
            if result['Status'] in ['Pending', 'InProgress', 'Delayed']:
                return False
            self.state.pop('command_id', None)
            if result['Status'] != 'Success':
                # stderr에는 명령/값을 넣지 않는다. 상세는 SSM의 고정 문서 실행 로그로 별도 조회한다.
                raise ValueError('kubernetes_cleanup_command_' + result['Status'])
            result = json.loads(result.get('StandardOutputContent', '').strip().splitlines()[-1])
            if result.get('environment_id') != self.env:
                raise ValueError('kubernetes_cleanup_environment_mismatch')
            if result.get('cleanup_contract') != CLEANUP_CONTRACT or result.get('node_role_name') != node_role:
                raise ValueError('kubernetes_cleanup_contract_mismatch')
            if result.get('complete') is True:
                self.state['kubernetes_complete'] = True
                self.state['kubernetes_cleanup_contract'] = CLEANUP_CONTRACT
                return True
        response = self.aws['ssm'].send_command(InstanceIds=[relay], DocumentName=self.config['document_name'],
                                               Parameters={'nodeRoleName': [node_role]}, TimeoutSeconds=120)
        self.state['command_id'] = response['Command']['CommandId']
        return False

    def auto_mode_finalized(self, stack):
        # EKS/NodeRole 삭제 전에 controller 소유 자원 소멸을 실제 서비스별 조회로 확인한다.
        # profile/LT 직접 삭제나 finalizer 강제 제거 권한은 사용하지 않는다.
        node_role = self.node_role(stack, allow_not_created=True)
        profiles = 0 if node_role else None
        if node_role:
            try:
                for page in self.aws['iam'].get_paginator('list_instance_profiles_for_role').paginate(RoleName=node_role):
                    self.check_time()
                    profiles += len(page['InstanceProfiles'])
            except Exception as error:
                if code(error) != 'NoSuchEntity':
                    raise
                # CFN이 이미 역할을 지운 재진입에서만 API가 확인한 부재로 기록한다.
                profiles = 0
        templates = 0
        filters = [{'Name': 'tag:' + OWNER, 'Values': [self.env]},
                   {'Name': 'tag:eks:eks-cluster-name', 'Values': [CLUSTER]}]
        for page in self.aws['ec2'].get_paginator('describe_launch_templates').paginate(Filters=filters, IncludeManagedResources=True):
            self.check_time()
            for item in page['LaunchTemplates']:
                self.owned(item.get('Tags', []), 'launch_template')
                if tags(item.get('Tags', [])).get('eks:eks-cluster-name') != CLUSTER:
                    raise ValueError('launch_template_cluster_mismatch')
                templates += 1
        self.state['auto_mode_residual_counts'] = {'instance_profiles': profiles, 'launch_templates': templates}
        self.state['auto_mode_node_role'] = 'FOUND' if node_role else 'NOT_CREATED'
        return profiles in [None, 0] and templates == 0

    def volumes_and_instances(self):
        ec2 = self.aws['ec2']
        remaining = []
        for page in ec2.get_paginator('describe_instances').paginate(Filters=[{'Name': 'tag:' + OWNER, 'Values': [self.env]}, {'Name': 'instance-state-name', 'Values': ACTIVE}], IncludeManagedResources=True):
            for reservation in page['Reservations']:
                for item in reservation['Instances']:
                    self.owned(item.get('Tags', []), item['InstanceId'])
                    remaining.append(item['InstanceId'])
                    if item['State']['Name'] != 'shutting-down':
                        ec2.terminate_instances(InstanceIds=[item['InstanceId']])
        for page in ec2.get_paginator('describe_volumes').paginate(Filters=[{'Name': 'tag:' + OWNER, 'Values': [self.env]}], IncludeManagedResources=True):
            for volume in page['Volumes']:
                self.owned(volume.get('Tags', []), volume['VolumeId'])
                remaining.append(volume['VolumeId'])
                if volume['State'] == 'available' and not volume.get('Attachments'):
                    ec2.delete_volume(VolumeId=volume['VolumeId'])
        return remaining

    def tick(self, force=False):
        self.load()
        try:
            capabilities = managed_visibility_capabilities(self.aws['ec2'])
            self.state['managed_resource_visibility'] = capabilities
            if not all(capabilities.values()):
                raise ValueError('managed_resource_visibility_sdk_unsupported')
            guard = self.stack(GUARD)
            if not guard:
                raise ValueError('guardrail_stack_missing')
            stacks = {name: self.stack(name) for name in STACKS}
            repo_times, _ = self.repositories()
            origin = min([epoch(s['CreationTime']) for s in [guard] + list(stacks.values()) if s] + repo_times + ([self.state['created_epoch']] if 'created_epoch' in self.state else []))
            self.state.update(created_epoch=origin, cleanup_start_epoch=origin + 79200, deadline_epoch=origin + 86400)
            self.state['deadline_exceeded'] = self.now >= self.state['deadline_epoch']
            self.remember_buckets(stacks)
            if force:
                self.state['cleanup_requested'] = True
            if self.now < self.state['cleanup_start_epoch'] and not self.state.get('cleanup_requested'):
                self.state['phase'] = 'WAITING'
                self.state.pop('error', None)
                return self.save()
            self.state['phase'] = 'KUBERNETES'
            if not self.kubernetes(stacks['PerfEksStack']):
                return self.save()
            if stacks['PerfEksStack']:
                self.state['phase'] = 'AUTO_MODE_FINALIZATION'
                if not self.auto_mode_finalized(stacks['PerfEksStack']):
                    return self.save()
            self.state['phase'] = 'STACKS'
            # 의존 역순으로 하나씩 요청하고 다음 스케줄에서 완료를 확인한다.
            for name in STACKS:
                stack = stacks[name]
                if not stack:
                    continue
                if stack['StackStatus'].endswith('_IN_PROGRESS'):
                    self.state['waiting_stack'] = name
                    return self.save()
                # multipart는 CDK auto-delete 객체 처리와 별개이므로 각 bucket을 매번 처리한다.
                for bucket in self.state['buckets']:
                    self.empty_bucket(bucket)
                self.aws['cloudformation'].delete_stack(StackName=stack['StackId'])
                self.state['waiting_stack'] = name
                return self.save()
            self.state.pop('waiting_stack', None)
            self.state['phase'] = 'RESIDUALS'
            _, repositories = self.repositories(remove=True)
            remaining = self.volumes_and_instances()
            buckets = [name for name in self.state['buckets'] if self.empty_bucket(name, delete=True)]
            self.state['residual_counts'] = {'ecr': len(repositories), 'ec2': len(remaining), 's3': len(buckets)}
            if repositories or remaining or buckets:
                return self.save()
            # CloudFormation의 완료 + 서비스별 외부 소유 자원 부재를 확인한 다음 보호 스택도 제거한다.
            self.state['phase'] = 'SELF_DELETE_REQUESTED'
            self.state.pop('error', None)
            result = self.save()
            self.aws['cloudformation'].delete_stack(StackName=guard['StackId'])
            return result
        except Exception as error:
            self.state['phase'] = 'ERROR'
            # AWS message 원문/응답에는 임의 값이 있을 수 있어 코드와 자체 오류만 기록한다.
            self.state['error'] = str(error)[:180] if isinstance(error, ValueError) else type(error).__name__ + ':' + code(error)
            return self.save()


def handler(event, context):
    import boto3
    import botocore
    from botocore.config import Config
    config = json.loads(os.environ['CLEANUP_CONFIG'])
    sdk = Config(connect_timeout=3, read_timeout=5, retries={'total_max_attempts': 1, 'mode': 'standard'})
    clients = {name: boto3.client(name, region_name=config['region'], config=sdk) for name in ['cloudformation', 'ssm', 'ecr', 'ec2', 'eks', 's3', 'iam']}
    # 실제 Lambda SDK 기능만 조회한다. 정리·SSM 상태 기록·자원 API는 호출하지 않는다.
    if event == {'action': 'sdk_capabilities', 'environment_id': config['environment_id']}:
        return {'environment_id': config['environment_id'], 'boto3': boto3.__version__, 'botocore': botocore.__version__,
                'managed_resource_visibility': managed_visibility_capabilities(clients['ec2']), 'cloud_mutations': 0}
    # 수동 호출도 정확한 환경을 명시해야 하며 자원 허용목록/TTL을 변경할 수 없다.
    force = event == {'action': 'cleanup', 'environment_id': config['environment_id']}
    if event and not force and event.get('source') != 'aws.events':
        raise ValueError('unsupported_cleanup_event')
    return Cleaner(clients, config, dt.datetime.now(dt.timezone.utc).timestamp()).tick(force)
