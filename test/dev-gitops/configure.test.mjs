import test from 'node:test';
import assert from 'node:assert/strict';
import { configure, prepareConfiguration } from '../../scripts/dev-gitops/configure.mjs';
import { promote } from '../../scripts/dev-gitops/engine.mjs';
import { GENERATED, configurationFingerprint } from '../../scripts/dev-gitops/release.mjs';
import { parse, json } from '../../scripts/dev-gitops/contract.mjs';
import { C, OWNER, makeBundle, observation, promotionArgs, repository } from './fixtures.mjs';

const NEXT_C = 'd'.repeat(40);
const CONFIG_OWNER = { repository: 'soma-376/infra', workflowRef: 'soma-376/infra/.github/workflows/dev_gitops.yml@refs/heads/develop',
  workflowRunId: '901', workflowRunAttempt: '1' };
const generated = files => new Map(GENERATED.map(name => [`dev/generated/${name}`, files.get(`dev/generated/${name}`)]));
async function args(fixture, overrides = {}) {
  const files = await fixture.store.files(fixture.V), candidate = generated(files);
  candidate.set('dev/generated/clickhouse.yaml', '# controlled configuration change\nfixed: updated\n');
  return { store: fixture.store, sourceCommit: NEXT_C, candidate, owner: CONFIG_OWNER,
    validateCandidate: async () => {}, observe: async () => observation(), nonce: () => 'd'.repeat(32), ...overrides };
}

test('설정 게시가 같은 정상 B와 이미지를 보존하며 V/P/bind/수락 순서로 새 C를 선택한다', async t => {
  const fixture = await repository(t), input = await args(fixture); let observations = 0, checks = 0;
  input.validateCandidate = async value => {
    checks++;
    assert.equal(value.sourceCommit, NEXT_C);
    assert.equal(value.bundleManifest, fixture.baseline.bytes);
    assert.equal(value.candidate.size, 13);
  };
  input.observe = async ({ selection, bundle, runtimeFingerprint }) => {
    observations++;
    const state = await fixture.store.state(await fixture.store.refresh());
    assert.equal(state.state, 'deploying'); assert.equal(state.operation.kind, 'config');
    assert.equal(state.generation, 1); assert.deepEqual(state.owner, CONFIG_OWNER);
    assert.equal(state.expectedDesiredP, selection.desiredCommit);
    assert.equal(bundle.bytes, fixture.baseline.bytes);
    assert.equal(runtimeFingerprint, configurationFingerprint(input.candidate));
    return observation();
  };
  const result = await configure(input);
  assert.equal(result.result, 'passed'); assert.equal(observations, 1); assert.equal(checks, 3);
  const head = await fixture.store.refresh(), state = await fixture.store.state(head);
  assert.equal(state.state, 'idle'); assert.equal(state.owner, null); assert.equal(state.operation, null);
  assert.equal(state.lastKnownGood.infraCommit, NEXT_C);
  assert.equal(state.lastKnownGood.bundleManifestSha256, fixture.baseline.B);
  assert.equal(state.lastKnownGood.configurationFingerprint, configurationFingerprint(input.candidate));
  const snapshot = await fixture.store.files(result.selection.valuesCommit);
  assert.equal(snapshot.get('dev/bundle.json'), fixture.baseline.bytes);
  assert.equal(snapshot.get('dev/infra-commit.txt'), `${NEXT_C}\n`);
  for (const [path, text] of input.candidate) assert.equal(snapshot.get(path), text);
  assert.equal(parse(snapshot.get('dev/desired.yaml')).infraCommit, C, 'V만 게시한 시점의 선택은 이전 C다');
  const selected = await fixture.store.files(result.selection.desiredCommit);
  assert.equal(parse(selected.get('dev/desired.yaml')).infraCommit, NEXT_C);
  assert.equal((await fixture.store.state(result.selection.desiredCommit)).expectedDesiredP, fixture.P, 'P 다음 commit에서만 자기 SHA를 state에 묶는다');
  assert.equal(await fixture.store.git(['rev-list', '--count', `${fixture.Q}..${head}`]), '5');
});

test('동일 C와 동일 13개는 검증 후 no-op이고 Git을 쓰지 않는다', async t => {
  const fixture = await repository(t), candidate = generated(await fixture.store.files(fixture.V)); let checks = 0;
  const result = await configure(await args(fixture, { sourceCommit: C, candidate,
    validateCandidate: async () => { checks++; }, observe: async () => { throw new Error('must not observe'); } }));
  assert.equal(result.result, 'noop'); assert.equal(checks, 1);
  assert.equal(await fixture.store.refresh(), fixture.Q);
});

test('미고정 source·13개 누락/추가·YAML 오류·이미지 변경은 첫 Git 쓰기 전에 거부한다', async t => {
  const fixture = await repository(t), original = await args(fixture);
  const mutations = [
    input => { input.sourceCommit = 'develop'; },
    input => { input.owner = OWNER; },
    input => { delete input.validateCandidate; },
    input => { input.candidate.delete('dev/generated/base.yaml'); },
    input => { input.candidate.set('dev/generated/other.yaml', '{}\n'); },
    input => { input.candidate.set('dev/generated/base.yaml', '[]\n'); },
    input => { input.candidate.set('dev/generated/base.yaml', 'foo: [sensitive-marker\n'); },
    input => { input.candidate.set('dev/generated/base.yaml', 'deliveryVerification: {}\n'); },
    input => { input.candidate.set('dev/generated/enrollment-api.yaml', input.candidate.get('dev/generated/enrollment-api.yaml').replace(fixture.baseline.manifest.images['enrollment-api'].digest, makeBundle().manifest.images['enrollment-api'].digest)); },
    input => { input.candidate.set('dev/generated/enrollment-api.yaml', input.candidate.get('dev/generated/enrollment-api.yaml').replace('123456789012', '111111111111')); },
  ];
  for (const change of mutations) {
    const input = { ...original, candidate: new Map(original.candidate) }; change(input);
    await assert.rejects(configure(input), error => !error.message.includes('sensitive-marker'));
    assert.equal(await fixture.store.refresh(), fixture.Q);
  }
  await assert.rejects(configure({ ...original, validateCandidate: async () => { throw new Error('sensitive-marker'); } }), /설정 후보 생성·렌더 검증 실패/);
  assert.equal(await fixture.store.refresh(), fixture.Q);
});

for (const result of ['failed', 'unknown', 'throws', 'nonterminal']) test(`설정 관측 ${result}는 rollback 없이 새 선택과 기존 정상 기준을 보존한 blocked다`, async t => {
  const fixture = await repository(t);
  const input = await args(fixture, { observe: async () => {
    if (result === 'throws') throw new Error('sensitive-marker');
    return observation({ result: result === 'nonterminal' ? 'passed' : result, terminal: result !== 'unknown' && result !== 'nonterminal' });
  } });
  assert.equal((await configure(input)).result, 'blocked');
  const head = await fixture.store.refresh(), state = await fixture.store.state(head);
  assert.equal(state.state, 'blocked'); assert.equal(state.operation.kind, 'config');
  assert.equal(state.operation.rollbackAttempted, false); assert.deepEqual(state.owner, CONFIG_OWNER);
  assert.equal(state.currentSelection.infraCommit, NEXT_C); assert.equal(state.lastKnownGood.infraCommit, C);
  assert.equal(state.failedReleases.length, 0); assert.equal(state.resumeFence, null);
  assert.equal((await fixture.store.files(head)).get('dev/bundle.json'), fixture.baseline.bytes);
  assert.doesNotMatch(await fixture.store.read(head, 'dev/delivery-state.json'), /sensitive-marker/);
});

test('V 게시 뒤 재검증 실패는 미선택 V만 남기고 이전 P를 blocked로 보존한다', async t => {
  const fixture = await repository(t); let checks = 0;
  const result = await configure(await args(fixture, { validateCandidate: async () => {
    if (++checks === 3) throw new Error('changed metadata');
  } }));
  assert.equal(result.result, 'blocked');
  const head = await fixture.store.refresh(), state = await fixture.store.state(head);
  assert.equal(state.expectedDesiredP, fixture.P); assert.equal(state.currentSelection.infraCommit, C);
  assert.equal(parse((await fixture.store.files(head)).get('dev/desired.yaml')).infraCommit, C);
  assert.equal(await fixture.store.git(['rev-list', '--count', `${fixture.Q}..${head}`]), '3');
});

test('P 게시 뒤 bind 실패도 그 P와 owner를 보존한 blocked로 묶는다', async t => {
  const fixture = await repository(t), original = fixture.store.cas.bind(fixture.store); let failed = false;
  fixture.store.cas = async (head, changes, message) => {
    if (message.includes('bind config') && !failed) { failed = true; throw new Error('simulated write failure'); }
    return original(head, changes, message);
  };
  assert.equal((await configure(await args(fixture))).result, 'blocked');
  const head = await fixture.store.refresh(), state = await fixture.store.state(head);
  assert.equal(state.currentSelection.infraCommit, NEXT_C); assert.equal(state.state, 'blocked');
  assert.equal(parse((await fixture.store.files(head)).get('dev/desired.yaml')).infraCommit, NEXT_C);
  assert.equal(state.expectedDesiredP, state.currentSelection.desiredCommit);
});

test('관측 중 owner를 잃으면 이전 설정 게시기가 blocked조차 덮어쓰지 않는다', async t => {
  const fixture = await repository(t); let takeover;
  await assert.rejects(configure(await args(fixture, { observe: async () => {
    const head = await fixture.store.refresh(), state = await fixture.store.state(head);
    takeover = await fixture.store.writeState(head, { ...state, generation: state.generation + 1,
      state: 'blocked', owner: { ...CONFIG_OWNER, workflowRunId: '999' }, operation: { ...state.operation, blockedReason: 'operator_takeover' } }, 'takeover');
    return observation();
  } })), /owner|불명확/);
  assert.equal(await fixture.store.refresh(), takeover);
  assert.equal((await fixture.store.state(takeover)).owner.workflowRunId, '999');
});

test('이미지와 설정 게시가 같은 HEAD에서 경쟁하면 실제 bare Git CAS의 한 실행만 진입한다', async t => {
  const fixture = await repository(t), second = await fixture.clone('config-contender');
  const outcomes = await Promise.allSettled([
    promote(promotionArgs(fixture)),
    configure(await args(fixture, { store: second })),
  ]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(result => result.status === 'rejected').length, 1);
  const state = await fixture.store.state(await fixture.store.refresh());
  assert.equal(state.state, 'idle'); assert.equal(state.generation, 1);
});

test('설정 수락 후 이미지 승격도 새 C와 비이미지 바이트를 유지한다', async t => {
  const fixture = await repository(t), input = await args(fixture);
  assert.equal((await configure(input)).result, 'passed');
  const configured = await fixture.store.state(await fixture.store.refresh());
  assert.equal(configured.lastKnownGood.configurationFingerprint, configurationFingerprint(input.candidate));
  assert.equal((await promote(promotionArgs(fixture))).result, 'passed');
  const head = await fixture.store.refresh(), state = await fixture.store.state(head);
  assert.equal(state.generation, 2); assert.equal(state.currentSelection.infraCommit, NEXT_C);
  const files = await fixture.store.files(state.currentSelection.valuesCommit);
  assert.equal(files.get('dev/generated/clickhouse.yaml'), input.candidate.get('dev/generated/clickhouse.yaml'));
});

test('첫 초기화 전 H-only에는 config publisher가 state를 꾸며 넣지 않는다', async t => {
  const fixture = await repository(t, { handoffOnly: true });
  await assert.rejects(configure({ store: fixture.store, sourceCommit: NEXT_C, candidate: generated(fixture.generated),
    owner: CONFIG_OWNER, observe: async () => observation(), validateCandidate: async () => {} }));
  assert.equal(await fixture.store.refresh(), fixture.expectedHead);
  assert.equal((await fixture.store.files(fixture.expectedHead)).has('dev/delivery-state.json'), false);
});
