import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { load } from 'js-yaml';
import { main, operationIdentity } from '../../scripts/dev-gitops/operations.mjs';
import { GENERATED } from '../../scripts/dev-gitops/release.mjs';
import { json, sha256 } from '../../scripts/dev-gitops/contract.mjs';
import { observation, repository } from './fixtures.mjs';

const source = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const env = () => ({ GITHUB_REPOSITORY: 'soma-376/infra', GITHUB_REF: 'refs/heads/develop',
  GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_WORKFLOW_REF: 'soma-376/infra/.github/workflows/dev-gitops-operations.yml@refs/heads/develop',
  GITHUB_SHA: source, GITHUB_WORKFLOW_SHA: source, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', AWS_ACCOUNT_ID: '123456789012' });
async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), 'gitops-operations-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, 'input'); await mkdir(input);
  return { root, input, output: join(root, 'output') };
}
async function dependencies(fixture, counters = {}) {
  const files = await fixture.store.files(fixture.V);
  const candidate = new Map(GENERATED.map(name => [`dev/generated/${name}`, files.get(`dev/generated/${name}`)]));
  candidate.set('dev/generated/clickhouse.yaml', 'fixed: reviewed-configuration\n');
  return { candidate, deps: {
    openStore: async () => Object.assign(Object.create(fixture.store), { close: async () => { counters.storeClosed = true; } }),
    prepareRuntime: async () => ({ candidate, validateCandidate: async () => {}, close: async () => { counters.runtimeClosed = true; } }),
    openObserver: async () => ({ observe: async () => observation(), close: async () => { counters.observerClosed = true; } }),
  } };
}

test('운영 identity는 exact workflow_dispatch/develop/source와 실제 run 식별자만 받는다', () => {
  assert.deepEqual(operationIdentity(env()), { repository: 'soma-376/infra', workflowRef: env().GITHUB_WORKFLOW_REF, workflowRunId: '123', workflowRunAttempt: '1' });
  for (const [key, value] of [
    ['GITHUB_REPOSITORY', 'other/infra'], ['GITHUB_REF', 'refs/heads/main'], ['GITHUB_EVENT_NAME', 'push'],
    ['GITHUB_WORKFLOW_REF', 'soma-376/infra/.github/workflows/other.yml@refs/heads/develop'],
    ['GITHUB_SHA', 'develop'], ['GITHUB_WORKFLOW_SHA', 'a'.repeat(40)], ['GITHUB_RUN_ID', '0'], ['GITHUB_RUN_ATTEMPT', '0'],
  ]) assert.throws(() => operationIdentity({ ...env(), [key]: value }));
});

test('허용하지 않은 operation과 실행 source 불일치는 store를 열기 전에 거부한다', async t => {
  const dirs = await directory(t); let opened = false;
  const deps = { openStore: async () => { opened = true; throw new Error('must not open'); } };
  await assert.rejects(main(['arbitrary-command', dirs.input, dirs.output], env(), deps));
  await assert.rejects(main(['review-config', dirs.input, dirs.output], { ...env(), GITHUB_SHA: 'a'.repeat(40), GITHUB_WORKFLOW_SHA: 'a'.repeat(40) }, deps));
  assert.equal(opened, false);
});

test('publish-config는 명시적 게시 스위치 없이는 입력/store를 읽지 않는다', async t => {
  const dirs = await directory(t); let opened = false;
  for (const mode of ['publish-config']) {
    await assert.rejects(main([mode, dirs.input, join(dirs.root, mode)], env(), { openStore: async () => { opened = true; } }), /게시 스위치/);
  }
  assert.equal(opened, false);
});

test('review-config는 private 파일과 hash만 만들고 Git CAS와 observer는 호출하지 않는다', async t => {
  const fixture = await repository(t), dirs = await directory(t), counters = {};
  const { candidate, deps } = await dependencies(fixture, counters);
  deps.openObserver = async () => { throw new Error('must not observe'); };
  t.mock.method(console, 'log', () => {});
  assert.equal(await main(['review-config', dirs.input, dirs.output], env(), deps), 0);
  assert.equal(await fixture.store.refresh(), fixture.Q);
  const review = JSON.parse(await readFile(join(dirs.output, 'config-review.json'), 'utf8'));
  assert.equal(review.sourceCommit, source); assert.equal(review.expectedHead, fixture.Q);
  assert.equal(review.bundleManifestSha256, fixture.baseline.B);
  assert.equal(Object.keys(review.hashes).length, 13);
  for (const [path, text] of candidate) {
    assert.equal(await readFile(join(dirs.output, path), 'utf8'), text);
    assert.equal(review.hashes[path], sha256(text));
  }
  assert.equal(counters.runtimeClosed, true);
});

test('publish-config는 검토한 HEAD/source/B/hash가 하나라도 다르면 CAS 전에 거부한다', async t => {
  const fixture = await repository(t), { candidate, deps } = await dependencies(fixture);
  const review = { sourceCommit: source, expectedHead: fixture.Q, bundleManifestSha256: fixture.baseline.B,
    hashes: Object.fromEntries([...candidate].map(([path, text]) => [path, sha256(text)])) };
  for (const key of ['sourceCommit', 'expectedHead', 'bundleManifestSha256', 'hashes']) {
    const dirs = await directory(t);
    const modified = { ...review, [key]: key === 'hashes' ? {} : 'f'.repeat(key === 'bundleManifestSha256' ? 64 : 40) };
    await writeFile(join(dirs.input, 'config-review.json'), json(modified));
    await assert.rejects(main(['publish-config', dirs.input, dirs.output], { ...env(), INFRA_GITOPS_ENABLED: 'true' }, deps), /검토한 설정 후보/);
    assert.equal(await fixture.store.refresh(), fixture.Q);
  }
});

test('config 검토 JSON symlink와 malformed JSON은 거부하고 원문을 오류에 싣지 않는다', async t => {
  const fixture = await repository(t), { deps } = await dependencies(fixture);
  for (const kind of ['symlink', 'malformed']) {
    const dirs = await directory(t);
    if (kind === 'symlink') {
      const elsewhere = join(dirs.root, 'elsewhere.json'); await writeFile(elsewhere, '{}');
      await symlink(elsewhere, join(dirs.input, 'config-review.json'));
    } else await writeFile(join(dirs.input, 'config-review.json'), '{"sensitive-marker":');
    await assert.rejects(main(['publish-config', dirs.input, dirs.output], { ...env(), INFRA_GITOPS_ENABLED: 'true' }, deps), error => !error.message.includes('sensitive-marker'));
    assert.equal(await fixture.store.refresh(), fixture.Q);
  }
});

test('workflow는 고정 source/Environment와 private data checkout을 분리하며 공개 artifact를 만들지 않는다', async () => {
  const doc = load(await readFile(resolve('.github/workflows/dev-gitops-operations.yml'), 'utf8'));
  assert.deepEqual(Object.keys(doc.on), ['workflow_dispatch']);
  assert.equal(doc.jobs.operate.environment, 'infra-dev-gitops');
  assert.equal(doc.concurrency['cancel-in-progress'], false);
  assert.deepEqual(doc.jobs.operate.permissions, { contents: 'read', 'id-token': 'write' });
  const steps = doc.jobs.operate.steps;
  const checkouts = steps.filter(step => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkouts.length, 2);
  assert.equal(checkouts[0].with.ref, '${{ github.workflow_sha }}');
  assert.equal(checkouts[0].with['persist-credentials'], false);
  assert.equal(checkouts[1].with.repository, 'soma-376/infra-generated-values');
  assert.equal(checkouts[1].with.ref, '${{ inputs.request_ref }}');
  assert.equal(checkouts[1].with['persist-credentials'], false);
  assert(steps.some(step => step.run === 'mv .gitops-input "$RUNNER_TEMP/gitops-input"'));
  assert(!steps.some(step => step.uses?.startsWith('actions/upload-artifact@')));
  assert(!steps.some(step => /--publish|kubectl (apply|patch)|cdk deploy/.test(step.run ?? '')));
});
