import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const { loadAll } = require('js-yaml');
const root = resolve(__dirname, '../..');
const chart = join(root, 'helm/dev/workloads/spring-app');
const helmTest = process.env.HELM_BIN ? test : test.skip;
const revision = 'pulsemetry.io/blocked-certs-revision';

function render(chartPath = chart, release = 'enrollment-api') {
  return spawnSync(process.env.HELM_BIN!, [
    'template', release, chartPath, '--namespace', 'pulsemetry-dev', '--kube-version', '1.36.0',
    '-f', join(root, 'helm/dev/workloads/enrollment-api.yaml'),
    '--set-string', 'image.repository=example.invalid/soma-376/enrollment-api',
    '--set-string', `image.digest=sha256:${'a'.repeat(64)}`,
  ], { cwd: root, encoding: 'utf8' });
}

describe('dev JVM blocked.certs 공급', () => {
  const temps: string[] = [];
  afterEach(() => { for (const temp of temps.splice(0)) rmSync(temp, { recursive: true, force: true }); });
  const copyChart = () => {
    const temp = mkdtempSync(join(tmpdir(), 'blocked-certs-test-'));
    temps.push(temp);
    const copy = join(temp, 'spring-app');
    cpSync(chart, copy, { recursive: true });
    return copy;
  };

  test('공식 원본의 출처·취득 시점·해시와 차단 목록 형식을 확인한다', () => {
    const contents = readFileSync(join(chart, 'files/blocked.certs'));
    const source = JSON.parse(readFileSync(join(chart, 'files/SOURCE.json'), 'utf8'));
    expect(source.url).toBe('https://ops.java/unix/blocked.certs');
    expect(Number.isNaN(Date.parse(source.retrievedAt))).toBe(false);
    expect(source.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(createHash('sha256').update(contents).digest('hex')).toBe(source.sha256);
    const lines = contents.toString('utf8').split(/\r?\n/).map(line => line.trim())
      .filter(line => line && !line.startsWith('#'));
    expect(lines.filter(line => line === 'Algorithm=SHA-256')).toHaveLength(1);
    const fingerprints = lines.filter(line => line !== 'Algorithm=SHA-256');
    expect(fingerprints.length).toBeGreaterThan(0);
    for (const fingerprint of fingerprints) expect(fingerprint).toMatch(/^[A-F0-9]{64}$/);
    expect(new Set(fingerprints).size).toBe(fingerprints.length);
  });

  helmTest.each(['missing', 'empty'])('공식 파일이 %s이면 차트를 렌더링하지 않는다', mode => {
    const copy = copyChart();
    const file = join(copy, 'files/blocked.certs');
    if (mode === 'missing') rmSync(file);
    else writeFileSync(file, '');
    const result = render(copy);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('blocked.certs');
  });

  helmTest('release별 ConfigMap을 참조하고 runtime 없이도 파일 변경이 Pod revision을 바꾼다', () => {
    const copy = copyChart();
    const contents = readFileSync(join(copy, 'files/blocked.certs'), 'utf8');
    const documents = (text: string) => loadAll(text).filter(Boolean);
    const first = render(copy, 'enrollment-api-blue');
    const second = render(copy, 'enrollment-api-green');
    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    for (const [release, result] of [['enrollment-api-blue', first], ['enrollment-api-green', second]] as const) {
      const resources = documents(result.stdout);
      const configMap = resources.find((doc: any) => doc.kind === 'ConfigMap');
      expect(configMap.metadata.name).toBe(`${release}-blocked-certs`);
      expect(configMap.data).toEqual({ 'blocked.certs': contents });
      const deployment = resources.find((doc: any) => doc.kind === 'Deployment');
      const pod = deployment.spec.template.spec;
      expect(pod.initContainers).toBeUndefined();
      expect(pod.volumes).toEqual([{
        name: 'blocked-certs', configMap: {
          name: `${release}-blocked-certs`, defaultMode: 0o444,
          items: [{ key: 'blocked.certs', path: 'blocked.certs' }],
        },
      }]);
      expect(deployment.spec.template.metadata.annotations[revision]).toBe(createHash('sha256').update(contents).digest('hex'));
    }
    const updated = `${contents}# PROJ-253 rollout fixture\n`;
    writeFileSync(join(copy, 'files/blocked.certs'), updated);
    const changed = render(copy, 'enrollment-api-blue');
    expect(changed.status).toBe(0);
    const updatedDeployment = documents(changed.stdout).find((doc: any) => doc.kind === 'Deployment');
    expect(updatedDeployment.spec.template.metadata.annotations[revision]).toBe(createHash('sha256').update(updated).digest('hex'));
    expect(updatedDeployment.spec.template.metadata.annotations[revision]).not.toBe(
      documents(first.stdout).find((doc: any) => doc.kind === 'Deployment').spec.template.metadata.annotations[revision],
    );
  });
});
