import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const { load, loadAll } = require('js-yaml');
const root = resolve(__dirname, '../..');
const directory = join(root, 'helm/dev/platform/cert-manager');
const source = JSON.parse(readFileSync(join(directory, 'SOURCE.json'), 'utf8'));
const values = load(readFileSync(join(directory, 'values.yaml'), 'utf8'));
const documents = (text: string): any[] => loadAll(text).filter(Boolean);

describe('cert-manager 공급 고정', () => {
  test('공식 chart checksum과 다섯 ARM64 이미지 digest를 배포 입력에 고정한다', () => {
    expect(source.chart.version).toBe('v1.21.3');
    expect(source.kubernetesVersion).toBe('1.36.0');
    const bytes = readFileSync(join(directory, 'vendor/cert-manager-v1.21.3.tgz'));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(source.chart.sha256);
    expect(load(readFileSync(join(directory, 'chart/Chart.yaml'), 'utf8'))).toMatchObject({ version: source.chart.version, appVersion: source.chart.appVersion });
    expect(Object.keys(source.images).sort()).toEqual(['acmesolver', 'cainjector', 'controller', 'startupapicheck', 'webhook']);
    for (const [component, pin] of Object.entries(source.images) as Array<[string, any]>) {
      expect(pin.platform).toBe('linux/arm64');
      expect(pin.arm64Digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(pin.indexDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect((component === 'controller' ? values.image : values[component].image).digest).toBe(pin.arm64Digest);
    }
  });
});

(process.env.HELM_BIN ? describe : describe.skip)('cert-manager와 LBC 인증서 실제 Helm 렌더', () => {
  const render = (release: string, chart: string, namespace: string, args: string[] = []) => {
    const result = spawnSync(process.env.HELM_BIN!, ['template', release, chart, '-n', namespace, '--kube-version', '1.36.0', '--include-crds', '--skip-tests', ...args], {
      cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    });
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    return documents(result.stdout);
  };
  const certManager = () => render('cert-manager', 'helm/dev/platform/cert-manager/chart', 'cert-manager', ['-f', 'helm/dev/platform/cert-manager/values.yaml']);
  const lbc = () => render('actual-existing-lbc-release', 'helm/dev/platform/lbc/chart', 'kube-system', [
    '-f', 'helm/dev/platform/lbc/values.yaml', '--set', 'clusterName=fixture,region=ap-northeast-2,vpcId=vpc-0123456789abcdef0',
  ]);

  test('신규 namespace·CRD와 ARM64 apps 배치를 선언하고 Secret 원문은 생성하지 않는다', () => {
    const docs = certManager();
    expect(docs).toEqual(certManager());
    expect(docs.filter(doc => doc.kind === 'Namespace').map(doc => doc.metadata.name)).toEqual(['cert-manager']);
    expect(docs.filter(doc => doc.kind === 'CustomResourceDefinition')).toHaveLength(6);
    expect(docs.some(doc => doc.kind === 'Secret')).toBe(false);
    expect(docs.filter(doc => doc.kind === 'CustomResourceDefinition').every(doc => doc.metadata.annotations['helm.sh/resource-policy'] === 'keep')).toBe(true);
    for (const doc of docs.filter(doc => ['Deployment', 'Job'].includes(doc.kind))) {
      expect(doc.metadata.namespace).toBe('cert-manager');
      const pod = doc.spec.template.spec;
      expect(pod.nodeSelector).toEqual({ 'kubernetes.io/os': 'linux', 'kubernetes.io/arch': 'arm64', 'karpenter.sh/nodepool': 'pulsemetry-dev-apps' });
      expect(pod.containers[0].resources.requests.memory).toMatch(/Mi$/);
      expect(pod.containers[0].resources.limits.memory).toMatch(/Mi$/);
      expect(Object.values(source.images).some((pin: any) => `${pin.repository}@${pin.arm64Digest}` === pod.containers[0].image)).toBe(true);
    }
    const webhook = docs.find(doc => doc.kind === 'Deployment' && doc.metadata.name === 'cert-manager-webhook');
    expect(webhook.spec.template.spec.hostNetwork ?? false).toBe(false);
    expect(webhook.spec.template.spec.containers[0].args).toContain('--secure-port=10250');
    expect(docs.filter(doc => doc.kind === 'Role').every(doc => doc.metadata.namespace === 'cert-manager')).toBe(true);
    expect(docs.filter(doc => doc.kind === 'ClusterRole').some(doc => Object.keys(doc.metadata.labels).some(key => key.startsWith('rbac.authorization.k8s.io/aggregate-to-')))).toBe(false);
  });

  test('startup API 검사는 PostSync의 선행 RBAC와 동일 SA를 사용하며 재실행 가능하다', () => {
    const hooks = certManager().filter(doc => doc.metadata.annotations?.['helm.sh/hook']);
    expect(hooks.map(doc => doc.kind).sort()).toEqual(['Job', 'Role', 'RoleBinding', 'ServiceAccount']);
    for (const hook of hooks) {
      const annotations = hook.metadata.annotations;
      expect(annotations['helm.sh/hook']).toBe('post-install,post-upgrade');
      expect(annotations['helm.sh/hook-delete-policy']).toBe('before-hook-creation,hook-succeeded');
      expect(annotations['helm.sh/hook-weight']).toBe(hook.kind === 'Job' ? '1' : '-5');
    }
    const job = hooks.find(doc => doc.kind === 'Job');
    const sa = hooks.find(doc => doc.kind === 'ServiceAccount');
    const role = hooks.find(doc => doc.kind === 'Role');
    const binding = hooks.find(doc => doc.kind === 'RoleBinding');
    expect(job.spec.template.spec.serviceAccountName).toBe(sa.metadata.name);
    expect(job.spec.template.spec.containers[0].args).toEqual(['check', 'api', '--wait=2m', '-v']);
    expect(job.spec.ttlSecondsAfterFinished).toBeUndefined();
    expect(role.rules).toEqual([{ apiGroups: ['cert-manager.io'], resources: ['certificaterequests'], verbs: ['create'] }]);
    expect(binding.roleRef.name).toBe(role.metadata.name);
    expect(binding.subjects).toEqual([{ kind: 'ServiceAccount', name: sa.metadata.name, namespace: 'cert-manager' }]);
  });

  test('LBC의 Secret·SAN·Issuer와 CA 주입 참조는 실제 기존 release 이름에 무관하게 일치한다', () => {
    const docs = lbc();
    expect(docs).toEqual(lbc());
    expect(docs.some(doc => doc.kind === 'Secret')).toBe(false);
    const certificates = docs.filter(doc => doc.kind === 'Certificate');
    expect(certificates).toHaveLength(2);
    const rootCert = certificates.find(doc => doc.spec.isCA);
    const leaf = certificates.find(doc => !doc.spec.isCA);
    const caIssuer = docs.find(doc => doc.kind === 'Issuer' && doc.spec.ca);
    const selfIssuer = docs.find(doc => doc.kind === 'Issuer' && doc.spec.selfSigned);
    const deployment = docs.find(doc => doc.kind === 'Deployment');
    const webhooks = docs.filter(doc => ['MutatingWebhookConfiguration', 'ValidatingWebhookConfiguration'].includes(doc.kind));
    expect(rootCert.spec.issuerRef.name).toBe(selfIssuer.metadata.name);
    expect(caIssuer.spec.ca.secretName).toBe(rootCert.spec.secretName);
    expect(leaf.spec.issuerRef).toEqual({ kind: 'Issuer', name: caIssuer.metadata.name });
    expect(deployment.spec.template.spec.volumes.find((volume: any) => volume.name === 'cert').secret.secretName).toBe(leaf.spec.secretName);
    for (const config of webhooks) {
      expect(config.metadata.annotations['cert-manager.io/inject-ca-from']).toBe(`kube-system/${leaf.metadata.name}`);
      for (const webhook of config.webhooks) {
        const service = webhook.clientConfig.service;
        expect(leaf.spec.dnsNames).toContain(`${service.name}.${service.namespace}.svc`);
        expect(webhook.clientConfig.caBundle).toBeUndefined();
      }
    }
  });
});
