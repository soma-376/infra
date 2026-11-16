// 설정 게시도 이미지 게시와 같은 CAS를 쓴다. 생성·Helm 검증은 호출자의 고정 C 준비 단계가 맡는다.
import { randomBytes } from 'node:crypto';
import { APPS, SHA, NONCE, assert, parse, json, sha256, validateManifest, validateOwner, validateState,
  acquire, assertOwned } from './contract.mjs';
import { GENERATED, yaml, pinApplications, configurationFingerprint, validateCurrent } from './release.mjs';
import { validateActivation, safeEvidence } from './engine.mjs';

const paths = GENERATED.map(name => `dev/generated/${name}`);

export function prepareConfiguration({ sourceCommit, candidate, selectedFiles, selection }) {
  assert(SHA.test(sourceCommit), '설정 sourceCommit은 고정 full SHA여야 한다');
  assert(candidate instanceof Map && candidate.size === paths.length && paths.every(path => candidate.has(path)),
    '설정 후보는 정확한 generated YAML 13개여야 한다');
  const bundle = validateManifest(selectedFiles.get('dev/bundle.json'));
  assert(bundle.B === selection.bundleManifestSha256, '현재 선택 V/B 불일치');
  const snapshot = new Map();
  for (const path of paths) {
    const text = candidate.get(path);
    let value;
    try { value = yaml(text); } catch { throw new Error('설정 후보 YAML 형식 오류'); }
    assert(value.deliveryVerification === undefined, '제거된 검증 Job 입력은 게시할 수 없다');
    snapshot.set(path, text);
  }
  for (const app of APPS) {
    let current, proposed;
    try {
      current = yaml(selectedFiles.get(`dev/generated/${app}.yaml`)).image;
      proposed = yaml(snapshot.get(`dev/generated/${app}.yaml`)).image;
    } catch { throw new Error('설정 후보 이미지 입력 오류'); }
    const expected = bundle.manifest.images[app];
    assert(current && typeof current.repository === 'string' &&
      new RegExp(`^\\d{12}\\.dkr\\.ecr\\.ap-northeast-2\\.amazonaws\\.com/${expected.repository}$`).test(current.repository) &&
      current.digest === expected.digest, '현재 선택 V의 이미지가 B와 다르다');
    assert(proposed && Object.keys(proposed).sort().join(',') === 'digest,repository' &&
      proposed.repository === current.repository && proposed.digest === current.digest, '설정 게시에서 이미지를 바꿀 수 없다');
  }
  snapshot.set('dev/bundle.json', bundle.bytes);
  snapshot.set('dev/infra-commit.txt', `${sourceCommit}\n`);
  return { snapshot, bundle, runtimeFingerprint: configurationFingerprint(snapshot) };
}

export async function configure({ store, sourceCommit, candidate, owner, observe, validateCandidate,
  nonce = () => randomBytes(16).toString('hex') }) {
  validateOwner(owner);
  assert(owner.repository === 'soma-376/infra', '설정 게시 owner는 infra 실행이어야 한다');
  assert(typeof observe === 'function' && typeof validateCandidate === 'function', '설정 생성·렌더 검증과 관측 adapter가 필요하다');
  let head = await store.refresh(), state = validateState(await store.state(head));
  const current = await store.files(head);
  const activation = validateActivation(parse(current.get('dev/activation.json'), '자동화 수락'));
  validateCurrent(current, state);
  assert(state.state === 'idle', '진행 중 또는 보류 상태는 설정 게시를 시작할 수 없다');
  const selectedFiles = await store.files(state.currentSelection.valuesCommit);
  const prepared = prepareConfiguration({ sourceCommit, candidate, selectedFiles, selection: state.currentSelection });
  // 원문 오류나 임의 callback 변경은 게시 자료·로그로 전달하지 않는다.
  async function checkCandidate() {
    try {
      await validateCandidate({ sourceCommit, candidate: new Map(paths.map(path => [path, prepared.snapshot.get(path)])),
        currentSelection: { ...state.currentSelection }, bundleManifest: prepared.bundle.bytes });
    } catch { throw new Error('설정 후보 생성·렌더 검증 실패'); }
  }
  await checkCandidate();
  if (sourceCommit === state.currentSelection.infraCommit && paths.every(path => prepared.snapshot.get(path) === selectedFiles.get(path))) {
    return { result: 'noop', selection: state.currentSelection };
  }
  const operationNonce = nonce();
  assert(NONCE.test(operationNonce), '설정 게시 nonce 오류');
  state = { ...acquire(state, owner, operationNonce), operation: { kind: 'config', nonce: operationNonce, rollbackAttempted: false } };
  const generation = state.generation;
  head = await store.writeState(head, state, '[PROJ-311] config delivery acquire');
  let publishedSelection;

  async function refreshOwned() {
    const actual = await store.refresh(), latest = validateState(await store.state(actual));
    assertOwned(latest, owner, generation);
    assert(actual === head && latest.expectedDesiredP === state.expectedDesiredP, '설정 게시 중 HEAD 또는 P 변경');
    state = latest;
  }
  async function writeState(next, message, extra = new Map()) {
    await refreshOwned();
    head = await store.cas(head, new Map([...extra, ['dev/delivery-state.json', json(next)]]), message);
    state = next;
  }
  async function block(reason, evidence) {
    await refreshOwned();
    // P 게시 뒤 bind가 실패한 경우에도 반환받은 P만 명시적으로 묶는다. 다른 owner/HEAD는 채택하지 않는다.
    const bound = publishedSelection ? { ...state, expectedDesiredP: publishedSelection.desiredCommit, currentSelection: publishedSelection } : state;
    validateCurrent(await store.files(head), bound);
    await writeState({ ...bound, state: 'blocked', operation: { ...bound.operation, blockedReason: reason } },
      '[PROJ-311] config delivery blocked', evidence ? new Map([[`dev/evidence/${operationNonce}.json`, evidence]]) : new Map());
    return { result: 'blocked', reason, selection: bound.currentSelection };
  }
  try {
    await refreshOwned();
    await checkCandidate();
    const V = await store.cas(head, prepared.snapshot, '[PROJ-311] immutable config snapshot');
    head = V;
    await refreshOwned();
    const files = await store.files(head);
    validateCurrent(files, state);
    await checkCandidate();
    const selection = { infraCommit: sourceCommit, valuesCommit: V, bundleManifestSha256: prepared.bundle.B, operationNonce };
    const P = await store.cas(head, pinApplications(files, selection), '[PROJ-311] select config snapshot');
    head = P;
    publishedSelection = { ...selection, desiredCommit: P };
    await writeState({ ...state, expectedDesiredP: P, currentSelection: publishedSelection }, '[PROJ-311] bind config desired revision');
    let observation;
    try { observation = await observe({ selection: publishedSelection, bundle: prepared.bundle, activation, runtimeFingerprint: prepared.runtimeFingerprint }); }
    catch { return await block('config_observation_unavailable'); }
    const evidence = safeEvidence(observation, publishedSelection);
    if (observation.result !== 'passed' || observation.terminal !== true) {
      return await block(observation.result === 'failed' && observation.terminal === true ? 'config_operation_failed' : 'config_observation_unknown', evidence);
    }
    await writeState({ ...state, state: 'idle', owner: null, operation: null,
      lastKnownGood: { ...publishedSelection, evidenceSha256: sha256(evidence), configurationFingerprint: prepared.runtimeFingerprint } },
    '[PROJ-311] config delivery verified', new Map([[`dev/evidence/${operationNonce}.json`, evidence]]));
    return { result: 'passed', selection: publishedSelection };
  } catch {
    try { return await block('config_publisher_error'); }
    catch { throw new Error('설정 게시 상태가 불명확하거나 owner를 잃었다. 자동 재게시·잠금 해제를 하지 않는다'); }
  }
}
