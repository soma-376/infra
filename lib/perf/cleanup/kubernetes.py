"""전용 perf EKS에서만 실행하는 정리 helper. AWS/토큰/Secret 원문은 출력하지 않는다."""
import base64
import json
import os
import re
import ssl
import subprocess
import urllib.error
import urllib.request
import urllib.parse

NAMESPACES = ['pulsemetry-perf', 'pulsemetry-perf-runner', 'pulsemetry-observability', 'pulsemetry-perf-logs']
NODE_CLASSES = {'perf-' + pool for pool in ['gateway', 'pipeline', 'clickhouse', 'generator', 'observability', 'system', 'kafka']}
CLEANUP_CONTRACT = 2


def aws(*args):
    return json.loads(subprocess.check_output(['aws', '--region', 'ap-northeast-2', *args, '--output', 'json'], stderr=subprocess.DEVNULL))


def cleanup(environment_id, node_role=None):
    cluster = aws('eks', 'describe-cluster', '--name', 'soma-376-perf-eks')['cluster']
    if cluster['tags'].get('pulsemetry:perf-environment') != environment_id:
        raise ValueError('cluster_ownership_mismatch')
    node_role = node_role or os.environ.get('PERF_CLEANUP_NODE_ROLE', '')
    if not re.fullmatch(r'PerfEksStack-NodeRole[A-Za-z0-9-]+', node_role):
        raise ValueError('invalid_cleanup_node_role')
    context = ssl.create_default_context(cadata=base64.b64decode(cluster['certificateAuthority']['data']).decode())
    token = aws('eks', 'get-token', '--cluster-name', 'soma-376-perf-eks')['status']['token']

    def request(path, method='GET', uid=None):
        options = {'propagationPolicy': 'Foreground'}
        if uid:
            options['preconditions'] = {'uid': uid}
        body = json.dumps(options).encode() if method == 'DELETE' else None
        req = urllib.request.Request(cluster['endpoint'] + path, data=body, method=method, headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(req, context=context, timeout=10) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return {'items': []}
            raise ValueError('kubernetes_http_' + str(error.code)) from None

    def remove(path, predicate=lambda _: True):
        value = request(path + '?limit=100')
        items = [item for item in value.get('items', []) if predicate(item)]
        for item in items:
            request(path + '/' + item['metadata']['name'], 'DELETE')
        return bool(items or value.get('metadata', {}).get('continue'))

    def inventory(path):
        items, cursor = [], ''
        while True:
            value = request(path + '?' + urllib.parse.urlencode({'limit': 100, 'continue': cursor}))
            items.extend(value.get('items', []))
            cursor = value.get('metadata', {}).get('continue', '')
            if not cursor:
                return items

    # TGB finalizer는 LBC가 동작할 때 먼저 완료한다. CFN TG를 먼저 지우지 않는다.
    if remove('/apis/elbv2.k8s.aws/v1beta1/namespaces/pulsemetry-perf/targetgroupbindings'):
        return False
    # 앱과 발생기를 멈추되 Kafka exporter/operator는 Kafka CR 정리까지 유지한다.
    pending = False
    for namespace in NAMESPACES[:2]:
        for api, resource in [('batch/v1', 'cronjobs'), ('batch/v1', 'jobs'), ('apps/v1', 'deployments'), ('apps/v1', 'statefulsets')]:
            pending |= remove('/apis/' + api + '/namespaces/' + namespace + '/' + resource,
                              lambda item: 'strimzi.io/cluster' not in item['metadata'].get('labels', {}))
    if pending:
        return False
    # Topic/User -> Kafka -> NodePool 순서로 운영자가 관리하는 CR를 지운다.
    for resource in ['kafkatopics', 'kafkausers', 'kafkas', 'kafkanodepools']:
        if remove('/apis/kafka.strimzi.io/v1/namespaces/pulsemetry-perf/' + resource):
            return False
    # 관측/로그 writer를 멈춰 PVC가 해제될 때까지 기다린다.
    for namespace in NAMESPACES[2:]:
        for api, resource in [('apps/v1', 'deployments'), ('apps/v1', 'statefulsets'), ('apps/v1', 'daemonsets')]:
            pending |= remove('/apis/' + api + '/namespaces/' + namespace + '/' + resource)
    if pending:
        return False
    for namespace in NAMESPACES:
        pending |= remove('/api/v1/namespaces/' + namespace + '/persistentvolumeclaims')
    if pending:
        return False
    # Kafka Retain PV는 PVC와 달리 별도 삭제가 필요하다. 환경 전용 StorageClass 세 개만 허용한다.
    if remove('/api/v1/persistentvolumes', lambda item: item['spec'].get('storageClassName') in ['pulsemetry-perf-gp3', 'pulsemetry-perf-kafka-gp3', 'gp3-observability']):
        return False
    # 전체 전용 클러스터 철거 단계다. CoreDNS 같은 addon PDB가 마지막 노드 drain을 막지 않게 한다.
    pdbs = request('/apis/policy/v1/poddisruptionbudgets?limit=100')
    for item in pdbs.get('items', []):
        request('/apis/policy/v1/namespaces/' + item['metadata']['namespace'] + '/poddisruptionbudgets/' + item['metadata']['name'], 'DELETE')
    if pdbs.get('items') or pdbs.get('metadata', {}).get('continue'):
        return False
    # 남은 EBS는 AWS 소유 태그 검사 후 드라이버가 삭제한다. finalizer 강제 제거는 하지 않는다.
    pools = inventory('/apis/karpenter.sh/v1/nodepools')
    for item in pools:
        name = item['metadata']['name']
        reference = item.get('spec', {}).get('template', {}).get('spec', {}).get('nodeClassRef', {})
        if name not in NODE_CLASSES or reference != {'group': 'eks.amazonaws.com', 'kind': 'NodeClass', 'name': name}:
            raise ValueError('nodepool_identity_mismatch')
    for item in pools:
        request('/apis/karpenter.sh/v1/nodepools/' + item['metadata']['name'], 'DELETE', item['metadata']['uid'])
    if pools:
        return False
    # Node가 0이어도 NodeClaim finalizer가 남아 있으면 NodeClass를 먼저 제거하지 않는다.
    if inventory('/api/v1/nodes') or inventory('/apis/karpenter.sh/v1/nodeclaims'):
        return False
    classes = inventory('/apis/eks.amazonaws.com/v1/nodeclasses')
    # 전체 페이지를 먼저 검증하여 다른 환경/역할의 객체는 하나도 삭제하지 않는다.
    for item in classes:
        metadata, spec = item['metadata'], item.get('spec', {})
        if (metadata['name'] not in NODE_CLASSES or spec.get('role') != node_role
                or spec.get('tags', {}).get('pulsemetry:perf-environment') != environment_id):
            raise ValueError('nodeclass_identity_mismatch')
        if not metadata.get('uid'):
            raise ValueError('nodeclass_uid_missing')
    for item in classes:
        request('/apis/eks.amazonaws.com/v1/nodeclasses/' + item['metadata']['name'], 'DELETE', item['metadata']['uid'])
    # 202 응답만으로 완료하지 않는다. 다음 호출에서 finalizer가 끝난 실제 부재를 확인한다.
    return not classes


if __name__ == '__main__':
    env = os.environ['PERF_CLEANUP_ENVIRONMENT_ID']
    try:
        complete = cleanup(env)
        print(json.dumps({'environment_id': env, 'complete': complete, 'cleanup_contract': CLEANUP_CONTRACT,
                          'node_role_name': os.environ.get('PERF_CLEANUP_NODE_ROLE')}))
    except Exception as error:
        print(json.dumps({'environment_id': env, 'complete': False, 'error': str(error) if isinstance(error, ValueError) else type(error).__name__}))
        raise SystemExit(1)
