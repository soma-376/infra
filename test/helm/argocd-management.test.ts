import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const { loadAll, load } = require('js-yaml');
const root = resolve(__dirname, '../..');
const directory = 'helm/dev/platform/argocd';
const image = `example.invalid/pulsemetry/strimzi-cmp@sha256:${'a'.repeat(64)}`;
const ruleObject = (kind: string, name: string, namespace?: string, extras = {}) => ({
  apiVersion: 'rbac.authorization.k8s.io/v1', kind, metadata: { name, ...(namespace ? { namespace } : {}) }, ...extras,
});
const resources = [
  { apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: 'observability-admission', namespace: 'pulsemetry-observability', annotations: { 'helm.sh/hook': 'pre-install,pre-upgrade,post-install,post-upgrade', 'helm.sh/hook-delete-policy': 'before-hook-creation,hook-succeeded' } } },
  ruleObject('ClusterRole', 'strimzi-controller'),
  ruleObject('ClusterRoleBinding', 'strimzi-controller', undefined, {
    roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'strimzi-controller' },
    subjects: [{ kind: 'ServiceAccount', name: 'strimzi-cluster-operator', namespace: 'strimzi-system' }],
  }),
  ruleObject('Role', 'observability-admission', 'pulsemetry-observability'),
  ruleObject('RoleBinding', 'observability-admission', 'pulsemetry-observability', {
    roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: 'observability-admission' },
    subjects: [{ kind: 'ServiceAccount', name: 'observability-admission', namespace: 'pulsemetry-observability' }],
  }),
];
function inputs(overrides = {}) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', `import {managementInputs} from './scripts/dev-argocd-management.mjs';console.log(JSON.stringify(managementInputs(${JSON.stringify({ cmpImage: image, resources, ...overrides })})))`], { cwd: root, encoding: 'utf8' });
}

describe('Argo 관리 입력과 인증 경계', () => {
  test('렌더에서 RBAC 이름만 추출하고 앱/CLI 비밀을 복제하지 않는다', () => {
    const result = inputs({ resources: [...resources, { apiVersion: 'v1', kind: 'Secret', metadata: { name: 'source' }, stringData: { sensitive: 'DO_NOT_COPY' } }] });
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('DO_NOT_COPY');
    const { argoValues, managementValues } = JSON.parse(result.stdout);
    expect(managementValues).toEqual({ reconciliationEnabled: false, managedRbac: {
      clusterRoles: ['strimzi-controller'], clusterRoleBindings: ['strimzi-controller'],
      roles: { 'pulsemetry-observability': ['observability-admission'] },
      roleBindings: { 'pulsemetry-observability': ['observability-admission'] },
      hookServiceAccounts: { 'pulsemetry-observability': ['observability-admission'] },
    } });
    expect(argoValues.configs.cm['resource.respectRBAC']).toBe('strict');
    expect(argoValues.configs.cm['cluster.inClusterEnabled']).toBe('false');
    expect(argoValues.configs.repositories).toBeUndefined();
    expect(argoValues.configs.credentialTemplates).toBeUndefined();
    const sidecar = argoValues.repoServer.extraContainers[0];
    expect(sidecar.image).toBe(image);
    expect(sidecar.securityContext).toMatchObject({ runAsUser: 999, runAsNonRoot: true, readOnlyRootFilesystem: true });
    expect(sidecar.volumeMounts.find((v: any) => v.mountPath === '/tmp').name).toBe('strimzi-cmp-tmp');
    expect(argoValues.repoServer.volumes.every((v: any) => !v.secret)).toBe(true);
    const plugin = load(argoValues.extraObjects[0].data['plugin.yaml']);
    expect(plugin.spec).toMatchObject({ provideGitCreds: false, preserveFileMode: false });
  });
  test.each([
    { cmpImage: 'example.invalid/cmp:latest' },
    { resources: [ruleObject('Role', 'wrong-role', 'pulsemetry-prod')] },
    { resources: [ruleObject('ClusterRole', 'system:cluster-admin')] },
    { resources: [resources[2]] },
    { resources: [resources[0], resources[0]] },
    { resources: [resources[1], { ...resources[2], subjects: [{ kind: 'Group', name: 'system:authenticated' }] }] },
  ])('잘못된 image·범위·bind·중복을 거부한다: %j', overrides => {
    expect(inputs(overrides).status).not.toBe(0);
  });
});

const renderSuite = process.env.HELM_BIN ? describe : describe.skip;
renderSuite('Argo 관리 chart의 적용·거부 범위', () => {
  let docs: any[];
  let temporary: string;
  const helm = (args: string[]) => spawnSync(process.env.HELM_BIN!, args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  beforeAll(() => {
    temporary = mkdtempSync(join(tmpdir(), 'argocd-management-test-'));
    const result = inputs();
    expect(result.status).toBe(0);
    const { argoValues, managementValues } = JSON.parse(result.stdout);
    writeFileSync(join(temporary, 'management.json'), JSON.stringify(managementValues));
    writeFileSync(join(temporary, 'argocd.json'), JSON.stringify(argoValues));
    const rendered = helm(['template', 'argocd-management', `${directory}/management`, '--namespace', 'argocd', '-f', join(temporary, 'management.json')]);
    expect(rendered.status).toBe(0);
    docs = loadAll(rendered.stdout).filter(Boolean);
  });
  afterAll(() => rmSync(temporary, { recursive: true, force: true }));

  test('root는 Application만 관리하며 platform·workload 목적지와 종류를 분리한다', () => {
    const projects = docs.filter(doc => doc.kind === 'AppProject');
    expect(projects).toHaveLength(3);
    const rootProject = projects.find(p => p.metadata.name === 'pulsemetry-dev-root');
    expect(rootProject.spec.namespaceResourceWhitelist).toEqual([{ group: 'argoproj.io', kind: 'Application' }]);
    expect(rootProject.spec.clusterResourceWhitelist).toEqual([]);
    const workload = projects.find(p => p.metadata.name === 'pulsemetry-dev-workloads');
    expect(workload.spec.destinations).toEqual([{ server: 'https://kubernetes.default.svc', namespace: 'pulsemetry-dev' }]);
    expect(workload.spec.namespaceResourceWhitelist.map((v: any) => v.kind)).not.toContain('Secret');
    for (const project of projects) {
      expect(JSON.stringify(project.spec)).not.toContain('*');
      expect(project.spec.destinations.every((d: any) => !/prod|perf/.test(d.namespace))).toBe(true);
    }
  });

  test('실제 인계 전 클러스터 연결을 등록하지 않고 활성화를 거부한다', () => {
    expect(docs.filter(doc => doc.kind === 'Secret')).toEqual([]);
    expect(helm(['template', 'argocd-management', `${directory}/management`, '--set', 'reconciliationEnabled=true']).status).not.toBe(0);
  });

  test('controller만 쓰기를 받고 서버는 viewer이며 bind/escalate는 렌더 이름으로 제한한다', () => {
    for (const doc of docs.filter(doc => ['Role', 'ClusterRole'].includes(doc.kind))) {
      for (const rule of doc.rules) {
        expect(rule.apiGroups).not.toContain('*');
        expect(rule.resources).not.toContain('*');
        expect(rule.verbs).not.toContain('*');
        expect(rule.verbs).not.toContain('impersonate');
        if (rule.verbs.some((verb: string) => ['bind', 'escalate'].includes(verb))) {
          expect(rule.resourceNames?.length).toBeGreaterThan(0);
          expect(rule.resourceNames.every((name: string) => ['strimzi-controller', 'observability-admission'].includes(name))).toBe(true);
        }
        if (doc.metadata.name === 'argocd-dev-viewer') expect(rule.verbs.every((verb: string) => ['get', 'list', 'watch'].includes(verb))).toBe(true);
        if (rule.resources.includes('serviceaccounts') && rule.verbs.includes('delete')) expect(rule.resourceNames).toEqual(['observability-admission']);
        if (rule.resources.includes('secrets')) expect(rule.verbs).toEqual(['get', 'list', 'watch']);
        if (rule.resources.includes('persistentvolumeclaims') || rule.resources.includes('customresourcedefinitions')) expect(rule.verbs).not.toContain('delete');
      }
    }
    const clusterBinding = docs.find(doc => doc.kind === 'ClusterRoleBinding' && doc.metadata.name === 'argocd-dev-manager');
    expect(clusterBinding.subjects).toEqual([{ kind: 'ServiceAccount', name: 'argocd-application-controller', namespace: 'argocd' }]);
    expect(docs.find(doc => doc.kind === 'ClusterRoleBinding' && doc.metadata.name === 'argocd-dev-viewer').subjects).toEqual([{ kind: 'ServiceAccount', name: 'argocd-server', namespace: 'argocd' }]);
  });

  test('고정 bootstrap에 관리 overlay를 합쳐도 repo-server에 API·Git credential을 mount하지 않는다', () => {
    const source = JSON.parse(readFileSync(join(root, directory, 'SOURCE.json'), 'utf8'));
    const rendered = helm(['template', 'argocd', `${directory}/vendor/argo-cd-${source.chart.version}.tgz`, '--namespace', 'argocd', '-f', `${directory}/values.yaml`, '-f', join(temporary, 'argocd.json')]);
    expect(rendered.status).toBe(0);
    const all = loadAll(rendered.stdout).filter(Boolean);
    const pod = all.find((d: any) => d.kind === 'Deployment' && d.metadata.name === 'argocd-repo-server').spec.template.spec;
    expect(pod.automountServiceAccountToken).toBe(false);
    const cmp = pod.containers.find((c: any) => c.name === 'strimzi-cmp');
    expect(cmp.image).toBe(image);
    expect(cmp.volumeMounts.map((v: any) => v.name)).not.toContain('argocd-repo-server-tls');
    expect(all.filter((d: any) => d.kind === 'ClusterRole')).toEqual([]);
    expect(all.filter((d: any) => d.kind === 'Secret' && d.metadata.labels?.['argocd.argoproj.io/secret-type'] === 'repository')).toEqual([]);
  });

  test('실제 CSI·관측 hook의 ServiceAccount 정리 권한을 정확한 이름으로 공급한다', () => {
    const real = [
      ['secrets-store-csi-driver', 'helm/dev/runtime/vendor/secrets-store-csi-driver-1.6.1', 'kube-system', 'helm/dev/runtime/csi-driver-values.yaml'],
      ['observability', 'helm/observability/pulsemetry-observability', 'pulsemetry-observability', 'helm/observability/tests/generated-values.yaml'],
    ].flatMap(([release, chart, namespace, values]) => {
      const result = helm(['template', release, chart, '--namespace', namespace, '--kube-version', '1.36.0', '--skip-tests', '-f', values]);
      expect(result.status).toBe(0);
      return loadAll(result.stdout).filter((d: any) => d?.apiVersion === 'rbac.authorization.k8s.io/v1' || d?.kind === 'ServiceAccount');
    });
    const generated = inputs({ resources: real });
    expect({ status: generated.status, stderr: generated.stderr }).toEqual({ status: 0, stderr: '' });
    const values = JSON.parse(generated.stdout).managementValues;
    writeFileSync(join(temporary, 'real-hooks.json'), JSON.stringify(values));
    const rendered = helm(['template', 'argocd-management', `${directory}/management`, '--namespace', 'argocd', '-f', join(temporary, 'real-hooks.json')]);
    expect(rendered.status).toBe(0);
    const managers = loadAll(rendered.stdout).filter((d: any) => d?.kind === 'Role' && d.metadata.name === 'argocd-dev-manager');
    const hooks = real.filter((d: any) => d.kind === 'ServiceAccount' && d.metadata.annotations?.['helm.sh/hook-delete-policy']);
    expect(hooks.length).toBeGreaterThanOrEqual(3);
    for (const hook of hooks) {
      const rules = managers.find((d: any) => d.metadata.namespace === hook.metadata.namespace).rules;
      const deletion = rules.find((r: any) => r.resources.includes('serviceaccounts') && r.verbs.includes('delete'));
      expect(deletion.resourceNames).toContain(hook.metadata.name);
      expect(deletion.resourceNames).not.toContain('default');
    }
  });
});
