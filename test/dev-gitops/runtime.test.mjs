import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { eligible, promote } from '../../scripts/dev-gitops/engine.mjs';
import { producerChecks, rootRevisionContainsSelection } from '../../scripts/dev-gitops/runtime.mjs';
import { sourceRequest, verifySourceBundle } from '../../scripts/dev-gitops/source-proof.mjs';
import { sha256 } from '../../scripts/dev-gitops/contract.mjs';
import { makeBundle, observation, promotionArgs, provenance, repository } from './fixtures.mjs';

test('실패 CAS 진행 중 생성한 생산 run은 durable 응답 뒤 확정한 fence를 넘지 못한다', async t => {
  const fixture = await repository(t), cas = fixture.store.cas.bind(fixture.store);
  let clock = '2026-11-06T05:00:00Z', observations = 0;
  fixture.store.cas = async (head, changes, message) => {
    const committed = await cas(head, changes, message);
    if (message.includes('record failed image')) clock = '2026-11-06T05:00:10Z';
    return committed;
  };
  const result = await promote(promotionArgs(fixture, {
    now: () => clock,
    observe: async ({ runtimeFingerprint }) => observation({ runtimeFingerprint, result: ++observations === 1 ? 'failed' : 'passed' }),
  }));
  assert.equal(result.result, 'passed');
  const failures = await fixture.store.failures(await fixture.store.refresh());
  assert.equal(failures.length, 1);
  assert.equal(failures[0].fenceSealed, true);
  assert.equal(failures[0].failureRecordedAt, '2026-11-06T05:00:10Z');
  const next = makeBundle({ commit: 'd'.repeat(40), run: '202', imageSeed: 'new-source' });
  await assert.rejects(eligible(next, provenance(next, { createdAt: '2026-11-06T05:00:05Z' }), failures, async () => true), /실패 기록 이후/);
  await eligible(next, provenance(next, { createdAt: '2026-11-06T05:00:11Z' }), failures, async () => true);
});

test('같은 실패의 더 늦은 fence를 오래된 Git 기록이나 약화된 최신 사본이 덮지 않는다', async t => {
  const fixture = await repository(t), candidate = makeBundle();
  const sealed = { bundleManifestSha256: candidate.B, imageVectorSha256: candidate.vector,
    backendCommit: candidate.manifest.backendCommit, failureRecordedAt: '2026-11-06T05:00:10Z', fenceSealed: true };
  const first = await fixture.store.writeState(fixture.Q, { ...fixture.state, failedReleases: [sealed] }, 'strong historical fence');
  const weaker = { ...sealed, failureRecordedAt: '2026-11-06T05:00:00Z' };
  const head = await fixture.store.writeState(first, { ...fixture.state, failedReleases: [weaker] }, 'weaker latest copy');
  assert.deepEqual(await fixture.store.failures(head), [sealed]);
});

test('unsealed 실패 이력은 source가 더 새로워도 자동 재개하지 않는다', async () => {
  const next = makeBundle({ commit: 'd'.repeat(40), run: '202', imageSeed: 'next' });
  const failure = { bundleManifestSha256: 'f'.repeat(64), imageVectorSha256: 'e'.repeat(64),
    backendCommit: 'a'.repeat(40), failureRecordedAt: '2026-11-06T01:00:00Z', fenceSealed: false };
  await assert.rejects(eligible(next, provenance(next), [failure], async () => true), /durable fence/);
});

test('원본 attempt 성공 뒤 같은 run의 새 attempt가 진행 중이면 private 승격을 시작하지 않는다', async t => {
  const bundle = makeBundle(), proof = provenance(bundle), requested = [];
  t.mock.method(globalThis, 'fetch', async url => {
    const path = new URL(url).pathname;
    requested.push(path);
    return { ok: true, json: async () => path.endsWith('/attempts/1') ? {
      id: Number(proof.workflowRunId), run_attempt: 1, head_sha: proof.backendCommit,
      status: 'completed', conclusion: 'success', head_branch: 'develop', event: 'push',
      repository: { full_name: proof.repository }, head_repository: { full_name: proof.repository },
      path: '.github/workflows/deploy_dev.yml', created_at: proof.createdAt,
    } : { status: 'in_progress', conclusion: null, run_attempt: 2 } };
  });
  await assert.rejects(producerChecks({ GH_TOKEN: 'synthetic' }).revalidateCandidate(bundle, proof), /새 attempt/);
  assert.equal(requested.length, 2);
});

function sourceFixture() {
  const bundle = makeBundle();
  const archive = execFileSync('python3', ['-c', 'import sys,io,hashlib,zipfile; raw=sys.stdin.buffer.read(); out=io.BytesIO(); z=zipfile.ZipFile(out,"w"); z.writestr("completion.json",raw); z.writestr("completion.sha256",hashlib.sha256(raw).hexdigest()+"\\n"); z.close(); sys.stdout.buffer.write(out.getvalue())'], { input: bundle.bytes });
  const proof = { ...provenance(bundle), artifactId: '789', artifactSha256: sha256(archive) };
  const run = { id: 201, run_attempt: 1, workflow_id: 456, repository: { full_name: proof.repository }, head_repository: { full_name: proof.repository },
    path: '.github/workflows/deploy_dev.yml', head_branch: 'develop', head_sha: proof.backendCommit,
    created_at: proof.createdAt, event: 'push', status: 'completed', conclusion: 'success' };
  const jobs = ['Gradle build (Testcontainers)', 'Build and publish images to ECR'].map((name, index) => ({
    id: index + 1, name, run_id: 201, run_attempt: 1, head_sha: proof.backendCommit, status: 'completed', conclusion: 'success',
  }));
  const artifact = { id: 789, name: 'dev-image-bundle-201-1', expired: false, expires_at: '2099-01-01T00:00:00Z',
    workflow_run: { id: 201, head_sha: proof.backendCommit }, digest: `sha256:${proof.artifactSha256}` };
  const value = { bundle, archive, proof, run, jobs, artifact, verifiedImages: 0, currentReads: 0 };
  value.request = async (path, binary) => {
    if (path === 'actions/runs/201/attempts/1') return value.run;
    if (path === 'actions/runs/201') { value.currentReads++; return value.current ?? value.run; }
    if (path === 'actions/workflows/deploy_dev.yml') return { id: 456, path: '.github/workflows/deploy_dev.yml' };
    if (path.startsWith('actions/runs/201/attempts/1/jobs?')) return { total_count: value.jobs.length, jobs: value.jobs };
    if (path.startsWith('actions/runs/201/artifacts?')) return { total_count: 1, artifacts: [value.artifact] };
    if (path === 'actions/artifacts/789/zip') { assert.equal(binary, true); return value.archive; }
    if (path === 'commits/develop') return { sha: 'e'.repeat(40) };
    if (path.startsWith('compare/')) return { status: 'ahead' };
    if (path.startsWith('actions/workflows/deploy_dev.yml/runs?')) return { total_count: 2, workflow_runs: [value.run, { ...value.run, id: 202, created_at: '2026-11-06T06:00:00Z' }] };
    throw new Error('unexpected source fixture path');
  };
  value.verifyImages = async bytes => { value.verifiedImages++; assert.equal(bytes.toString(), value.bundle.bytes); };
  return value;
}

test('초기화는 과거 정상 B도 원본 성공·ZIP 바이트·패키지를 검증하고 이미지를 실행하지 않는다', async () => {
  const value = sourceFixture();
  const result = await verifySourceBundle(value.bundle, value.proof, value);
  assert.equal(result.verified, true); assert.equal(value.verifiedImages, 1);
  assert.equal(value.currentReads, 2, '패키지 검사 뒤 최신 attempt를 다시 확인한다');
  await assert.rejects(verifySourceBundle(value.bundle, value.proof, { ...value, requireLatest: true }), /더 새로운/);
});

test('초기화의 provenance 누락·다른 attempt/job·만료·ZIP 변조는 패키지 검사 전에 거부한다', async () => {
  for (const mutation of [
    value => value.proof = undefined,
    value => value.jobs[0].run_attempt = 2,
    value => value.current = { ...value.run, run_attempt: 2 },
    value => value.artifact.expired = true,
    value => value.artifact.workflow_run.head_sha = 'f'.repeat(40),
    value => value.archive = Buffer.from('mutated'),
  ]) {
    const value = sourceFixture(); mutation(value);
    await assert.rejects(verifySourceBundle(value.bundle, value.proof, value));
    assert.equal(value.verifiedImages, 0);
  }
});

test('패키지 검사 중 재실행이 시작되면 초기화 원본 검증을 무효화한다', async () => {
  const value = sourceFixture();
  value.verifyImages = async () => { value.current = { ...value.run, status: 'in_progress', conclusion: null, run_attempt: 2 }; };
  await assert.rejects(verifySourceBundle(value.bundle, value.proof, value), /이미지 검사 중/);
});

test('GitHub ZIP hash가 맞아도 추가 경로·내부 hash·다른 B 원문은 초기화에 쓰지 못한다', async () => {
  for (const mode of ['extra-path', 'inner-hash', 'different-bytes']) {
    const value = sourceFixture();
    value.archive = execFileSync('python3', ['-c', [
      'import sys,io,zipfile,hashlib',
      'src=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); raw=src.read("completion.json"); mode=sys.argv[1]',
      'changed=raw+b" " if mode in ("inner-hash","different-bytes") else raw',
      'out=io.BytesIO(); z=zipfile.ZipFile(out,"w"); z.writestr("completion.json",changed)',
      'z.writestr("completion.sha256",hashlib.sha256(changed if mode=="different-bytes" else raw).hexdigest()+"\\n")',
      'z.writestr("../unexpected",b"fixture") if mode=="extra-path" else None',
      'z.close(); sys.stdout.buffer.write(out.getvalue())',
    ].join(';'), mode], { input: value.archive });
    value.proof.artifactSha256 = sha256(value.archive); value.artifact.digest = `sha256:${value.proof.artifactSha256}`;
    await assert.rejects(verifySourceBundle(value.bundle, value.proof, value));
    assert.equal(value.verifiedImages, 0);
  }
});

test('서명된 artifact URL에는 GitHub token을 전달하지 않고 다른 host redirect를 거부한다', async t => {
  let blobSeen = false, wrongHost = false;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url).startsWith('https://api.github.com/')) {
      assert.equal(options.headers.Authorization, 'Bearer synthetic');
      return new Response(null, { status: 302, headers: { location: wrongHost ? 'https://attacker.invalid/object' : 'https://fixture.blob.core.windows.net/object?signature=synthetic' } });
    }
    blobSeen = true; assert.equal(options.headers, undefined);
    return new Response(Buffer.from('archive'));
  });
  assert.equal((await sourceRequest('actions/artifacts/789/zip', { env: { GH_TOKEN: 'synthetic' }, binary: true })).toString(), 'archive');
  assert.equal(blobSeen, true);
  wrongHost = true;
  await assert.rejects(sourceRequest('actions/artifacts/789/zip', { env: { GH_TOKEN: 'synthetic' }, binary: true }), /host/);
});


test('root revision은 P와 같은 desired/Application tree를 유지한 state-only 후속 commit만 수락한다', async t => {
  const fixture = await repository(t);
  assert.equal(await rootRevisionContainsSelection(fixture.store, fixture.P, fixture.P), true);
  assert.equal(await rootRevisionContainsSelection(fixture.store, fixture.Q, fixture.P), true);
  assert.equal(await rootRevisionContainsSelection(fixture.store, fixture.V, fixture.P), false);
  const path = 'dev/applications/enrollment-api.yaml';
  const changed = await fixture.store.cas(fixture.Q, new Map([[path, (await fixture.store.read(fixture.Q, path)).replace(fixture.V, '0'.repeat(40))]]), 'different selected application');
  assert.equal(await rootRevisionContainsSelection(fixture.store, changed, fixture.P), false);
  const changedDesired = await fixture.store.cas(changed, new Map([
    [path, await fixture.store.read(fixture.P, path)],
    ['dev/desired.yaml', (await fixture.store.read(fixture.P, 'dev/desired.yaml')).replace(fixture.V, '0'.repeat(40))],
  ]), 'different desired selection');
  assert.equal(await rootRevisionContainsSelection(fixture.store, changedDesired, fixture.P), false);
  await assert.rejects(rootRevisionContainsSelection({ refresh: async () => { throw new Error('unavailable'); } }, fixture.P, fixture.P), /unavailable/);
});
