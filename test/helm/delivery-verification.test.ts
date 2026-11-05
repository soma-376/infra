import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
const yaml = require('js-yaml');
const helm = process.env.HELM_BIN;
const suite = helm ? describe : describe.skip;

suite('PostSync 검증 Job과 독립 읽기 권한', () => {
  const root = resolve(__dirname, '../..');
  const chart = resolve(root, 'helm/dev/workloads/spring-app');
  const contract = '{"schemaVersion":1,"app":"enrollment-api"}\n';
  const applicationNames = JSON.parse(readFileSync(resolve(root, 'helm/dev/gitops/catalog.json'), 'utf8')).applications.map((app: any) => app.name);
  const values = {
    ...yaml.load(readFileSync(resolve(root, 'helm/dev/workloads/enrollment-api.yaml'), 'utf8')),
    image: { repository: 'example.invalid/enrollment-api', digest: `sha256:${'a'.repeat(64)}` },
    deliveryVerification: { enabled: true, image: { repository: 'example.invalid/verifier', digest: `sha256:${'b'.repeat(64)}` },
      operationNonce: 'a'.repeat(32), infraCommit: 'c'.repeat(40), bundleManifestSha256: 'd'.repeat(64),
      imageDigest: `sha256:${'a'.repeat(64)}`, contractSha256: createHash('sha256').update(contract).digest('hex'), contract,
      config: { schemaVersion: 1 } },
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
  test('disabled는 기존 렌더를 유지하고 nonce 변경은 앱 Pod template을 바꾸지 않는다', () => {
    expect(docs({ ...values, deliveryVerification: { enabled: false } }).some((d: any) => d.kind === 'Job')).toBe(false);
    const first = docs(values), second = docs({ ...values, deliveryVerification: { ...values.deliveryVerification, operationNonce: 'b'.repeat(32) } });
    expect(first.find((d: any) => d.kind === 'Deployment')).toEqual(second.find((d: any) => d.kind === 'Deployment'));
    const job = first.find((d: any) => d.kind === 'Job');
    expect(job.metadata.name).toBe('enrollment-api-verify');
    expect(job.metadata.annotations).toEqual({ 'argocd.argoproj.io/hook': 'PostSync', 'argocd.argoproj.io/hook-delete-policy': 'BeforeHookCreation' });
    expect(job.spec).toMatchObject({ backoffLimit: 0, activeDeadlineSeconds: 600 });
    expect(job.spec.ttlSecondsAfterFinished).toBeUndefined();
    expect(job.spec.template.spec.initContainers).toBeUndefined();
    expect(job.spec.template.spec.containers).toHaveLength(1);
    expect(job.spec.template.spec.containers[0].name).toBe('verifier');
    expect(job.spec.template.spec.containers[0].image).toContain('example.invalid/verifier@sha256:');
    expect(job.spec.template.spec.nodeSelector['karpenter.sh/nodepool']).toBe('pulsemetry-dev-apps');
  });
  test('image·contract binding 위반과 mutable verifier tag는 렌더 단계에서 거부한다', () => {
    for (const patch of [{ imageDigest: `sha256:${'0'.repeat(64)}` }, { contract: contract + '\n' }, { image: { repository: 'example.invalid/verifier', digest: 'latest' } }]) {
      expect(render({ ...values, deliveryVerification: { ...values.deliveryVerification, ...patch } }).status).not.toBe(0);
    }
  });
  test('지원 chart는 기본 비활성이고 승인된 대상만 읽으며 exec·portforward·writes가 없다', () => {
    const support = resolve(root, 'helm/dev/platform/delivery-verification');
    expect(docs({}, support)).toEqual([]);
    const input = { enabled: true, applicationNames,
      jobNames: ['enrollment-api-verify', 'telemetry-ingest-verify', 'telemetry-gateway-verify', 'dashboard-api-verify'],
      prometheus: { namespace: 'pulsemetry-observability', proxyName: 'pulsemetry-monitoring-prometheus:9090' },
      probeSecretArn: 'arn:aws:secretsmanager:ap-northeast-2:111111111111:secret:pulsemetry/dev/deployment-verifier-abcdef', probeSecretVersionId: 'a'.repeat(32) };
    const resources = docs(input, support);
    const rules = resources.filter((d: any) => d.kind === 'Role').flatMap((d: any) => d.rules);
    expect(rules.flatMap((r: any) => r.verbs).every((v: string) => ['get', 'list'].includes(v))).toBe(true);
    expect(rules.flatMap((r: any) => r.resources)).not.toEqual(expect.arrayContaining(['pods/exec', 'pods/portforward', 'pods/log']));
    expect(rules.find((r: any) => r.resources.includes('services/proxy')).resourceNames).toEqual(['pulsemetry-monitoring-prometheus:9090']);
    expect(rules.find((r: any) => r.resources.includes('applications')).resourceNames.sort()).toEqual([...applicationNames, 'pulsemetry-dev-root'].sort());
    for (const patch of [{ applicationNames: [...applicationNames.slice(1), applicationNames[1]] },
      { applicationNames: [...applicationNames.slice(1), 'external-app'] }, { workloadNames: ['enrollment-api', 'telemetry-ingest', 'telemetry-gateway', 'external'] },
      { jobNames: ['a-verify', 'b-verify', 'c-verify', 'c-verify'] }, { jobNames: ['a-verify', 'b-verify', 'c-verify', 'wrong'] },
      { prometheus: { namespace: 'external', proxyName: 'pulsemetry-monitoring-prometheus:9090' } }]) {
      expect(render({ ...input, ...patch }, support).status).not.toBe(0);
    }
  });
});
