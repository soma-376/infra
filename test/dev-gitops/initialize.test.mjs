import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareInitialization, initialize, acceptInitialization, main } from '../../scripts/dev-gitops/initialize.mjs';
import { CATALOG } from '../../scripts/dev-argocd-applications.mjs';
import { parse, sha256, json } from '../../scripts/dev-gitops/contract.mjs';
import { C, OWNER, activation, provenance, repository, makeBundle, observation } from './fixtures.mjs';

function input(fixture, overrides = {}) {
  return { schemaVersion: 1, infraCommit: C, expectedHead: fixture.expectedHead, operationNonce: 'd'.repeat(32),
    owner: { ...OWNER, repository: 'soma-376/infra', workflowRef: 'soma-376/infra/.github/workflows/acceptance.yml@refs/heads/develop' },
    activation: activation(), normalBundleEvidenceSha256: sha256('normal bundle functional evidence'),
    renderEvidenceSha256: sha256('same C render evidence'), normalBundleManifestSha256: fixture.baseline.B,
    provenance: provenance(fixture.baseline), ...overrides };
}
function prepared(fixture, overrides) {
  return prepareInitialization(input(fixture, overrides), fixture.baseline.bytes, fixture.generated);
}

test('초기화는 H marker가 아닌 정상 contract B와 세 운영 수락을 요구한다', async t => {
  const fixture = await repository(t, { handoffOnly: true });
  assert.throws(() => prepareInitialization(input(fixture), json({ schemaVersion: 1, mode: 'handoff' }), fixture.generated));
  assert.throws(() => prepared(fixture, { normalBundleManifestSha256: makeBundle().B }));
  assert.throws(() => prepared(fixture, { normalBundleEvidenceSha256: '' }));
  assert.throws(() => prepared(fixture, { renderEvidenceSha256: '' }));
  assert.throws(() => prepared(fixture, { owner: OWNER }));
  for (const key of ['handoffAccepted', 'infraPublisherAccepted', 'normalBundleAccepted']) {
    const value = activation(); value.readiness[key] = false;
    assert.throws(() => prepared(fixture, { activation: value }));
  }
  const wrongCurrentImages = new Map(fixture.generated);
  wrongCurrentImages.set('dev/generated/enrollment-api.yaml', wrongCurrentImages.get('dev/generated/enrollment-api.yaml').replace(
    fixture.baseline.manifest.images['enrollment-api'].digest, makeBundle().manifest.images['enrollment-api'].digest));
  assert.throws(() => prepareInitialization(input(fixture), fixture.baseline.bytes, wrongCurrentImages));
  assert.equal(await fixture.store.refresh(), fixture.expectedHead);
});

test('로컬 bare Git 초기화도 V·P·상태 순서를 지키고 실제 gate 통과 뒤 첫 idle을 기록한다', async t => {
  const fixture = await repository(t, { handoffOnly: true }), init = prepared(fixture); let observed;
  const result = await initialize({ prepared: init, store: fixture.store,
    observe: async data => { observed = data; return observation({ runtimeFingerprint: data.runtimeFingerprint }); } });
  assert.equal(result.result, 'passed');
  const head = await fixture.store.refresh(), state = await fixture.store.state(head), files = await fixture.store.files(head);
  assert.equal(state.state, 'idle'); assert.equal(state.owner, null); assert.equal(state.generation, 1);
  assert.equal(state.lastKnownGood.bundleManifestSha256, fixture.baseline.B);
  assert.equal(observed.selection.valuesCommit, state.currentSelection.valuesCommit);
  const root = parse(files.get('dev/root.yaml'));
  assert.equal(root.spec.syncPolicy.automated.enabled, true); assert.equal(root.spec.syncPolicy.automated.prune, false);
  assert.deepEqual(root.spec.syncPolicy.retry, { limit: 0 });
  assert.equal(files.get('dev/bundle.json'), fixture.baseline.bytes);
  assert.equal([...files.keys()].filter(name => name.startsWith('dev/applications/')).length, 18);
  for (const entry of CATALOG.applications) {
    const app = parse(files.get(`dev/applications/${entry.id}.yaml`));
    assert.equal(app.spec.sources[0].targetRevision, C);
    assert.equal(app.spec.syncPolicy.automated.selfHeal, true);
    assert.equal(app.spec.syncPolicy.automated.allowEmpty, false);
    assert.deepEqual(app.spec.syncPolicy.retry, { limit: 0 });
  }
  const atP = await fixture.store.files(state.currentSelection.desiredCommit);
  assert.equal(atP.has('dev/delivery-state.json'), false);
  assert.equal(atP.get('dev/desired.yaml').includes(state.currentSelection.desiredCommit), false);
  const atV = await fixture.store.files(state.currentSelection.valuesCommit);
  assert.equal(atV.has('dev/desired.yaml'), false); assert.equal(atV.has('dev/root.yaml'), false);
});

for (const throws of [false, true]) test(`초기 gate 불명은 정상 B·idle을 꾸미지 않고 차단한다 (조회 예외=${throws})`, async t => {
  const fixture = await repository(t, { handoffOnly: true });
  const result = await initialize({ prepared: prepared(fixture), store: fixture.store,
    observe: async ({ runtimeFingerprint }) => {
      if (throws) throw new Error('simulated private observation timeout');
      return observation({ runtimeFingerprint, result: 'unknown', terminal: false });
    } });
  assert.equal(result.result, 'blocked');
  const state = await fixture.store.state(await fixture.store.refresh());
  assert.equal(state.state, 'blocked'); assert.equal(state.lastKnownGood, null);
  assert.equal(state.owner.repository, 'soma-376/infra');
});

test('기존 GitOps와 낡은 bootstrap HEAD는 초기화로 덮어쓰지 않는다', async t => {
  const handoff = await repository(t, { handoffOnly: true }), init = prepared(handoff);
  const head = await handoff.store.cas(handoff.expectedHead, new Map([['dev/evidence/' + 'a'.repeat(32) + '.json', '{}\n']]), 'external change');
  await assert.rejects(initialize({ prepared: init, store: handoff.store, observe: async () => { throw new Error('must not observe'); } }));
  assert.equal(await handoff.store.refresh(), head);
  const active = await repository(t);
  const activeFiles = await active.store.files(active.V);
  const activeInput = input({ ...active, expectedHead: active.Q });
  const retry = prepareInitialization(activeInput, active.baseline.bytes, activeFiles);
  await assert.rejects(initialize({ prepared: retry, store: active.store, observe: async () => { throw new Error('must not observe'); } }));
  assert.equal(await active.store.refresh(), active.Q);
});


test('검토 CLI는 root·snapshot만 생성하고 명시적 게시 gate 없이는 Git을 쓰지 않는다', async t => {
  const fixture = await repository(t, { handoffOnly: true });
  const config = join(fixture.root, 'input.json'), candidate = join(fixture.root, 'candidate.json');
  const generated = join(fixture.root, 'generated'); await mkdir(generated);
  await writeFile(config, json(input(fixture))); await writeFile(candidate, fixture.baseline.bytes);
  for (const [name, content] of fixture.generated) if (name.startsWith('dev/generated/')) await writeFile(join(generated, name.split('/').at(-1)), content);
  t.mock.method(console, 'log', () => {});
  const output = join(fixture.root, 'review');
  const args = ['--input', config, '--candidate', candidate, '--generated-dir', generated, '--output-dir', output];
  assert.equal(await main(args, {}), 0);
  const review = parse(await readFile(join(output, 'initialization-review.json'), 'utf8'));
  assert.equal(review.mode, 'review'); assert.equal(review.valuesCommit, null); assert.equal(review.desiredCommit, null);
  const root = parse(await readFile(join(output, 'root.yaml'), 'utf8'));
  assert.equal(root.kind, 'Application'); assert.equal(root.spec.source.targetRevision, 'main');
  assert.equal(await fixture.store.refresh(), fixture.expectedHead);
  const publishArgs = [...args.slice(0, 7), join(fixture.root, 'disabled-publish'), '--publish'];
  await assert.rejects(main(publishArgs, {}), /초기화 게시|운영 수락/);
  assert.equal(await fixture.store.refresh(), fixture.expectedHead);
});

test('초기화 blocked 재수락은 같은 owner·P/V를 재검증하고 선택을 재게시하지 않는다', async t => {
  const fixture = await repository(t, { handoffOnly: true });
  await initialize({ prepared: prepared(fixture), store: fixture.store,
    observe: async ({ runtimeFingerprint }) => observation({ runtimeFingerprint, result: 'unknown', terminal: false }) });
  const before = await fixture.store.refresh(), state = await fixture.store.state(before);
  const accept = { expectedHead: before, owner: state.owner, generation: state.generation };
  for (const invalid of [{ ...accept, generation: 99 }, { ...accept, owner: OWNER }, { ...accept, expectedHead: fixture.expectedHead }]) {
    await assert.rejects(acceptInitialization({ store: fixture.store, input: invalid, observe: async () => { throw new Error('must not observe'); } }));
    assert.equal(await fixture.store.refresh(), before);
  }
  const result = await acceptInitialization({ store: fixture.store, input: accept,
    observe: async ({ runtimeFingerprint }) => observation({ runtimeFingerprint }) });
  assert.equal(result.result, 'passed');
  const head = await fixture.store.refresh(), final = await fixture.store.state(head);
  assert.equal(final.state, 'idle'); assert.deepEqual(final.currentSelection, state.currentSelection);
  assert.equal(await fixture.store.git(['rev-list', '--count', `${before}..${head}`]), '1');
  assert.equal(final.lastKnownGood.desiredCommit, state.expectedDesiredP);
});

test('초기 수락 재관측 중 owner가 바뀌면 이전 운영자도 상태를 덮지 않는다', async t => {
  const fixture = await repository(t, { handoffOnly: true });
  await initialize({ prepared: prepared(fixture), store: fixture.store,
    observe: async ({ runtimeFingerprint }) => observation({ runtimeFingerprint, result: 'unknown', terminal: false }) });
  const head = await fixture.store.refresh(), state = await fixture.store.state(head); let takeover;
  await assert.rejects(acceptInitialization({ store: fixture.store,
    input: { expectedHead: head, generation: state.generation, owner: state.owner },
    observe: async ({ runtimeFingerprint }) => {
      takeover = await fixture.store.writeState(head, { ...state, generation: state.generation + 1,
        owner: { ...state.owner, workflowRunId: '999' } }, 'operator takeover during initial acceptance');
      return observation({ runtimeFingerprint });
    } }));
  assert.equal(await fixture.store.refresh(), takeover);
  assert.equal((await fixture.store.state(takeover)).owner.workflowRunId, '999');
});
