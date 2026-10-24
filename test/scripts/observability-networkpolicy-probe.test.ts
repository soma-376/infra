import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// NetworkPolicy live 시험 스크립트의 판정·정리를 모의 kubectl로 회귀 시험한다(ADR-0039). 클러스터에 붙지 않는다.
const root = resolve(__dirname, '../..');
const script = join(root, 'scripts/observability-networkpolicy-probe.mjs');
const fake = join(root, 'test/scripts/fixtures/fake-kubectl.mjs');

type Run = { status: number | null; evidence: { status: string; failures: string[]; cases?: { target: string; verdict: string }[]; cleanup: Record<string, unknown> }; calls: string[][] };

function probe(phase: 'n2' | 'n5', scenario: Record<string, unknown> = {}, extra: string[] = []): Run {
  const dir = mkdtempSync(join(tmpdir(), 'np-probe-test-'));
  try {
    writeFileSync(join(dir, 'kubectl'), `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
    chmodSync(join(dir, 'kubectl'), 0o755);
    const output = join(dir, 'evidence.json');
    const result = spawnSync(process.execPath, [script, '--phase', phase, '--output', output, ...extra], {
      encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FAKE_KUBECTL_DIR: dir, FAKE_REPO_ROOT: root, FAKE_SCENARIO: JSON.stringify(scenario) },
    });
    const calls = readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    return { status: result.status, evidence: JSON.parse(readFileSync(output, 'utf8')), calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const deletedNamespace = (calls: string[][]) => calls.some(c => c[0] === 'delete' && c[1] === 'namespace');

describe('NetworkPolicy N2 시험 스크립트', () => {
  test('controller가 꺼져 있으면 FAIL이고 만들지 않은 namespace를 지우지 않는다', () => {
    const run = probe('n2', { controllerOff: true });
    expect(run.status).toBe(1);
    expect(run.evidence.status).toBe('FAIL');
    expect(deletedNamespace(run.calls)).toBe(false);
  });

  test('시험 namespace가 이미 있으면 FAIL이고 그 namespace를 지우지 않는다', () => {
    const run = probe('n2', { namespaceExists: true });
    expect(run.evidence.status).toBe('FAIL');
    expect(deletedNamespace(run.calls)).toBe(false);
  });

  test('정책이 강제되지 않으면 FAIL이다', () => {
    const run = probe('n2', { noEnforcement: true }, ['--ready-seconds', '5']);
    expect(run.evidence.status).toBe('FAIL');
    expect(run.evidence.failures.join('\n')).toContain('deny-all 뒤 label 없는 client');
    expect(deletedNamespace(run.calls)).toBe(true);
  });

  test('deny-all 뒤 server가 NotReady면 FAIL이다', () => {
    const run = probe('n2', { serverNotReady: true }, ['--ready-seconds', '5']);
    expect(run.evidence.status).toBe('FAIL');
    expect(run.evidence.failures.join('\n')).toContain('Ready를 유지하지 못했다');
  });

  test('정상 흐름은 관찰 시간을 줄이면 SHORT_RUN이고, 만든 namespace만 지운다', () => {
    const run = probe('n2', {}, ['--ready-seconds', '5']);
    expect(run.evidence.status).toBe('SHORT_RUN');
    expect(run.evidence.failures).toEqual([]);
    expect(run.calls.filter(c => c[0] === 'delete' && c[1] === 'namespace')).toEqual([['delete', 'namespace', 'pulsemetry-np-probe', '--wait=false']]);
  });
});

describe('NetworkPolicy N5 시험 스크립트', () => {
  test('허용 송신자가 모두 닿고 비허용이 막히면 PASS이고, 이 실행의 Job만 지운다', () => {
    const run = probe('n5');
    expect(run.evidence.status).toBe('PASS');
    const deletes = run.calls.filter(c => c[0] === 'delete' && c[1] === 'job');
    expect(deletes.length).toBeGreaterThan(0);
    for (const call of deletes) expect(call.join(' ')).toMatch(/pulsemetry\.io\/np-probe-run=[0-9a-f]{6}/);
    // apps 풀에서 Tempo 3200은 SG도 막는 경로라 정책 증거로 세지 않는다.
    expect(run.evidence.cases?.find(c => c.target === 'tempo-3200' && c.verdict === 'SG_ALSO_BLOCKS')).toBeDefined();
  });

  test('Grafana → Loki가 막히면 Prometheus가 닿아도 FAIL이다', () => {
    const run = probe('n5', { portControl: { grafana: { 'loki-3100': 'TIMEOUT' } } });
    expect(run.evidence.status).toBe('FAIL');
    expect(run.evidence.failures.join('\n')).toContain('grafana → loki-3100: TIMEOUT');
  });

  test('비허용 송신자가 닿으면 FAIL이다', () => {
    const run = probe('n5', { stranger: { 'collector-4318': 'OPEN' } });
    expect(run.evidence.status).toBe('FAIL');
    expect(run.evidence.cases?.some(c => c.target === 'collector-4318' && c.verdict === 'NOT_BLOCKED')).toBe(true);
  });

  test('trace 통신량이 없으면 PASS가 아니라 PENDING이다', () => {
    const run = probe('n5', { functionalZero: true });
    expect(run.evidence.status).toBe('PENDING');
  });
});
