// 네트워크·관측 adapter를 분리해 실제 Git 경합과 불명확한 응답을 로컬에서 재현한다.
import { randomBytes } from 'node:crypto';
import { SHA, HASH, NONCE, assert, parse, json, sha256, validateManifest, validateState,
  acquire, assertOwned } from './contract.mjs';
import { snapshotFiles, pinApplications, validateCurrent, configurationFingerprint } from './release.mjs';
import { CATALOG, validateApplicationInput } from '../dev-argocd-applications.mjs';

export function validateActivation(value) {
  assert(value?.schemaVersion === 1 && value.readiness?.handoffAccepted === true &&
    value.readiness?.infraPublisherAccepted === true && value.readiness?.normalBundleAccepted === true &&
    HASH.test(value.readiness.acceptanceEvidenceSha256), 'PROJ-310·infra publisher·정상 B 운영 수락이 필요하다');
  assert(Array.isArray(value.inventory) && value.inventory.length === 18, '수락된 release inventory가 필요하다');
  validateApplicationInput({ schemaVersion: 1, mode: 'gitops', infraRevision: 'a'.repeat(40), valuesRevision: 'b'.repeat(40),
    bundleManifestSha256: 'c'.repeat(64), inventory: value.inventory });
  return value;
}
export async function eligible(bundle, provenance, failures, isDescendant) {
  for (const failure of failures) {
    assert(failure.fenceSealed !== false, '실패 기록의 durable fence가 확정되지 않았다');
    assert(failure.bundleManifestSha256 !== bundle.B && failure.imageVectorSha256 !== bundle.vector, '실패한 B 또는 동일 이미지 조합은 재승격할 수 없다');
    assert(provenance.backendCommit !== failure.backendCommit && await isDescendant(failure.backendCommit, provenance.backendCommit), '실패 source의 엄격한 후속 develop commit만 재개할 수 있다');
    assert(Date.parse(provenance.createdAt) > Date.parse(failure.failureRecordedAt), '실패 기록 이후 생성한 원본 생산 run이 필요하다');
  }
}
export function safeEvidence(observation, selection) {
  // 응답·로그·URL·계정·사용자 식별자를 private 증거에도 복제하지 않는다.
  const value = { schemaVersion: 1, selection, result: observation.result,
    observedAt: observation.observedAt, reason: observation.reason,
    terminal: observation.terminal === true,
    applications: observation.applications ?? [] };
  if (observation.root) {
    const root = observation.root;
    assert(Object.keys(root).every(key => ['uid', 'revision', 'operationRevision', 'result', 'phase', 'startedAt', 'finishedAt'].includes(key)) && /^[a-f0-9-]{1,64}$/.test(root.uid) &&
      SHA.test(root.revision), 'root 관측 증거 오류');
    if (root.operationRevision !== undefined) assert(SHA.test(root.operationRevision), 'root operation revision 오류');
    for (const key of ['startedAt', 'finishedAt']) if (root[key] !== undefined) assert(Number.isFinite(Date.parse(root[key])), 'root operation 시각 오류');
    assert(['passed', 'failed', 'unknown'].includes(root.result) && (root.phase === undefined || ['Succeeded', 'Failed', 'Error'].includes(root.phase)), 'root 상태 증거 오류');
    value.root = root;
  }
  assert(['passed', 'failed', 'unknown'].includes(value.result), '관측 결과 오류');
  assert(typeof value.reason === 'string' && /^[a-z][a-z0-9_-]{0,79}$/.test(value.reason), '관측 reason 코드 오류');
  assert(Number.isFinite(Date.parse(value.observedAt)), '관측 시각 오류');
  assert(Array.isArray(value.applications) && value.applications.length <= 18, '관측 Application 증거 오류');
  for (const app of value.applications) {
    assert(Object.keys(app).every(key => ['id', 'uid', 'result', 'revisions', 'operationRevisions', 'phase', 'startedAt', 'finishedAt'].includes(key)), '관측 증거 허용목록 오류');
    assert(CATALOG.applications.some(entry => entry.id === app.id) && ['passed', 'failed', 'unknown'].includes(app.result), '관측 Application 식별자 오류');
    for (const key of ['startedAt', 'finishedAt']) if (app[key] !== undefined) assert(Number.isFinite(Date.parse(app[key])), '관측 operation 시각 오류');
    if (app.uid) assert(/^[a-f0-9-]{1,64}$/.test(app.uid), 'Kubernetes UID 오류');
    if (app.phase) assert(['Succeeded', 'Failed', 'Error'].includes(app.phase), 'Application operation phase 오류');
    for (const key of ['revisions', 'operationRevisions']) if (app[key] !== undefined) assert(Array.isArray(app[key]) && app[key].length >= 1 && app[key].length <= 2 && app[key].every(revision => SHA.test(revision)), 'Application revision 증거 오류');
  }
  return json(value);
}

export async function promote({ store, candidateBytes, provenance, owner, observe, isDescendant,
  revalidateCandidate = async () => {}, now = () => new Date().toISOString(), nonce = () => randomBytes(16).toString('hex') }) {
  const bundle = validateManifest(candidateBytes, provenance);
  let head = await store.refresh(), state = validateState(await store.state(head));
  const initialFiles = await store.files(head);
  const activation = validateActivation(parse(initialFiles.get('dev/activation.json'), '자동화 수락'));
  validateCurrent(initialFiles, state);
  const failures = await store.failures(head);
  await eligible(bundle, provenance, failures, isDescendant);
  try { await revalidateCandidate(bundle, provenance); }
  catch (error) { if (error.code === 'candidate_superseded') return { result: 'superseded' }; throw error; }
  assert(state.state === 'idle', '진행 중 또는 보류 상태는 자동 재개하지 않는다');
  if (state.currentSelection.bundleManifestSha256 === bundle.B) return { result: 'noop', selection: state.currentSelection };
  state = acquire(state, owner, nonce());
  const originalP = state.expectedDesiredP;
  const generation = state.generation;
  head = await store.writeState(head, state, '[PROJ-311] image delivery acquire');

  async function refreshOwned() {
    const next = await store.refresh(), current = validateState(await store.state(next));
    assertOwned(current, owner, generation);
    // 같은 owner의 외부 프로세스도 기대하지 않은 변경을 이어받지 않는다.
    assert(next === head, '소유 중 main HEAD 변경: 현재 작업을 중지한다');
    assert(current.expectedDesiredP === state.expectedDesiredP, '소유 중 P 변경');
    state = current;
  }
  async function writeState(nextState, message, extra = new Map()) {
    await refreshOwned();
    const changes = new Map(extra);
    changes.set('dev/delivery-state.json', json(nextState));
    head = await store.cas(head, changes, message);
    state = nextState;
  }
  async function block(reason, evidence) {
    // owner 소실 시 이 기록도 거부한다. 기존 운영자의 보류를 덮어쓰지 않는다.
    validateCurrent(await store.files(head), state);
    const extra = evidence ? new Map([[`dev/evidence/${state.operation.nonce}.json`, evidence]]) : new Map();
    await writeState({ ...state, state: 'blocked', operation: { ...state.operation, blockedReason: reason } }, '[PROJ-311] delivery blocked', extra);
    return { result: 'blocked', reason, selection: state.currentSelection };
  }
  async function publish(target, operationNonce) {
    assert(NONCE.test(operationNonce), '게시 nonce 오류');
    await refreshOwned();
    // 반드시 현재 선택된 V를 읽는다. 이전 실행이 main에 남긴 미선택 V는 입력이 아니다.
    const source = await store.files(state.currentSelection.valuesCommit);
    const sourceBundle = validateManifest(source.get('dev/bundle.json'));
    assert(sourceBundle.B === state.currentSelection.bundleManifestSha256, '선택 V/B 불일치');
    const selection = { infraCommit: state.currentSelection.infraCommit, bundleManifestSha256: target.B, operationNonce };
    const changes = snapshotFiles(source, target, selection);
    const V = await store.cas(head, changes, '[PROJ-311] immutable image snapshot');
    head = V;
    selection.valuesCommit = V;
    await refreshOwned();
    const current = await store.files(head);
    validateCurrent(current, state);
    if (state.operation.kind === 'image') await revalidateCandidate(bundle, provenance);
    const P = await store.cas(head, pinApplications(current, selection), '[PROJ-311] select image snapshot');
    head = P;
    // P 자신은 P 내용에 넣지 않는다. 성공한 P 다음 상태 commit에서만 기록한다.
    const selected = { ...selection, desiredCommit: P };
    await writeState({ ...state, expectedDesiredP: P, currentSelection: selected,
      operation: { ...state.operation, nonce: operationNonce } }, '[PROJ-311] bind desired revision');
    return { selection: selected, runtimeFingerprint: configurationFingerprint(changes) };
  }
  async function recordSuccess(observation, selection, runtimeFingerprint) {
    assert(observation.terminal === true && observation.result === 'passed',
      '종료된 현재 배포의 Argo 성공 증거가 필요하다');
    const evidence = safeEvidence(observation, selection);
    const good = { ...selection, evidenceSha256: sha256(evidence), configurationFingerprint: runtimeFingerprint };
    await writeState({ ...state, state: 'idle', owner: null, operation: null, lastKnownGood: good,
      resumeFence: state.resumeFence ? { ...state.resumeFence, active: state.operation.kind === 'rollback' } : null }, '[PROJ-311] delivery verified',
    new Map([[`dev/evidence/${selection.operationNonce}.json`, evidence]]));
    return { result: 'passed', selection };
  }
  try {
    await revalidateCandidate(bundle, provenance);
    const { selection, runtimeFingerprint } = await publish(bundle, state.operation.nonce);
    const observation = await observe({ selection, bundle, activation, runtimeFingerprint });
    const evidence = safeEvidence(observation, selection);
    if (observation.result === 'passed') return await recordSuccess(observation, selection, runtimeFingerprint);
    if (observation.result !== 'failed' || observation.terminal !== true) return await block('observation_unknown', evidence);

    const failure = { bundleManifestSha256: bundle.B, backendCommit: bundle.manifest.backendCommit,
      imageVectorSha256: bundle.vector, images: bundle.manifest.images, failureRecordedAt: now(), fenceSealed: false };
    await writeState({ ...state, failedRelease: failure,
      failedReleases: [...state.failedReleases, failure],
      resumeFence: { active: true, failedBackendCommit: failure.backendCommit, recordedAt: failure.failureRecordedAt } },
    '[PROJ-311] record failed image and resume fence', new Map([[`dev/evidence/${selection.operationNonce}.json`, evidence]]));
    // 첫 실패 marker의 durable CAS가 응답한 뒤 시각을 고정한다. 게시 중 생성한 run은 재개 후보가 아니다.
    const sealed = { ...failure, failureRecordedAt: now(), fenceSealed: true };
    await writeState({ ...state, failedRelease: sealed,
      failedReleases: state.failedReleases.map(item => item.bundleManifestSha256 === failure.bundleManifestSha256 && item.imageVectorSha256 === failure.imageVectorSha256 ? sealed : item),
      resumeFence: { active: true, failedBackendCommit: sealed.backendCommit, recordedAt: sealed.failureRecordedAt } }, '[PROJ-311] seal durable failure fence');
    const good = state.lastKnownGood;
    // 실제 DB schema·키/TLS 호환성은 검사하지 않는다. 현재 C와 비이미지 설정만 보존해 이전 이미지를 한 번 선택한다.
    if (!good || state.operation.rollbackAttempted || good.infraCommit !== selection.infraCommit || good.configurationFingerprint !== runtimeFingerprint) return await block('no_matching_baseline');
    const prior = validateManifest(await store.read(good.valuesCommit, 'dev/bundle.json'));
    assert(prior.B === good.bundleManifestSha256, '정상 B 원본 불일치');
    const rollbackNonce = nonce();
    await writeState({ ...state, state: 'rolling_back', operation: { ...state.operation, kind: 'rollback', rollbackAttempted: true, nonce: rollbackNonce } }, '[PROJ-311] acquire one image recovery');
    const recovery = await publish(prior, rollbackNonce);
    const restored = await observe({ selection: recovery.selection, bundle: prior, activation, runtimeFingerprint: recovery.runtimeFingerprint });
    if (restored.result === 'passed') return await recordSuccess(restored, recovery.selection, recovery.runtimeFingerprint);
    return await block('rollback_failed_or_unknown', safeEvidence(restored, recovery.selection));
  } catch (error) {
    if (error.code === 'candidate_superseded' && state.expectedDesiredP === originalP) {
      // 아직 P를 바꾸지 않았다면 미선택 V를 남긴 채 잠금만 정상 해제하고 최신 후보를 다시 고른다.
      validateCurrent(await store.files(head), state);
      await writeState({ ...state, state: 'idle', owner: null, operation: null }, '[PROJ-311] release superseded candidate');
      return { result: 'superseded' };
    }
    // 원문 exception은 보관하지 않는다. owner/P가 바뀌었거나 확인할 수 없으면 block도 쓰지 않는다.
    try { return await block('publisher_error'); }
    catch { throw new Error('게시 상태가 불명확하거나 owner를 잃었다. 자동 재게시·잠금 해제를 하지 않는다'); }
  }
}
