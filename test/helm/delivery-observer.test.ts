import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
const yaml = require('js-yaml');
const helm = process.env.HELM_BIN;
const suite = helm ? describe : describe.skip;

suite('Argo 배포 관측과 검증 Job 제거', () => {
  const root = resolve(__dirname, '../..');
  const chart = resolve(root, 'helm/dev/workloads/spring-app');
  const applicationNames = JSON.parse(readFileSync(resolve(root, 'helm/dev/gitops/catalog.json'), 'utf8')).applications.map((app: any) => app.name);
  const values = {
    ...yaml.load(readFileSync(resolve(root, 'helm/dev/workloads/enrollment-api.yaml'), 'utf8')),
    image: { repository: 'example.invalid/enrollment-api', digest: `sha256:${'a'.repeat(64)}` },
  };
  function render(input: any, path = chart) {
    const directory = mkdtempSync(resolve(tmpdir(), 'delivery-helm-'));
    try {
      writeFileSync(resolve(directory, 'values.json'), JSON.stringify(input));
      return spawnSync(helm!, ['template', 'enrollment-api', path, '--namespace', 'pulsemetry-dev', '--kube-version', '1.36.0', '-f', resolve(directory, 'values.json')], { encoding: 'utf8' });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
  function docs(input: any, path = chart) {
    const result = render(input, path);
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    return yaml.loadAll(result.stdout).filter(Boolean);
  }
  test('앱은 검증 Job 없이 렌더하고 제거한 검증 입력은 거부한다', () => {
    const resources = docs(values);
    expect(resources.some((resource: any) => resource.kind === 'Deployment')).toBe(true);
    expect(resources.some((resource: any) => resource.kind === 'Job')).toBe(false);
    expect(resources.some((resource: any) => resource.metadata.annotations?.['argocd.argoproj.io/hook'])).toBe(false);
    expect(resources.some((resource: any) => resource.metadata.name.endsWith('-verification'))).toBe(false);
    expect(render({ ...values, deliveryVerification: { enabled: true } }).status).not.toBe(0);
  });
  test('관측 chart는 기본 비활성이고 root와 정확한 18개 Application의 get만 허용한다', () => {
    const support = resolve(root, 'helm/dev/platform/delivery-observer');
    expect(docs({}, support)).toEqual([]);
    const input = { enabled: true, applicationNames };
    const resources = docs(input, support);
    expect(resources.map((resource: any) => resource.kind)).toEqual(['Role', 'RoleBinding']);
    expect(resources.every((resource: any) => resource.metadata.namespace === 'argocd')).toBe(true);
    const role = resources.find((resource: any) => resource.kind === 'Role');
    role.rules[0].resourceNames.sort();
    expect(role.rules).toEqual([{ apiGroups: ['argoproj.io'], resources: ['applications'],
      resourceNames: [...applicationNames, 'pulsemetry-dev-root'].sort(), verbs: ['get'] }]);
    const binding = resources.find((resource: any) => resource.kind === 'RoleBinding');
    expect(binding.subjects).toEqual([{ kind: 'Group', name: 'pulsemetry:dev:gitops-observer', apiGroup: 'rbac.authorization.k8s.io' }]);
    for (const applicationNames of [input.applicationNames.slice(1),
      [...input.applicationNames.slice(1), input.applicationNames[1]],
      [...input.applicationNames.slice(1), 'external-app']]) {
      expect(render({ ...input, applicationNames }, support).status).not.toBe(0);
    }
  });
});
