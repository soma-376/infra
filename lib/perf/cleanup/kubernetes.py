"""전용 perf EKS에서만 실행하는 정리 helper. AWS/토큰/Secret 원문은 출력하지 않는다."""
import base64
import json
import os
import ssl
import subprocess
import urllib.error
import urllib.request

NAMESPACES = ['pulsemetry-perf', 'pulsemetry-perf-runner', 'pulsemetry-observability', 'pulsemetry-perf-logs']


def aws(*args):
    return json.loads(subprocess.check_output(['aws', '--region', 'ap-northeast-2', *args, '--output', 'json'], stderr=subprocess.DEVNULL))


def cleanup(environment_id):
    cluster = aws('eks', 'describe-cluster', '--name', 'soma-376-perf-eks')['cluster']
    if cluster['tags'].get('pulsemetry:perf-environment') != environment_id:
        raise ValueError('cluster_ownership_mismatch')
    context = ssl.create_default_context(cadata=base64.b64decode(cluster['certificateAuthority']['data']).decode())
    token = aws('eks', 'get-token', '--cluster-name', 'soma-376-perf-eks')['status']['token']

    def request(path, method='GET'):
        body = json.dumps({'propagationPolicy': 'Foreground'}).encode() if method == 'DELETE' else None
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
    if remove('/apis/karpenter.sh/v1/nodepools', lambda item: item['metadata']['name'].startswith('perf-')):
        return False
    nodes = request('/api/v1/nodes').get('items', [])
    return not nodes


if __name__ == '__main__':
    env = os.environ['PERF_CLEANUP_ENVIRONMENT_ID']
    try:
        complete = cleanup(env)
        print(json.dumps({'environment_id': env, 'complete': complete}))
    except Exception as error:
        print(json.dumps({'environment_id': env, 'complete': False, 'error': str(error) if isinstance(error, ValueError) else type(error).__name__}))
        raise SystemExit(1)
