import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preserveReview } from '../../scripts/dev-gitops/preserve-review.mjs';
import { GENERATED } from '../../scripts/dev-gitops/release.mjs';
import { sha256, json } from '../../scripts/dev-gitops/contract.mjs';
import { repository } from './fixtures.mjs';

test('private 검토는 새 branch만 만들고 main/CAS 상태는 보존하며 같은 branch를 덮어쓰지 않는다', async t => {
  const f = await repository(t);
  const root = await mkdtemp(join(tmpdir(), 'private-config-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'dev/generated'), { recursive: true });
  const hashes = {};
  for (const name of GENERATED) {
    const text = '# review\nfixed: true\n';
    await writeFile(join(root, 'dev/generated', name), text);
    hashes[`dev/generated/${name}`] = sha256(text);
  }
  const source = 'a'.repeat(40);
  await writeFile(join(root, 'config-review.json'), json({ sourceCommit: source, expectedHead: f.Q, hashes }));
  const env = { GITHUB_REPOSITORY: 'soma-376/infra', GITHUB_REF: 'refs/heads/develop',
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_WORKFLOW_REF: 'soma-376/infra/.github/workflows/dev-gitops-operations.yml@refs/heads/develop',
    GITHUB_SHA: source, GITHUB_WORKFLOW_SHA: source, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1' };
  const openStore = async () => Object.assign(Object.create(f.store), { close: async () => {} });
  t.mock.method(console, 'log', () => {});
  const result = await preserveReview(root, env, { openStore });
  assert.equal(await f.store.refresh(), f.Q);
  const remote = await f.store.git(['ls-remote', 'origin', `refs/heads/${result.branch}`]);
  assert.equal(remote.split('\t')[0], result.commit);
  const content = await f.store.git(['show', `${result.commit}:dev/operations/config-review.json`]);
  assert.equal(JSON.parse(content).expectedHead, f.Q);
  await assert.rejects(preserveReview(root, env, { openStore }));
  assert.equal(await f.store.refresh(), f.Q);
});
