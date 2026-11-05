import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const { loadAll, load } = require('js-yaml');
const root = resolve(__dirname, '../..');
const directory = 'helm/dev/platform/argocd';
const image = `example.invalid/pulsemetry/strimzi-cmp@sha256:${'a'.repeat(64)}`;
const scrapeSecret = (content = '\n  []\n') => ({
  apiVersion: 'v1', kind: 'Secret', type: 'Opaque',
  metadata: { name: 'pulsemetry-monitoring-prometheus-scrape-confg', namespace: 'pulsemetry-observability' },
  data: { 'additional-scrape-configs.yaml': Buffer.from(content).toString('base64') },
});
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
const readerRbac = () => loadAll(readFileSync(join(root, 'helm/dev/platform/base/templates/values-reader-rbac.yaml'), 'utf8')).filter(Boolean);
function inputs(overrides = {}) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', `import {managementInputs} from './scripts/dev-argocd-management.mjs';console.log(JSON.stringify(managementInputs(${JSON.stringify({ cmpImage: image, resources, ...overrides })})))`], { cwd: root, encoding: 'utf8' });
}

describe('Argo 관리 입력과 인증 경계', () => {
  test('렌더에서 RBAC 이름만 추출하고 비인증 scrape Secret 내용도 복제하지 않는다', () => {
    const secret = scrapeSecret();
    const result = inputs({ resources: [...resources, secret] });
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain(secret.data['additional-scrape-configs.yaml']);
    expect(result.stdout).not.toContain(secret.metadata.name);
    const { argoValues, managementValues } = JSON.parse(result.stdout);
    expect(managementValues).toEqual({ reconciliationEnabled: false, managedRbac: {
      clusterRoles: ['strimzi-controller'], clusterRoleBindings: ['strimzi-controller'],
      roles: { 'pulsemetry-observability': ['observability-admission'] },
      roleBindings: { 'pulsemetry-observability': ['observability-admission'] },
      hookServiceAccounts: { 'pulsemetry-observability': ['observability-admission'] },
    } });
    expect(argoValues.configs.cm['resource.respectRBAC']).toBe('strict');
    expect(argoValues.configs.cm['cluster.inClusterEnabled']).toBe('false');
    expect(argoValues.configs.cm['resource.customizations.health.cert-manager.io_Certificate']).toBe(readFileSync(join(root, 'helm/dev/gitops/health/certificate.lua'), 'utf8'));
    expect(argoValues.configs.cm['resource.customizations.health.cert-manager.io_Issuer']).toBe(argoValues.configs.cm['resource.customizations.health.cert-manager.io_Certificate']);
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
    { reconciliationEnabled: 'true' },
    { reconciliationEnabled: null },
    { resources: [ruleObject('Role', 'wrong-role', 'pulsemetry-prod')] },
    { resources: [ruleObject('ClusterRole', 'system:cluster-admin')] },
    { resources: [resources[2]] },
    { resources: [resources[0], resources[0]] },
    { resources: [resources[1], { ...resources[2], subjects: [{ kind: 'Group', name: 'system:authenticated' }] }] },
  ])('잘못된 image·범위·bind·중복을 거부한다: %j', overrides => {
    expect(inputs(overrides).status).not.toBe(0);
  });

  test('적용용 opt-in은 Argo 연결과 관리 Secret 출력을 함께 활성화한다', () => {
    const result = inputs({ reconciliationEnabled: true });
    expect(result.status).toBe(0);
    const { argoValues, managementValues } = JSON.parse(result.stdout);
    expect(argoValues.configs.cm['cluster.inClusterEnabled']).toBe('true');
    expect(managementValues.reconciliationEnabled).toBe(true);
    expect(argoValues.repoServer.automountServiceAccountToken).toBe(false);
    expect(argoValues.extraObjects.some((item: any) => item.kind === 'Secret')).toBe(false);
  });

  test.each([
    { ...scrapeSecret(), metadata: { ...scrapeSecret().metadata, name: 'source' } },
    { ...scrapeSecret(), metadata: { ...scrapeSecret().metadata, namespace: 'kube-system' } },
    { ...scrapeSecret(), type: 'kubernetes.io/tls' },
    { ...scrapeSecret(), stringData: {} },
    { ...scrapeSecret(), data: { ...scrapeSecret().data, token: 'ZmFrZQ==' } },
    { ...scrapeSecret(), data: { 'additional-scrape-configs.yaml': 'W10=!' } },
    scrapeSecret('[]\n---\n[]'), scrapeSecret('# token: fixture\n[]'),
    scrapeSecret('- job_name: msk\n  basic_auth: { username: fixture, password: fixture }'),
    scrapeSecret('{}'),
  ])('관측 Secret 예외에 다른 이름·인증값·MSK·숨긴 입력을 넣으면 거부한다: %j', resource => {
    expect(inputs({ resources: [resource] }).status).not.toBe(0);
  });

  test('추적 base chart의 PROJ-279 Group은 동일 렌더의 다섯 Secret get Role만 연결한다', () => {
    const rendered = readerRbac();
    const result = inputs({ resources: rendered });
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    expect(JSON.parse(result.stdout).managementValues.managedRbac).toMatchObject({
      roles: { 'pulsemetry-dev': ['generated-values-reader'] },
      roleBindings: { 'pulsemetry-dev': ['generated-values-reader'] },
    });
    expect(inputs({ resources: rendered.reverse() }).status).toBe(0);
  });

  test.each([
    ['다른 Group', (role: any, binding: any) => { binding.subjects[0].name = 'system:authenticated'; }],
    ['다른 binding 이름', (role: any, binding: any) => { binding.metadata.name = 'other-reader'; }],
    ['다른 namespace', (role: any, binding: any) => { role.metadata.namespace = binding.metadata.namespace = 'kube-system'; }],
    ['subject namespace', (role: any, binding: any) => { binding.subjects[0].namespace = 'pulsemetry-dev'; }],
    ['추가 subject', (role: any, binding: any) => { binding.subjects.push({ kind: 'Group', name: 'another' }); }],
    ['다른 roleRef', (role: any, binding: any) => { binding.roleRef.kind = 'ClusterRole'; }],
    ['추가 동작', (role: any) => { role.rules[0].verbs.push('list'); }],
    ['다른 Secret', (role: any) => { role.rules[0].resourceNames[0] = 'different-secret'; }],
    ['추가 Secret', (role: any) => { role.rules[0].resourceNames.push('additional-secret'); }],
    ['resourceNames 없음', (role: any) => { delete role.rules[0].resourceNames; }],
    ['추가 규칙', (role: any) => { role.rules.push({ apiGroups: [''], resources: ['secrets'], verbs: ['get'] }); }],
  ])('PROJ-279 한정 Group 예외의 %s 확대를 거부한다', (_label, mutate) => {
    const [role, binding] = readerRbac();
    (mutate as (role: any, binding: any) => void)(role, binding);
    expect(inputs({ resources: [role, binding] }).status).not.toBe(0);
  });

  test('잘못된 YAML의 Secret 입력을 CLI 오류에 포함하지 않는다', () => {
    const temporary = mkdtempSync(join(tmpdir(), 'argocd-management-parse-'));
    try {
      const file = join(temporary, 'malformed.yaml');
      writeFileSync(file, 'apiVersion: v1\nkind: Secret\nstringData: {token: FIXTURE_DO_NOT_ECHO, broken: [}\n');
      const result = spawnSync(process.execPath, ['scripts/dev-argocd-management.mjs', '--cmp-image', image, '--rendered-manifests', file, '--output-dir', join(temporary, 'output')], { cwd: root, encoding: 'utf8' });
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('관리 렌더 YAML 구문 오류\n');
      expect(result.stderr).not.toContain('FIXTURE_DO_NOT_ECHO');
    } finally { rmSync(temporary, { recursive: true, force: true }); }
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
    expect(workload.spec.namespaceResourceWhitelist).toContainEqual({ group: 'batch', kind: 'Job' });
    const platform = projects.find(p => p.metadata.name === 'pulsemetry-dev-platform');
    expect(platform.spec.destinations).toContainEqual({ server: 'https://kubernetes.default.svc', namespace: 'cert-manager' });
    expect(platform.spec.namespaceResourceWhitelist).toEqual(expect.arrayContaining([
      { group: 'cert-manager.io', kind: 'Certificate' }, { group: 'cert-manager.io', kind: 'Issuer' },
    ]));
    expect(platform.spec.clusterResourceWhitelist.map((v: any) => v.kind)).not.toContain('ClusterIssuer');
    expect(workload.spec.namespaceResourceWhitelist.some((v: any) => v.group === 'cert-manager.io')).toBe(false);
    for (const project of projects) {
      expect(JSON.stringify(project.spec)).not.toContain('*');
      expect(project.spec.destinations.every((d: any) => !/prod|perf/.test(d.namespace))).toBe(true);
    }
  });

  test('기본 연결은 닫혀 있고 opt-in은 인증 원문 없는 namespace 제한 연결만 등록한다', () => {
    expect(docs.filter(doc => doc.kind === 'Secret')).toEqual([]);
    const input = JSON.parse(inputs({ reconciliationEnabled: true }).stdout);
    writeFileSync(join(temporary, 'active-management.json'), JSON.stringify(input.managementValues));
    writeFileSync(join(temporary, 'active-argocd.json'), JSON.stringify(input.argoValues));
    const active = helm(['template', 'argocd-management', `${directory}/management`, '--namespace', 'argocd', '-f', join(temporary, 'active-management.json')]);
    expect(active.status).toBe(0);
    const secrets = loadAll(active.stdout).filter((doc: any) => doc?.kind === 'Secret');
    expect(secrets).toHaveLength(1);
    expect(secrets[0]).toEqual({
      apiVersion: 'v1', kind: 'Secret',
      metadata: { name: 'argocd-dev-in-cluster', namespace: 'argocd', labels: { 'argocd.argoproj.io/secret-type': 'cluster' } },
      type: 'Opaque',
      stringData: {
        name: 'pulsemetry-dev', server: 'https://kubernetes.default.svc',
        namespaces: 'argocd,kube-system,cert-manager,pulsemetry-dev,pulsemetry-dev-logs,pulsemetry-observability,strimzi-system',
        clusterResources: 'true', config: '{}',
      },
    });
    const source = JSON.parse(readFileSync(join(root, directory, 'SOURCE.json'), 'utf8'));
    const argo = helm(['template', 'argocd', `${directory}/vendor/argo-cd-${source.chart.version}.tgz`, '--namespace', 'argocd', '-f', `${directory}/values.yaml`, '-f', join(temporary, 'active-argocd.json')]);
    expect(argo.status).toBe(0);
    const config = loadAll(argo.stdout).find((doc: any) => doc?.kind === 'ConfigMap' && doc.metadata.name === 'argocd-cm');
    expect(config.data['cluster.inClusterEnabled']).toBe('true');
    expect(helm(['template', 'argocd-management', `${directory}/management`, '--set-string', 'reconciliationEnabled=true']).status).not.toBe(0);
  });

  test('LBC 인증서 선언 쓰기는 kube-system만, 파생 CertificateRequest는 읽기만 허용한다', () => {
    const managers = docs.filter(doc => doc.kind === 'Role' && doc.metadata.name === 'argocd-dev-manager');
    for (const manager of managers) {
      const certRules = manager.rules.filter((rule: any) => rule.apiGroups.includes('cert-manager.io'));
      const writes = certRules.filter((rule: any) => rule.verbs.some((verb: string) => ['create', 'update', 'patch', 'delete'].includes(verb)));
      if (manager.metadata.namespace === 'kube-system') {
        expect(writes).toEqual([{ apiGroups: ['cert-manager.io'], resources: ['certificates', 'issuers'], verbs: ['create', 'update', 'patch'] }]);
      } else expect(writes).toEqual([]);
      for (const rule of certRules.filter((rule: any) => rule.resources.includes('certificaterequests'))) expect(rule.verbs).toEqual(['get', 'list', 'watch']);
      if (manager.metadata.namespace === 'cert-manager') {
        expect(manager.rules.flatMap((rule: any) => rule.resources)).not.toEqual(expect.arrayContaining(['persistentvolumeclaims']));
        expect(manager.rules.flatMap((rule: any) => rule.apiGroups)).not.toEqual(expect.arrayContaining(['kafka.strimzi.io']));
        expect(manager.rules.flatMap((rule: any) => rule.apiGroups)).not.toEqual(expect.arrayContaining(['secrets-store.csi.x-k8s.io']));
      }
    }
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
        if (rule.resources.includes('secrets')) {
          if (rule.resourceNames) {
            expect(doc.metadata).toMatchObject({ namespace: 'pulsemetry-observability', name: 'argocd-dev-manager' });
            expect(rule.resourceNames).toEqual(['pulsemetry-monitoring-prometheus-scrape-confg']);
            expect(rule.verbs).toEqual(['update', 'patch']);
          } else expect(rule.verbs).toEqual(['get', 'list', 'watch']);
        }
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

  test('실제 CSI·관측·cert-manager hook의 ServiceAccount 정리 권한을 정확한 이름으로 공급한다', () => {
    const real = [
      ['secrets-store-csi-driver', 'helm/dev/runtime/vendor/secrets-store-csi-driver-1.6.1', 'kube-system', 'helm/dev/runtime/csi-driver-values.yaml'],
      ['observability', 'helm/observability/pulsemetry-observability', 'pulsemetry-observability', 'helm/observability/tests/generated-values.yaml'],
      ['cert-manager', 'helm/dev/platform/cert-manager/chart', 'cert-manager', 'helm/dev/platform/cert-manager/values.yaml'],
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
    expect(hooks).toEqual(expect.arrayContaining([expect.objectContaining({ metadata: expect.objectContaining({ name: 'cert-manager-startupapicheck', namespace: 'cert-manager' }) })]));
    for (const hook of hooks) {
      const rules = managers.find((d: any) => d.metadata.namespace === hook.metadata.namespace).rules;
      const deletion = rules.find((r: any) => r.resources.includes('serviceaccounts') && r.verbs.includes('delete'));
      expect(deletion.resourceNames).toContain(hook.metadata.name);
      expect(deletion.resourceNames).not.toContain('default');
    }
  });

  test('실제 Strimzi 관측 렌더의 빈 scrape Secret만 검증하고 인증 원문을 출력하지 않는다', () => {
    const rendered = helm(['template', 'observability', 'helm/observability/pulsemetry-observability', '--namespace', 'pulsemetry-observability', '--kube-version', '1.36.0', '--skip-tests', '-f', 'helm/observability/tests/generated-values.yaml', '--set', 'global.pulsemetry.kafkaProvider=strimzi,global.pulsemetry.kafkaClusterName=telemetry']);
    expect({ status: rendered.status, stderr: rendered.stderr }).toEqual({ status: 0, stderr: '' });
    const secrets = loadAll(rendered.stdout).filter((doc: any) => doc?.kind === 'Secret');
    expect(secrets).toHaveLength(1);
    expect(secrets[0].metadata).toMatchObject(scrapeSecret().metadata);
    const generated = inputs({ resources: secrets });
    expect({ status: generated.status, stderr: generated.stderr }).toEqual({ status: 0, stderr: '' });
    expect(generated.stdout).not.toContain('additional-scrape-configs.yaml');
  });
});
