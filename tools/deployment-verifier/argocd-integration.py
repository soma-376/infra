#!/usr/bin/env python3
"""격리 kind에서 실제 Argo 3.5.7의 PostSync wave·nonce·retained Job을 검증하고 정리한다."""
import argparse
import json
from pathlib import Path
import subprocess
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
NODE = 'kindest/node:v1.36.4@sha256:099e049362a1526b2db71494e1947aae99bd16290d7c895f2b7ea312e3cbfaed'
ARGO = 'quay.io/argoproj/argocd@sha256:d858fe2b772874df58672a82e82137b53a59a80f5bf7e8b1b0f8a0f29eccb7dd'
PYTHON = 'docker.io/library/python@sha256:df540bfd30bd380e89a349611ce42aa67bcb542d58c047706616eb6ba2f86a1b'
REDIS = 'ecr-public.aws.com/docker/library/redis@sha256:8767d84b0adc89c37a352a17372a5e97bf21bb723890e244c212bb44b9f11177'
APPLICATIONS = {'first': 'pulsemetry-dev-enrollment-api', 'second': 'pulsemetry-dev-telemetry-ingest'}


def run(args, data=None, check=True, timeout=300):
    result = subprocess.run(args, input=data, text=True, capture_output=True, timeout=timeout)
    if check and result.returncode:
        raise RuntimeError('local command failed: ' + ' '.join(args[:4]) + '\n' + result.stderr[-1500:])
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--kind', required=True)
    parser.add_argument('--kubectl', default='kubectl')
    parser.add_argument('--helm', required=True)
    parser.add_argument('--name', default='proj311-argo-' + uuid.uuid4().hex[:10])
    parser.add_argument('--work-dir', type=Path)
    args = parser.parse_args()
    if not args.name.startswith('proj311-argo-'):
        raise ValueError('로컬 시험 전용 이름이 필요하다')
    directory = args.work_dir or Path(tempfile.mkdtemp(prefix=args.name + '-'))
    directory.mkdir(parents=True, exist_ok=True)
    kubeconfig = directory / 'kubeconfig'
    kubectl = [args.kubectl, '--kubeconfig', str(kubeconfig), '--context', 'kind-' + args.name, '--cache-dir', str(directory / 'kube-cache')]
    git_container = args.name + '-git'
    git_started = False
    report = {'schemaVersion': 1, 'argocdVersion': '3.5.7', 'kubernetesImage': NODE, 'checks': []}
    def kube(*items, data=None, check=True):
        return run(kubectl + list(items), data, check)
    def get(kind, name=None, namespace='argocd'):
        command = ['get', kind] + ([name] if name else []) + ['-n', namespace, '-o', 'json']
        result = kube(*command, check=False)
        return json.loads(result.stdout) if result.returncode == 0 else None
    def apply(obj):
        kube('apply', '-f', '-', data=json.dumps(obj))
    def wait(predicate, description, seconds=180):
        until = time.monotonic() + seconds
        while time.monotonic() < until:
            value = predicate()
            if value:
                return value
            time.sleep(2)
        # 여기에는 합성 Application 상태만 기록하며 Secret·로그는 읽지 않는다.
        state = get('applications')
        (directory / 'application-diagnostic.json').write_text(json.dumps(state, indent=2))
        raise TimeoutError(description)
    try:
        existing = run(['docker', 'inspect', args.name + '-control-plane'], check=False)
        if not kubeconfig.exists() or existing.returncode:
            print('Creating isolated kind cluster', flush=True)
            run([args.kind, 'create', 'cluster', '--name', args.name, '--image', NODE, '--kubeconfig', str(kubeconfig), '--wait', '120s'], timeout=600)
        # 기존 kubeconfig를 받더라도 명시 context와 로컬 Docker node를 함께 확인한다.
        node = json.loads(run(['docker', 'inspect', args.name + '-control-plane']).stdout)[0]
        if node['Config']['Labels'].get('io.x-k8s.kind.cluster') != args.name:
            raise ValueError('시험 전용 kind node가 아니다')
        for image in [ARGO, PYTHON, REDIS]:
            print('Preparing pinned image ' + image.split('@')[0], flush=True)
            if image == PYTHON:
                run(['docker', 'pull', '--platform', 'linux/arm64', image], timeout=300)
            # Docker29의 save/import 임시 참조 대신 CRI가 고정 manifest를 직접 등록한다.
            runtime_image = image
            if image == ARGO:
                runtime_image = image.replace('@', ':v3.5.7@')
            elif image == REDIS:
                runtime_image = image.replace('@', ':8.6.4-alpine@')
            run(['docker', 'exec', args.name + '-control-plane', 'crictl', 'pull', runtime_image], timeout=300)
        kube('create', 'namespace', 'argocd')
        kube('create', 'namespace', 'fixture')
        health = (ROOT / 'helm/dev/gitops/health/application.lua').read_text()
        values = {
            'fullnameOverride': 'argocd', 'namespaceOverride': 'argocd',
            'global': {'image': {'repository': ARGO.split('@')[0], 'tag': 'v3.5.7@' + ARGO.split('@')[1], 'imagePullPolicy': 'IfNotPresent'}},
            'configs': {'cm': {'admin.enabled': 'false', 'cluster.inClusterEnabled': 'true',
                                'timeout.reconciliation': '10s', 'timeout.reconciliation.jitter': '0s',
                                'resource.customizations.health.argoproj.io_Application': health}},
            'server': {'enabled': False}, 'dex': {'enabled': False}, 'notifications': {'enabled': False},
            'applicationSet': {'replicas': 0},
            'redis': {'image': {'repository': REDIS.split('@')[0], 'tag': '8.6.4-alpine@' + REDIS.split('@')[1]}},
        }
        values_file = directory / 'argocd-values.json'
        values_file.write_text(json.dumps(values))
        chart = ROOT / 'helm/dev/platform/argocd/vendor/argo-cd-10.11.7.tgz'
        manifest = run([args.helm, 'template', 'argocd', str(chart), '--namespace', 'argocd', '--include-crds', '--kube-version', '1.36.4', '-f', str(values_file)]).stdout
        kube('apply', '--server-side', '-f', '-', data=manifest)
        kube('wait', '--for=condition=Established', 'crd/applications.argoproj.io', '--timeout=90s')
        kube('wait', '--for=condition=Established', 'crd/appprojects.argoproj.io', '--timeout=90s')
        apply({'apiVersion': 'argoproj.io/v1alpha1', 'kind': 'AppProject', 'metadata': {'name': 'default', 'namespace': 'argocd'},
               'spec': {'sourceRepos': ['*'], 'destinations': [{'server': 'https://kubernetes.default.svc', 'namespace': 'argocd'},
                                                           {'server': 'https://kubernetes.default.svc', 'namespace': 'fixture'}],
                        'namespaceResourceWhitelist': [{'group': '*', 'kind': '*'}]}})
        print('Waiting for Argo components', flush=True)
        kube('rollout', 'status', 'deployment/argocd-repo-server', '-n', 'argocd', '--timeout=180s')
        kube('rollout', 'status', 'statefulset/argocd-application-controller', '-n', 'argocd', '--timeout=180s')
        attempt = uuid.uuid4().hex[:8]
        git_http = directory / ('git-http-' + attempt)
        git_http.mkdir(exist_ok=True)
        work, bare = directory / ('source-' + attempt), git_http / 'repo.git'
        work.mkdir()
        run(['git', 'init', '--initial-branch=main', str(work)])
        run(['git', '-C', str(work), 'config', 'user.name', 'PROJ-311 local fixture'])
        run(['git', '-C', str(work), 'config', 'user.email', 'fixture@example.invalid'])
        def commit(message):
            run(['git', '-C', str(work), 'add', '.'])
            run(['git', '-C', str(work), 'commit', '-m', message])
            return run(['git', '-C', str(work), 'rev-parse', 'HEAD']).stdout.strip()
        def publish():
            if not bare.exists():
                run(['git', 'clone', '--bare', str(work), str(bare)])
            else:
                run(['git', '--git-dir', str(bare), 'fetch', str(work), 'main:main'])
            run(['git', '--git-dir', str(bare), 'update-server-info'])
        # 합성 Git만 Docker bridge에서 제공한다. 외부 포트·외부 게시·인증은 없다.
        run(['docker', 'run', '-d', '--name', git_container, '--network', 'kind', '-v', str(git_http) + ':/fixture:ro',
             PYTHON, 'python3', '-m', 'http.server', '8080', '--directory', '/fixture'])
        git_started = True
        ip = json.loads(run(['docker', 'inspect', git_container]).stdout)[0]['NetworkSettings']['Networks']['kind']['IPAddress']
        repo = 'http://' + ip + ':8080/repo.git'
        def workload(app, nonce, failed):
            path = work / 'workloads' / app
            path.mkdir(parents=True, exist_ok=True)
            deployment = {'apiVersion': 'apps/v1', 'kind': 'Deployment', 'metadata': {'name': app, 'namespace': 'fixture'},
                          'spec': {'replicas': 1, 'selector': {'matchLabels': {'app': app}}, 'template': {'metadata': {'labels': {'app': app}},
                                   'spec': {'containers': [{'name': 'app', 'image': PYTHON, 'imagePullPolicy': 'IfNotPresent',
                                                           'command': ['python3', '-c', 'import time; time.sleep(3600)']}]}}}}
            job = {'apiVersion': 'batch/v1', 'kind': 'Job', 'metadata': {'name': app + '-verify', 'namespace': 'fixture',
                   'labels': {'operation-nonce': nonce}, 'annotations': {'argocd.argoproj.io/hook': 'PostSync', 'argocd.argoproj.io/hook-delete-policy': 'BeforeHookCreation'}},
                   'spec': {'backoffLimit': 0, 'activeDeadlineSeconds': 30, 'template': {'metadata': {'labels': {'operation-nonce': nonce}},
                            'spec': {'restartPolicy': 'Never', 'containers': [{'name': 'verifier', 'image': PYTHON, 'imagePullPolicy': 'IfNotPresent',
                                     'command': ['python3', '-c', 'import sys; sys.exit(' + ('1' if failed else '0') + ')']}]}}}}
            (path / 'deployment.json').write_text(json.dumps(deployment))
            (path / 'job.json').write_text(json.dumps(job))
            # 실제 chart처럼 비 hook ConfigMap에도 nonce가 있어야 자동 sync가 새 hook을 실행한다.
            binding = {'apiVersion': 'v1', 'kind': 'ConfigMap', 'metadata': {'name': app + '-verify-input', 'namespace': 'fixture'},
                       'data': {'binding.json': json.dumps({'operationNonce': nonce}, sort_keys=True)}}
            (path / 'binding.json').write_text(json.dumps(binding))
        def revision(nonce, failed=False):
            workload('first', nonce, failed)
            workload('second', nonce, False)
            v = commit('synthetic immutable workload ' + nonce)
            root = work / 'root'
            root.mkdir(exist_ok=True)
            for index, app in enumerate(['first', 'second']):
                application = {'apiVersion': 'argoproj.io/v1alpha1', 'kind': 'Application',
                               'metadata': {'name': APPLICATIONS[app], 'namespace': 'argocd', 'annotations': {'argocd.argoproj.io/sync-wave': str(index)}},
                               'spec': {'project': 'default', 'sources': [{'repoURL': repo, 'targetRevision': v, 'path': 'workloads/' + app},
                                                                         {'repoURL': repo, 'targetRevision': v, 'ref': 'values'}],
                                        'destination': {'server': 'https://kubernetes.default.svc', 'namespace': 'fixture'},
                                        'syncPolicy': {'automated': {'enabled': True, 'prune': False, 'selfHeal': True, 'allowEmpty': False}, 'retry': {'limit': 0}}}}
                (root / (app + '.json')).write_text(json.dumps(application))
            p = commit('synthetic root selection ' + nonce)
            publish()
            return v, p
        def root_sync(p):
            app = {'apiVersion': 'argoproj.io/v1alpha1', 'kind': 'Application', 'metadata': {'name': 'fixture-root', 'namespace': 'argocd'},
                   'spec': {'project': 'default', 'source': {'repoURL': repo, 'targetRevision': p, 'path': 'root'},
                            'destination': {'server': 'https://kubernetes.default.svc', 'namespace': 'argocd'},
                            'syncPolicy': {'automated': {'enabled': True, 'prune': False, 'selfHeal': True, 'allowEmpty': False}, 'retry': {'limit': 0}}},
                   'operation': {'retry': {'limit': 0}, 'sync': {'revision': p, 'prune': False, 'syncStrategy': {'hook': {}}}}}
            apply(app)
        def completed(p):
            app = get('application', 'fixture-root') or {}
            status = app.get('status', {})
            return status.get('operationState', {}).get('phase') == 'Succeeded' and status.get('sync', {}).get('revision') == p
        def ids():
            pods = get('pods', namespace='fixture')['items']
            return {app: {'job': get('job', app + '-verify', namespace='fixture')['metadata']['uid'],
                          'pod': next(p['metadata']['uid'] for p in pods if p['metadata'].get('labels', {}).get('app') == app)} for app in ['first', 'second']}
        print('Running initial successful waves', flush=True)
        _, p1 = revision('nonce-1')
        root_sync(p1)
        wait(lambda: completed(p1), 'initial root operation did not succeed')
        wait(lambda: all((get('job', app + '-verify', namespace='fixture') or {}).get('status', {}).get('succeeded') == 1 for app in ['first', 'second']), 'initial verification jobs missing')
        first = ids()
        print('Repeating unchanged images with a fresh nonce', flush=True)
        v2, p2 = revision('nonce-2')
        root_sync(p2)
        wait(lambda: completed(p2), 'second root operation did not succeed')
        wait(lambda: all((job := get('job', app + '-verify', namespace='fixture') or {}).get('status', {}).get('succeeded') == 1
                         and job.get('metadata', {}).get('labels', {}).get('operation-nonce') == 'nonce-2'
                         for app in ['first', 'second']), 'second verification jobs missing')
        second = ids()
        for app in first:
            assert first[app]['pod'] == second[app]['pod'], 'nonce restarted app Pod'
            assert first[app]['job'] != second[app]['job'], 'PostSync Job was not recreated'
        report['checks'] += ['postsync_success_opens_next_wave', 'same_image_new_nonce_recreates_job', 'nonce_preserves_app_pod_uid', 'retained_job_before_hook_creation']
        print('Failing the first PostSync gate', flush=True)
        _, p3 = revision('nonce-3', failed=True)
        root_sync(p3)
        wait(lambda: (get('application', APPLICATIONS['first']) or {}).get('status', {}).get('operationState', {}).get('phase') == 'Failed', 'first PostSync did not fail')
        wait(lambda: (get('application', 'fixture-root') or {}).get('status', {}).get('operationState', {}).get('phase') == 'Failed', 'root operation did not fail')
        failed_uid = get('job', 'first-verify', namespace='fixture')['metadata']['uid']
        # selfHeal을 유지해도 같은 게시의 실패 hook을 새 Job으로 재실행하면 안 된다.
        stable_until = time.monotonic() + 15
        samples = 0
        while time.monotonic() < stable_until:
            assert get('job', 'first-verify', namespace='fixture')['metadata']['uid'] == failed_uid, 'selfHeal recreated failed verification'
            assert (get('application', 'fixture-root') or {}).get('status', {}).get('operationState', {}).get('phase') == 'Failed', 'selfHeal restarted root operation'
            samples += 1
            time.sleep(2)
        b = get('application', APPLICATIONS['second'])
        assert b['spec']['sources'][0]['targetRevision'] == v2, 'failed gate advanced next app source'
        assert get('job', 'second-verify', namespace='fixture')['metadata']['uid'] == second['second']['job'], 'failed gate ran next verification'
        assert not completed(p3), 'failed gate allowed root success'
        report['failedRootOperationPhase'] = (get('application', 'fixture-root') or {}).get('status', {}).get('operationState', {}).get('phase')
        failed_job = get('job', 'first-verify', namespace='fixture')
        assert failed_job['metadata']['uid'] != second['first']['job'] and failed_job['status'].get('failed') == 1
        assert ids()['first']['pod'] == second['first']['pod']
        report['checks'] += ['failed_postsync_blocks_next_application_wave', 'failed_job_retained', 'failed_gate_preserves_app_pod_uid']
        report['checks'] += ['self_heal_keeps_failed_job_uid', 'self_heal_keeps_root_terminal_failed']
        report['stability'] = {'seconds': 15, 'samples': samples, 'failedJobUid': failed_uid}
        report['syncPolicy'] = {'automated': {'enabled': True, 'selfHeal': True, 'prune': False, 'allowEmpty': False}, 'retry': {'limit': 0}}
        report['result'] = 'passed'
        (directory / 'result.json').write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps(report), flush=True)
    except Exception:
        try:
            diagnostic = {'applications': get('applications'), 'jobs': get('jobs', namespace='fixture'), 'pods': get('pods', namespace='fixture')}
            (directory / 'failure-diagnostic.json').write_text(json.dumps(diagnostic, indent=2) + '\n')
        except Exception:
            pass
        raise
    finally:
        if git_started:
            run(['docker', 'rm', '-f', git_container], check=False)
        run([args.kind, 'delete', 'cluster', '--name', args.name], check=False)
        print('Cleaned isolated cluster ' + args.name, flush=True)


if __name__ == '__main__':
    main()
