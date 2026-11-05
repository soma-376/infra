import test from 'node:test';
import assert from 'node:assert/strict';
import { promote } from '../../scripts/dev-gitops/engine.mjs';
import { json, parse, sha256 } from '../../scripts/dev-gitops/contract.mjs';
import { repository, promotionArgs, observation, fingerprints, makeBundle, provenance, OWNER } from './fixtures.mjs';

async function commits(store) {
  const head = await store.refresh();
  return (await store.git(['log', '--reverse', '--format=%H%x09%s', head])).split('\n').map(line => {
    const [sha, message] = line.split('\t'); return { sha, message };
  });
}

test('V를 먼저 보존하고 P 후속 상태만 자기 P를 결합한 뒤 검증 성공으로 잠금을 해제한다', async t => {
  const fixture = await repository(t), candidate = makeBundle();
  const result = await promote(promotionArgs(fixture));
  assert.equal(result.result, 'passed');
  const head = await fixture.store.refresh(), state = await fixture.store.state(head);
  assert.equal(state.state, 'idle'); assert.equal(state.owner, null); assert.equal(state.operation, null);
  assert.equal(state.generation, 1); assert.equal(state.expectedDesiredP, result.selection.desiredCommit);
  assert.equal(state.lastKnownGood.bundleManifestSha256, candidate.B);
  const history = await commits(fixture.store);
  const V = history.find(entry => entry.message.includes('immutable image snapshot')).sha;
  const P = history.find(entry => entry.message.includes('select image snapshot')).sha;
  assert.equal(result.selection.valuesCommit, V); assert.equal(result.selection.desiredCommit, P);
  assert.equal(parse(await fixture.store.read(V, 'dev/desired.yaml')).valuesCommit, fixture.V);
  assert.equal(await fixture.store.read(V, 'dev/bundle.json'), candidate.bytes);
  const pDesired = await fixture.store.read(P, 'dev/desired.yaml');
  assert.equal(pDesired.includes(P), false);
  assert.equal((await fixture.store.state(P)).expectedDesiredP, fixture.P);
  assert.equal(parse(pDesired).valuesCommit, V);
  const evidence = await fixture.store.read(head, `dev/evidence/${result.selection.operationNonce}.json`);
  assert.equal(sha256(evidence), state.lastKnownGood.evidenceSha256);
});

test('같은 B는 Git 쓰기·새 observation 없이 no-op이다', async t => {
  const fixture = await repository(t); let observed = false;
  const result = await promote(promotionArgs(fixture, { candidateBytes: fixture.baseline.bytes,
    provenance: provenance(fixture.baseline), observe: async () => { observed = true; throw new Error('no-op'); } }));
  assert.equal(result.result, 'noop'); assert.equal(observed, false);
  assert.equal(await fixture.store.refresh(), fixture.Q);
});

test('활성 Application의 기본 재시도는 잠금·V 게시 전에 거부한다', async t => {
  const fixture = await repository(t);
  const path = 'dev/applications/enrollment-api.yaml';
  const app = parse(await fixture.store.read(fixture.Q, path));
  delete app.spec.syncPolicy.retry;
  const head = await fixture.store.cas(fixture.Q, new Map([[path, json(app)]]), 'fixture retry drift');
  await assert.rejects(promote(promotionArgs(fixture)), /retry.limit=0/);
  assert.equal(await fixture.store.refresh(), head);
});

test('V 뒤 P 게시 실패는 원래 선택을 유지하고 미선택 candidate를 정상 B로 만들지 않는다', async t => {
  const fixture = await repository(t); const cas = fixture.store.cas.bind(fixture.store);
  fixture.store.cas = async (head, changes, message) => {
    if (message.includes('select image snapshot')) throw new Error('injected local publication failure');
    return cas(head, changes, message);
  };
  const result = await promote(promotionArgs(fixture));
  assert.equal(result.result, 'blocked');
  const head = await fixture.store.refresh(), state = await fixture.store.state(head);
  assert.equal(state.currentSelection.valuesCommit, fixture.V);
  assert.equal(state.currentSelection.desiredCommit, fixture.P);
  assert.equal(state.lastKnownGood.bundleManifestSha256, fixture.baseline.B);
  assert.equal(parse(await fixture.store.read(head, 'dev/desired.yaml')).valuesCommit, fixture.V);
  assert.equal(parse(await fixture.store.read(head, 'dev/bundle.json')).backendCommit, makeBundle().manifest.backendCommit);
  assert.equal((await commits(fixture.store)).filter(entry => entry.message.includes('select image snapshot')).length, 0);
});

test('owner 유실 뒤 이전 실행은 blocked 기록도 덮어쓰지 않는다', async t => {
  const fixture = await repository(t); let takeover;
  const args = promotionArgs(fixture, { observe: async ({ runtimeFingerprint }) => {
    const head = await fixture.store.refresh(), state = await fixture.store.state(head);
    takeover = await fixture.store.writeState(head, { ...state, generation: state.generation + 1,
      state: 'blocked', owner: { ...OWNER, workflowRunId: '999' }, operation: { ...state.operation, blockedReason: 'operator_handoff' } },
    'operator owns newer generation');
    return observation({ runtimeFingerprint, result: 'unknown' });
  } });
  await assert.rejects(promote(args), /owner|불명확/);
  assert.equal(await fixture.store.refresh(), takeover);
  const state = await fixture.store.state(takeover);
  assert.equal(state.owner.workflowRunId, '999'); assert.equal(state.operation.blockedReason, 'operator_handoff');
});

for (const terminal of [true, false]) test(`unknown 또는 미종료 실패는 자동 복구하지 않는다 (terminal=${terminal})`, async t => {
  const fixture = await repository(t); let compatibilityCalls = 0;
  const result = await promote(promotionArgs(fixture, {
    observe: async ({ runtimeFingerprint }) => observation({ runtimeFingerprint, result: terminal ? 'unknown' : 'failed', terminal }),
    compatibility: async () => { compatibilityCalls++; throw new Error('must not recover unknown'); },
  }));
  assert.equal(result.result, 'blocked'); assert.equal(result.reason, 'observation_unknown');
  assert.equal(compatibilityCalls, 0);
  const state = await fixture.store.state(await fixture.store.refresh());
  assert.equal(state.failedReleases.length, 0); assert.equal(state.operation.rollbackAttempted, false);
});

test('실패 시 실제 schema가 변했으면 실패 fence를 남기고 rollback을 시작하지 않는다', async t => {
  const fixture = await repository(t); let observations = 0;
  const result = await promote(promotionArgs(fixture, {
    observe: async ({ runtimeFingerprint }) => { observations++; return observation({ runtimeFingerprint, result: 'failed' }); },
    compatibility: async ({ runtimeFingerprint }) => ({ terminal: true,
      fingerprints: { ...fingerprints(runtimeFingerprint), schemaFingerprint: '0'.repeat(64) } }),
  }));
  assert.equal(result.result, 'blocked'); assert.equal(result.reason, 'compatibility_unknown_or_changed');
  assert.equal(observations, 1);
  const state = await fixture.store.state(await fixture.store.refresh());
  assert.equal(state.resumeFence.active, true); assert.equal(state.failedReleases.length, 1);
  assert.equal(state.failedReleases[0].bundleManifestSha256, makeBundle().B);
  assert.equal(state.operation.rollbackAttempted, false);
});

test('호환 가능한 확정 실패는 새 nonce·V/P로 한 번 복구하고 누적 실패와 fence를 보존한다', async t => {
  const fixture = await repository(t), seen = []; let compatibilityCalls = 0;
  const result = await promote(promotionArgs(fixture, {
    observe: async input => { seen.push(input); return observation({ runtimeFingerprint: input.runtimeFingerprint,
      result: seen.length === 1 ? 'failed' : 'passed' }); },
    compatibility: async ({ runtimeFingerprint }) => { compatibilityCalls++; return { terminal: true, fingerprints: fingerprints(runtimeFingerprint) }; },
  }));
  assert.equal(result.result, 'passed'); assert.equal(seen.length, 2); assert.equal(compatibilityCalls, 1);
  assert.equal(seen[1].bundle.B, fixture.baseline.B);
  assert.notEqual(seen[0].selection.operationNonce, seen[1].selection.operationNonce);
  assert.notEqual(seen[0].selection.valuesCommit, seen[1].selection.valuesCommit);
  assert.notEqual(seen[0].selection.desiredCommit, seen[1].selection.desiredCommit);
  assert.notEqual(seen[1].selection.valuesCommit, fixture.V);
  assert.equal(seen[0].runtimeFingerprint, seen[1].runtimeFingerprint);
  const head = await fixture.store.refresh(), state = await fixture.store.state(head);
  assert.equal(state.state, 'idle'); assert.equal(state.resumeFence.active, true);
  assert.equal(state.lastKnownGood.bundleManifestSha256, fixture.baseline.B);
  assert.equal(state.failedReleases[0].bundleManifestSha256, makeBundle().B);
  assert.equal((await fixture.store.failures(head)).length, 1);
  assert.equal((await commits(fixture.store)).filter(entry => entry.message.includes('immutable image snapshot')).length, 2);
});

test('복구도 실패하면 세 번째 선택 없이 blocked에 잠금을 보존한다', async t => {
  const fixture = await repository(t); let observations = 0, compatibilityCalls = 0;
  const result = await promote(promotionArgs(fixture, {
    observe: async ({ runtimeFingerprint }) => { observations++; return observation({ runtimeFingerprint, result: 'failed' }); },
    compatibility: async ({ runtimeFingerprint }) => { compatibilityCalls++; return { terminal: true, fingerprints: fingerprints(runtimeFingerprint) }; },
  }));
  assert.equal(result.result, 'blocked'); assert.equal(result.reason, 'rollback_failed_or_unknown');
  assert.equal(observations, 2); assert.equal(compatibilityCalls, 1);
  const state = await fixture.store.state(await fixture.store.refresh());
  assert.equal(state.operation.rollbackAttempted, true); assert.deepEqual(state.owner, OWNER);
  assert.equal((await commits(fixture.store)).filter(entry => entry.message.includes('select image snapshot')).length, 2);
});

test('현재 state에서 빠진 이전 실패도 전체 Git 이력에서 복원하여 재포장 후보를 거부한다', async t => {
  const fixture = await repository(t), candidate = makeBundle();
  const failure = { bundleManifestSha256: 'f'.repeat(64), imageVectorSha256: candidate.vector,
    backendCommit: 'd'.repeat(40), failureRecordedAt: '2026-11-06T01:00:00Z' };
  const old = await fixture.store.writeState(fixture.Q, { ...fixture.state, failedReleases: [failure], failedRelease: failure }, 'historical failure');
  const head = await fixture.store.writeState(old, fixture.state, 'latest state no longer repeats previous failure');
  assert.deepEqual(await fixture.store.failures(head), [failure]);
  await assert.rejects(promote(promotionArgs(fixture)), /실패한 B|이미지 조합/);
  assert.equal(await fixture.store.refresh(), head);
});

test('잠금 이후 원본 후보 재검증이 실패하면 P를 선택하지 않는다', async t => {
  const fixture = await repository(t); let checked = 0;
  const result = await promote(promotionArgs(fixture, { revalidateCandidate: async () => {
    checked++;
    const state = await fixture.store.state(await fixture.store.refresh());
    if (state.owner) throw new Error('latest producer changed after lock acquisition');
  } }));
  assert.ok(checked >= 2, '잠금 전에 한 번 확인한 후보만으로 P를 게시하면 안 된다');
  assert.equal(result.result, 'blocked');
  const desired = parse(await fixture.store.read(await fixture.store.refresh(), 'dev/desired.yaml'));
  assert.equal(desired.valuesCommit, fixture.V);
});

test('P 게시 뒤 상태 결합 실패를 blocked로 기록하면 실제 desired 선택을 함께 기록한다', async t => {
  const fixture = await repository(t); const cas = fixture.store.cas.bind(fixture.store);
  fixture.store.cas = async (head, changes, message) => {
    if (message.includes('bind desired revision')) throw new Error('injected state write interruption');
    return cas(head, changes, message);
  };
  let result;
  try { result = await promote(promotionArgs(fixture)); } catch { /* 확인할 수 없는 상태는 원래 잠금을 보존할 수 있다. */ }
  const head = await fixture.store.refresh(), state = await fixture.store.state(head);
  const desired = parse(await fixture.store.read(head, 'dev/desired.yaml'));
  assert.notEqual(desired.valuesCommit, fixture.V);
  if (result?.result === 'blocked') {
    assert.equal(state.currentSelection.valuesCommit, desired.valuesCommit);
    assert.equal(state.currentSelection.bundleManifestSha256, desired.bundleManifestSha256);
    assert.equal(state.expectedDesiredP, state.currentSelection.desiredCommit);
  } else {
    assert.equal(state.state, 'deploying');
    assert.equal((await commits(fixture.store)).filter(entry => entry.message.includes('delivery blocked')).length, 0);
  }
});

test('관측 ID에 원문 문자열을 넣어 private evidence 허용목록을 우회하지 못한다', async t => {
  const fixture = await repository(t);
  const result = await promote(promotionArgs(fixture, { observe: async ({ runtimeFingerprint }) => observation({ runtimeFingerprint,
    applications: [{ id: 'password=not-a-real-secret', result: 'passed' }] }) }));
  assert.equal(result.result, 'blocked');
  const files = await fixture.store.files(await fixture.store.refresh());
  assert.equal([...files].some(([name, value]) => name.startsWith('dev/evidence/') && value.includes('not-a-real-secret')), false);
});
