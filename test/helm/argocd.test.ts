import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const { load, loadAll } = require('js-yaml');
const root = resolve(__dirname, '../..');
const directory = 'helm/dev/platform/argocd';
const read = (file: string) => readFileSync(join(root, directory, file), 'utf8');
const source = JSON.parse(read('SOURCE.json'));
const archive = join(directory, 'vendor', `argo-cd-${source.chart.version}.tgz`);
const values = load(read('values.yaml'));
const bootstrapProject = load(read('bootstrap-default-project.yaml'));
const digestPattern = /^sha256:[0-9a-f]{64}$/;

describe('Argo CD 설치 원본과 bootstrap 경계', () => {
  test('공식 chart archive와 SHA256SUMS가 같은 고정 원본을 가리킨다', () => {
    const checksum = createHash('sha256').update(readFileSync(join(root, archive))).digest('hex');
    expect(source.chart).toMatchObject({ version: '10.11.7', appVersion: 'v3.5.7', sha256: checksum });
    expect(source.chart.url).toBe(`https://github.com/argoproj/argo-helm/releases/download/argo-cd-${source.chart.version}/argo-cd-${source.chart.version}.tgz`);
    expect(read('SHA256SUMS').trim()).toBe(`${checksum}  vendor/argo-cd-${source.chart.version}.tgz`);
    expect(source).toMatchObject({ helmVersion: '3.22.0', kubernetesVersion: '1.36.0' });
    const extracted = spawnSync('tar', ['-xOf', join(root, archive), 'argo-cd/Chart.yaml'], { encoding: 'utf8' });
    expect({ status: extracted.status, stderr: extracted.stderr }).toEqual({ status: 0, stderr: '' });
    expect(load(extracted.stdout)).toMatchObject({ name: 'argo-cd', version: source.chart.version, appVersion: source.chart.appVersion });
  });

  test('실행 이미지의 digest와 ARM64 근거를 고정하며 AWS·Git 자격증명을 입력하지 않는다', () => {
    expect(Object.keys(source.images).sort()).toEqual(['argocd', 'redis']);
    for (const image of Object.values(source.images) as any[]) {
      expect(image.digest).toMatch(digestPattern);
      const platform = image.platforms.find((item: any) => item.os === 'linux' && item.architecture === 'arm64');
      expect(platform).toBeDefined();
      expect(platform.digest).toMatch(digestPattern);
      expect(image.manifestUrl).toMatch(/^https:\/\//);
    }
    // Redis는 ARM64 단일 manifest를 직접 고정한다.
    expect(source.images.redis.platforms).toContainEqual(expect.objectContaining({ os: 'linux', architecture: 'arm64', digest: source.images.redis.digest }));
    expect(values.global.image).toMatchObject({ repository: source.images.argocd.repository, tag: `${source.images.argocd.tag}@${source.images.argocd.digest}` });
    expect(values.redis.image).toMatchObject({ repository: source.images.redis.repository, tag: `${source.images.redis.tag}@${source.images.redis.digest}` });
    expect(values.configs?.repositories ?? {}).toEqual({});
    expect(values.configs?.credentialTemplates ?? {}).toEqual({});
    expect(values.global.imagePullSecrets ?? []).toEqual([]);
  });

  test('default project는 저장소·대상과 namespaced·cluster 리소스를 모두 허용하지 않는다', () => {
    expect(bootstrapProject).toMatchObject({
      apiVersion: 'argoproj.io/v1alpha1', kind: 'AppProject',
      metadata: { name: 'default', namespace: 'argocd' },
      spec: {
        sourceRepos: [], destinations: [], clusterResourceWhitelist: [],
        namespaceResourceBlacklist: [{ group: '*', kind: '*' }],
      },
    });
    expect(bootstrapProject.metadata.finalizers ?? []).toEqual([]);
    expect(bootstrapProject.spec.roles ?? []).toEqual([]);
    expect(bootstrapProject.spec.sourceNamespaces ?? []).toEqual([]);
  });
});

// 일반 로컬 테스트는 원본 검사를 항상 실행하고, CI는 고정 Helm 존재·버전을 먼저 확인한다.
const renderSuite = process.env.HELM_BIN ? describe : describe.skip;
renderSuite('Argo CD 고정 Helm 렌더 계약', () => {
  let docs: any[];
  let workloads: any[];
  const helm = (args: string[]) => spawnSync(process.env.HELM_BIN!, args, {
    cwd: root, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024,
  });

  beforeAll(() => {
    const version = helm(['version', '--short']);
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toMatch(/^v3\.22\.0(?:\+|$)/);
    const lint = helm(['lint', archive, '--strict', '--kube-version', source.kubernetesVersion, '-f', `${directory}/values.yaml`]);
    expect({ status: lint.status, stderr: lint.stderr }).toEqual({ status: 0, stderr: '' });
    const rendered = helm(['template', 'argocd', archive, '--namespace', 'argocd', '--kube-version', source.kubernetesVersion,
      '-f', `${directory}/values.yaml`]);
    expect({ status: rendered.status, stderr: rendered.stderr }).toEqual({ status: 0, stderr: '' });
    docs = loadAll(rendered.stdout).filter(Boolean);
    workloads = docs.filter(doc => ['Deployment', 'StatefulSet', 'Job'].includes(doc.kind));
  });

  test('CRD 세 개를 보존하고 설치 권한을 argocd namespace에 한정한다', () => {
    const crds = docs.filter(doc => doc.kind === 'CustomResourceDefinition');
    expect(crds.map(doc => doc.metadata.name).sort()).toEqual(['applications.argoproj.io', 'applicationsets.argoproj.io', 'appprojects.argoproj.io']);
    for (const crd of crds) {
      expect(crd.metadata.annotations['helm.sh/resource-policy']).toBe('keep');
      expect(crd.spec.scope).toBe('Namespaced');
    }
    for (const doc of docs.filter(doc => doc.kind !== 'CustomResourceDefinition')) expect(doc.metadata.namespace).toBe('argocd');
    expect(docs.filter(doc => ['ClusterRole', 'ClusterRoleBinding', 'Application', 'ApplicationSet', 'AppProject'].includes(doc.kind))).toEqual([]);
    const roles = docs.filter(doc => doc.kind === 'Role');
    const bindings = docs.filter(doc => doc.kind === 'RoleBinding');
    expect(roles.length).toBeGreaterThan(0);
    expect(bindings.length).toBeGreaterThan(0);
    for (const binding of bindings) {
      expect(binding.roleRef.kind).toBe('Role');
      expect(roles.some(role => role.metadata.name === binding.roleRef.name)).toBe(true);
      for (const subject of binding.subjects) expect(subject).toMatchObject({ kind: 'ServiceAccount', namespace: 'argocd' });
    }
    const projectSchema = crds.find(doc => doc.metadata.name === 'appprojects.argoproj.io').spec.versions
      .find((version: any) => version.name === 'v1alpha1').schema.openAPIV3Schema.properties.spec;
    for (const field of Object.keys(bootstrapProject.spec)) expect(projectSchema.properties[field]).toBeDefined();
    for (const field of ['sourceRepos', 'destinations', 'clusterResourceWhitelist', 'namespaceResourceBlacklist']) {
      expect(projectSchema.properties[field].type).toBe('array');
      expect(Array.isArray(bootstrapProject.spec[field])).toBe(true);
    }
    expect(projectSchema.properties.namespaceResourceBlacklist.items.properties).toMatchObject({ group: { type: 'string' }, kind: { type: 'string' } });
  });

  test('필수 구성만 비 HA로 실행하고 모든 container·initContainer를 검증한 digest에 고정한다', () => {
    const running = workloads.filter(doc => doc.kind === 'Job' || doc.spec.replicas > 0);
    expect(running.map(doc => doc.metadata.name).sort()).toEqual([
      'argocd-application-controller', 'argocd-redis', 'argocd-redis-secret-init', 'argocd-repo-server', 'argocd-server',
    ]);
    for (const workload of running.filter(doc => doc.kind !== 'Job')) expect(workload.spec.replicas).toBe(1);
    expect(workloads.find(doc => doc.metadata.name === 'argocd-applicationset-controller').spec.replicas).toBe(0);
    const allowedImages = new Set((Object.values(source.images) as any[]).map(image => `${image.repository}:${image.tag}@${image.digest}`));
    for (const workload of workloads) {
      const pod = workload.spec.template.spec;
      for (const container of [...pod.containers, ...(pod.initContainers ?? [])]) expect(allowedImages.has(container.image)).toBe(true);
      expect(pod.volumes?.some((volume: any) => volume.persistentVolumeClaim)).not.toBe(true);
    }
    expect(docs.filter(doc => doc.kind === 'PersistentVolumeClaim')).toEqual([]);
  });

  test('기존 ARM64 apps 노드에 배치하고 필수 구성의 메모리 예산을 제한한다', () => {
    const budget: Record<string, { cpu: string; memory: string; limit: string }> = {
      'argocd-application-controller': { cpu: '250m', memory: '512Mi', limit: '1Gi' },
      'argocd-repo-server': { cpu: '100m', memory: '256Mi', limit: '1Gi' },
      'argocd-server': { cpu: '100m', memory: '128Mi', limit: '512Mi' },
      'argocd-redis': { cpu: '50m', memory: '128Mi', limit: '256Mi' },
      'argocd-redis-secret-init': { cpu: '50m', memory: '64Mi', limit: '128Mi' },
    };
    for (const workload of workloads) {
      const pod = workload.spec.template.spec;
      expect(pod.nodeSelector).toMatchObject({ 'kubernetes.io/os': 'linux', 'kubernetes.io/arch': 'arm64', 'karpenter.sh/nodepool': 'pulsemetry-dev-apps' });
      expect(pod.tolerations ?? []).toEqual([]);
      expect(pod.hostNetwork ?? false).toBe(false);
      const resource = budget[workload.metadata.name];
      if (resource) {
        expect(pod.containers[0].resources).toEqual({ requests: { cpu: resource.cpu, memory: resource.memory }, limits: { memory: resource.limit } });
      }
      for (const container of [...pod.containers, ...(pod.initContainers ?? [])]) {
        expect(container.resources?.limits?.cpu).toBeUndefined();
        expect((container.ports ?? []).every((port: any) => !port.hostPort)).toBe(true);
      }
    }
  });

  test('관리 접속은 ClusterIP와 인증을 유지하고 자동 인계·private Git 연결을 만들지 않는다', () => {
    expect(docs.filter(doc => ['Ingress', 'Gateway', 'HTTPRoute', 'TargetGroupBinding'].includes(doc.kind))).toEqual([]);
    const services = docs.filter(doc => doc.kind === 'Service');
    expect(services.length).toBeGreaterThan(0);
    for (const service of services) {
      expect(service.spec.type ?? 'ClusterIP').toBe('ClusterIP');
      expect(service.spec.externalIPs ?? []).toEqual([]);
      expect(service.spec.ports.every((port: any) => !port.nodePort)).toBe(true);
    }
    const config = docs.find(doc => doc.kind === 'ConfigMap' && doc.metadata.name === 'argocd-cm');
    expect(config.data).toMatchObject({ 'cluster.inClusterEnabled': 'false', 'admin.enabled': 'true', 'users.anonymous.enabled': 'false', 'exec.enabled': 'false', 'application.resourceTrackingMethod': 'annotation' });
    const params = docs.find(doc => doc.kind === 'ConfigMap' && doc.metadata.name === 'argocd-cmd-params-cm');
    expect(params.data).toMatchObject({ 'server.insecure': 'false' });
    for (const name of ['argocd-repo-server', 'argocd-redis']) {
      expect(workloads.find(doc => doc.metadata.name === name).spec.template.spec.automountServiceAccountToken).toBe(false);
    }
    for (const secret of docs.filter(doc => doc.kind === 'Secret')) {
      expect(secret.metadata.labels?.['argocd.argoproj.io/secret-type']).toBeUndefined();
      expect(secret.data ?? {}).toEqual({});
      expect(secret.stringData ?? {}).toEqual({});
    }
    for (const serviceAccount of docs.filter(doc => doc.kind === 'ServiceAccount')) {
      expect(serviceAccount.metadata.annotations?.['eks.amazonaws.com/role-arn']).toBeUndefined();
    }
  });
});
