import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const githubScript = resolve(__dirname, '../../scripts/generated-values-github.mjs');
const harness = String.raw`
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
const [githubPath] = process.argv.slice(1);
process.argv[1] = 'publication-test-harness';
const { verifyPublicationEvidence, githubClient } = await import(githubPath);
const input = JSON.parse(readFileSync(0, 'utf8'));
const sha = 'a'.repeat(40);
const files = ['base.yaml', 'lbc.yaml', 'runtime.yaml', 'enrollment-api.yaml', 'telemetry-ingest.yaml',
  'telemetry-gateway.yaml', 'telemetry-kafka-admin.yaml', 'dashboard-api.yaml', 'clickhouse.yaml',
  'fluent-bit.yaml', 'ascp.yaml', 'observability.yaml', 'kafka-strimzi.yaml'];
if (input.evidence) {
  const receipt = { runId: '123', runAttempt: '2', sourceSha: sha, event: 'push', planArtifactId: '700' };
  const paths = [];
  const github = async path => {
    paths.push(path);
    if (path.endsWith('/attempts/2')) return { id: 123, run_attempt: input.wrongAttempt ? 3 : 2,
      head_sha: input.wrongSha ? 'b'.repeat(40) : sha, head_branch: input.wrongBranch ? 'main' : 'develop',
      status: 'completed', conclusion: 'failure', event: 'push', path: '.github/workflows/dev-cdk-deploy.yml' };
    if (path.includes('/jobs?')) {
      const jobs = ['plan', 'deploy'].map((name, i) => ({ id: i + 1, name, status: 'completed',
        conclusion: input.failedJob === name ? 'failure' : 'success', run_id: 123,
        run_attempt: input.wrongJobAttempt === name ? 3 : 2, head_sha: sha }));
      if (input.duplicateJob) jobs.push(jobs[0]);
      if (input.missingJob) jobs.pop();
      if (input.paginate) {
        const fillers = Array.from({ length: 99 }, (_, i) => ({ id: i + 50, name: 'irrelevant-' + i }));
        const first = [jobs[0], ...fillers];
        return { total_count: input.changedTotal && path.endsWith('page=2') ? 102 : 101,
          jobs: path.endsWith('page=1') ? first : input.emptyPage ? [] : [jobs[1]] };
      }
      return { total_count: input.invalidTotal ? '2' : input.oversizedTotal ? 1001 : input.excessJobs ? 2 : jobs.length,
        jobs: input.excessJobs ? [...jobs, { id: 3, name: 'third' }] : jobs };
    }
    if (path.includes('/artifacts/')) {
      const id = path.split('/').at(-1), prefix = id === '700' ? 'dev-cdk-plan' : 'dev-cdk-receipt';
      return { id: Number(id), expired: Boolean(input.expired), expires_at: input.expiredDate ? '2000-01-01T00:00:00Z' : '2999-01-01T00:00:00Z',
        name: prefix + '-123-' + (input.wrongArtifactAttempt ? '3' : '2'),
        workflow_run: { id: input.wrongArtifactRun ? 456 : 123, head_sha: sha } };
    }
    throw new Error('Unexpected fixture path');
  };
  try {
    await verifyPublicationEvidence({ receipt, receiptArtifactId: '701', github });
    console.log(JSON.stringify({ ok: true, paths }));
  } catch (error) { console.log(JSON.stringify({ ok: false, error: error.message, paths })); }
} else if (input.client) {
  const paths = [], marker = 'DO_NOT_LEAK_GITHUB_RESPONSE';
  globalThis.fetch = async (url, options) => {
    paths.push({ url, redirect: options.redirect, hasAuthorization: options.headers.Authorization === 'Bearer fixture-token' });
    if (input.clientError) throw new Error(marker);
    return { ok: !input.httpError, status: input.httpError ? 404 : 200,
      json: async () => { if (input.jsonError) throw new Error(marker); return { ok: true }; } };
  };
  try {
    const result = await githubClient('fixture-token')(input.path || '/repos/soma-376/infra/actions/runs/123');
    console.log(JSON.stringify({ ok: true, paths, result }));
  } catch (error) { console.log(JSON.stringify({ ok: false, paths, error: error.message })); }
}

`;

function run(input: any = {}) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', harness, githubScript], {
    input: JSON.stringify(input), encoding: 'utf8', timeout: 20_000,
  });
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
  expect(result.stdout).not.toContain('DO_NOT_LEAK_GITHUB_RESPONSE');
  return JSON.parse(result.stdout);
}

describe('원본 승인·배포 GitHub 증거', () => {
  test('전체 workflow 실패여도 정확한 원본 attempt의 plan/deploy 성공을 인정한다', () => {
    const result = run({ evidence: true, paginate: true });
    expect(result.ok).toBe(true);
    expect(result.paths).toContain('/repos/soma-376/infra/actions/runs/123/attempts/2/jobs?per_page=100&page=2');
    expect(result.paths.some((path: string) => path.includes('/runs/123/jobs'))).toBe(false);
    expect(result.paths.slice(-2)).toEqual(['/repos/soma-376/infra/actions/artifacts/700', '/repos/soma-376/infra/actions/artifacts/701']);
  });

  test.each([
    { wrongAttempt: true }, { wrongSha: true }, { wrongBranch: true }, { failedJob: 'plan' }, { failedJob: 'deploy' },
    { wrongJobAttempt: 'plan' }, { wrongJobAttempt: 'deploy' }, { duplicateJob: true }, { missingJob: true },
    { expired: true }, { expiredDate: true }, { wrongArtifactAttempt: true }, { wrongArtifactRun: true },
    { invalidTotal: true }, { oversizedTotal: true }, { excessJobs: true },
    { paginate: true, changedTotal: true }, { paginate: true, emptyPage: true },
  ])('원본 job 실패·다른 출처·artifact 만료를 거부한다: %j', input => {
    const result = run({ evidence: true, ...input });
    expect(result.ok).toBe(false);
  });

  test('GitHub 자격은 허용 API 요청에만 전달하고 redirect를 거부한다', () => {
    const result = run({ client: true });
    expect(result.ok).toBe(true);
    expect(result.paths).toEqual([{ url: 'https://api.github.com/repos/soma-376/infra/actions/runs/123', redirect: 'error', hasAuthorization: true }]);
    expect(run({ client: true, path: '/repos/another-owner/infra' }).ok).toBe(false);
  });

  test.each([{ httpError: true }, { clientError: true }, { jsonError: true }])('GitHub 실패 원문은 노출하지 않는다: %j', input => {
    expect(run({ client: true, ...input }).ok).toBe(false);
  });
});
