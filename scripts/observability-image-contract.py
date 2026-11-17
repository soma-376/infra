#!/usr/bin/env python3
"""공식 OCI index의 ARM64 manifest를 확인한다. 이미지를 실행하거나 배포하지 않는다."""
import argparse, concurrent.futures, datetime, hashlib, json, pathlib, subprocess
IMAGES = [
    'quay.io/prometheus/prometheus:v3.9.1',
    'docker.io/grafana/grafana:12.3.1',
    'quay.io/prometheus-operator/prometheus-operator:v0.88.0',
    'quay.io/prometheus-operator/prometheus-config-reloader:v0.88.0',
    'registry.k8s.io/kube-state-metrics/kube-state-metrics:v2.18.0',
    'quay.io/prometheus/node-exporter:v1.10.2',
    'ghcr.io/jkroepke/kube-webhook-certgen:1.7.4',
    'cr.fluentbit.io/fluent/fluent-bit:5.1.3',
]
# Loki·Tempo·플랫폼 Collector(ADR-0039). wrapper chart values의 digest와 함께 바꾼다.
PLATFORM_TRACE_IMAGES = [
    'docker.io/grafana/loki:3.7.8',
    'docker.io/grafana/tempo:3.1.0',
    'docker.io/otel/opentelemetry-collector-k8s:0.161.0',
]
# dev 부하 시험 k6 Job과 지표 sidecar(ADR-0064). helm/dev/loadtest values의 digest와 함께 바꾼다.
# k8s 배포판에는 prometheus exporter가 없어 sidecar는 core 배포판을 쓴다.
# digest로 고정한다 — k6 1.8.2 tag는 2026-11 재게시돼 다른 index를 가리킨다. k6는 dependencies.lock.json의 k6Image와 같은 index다.
LOADTEST_IMAGES = [
    'docker.io/grafana/k6:1.8.2@sha256:bd6ae8607c0a05d0dc0dc3f5753c464b0929baf083ef0f20b7eed845a3d9e6b4',
    'docker.io/otel/opentelemetry-collector:0.161.0@sha256:b6d2b9a85b1029d05b5ad913150c1f014eed4ae99be81a1813ca5ade4a191913',
]
SETS = {'observability': IMAGES, 'platform-trace': PLATFORM_TRACE_IMAGES, 'loadtest': LOADTEST_IMAGES}
def inspect(image):
    raw = subprocess.check_output(['docker', 'buildx', 'imagetools', 'inspect', '--raw', image], timeout=60)
    index = json.loads(raw)
    arm = [m for m in index.get('manifests', []) if m.get('platform', {}).get('os') == 'linux' and m['platform'].get('architecture') == 'arm64']
    if not arm:
        raise RuntimeError(f'{image}: linux/arm64 manifest 없음')
    index_sha = hashlib.sha256(raw.rstrip(b'\n')).hexdigest()
    # digest로 고정한 참조는 받은 index 바이트가 그 digest와 같아야 한다.
    if '@sha256:' in image and image.rsplit('@sha256:', 1)[1] != index_sha:
        raise RuntimeError(f'{image}: index digest 불일치 {index_sha}')
    return {'image': image, 'linux_arm64_digests': [m['digest'] for m in arm], 'manifest_index_sha256': index_sha}
if __name__ == '__main__':
    parser=argparse.ArgumentParser(); parser.add_argument('--output', required=True); parser.add_argument('--set', choices=sorted(SETS), default='observability'); args=parser.parse_args()
    path=pathlib.Path(args.output)
    if path.exists(): parser.error('증거 파일을 덮어쓸 수 없다. 새 --output 경로를 사용한다.')
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool: images=list(pool.map(inspect,SETS[args.set]))
    path.write_text(json.dumps({'status':'PASS','scope':'registry-manifest-platform-only','set':args.set,'verified_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'images':images},indent=2)+'\n')
    print(f'{len(images)}개 공식 이미지의 linux/arm64 manifest 확인: {path}')
