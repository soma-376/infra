import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const { loadAll } = require('js-yaml');

(process.env.HELM_BIN ? describe : describe.skip)('ClickHouse 수동 인계 메모리 보존', () => {
  const render = (args: string[] = []) => spawnSync(process.env.HELM_BIN!, [
    'template', 'clickhouse', 'helm/dev/workloads/clickhouse', '--namespace', 'pulsemetry-dev',
    '--kube-version', '1.36.0', '--set', 'availabilityZone=ap-northeast-2a', ...args,
  ], { cwd: resolve(__dirname, '../..'), encoding: 'utf8' });

  test('기존 운영 메모리를 입력해도 자원 이외의 선언은 바뀌지 않는다', () => {
    const baseline = render();
    const handoff = render(['--set', 'resources.requests.memory=2Gi,resources.limits.memory=2560Mi']);
    expect(baseline.status).toBe(0);
    expect(handoff.status).toBe(0);
    const before = loadAll(baseline.stdout).filter(Boolean);
    const after = loadAll(handoff.stdout).filter(Boolean);
    const container = (docs: any[]) => docs.find(doc => doc.kind === 'StatefulSet').spec.template.spec.containers[0];
    expect(container(before).resources).toEqual({ requests: { cpu: '250m', memory: '1Gi' }, limits: { cpu: '1', memory: '2Gi' } });
    expect(container(after).resources).toEqual({ requests: { cpu: '250m', memory: '2Gi' }, limits: { cpu: '1', memory: '2560Mi' } });
    container(after).resources = container(before).resources;
    expect(after).toEqual(before);
  });

  test('승인하지 않은 메모리와 CPU 확대는 계속 거부한다', () => {
    for (const setting of ['resources.requests.memory=512Mi', 'resources.limits.memory=8Gi', 'resources.limits.cpu=4']) {
      expect(render(['--set', setting]).status).not.toBe(0);
    }
  });
});
