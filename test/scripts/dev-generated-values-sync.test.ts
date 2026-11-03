import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const publisherScript = resolve(__dirname, '../../scripts/dev-generated-values-sync.mjs');
const githubScript = resolve(__dirname, '../../scripts/generated-values-github.mjs');
const harness = String.raw`
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
const [publisherPath, githubPath] = process.argv.slice(1);
process.argv[1] = 'publication-test-harness';
const { createValuesPublisher } = await import(publisherPath);
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
} else {
  const temporary = mkdtempSync(join(tmpdir(), 'generated-values-git-test-'));
  const seed = join(temporary, 'seed'), remote = join(temporary, 'remote.git'), generated = join(temporary, 'generated');
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
  function git(args, cwd = seed) {
    const result = spawnSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', ...args], { cwd, env, encoding: 'utf8' });
    if (result.status !== 0 || result.error) throw new Error('fixture git failure: ' + args[0] + ': ' + result.stderr);
    return result.stdout.trim();
  }
  const write = (name, content = 'fixture\n') => { mkdirSync(dirname(join(seed, name)), { recursive: true }); writeFileSync(join(seed, name), content); };
  const head = () => git(['--git-dir', remote, 'rev-parse', 'refs/heads/main']);
  const backend = { schemaVersion: 1, repository: 'soma-376/pulsemetry-backend', workflow: '.github/workflows/deploy_dev.yml',
    sourceSha: 'b'.repeat(40), runId: '400', runAttempt: '2', jobId: '500', createdAt: '2026-10-30T01:00:00Z', logSha256: 'c'.repeat(64),
    images: Object.fromEntries(['enrollment-api', 'telemetry-ingest', 'telemetry-gateway', 'dashboard-api'].map(app => [app, { digest: 'sha256:' + 'd'.repeat(64), platform: 'linux/arm64' }])) };
  let before, competitor, verifies = 0;
  const calls = [];
  try {
    mkdirSync(seed); git(['init', '--quiet', '--initial-branch=main']);
    write('README.md', 'keep README\n'); write('AGENTS.md', 'keep AGENTS\n');
    if (input.existing) { for (const file of files) write('dev/generated/' + file, 'old: ' + file + '\n'); write('dev/infra-commit.txt', 'b'.repeat(40) + '\n'); }
    if (input.partialSnapshot) write('dev/generated/base.yaml');
    if (input.unknownRoot) write('unowned.yaml');
    if (input.marker) write(input.marker);
    if (input.unknownGenerated) write('dev/generated/unexpected.yaml');
    if (input.symlink) {
      const target = join(seed, input.symlink); mkdirSync(dirname(target), { recursive: true });
      symlinkSync(join(temporary, 'missing-target'), target);
    }
    git(['add', '.']); git(['commit', '--quiet', '-m', 'fixture start']);
    if (input.rewindOnPush) { write('README.md', 'keep README v2\n'); git(['add', '.']); git(['commit', '--quiet', '-m', 'fixture second']); }
    git(['clone', '--quiet', '--bare', seed, remote], temporary); before = head();
    mkdirSync(generated);
    for (const file of files) writeFileSync(join(generated, file), 'new: ' + file + '\n');
    if (input.missingGenerated) rmSync(join(generated, 'base.yaml'));
    if (input.sourceSymlink) { rmSync(join(generated, 'base.yaml')); symlinkSync(join(temporary, 'missing-source'), join(generated, 'base.yaml')); }
    const race = () => { write('competitor.txt', 'do not overwrite\n'); git(['add', '.']); git(['commit', '--quiet', '-m', 'competing writer']); git(['push', '--quiet', remote, 'main']); competitor = head(); };
    const runner = (command, args, options) => {
      calls.push({ args, tokenInArgs: args.some(value => value.includes('fixture-token')),
        tokenInEnvironment: Object.values(options.env).some(value => String(value).includes(Buffer.from('x-access-token:fixture-token').toString('base64'))) });
      const isPush = args.includes('push');
      if (isPush && input.raceOnPush) race();
      if (isPush && input.rewindOnPush) {
        competitor = git(['--git-dir', remote, 'rev-parse', 'main^']);
        git(['--git-dir', remote, 'update-ref', 'refs/heads/main', competitor, before]);
      }
      if (isPush && input.pushFailure) return { status: 1, stdout: '', stderr: 'simulated failure' };
      const result = spawnSync(command, args, options);
      if (isPush && input.responseLost && result.status === 0) return { ...result, status: 1, stderr: 'response lost' };
      return result;
    };
    const publisher = createValuesPublisher({ directory: join(temporary, 'copy'), remote, token: 'fixture-token', runner });
    const publishOptions = { generatedDirectory: generated, infraSha: sha, runId: '123', runAttempt: '3', backend,
      verify: async () => { verifies++; if (input.raceBeforePush) race(); if (input.verifyFailure) throw new Error('metadata changed'); } };
    const result = await publisher.publish(publishOptions);
    let second;
    if (input.twice) {
      const publisher2 = createValuesPublisher({ directory: join(temporary, 'copy2'), remote, runner });
      second = await publisher2.publish(publishOptions);
    }
    const current = head();
    const changed = git(['--git-dir', remote, 'diff', '--name-only', before, current]).split('\n').filter(Boolean);
    const commits = Number(git(['--git-dir', remote, 'rev-list', '--count', before + '..main']));
    const message = git(['--git-dir', remote, 'log', '-1', '--format=%B', 'main']);
    const readme = git(['--git-dir', remote, 'show', 'main:README.md']);
    const agents = git(['--git-dir', remote, 'show', 'main:AGENTS.md']);
    const infraCommit = git(['--git-dir', remote, 'show', 'main:dev/infra-commit.txt']);
    console.log(JSON.stringify({ ok: true, before, current, result, second, changed, commits, message, readme, agents, infraCommit, calls, verifies }));
  } catch (error) { console.log(JSON.stringify({ ok: false, error: error.message, before, current: before ? head() : undefined, competitor, calls, verifies })); }
  finally { rmSync(temporary, { recursive: true, force: true }); }
}
`;

function run(input: any = {}) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', harness, publisherScript, githubScript], {
    input: JSON.stringify(input), encoding: 'utf8', timeout: 20_000,
  });
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
  expect(result.stdout).not.toContain('DO_NOT_LEAK_GITHUB_RESPONSE');
  return JSON.parse(result.stdout);
}

describe('private generated values 게시', () => {
  test('최초 14개 파일을 한 커밋으로 게시하고 같은 내용 재실행은 no-op이다', () => {
    const result = run({ twice: true });
    expect(result.ok).toBe(true);
    expect(result.result.status).toBe('published');
    expect(result.current).toBe(result.result.commit);
    expect(result.second).toEqual({ status: 'noop', commit: result.current });
    expect(result.commits).toBe(1);
    expect(result.changed).toHaveLength(14);
    expect(result.changed.filter((name: string) => name.startsWith('dev/generated/') && name.endsWith('.yaml'))).toHaveLength(13);
    expect(result.changed).toContain('dev/infra-commit.txt');
    expect(result.infraCommit).toBe('a'.repeat(40));
    expect(result.readme).toBe('keep README');
    expect(result.agents).toBe('keep AGENTS');
    expect(result.message).toContain('auto(dev): values 동기화 by infra@aaaaaaaaaaaa (run 123/3)');
    expect(result.message).toContain('backend run: 400/2');
    expect(result.verifies).toBe(2);
    expect(result.calls.every((call: any) => !call.tokenInArgs)).toBe(true);
    expect(result.calls.some((call: any) => call.tokenInEnvironment)).toBe(true);
    const pushes = result.calls.filter((call: any) => call.args.includes('push'));
    expect(pushes).toHaveLength(1);
    expect(pushes[0].args).toEqual(['-c', expect.stringMatching(/^core.hooksPath=/), 'push', '--porcelain', 'origin', 'HEAD:refs/heads/main']);
  });

  test.each([{ raceBeforePush: true }, { raceOnPush: true }, { rewindOnPush: true }])('main 경쟁·rewind가 생기면 시작 HEAD가 아닌 원격을 변경하지 않는다: %j', input => {
    const result = run(input);
    expect(result.ok).toBe(false);
    expect(result.current).toBe(result.competitor);
    expect(result.current).not.toBe(result.before);
    expect(result.error).toMatch(/HEAD 경쟁|HEAD 변경|push 실패/);
  });

  test('push 응답이 유실되어도 원격의 정확한 commit 일치로 성공을 확인한다', () => {
    const result = run({ responseLost: true, twice: true });
    expect(result.ok).toBe(true);
    expect(result.result).toEqual({ status: 'published', commit: result.current });
    expect(result.second.status).toBe('noop');
    expect(result.commits).toBe(1);
  });

  test.each([{ verifyFailure: true }, { pushFailure: true }, { missingGenerated: true }, { sourceSymlink: true }])(
    '검증·파일·게시 실패 시 기존 사본 commit을 보존한다: %j', input => {
      const result = run({ existing: true, ...input });
      expect(result.ok).toBe(false);
      expect(result.current).toBe(result.before);
    });

  test.each([
    { marker: 'bundle.json' }, { marker: 'dev/desired.yaml' }, { marker: 'dev/applications/app.yaml' },
    { marker: 'dev/delivery-state.json' }, { symlink: 'dev/bundle.json' },
    { symlink: 'dev/generated/base.yaml' }, { symlink: 'dev/generated' }, { symlink: 'dev' },
    { unknownGenerated: true }, { unknownRoot: true }, { partialSnapshot: true },
  ])('GitOps 표식·dangling symlink·허용목록 밖 사본을 게시 전에 거부한다: %j', input => {
    const result = run(input);
    expect(result.ok).toBe(false);
    expect(result.current).toBe(result.before);
    expect(result.calls.some((call: any) => call.args.includes('push'))).toBe(false);
  });
});

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
