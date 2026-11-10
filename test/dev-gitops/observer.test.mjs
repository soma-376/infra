import test from 'node:test';
import assert from 'node:assert/strict';
import { safeEvidence } from '../../scripts/dev-gitops/engine.mjs';
import { CATALOG } from '../../scripts/dev-argocd-applications.mjs';
import { currentApplication, evaluateStage, observeDeployment, credentialEnv } from '../../scripts/dev-gitops/observer.mjs';

const C = 'c'.repeat(40), V = 'd'.repeat(40), P = 'e'.repeat(40), ROOT_REVISION = 'f'.repeat(40);
const selection = { infraCommit: C, valuesCommit: V, desiredCommit: P, operationNonce: 'a'.repeat(32) };
function application(entry) {
  const revisions = entry.generatedFile ? [C, V] : [C];
  const sources = revisions.map(targetRevision => ({ targetRevision }));
  return { metadata: { name: entry.name, uid: 'a1-a2' }, spec: { sources: structuredClone(sources) },
    status: { sync: { comparedTo: { sources: structuredClone(sources) }, revisions: [...revisions], status: 'Synced' },
      health: { status: 'Healthy' }, operationState: { phase: 'Succeeded', startedAt: '2026-11-10T01:00:00Z',
        finishedAt: '2026-11-10T01:03:00Z', syncResult: { revisions: [...revisions] } } } };
}
function stage(id = 'enrollment-api') {
  const entry = CATALOG.applications.find(value => value.id === id);
  return { app: application(entry), entry, selection };
}
function deployment() {
  const applications = CATALOG.applications.map(application);
  const source = { repoURL: 'https://github.com/soma-376/infra-generated-values.git', targetRevision: 'main', path: 'dev/applications' };
  const parent = { metadata: { name: 'pulsemetry-dev-root', uid: 'b1-b2' }, spec: { source: structuredClone(source) },
    status: { sync: { comparedTo: { source: structuredClone(source) }, revision: ROOT_REVISION, status: 'Synced' },
      health: { status: 'Healthy' }, operationState: { phase: 'Succeeded', startedAt: '2026-11-10T01:00:00Z',
        finishedAt: '2026-11-10T01:04:00Z', syncResult: { revision: ROOT_REVISION } } } };
  let clock = 0;
  const paths = [];
  const client = { get: async path => {
    paths.push(path);
    const app = [...applications, parent].find(value => path === `/apis/argoproj.io/v1alpha1/namespaces/argocd/applications/${value.metadata.name}`);
    assert.ok(app, 'Application 외의 API를 조회하지 않는다');
    return structuredClone(app);
  } };
  const input = { client, selection, rootRevisionContainsSelection: async (revision, selected) => revision === ROOT_REVISION && selected === P,
    now: () => clock, timeoutMs: 10, intervalMs: 5, sleep: async ms => { clock += ms; } };
  return { applications, parent, paths, input };
}

test('현재 C/V의 Synced·Healthy와 진행 중 operation 부재로 stage 성공을 판정한다', () => {
  for (const id of ['enrollment-api', 'cert-manager']) {
    const input = stage(id), result = evaluateStage(input);
    assert.equal(currentApplication(input.app, input.entry, selection), true);
    assert.equal(result.result, 'passed');
    assert.deepEqual(result.evidence.revisions, input.entry.generatedFile ? [C, V] : [C]);
    assert.equal(result.evidence.phase, 'Succeeded');
    assert.equal(result.evidence.uid, input.app.metadata.uid);
    assert.equal(result.evidence.jobUid, undefined);
  }
});

test('이전 spec·comparedTo·resolved revision·진행 중 상태는 unknown이다', () => {
  for (const mutate of [
    app => app.spec.sources[1].targetRevision = '0'.repeat(40),
    app => app.status.sync.comparedTo.sources[1].targetRevision = '0'.repeat(40),
    app => app.status.sync.revisions[1] = '0'.repeat(40),
    app => app.operation = { sync: {} },
    app => app.status.operationState.phase = 'Running',
    app => app.status.operationState.phase = 'Terminating',
    app => app.status.sync.status = 'OutOfSync',
    app => app.status.health.status = 'Degraded',
    app => delete app.metadata.uid,
  ]) {
    const input = stage(); mutate(input.app); assert.equal(evaluateStage(input).result, 'unknown');
  }
});

test('현재 revision에 귀속된 완료 Failed/Error만 확정 실패다', () => {
  for (const phase of ['Failed', 'Error']) {
    const input = stage(); input.app.status.operationState.phase = phase;
    input.app.status.sync.status = 'OutOfSync'; input.app.status.health.status = 'Degraded';
    assert.equal(evaluateStage(input).result, 'failed');
    input.app.status.operationState.syncResult.revisions[1] = '0'.repeat(40);
    assert.equal(evaluateStage(input).result, 'unknown');
  }
});

test('root와 18 child의 현재 Argo 완료 상태만 읽어 성공을 판정한다', async () => {
  const value = deployment(), result = await observeDeployment(value.input);
  assert.equal(result.result, 'passed'); assert.equal(result.terminal, true);
  assert.equal(result.applications.length, 18); assert.equal(value.paths.length, 19);
  assert.equal(result.root.revision, ROOT_REVISION); assert.equal(result.root.phase, 'Succeeded');
  assert.equal(result.fingerprints, undefined);
  assert.deepEqual(JSON.parse(safeEvidence(result, value.input.selection)).applications, result.applications);
  assert.ok(value.paths.every(path => path.startsWith('/apis/argoproj.io/v1alpha1/namespaces/argocd/applications/')));
});

test('operation 없는 최초 수락과 과거 operation 증거도 publisher가 저장할 수 있다', async () => {
  for (const absent of [true, false]) {
    const value = deployment();
    for (const app of [...value.applications, value.parent]) {
      if (absent) delete app.status.operationState;
      else if (app === value.parent) app.status.operationState.syncResult.revision = '0'.repeat(40);
      else app.status.operationState.syncResult.revisions = app.status.sync.revisions.map(() => '0'.repeat(40));
    }
    const result = await observeDeployment(value.input);
    assert.equal(result.result, 'passed');
    const evidence = JSON.parse(safeEvidence(result, value.input.selection));
    assert.equal(evidence.root.phase, absent ? undefined : 'Succeeded');
    assert.equal(evidence.applications.length, 18);
  }
});

test('알 수 없는 operation phase는 현재 Healthy여도 성공 또는 rollback으로 판정하지 않는다', async () => {
  for (const phase of ['Pending', undefined]) {
    const value = deployment(); value.parent.status.operationState.phase = phase;
    assert.equal((await observeDeployment(value.input)).result, 'unknown');
    const input = stage(); input.app.status.operationState.phase = phase;
    assert.equal(evaluateStage(input).result, 'unknown');
  }
});

test('root의 source·comparedTo·P 선택 증명이 다르면 성공하지 않는다', async () => {
  for (const mutate of [
    value => value.parent.spec.source.repoURL = 'https://example.invalid/repo.git',
    value => value.parent.spec.source.targetRevision = 'stale',
    value => value.parent.status.sync.comparedTo.source.path = 'old/applications',
    value => value.input.rootRevisionContainsSelection = async () => false,
  ]) {
    const value = deployment(); mutate(value);
    assert.equal((await observeDeployment(value.input)).result, 'unknown');
  }
});

test('현재 child의 확정 실패는 후속 wave가 이전 revision에 남아도 모두 종료됐으면 실패다', async () => {
  const value = deployment();
  value.applications[14].status.operationState.phase = 'Failed';
  for (const app of value.applications.slice(15)) {
    app.spec.sources[1].targetRevision = '0'.repeat(40);
    app.status.sync.comparedTo.sources[1].targetRevision = '0'.repeat(40);
    app.status.sync.revisions[1] = '0'.repeat(40);
    app.status.operationState.syncResult.revisions[1] = '0'.repeat(40);
  }
  const result = await observeDeployment(value.input);
  assert.equal(result.result, 'failed'); assert.equal(result.terminal, true);
  assert.equal(result.applications.find(app => app.id === 'enrollment-api').phase, 'Failed');
});

test('root 자신의 현재 Failed/Error는 확정 실패이며 stale 실패는 현재 Healthy를 막지 않는다', async () => {
  for (const phase of ['Failed', 'Error']) {
    const value = deployment(); value.parent.status.operationState.phase = phase;
    assert.equal((await observeDeployment(value.input)).result, 'failed');
    value.parent.status.operationState.syncResult.revision = '0'.repeat(40);
    assert.equal((await observeDeployment(value.input)).result, 'passed');
  }
});

test('child 실패가 있어도 root 또는 다른 child의 진행 중 operation이 있으면 unknown이다', async () => {
  for (const mutate of [
    value => value.parent.operation = { sync: {} },
    value => value.parent.status.operationState.phase = 'Running',
    value => value.applications[0].status.operationState.phase = 'Terminating',
  ]) {
    const value = deployment(); value.applications[14].status.operationState.phase = 'Failed'; mutate(value);
    const result = await observeDeployment(value.input);
    assert.equal(result.result, 'unknown'); assert.equal(result.terminal, false);
  }
});

test('Degraded 단독 상태·관측 장애는 확정 실패로 바꾸지 않는다', async () => {
  for (const mutate of [
    value => value.applications[14].status.health.status = 'Degraded',
    value => value.input.client.get = async () => { throw new Error('simulated private API failure'); },
  ]) {
    const value = deployment(); mutate(value);
    const result = await observeDeployment(value.input);
    assert.equal(result.result, 'unknown'); assert.equal(result.reason, 'observation_deadline');
  }
});


test('manifest가 같은 새 V는 이전 Succeeded/Failed/Error operation으로도 현재 Healthy면 성공한다', () => {
  for (const phase of ['Succeeded', 'Failed', 'Error']) {
    const input = stage(); input.app.status.operationState.phase = phase;
    input.app.status.operationState.syncResult.revisions[1] = '0'.repeat(40);
    const result = evaluateStage(input);
    assert.equal(result.result, 'passed');
    assert.deepEqual(result.evidence.revisions, [C, V]);
    assert.deepEqual(result.evidence.operationRevisions, [C, '0'.repeat(40)]);
  }
});

test('최초 no-op 인수는 root와 child operation이 없어도 현재 Synced Healthy면 성공한다', async () => {
  const value = deployment();
  for (const app of [...value.applications, value.parent]) delete app.status.operationState;
  const result = await observeDeployment(value.input);
  assert.equal(result.result, 'passed'); assert.equal(result.terminal, true);
  assert.equal(result.root.phase, undefined); assert.equal(result.root.operationRevision, undefined);
  assert.equal(result.applications[0].phase, undefined); assert.equal(result.applications[0].startedAt, undefined);
});

test('root가 state-only HEAD를 비교해도 마지막 Succeeded operation은 P에 남을 수 있다', async () => {
  const value = deployment(); value.parent.status.operationState.syncResult.revision = P;
  const result = await observeDeployment(value.input);
  assert.equal(result.result, 'passed'); assert.equal(result.root.revision, ROOT_REVISION);
  assert.equal(result.root.operationRevision, P);
});

test('root 실패 operation이 현재 P 선언을 유지한 revision이면 state-only HEAD에서도 실패다', async () => {
  const value = deployment(); value.parent.status.operationState.syncResult.revision = P;
  value.parent.status.operationState.phase = 'Failed';
  const checked = [];
  value.input.rootRevisionContainsSelection = async (revision, selected) => {
    checked.push([revision, selected]); return [ROOT_REVISION, P].includes(revision) && selected === P;
  };
  const result = await observeDeployment(value.input);
  assert.equal(result.result, 'failed'); assert.deepEqual(checked, [[ROOT_REVISION, P], [P, P]]);
});

test('root 실패 operation의 Git 귀속 조회 장애는 stale 실패로 오인해 성공 처리하지 않는다', async () => {
  const value = deployment(); value.parent.status.operationState.syncResult.revision = P;
  value.parent.status.operationState.phase = 'Failed';
  value.input.rootRevisionContainsSelection = async revision => {
    if (revision === ROOT_REVISION) return true;
    throw new Error('simulated operation revision lookup failure');
  };
  assert.equal((await observeDeployment(value.input)).result, 'unknown');
});

test('현재 실패는 완료 시각을 요구하고 미실행 후속 wave의 operation 부재는 실패 판정을 막지 않는다', async () => {
  const value = deployment(); value.applications[14].status.operationState.phase = 'Failed';
  delete value.applications[15].status.operationState;
  assert.equal((await observeDeployment(value.input)).result, 'failed');
  delete value.applications[14].status.operationState.finishedAt;
  assert.equal((await observeDeployment(value.input)).result, 'unknown');
});

test('관측 역할 환경은 원래 AWS profile·web identity·임의 endpoint를 상속하지 않는다', () => {
  const env = credentialEnv({ AccessKeyId: 'synthetic-access-key', SecretAccessKey: 'synthetic-secret', SessionToken: 'synthetic-session',
    Expiration: new Date(Date.now() + 300_000).toISOString() }, { PATH: '/test/bin', AWS_PROFILE: 'operator', AWS_ENDPOINT_URL: 'https://untrusted.invalid',
    AWS_WEB_IDENTITY_TOKEN_FILE: '/tmp/untrusted', AWS_ROLE_ARN: 'untrusted', AWS_ACCESS_KEY_ID: 'previous', AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://untrusted.invalid' });
  for (const key of ['AWS_PROFILE', 'AWS_ENDPOINT_URL', 'AWS_WEB_IDENTITY_TOKEN_FILE', 'AWS_ROLE_ARN', 'AWS_CONTAINER_CREDENTIALS_FULL_URI']) assert.equal(env[key], undefined);
  assert.equal(env.AWS_ACCESS_KEY_ID, 'synthetic-access-key'); assert.equal(env.AWS_CONFIG_FILE, '/dev/null');
  assert.equal(env.AWS_SHARED_CREDENTIALS_FILE, '/dev/null');
});
