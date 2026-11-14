// H를 B로 변환하지 않는다. contract가 포함된 정상 생산 B와 별도 운영 수락 뒤에만 실행한다.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { APPS, SHA, HASH, NONCE, assert, parse, json, sha256, validateManifest, validateOwner, validateState, ownerEqual } from './contract.mjs';
import { GENERATED, yaml, snapshotFiles, activationApplications, activationRoot, pinApplications, configurationFingerprint, validateCurrent } from './release.mjs';
import { validateActivation, safeEvidence } from './engine.mjs';
import { GitStore } from './git-store.mjs';
import { runtimeObservers } from './runtime.mjs';
import { verifySourceBundle } from './source-proof.mjs';

export function prepareInitialization(input, candidateBytes, generated) {
  assert(input.schemaVersion === 1 && SHA.test(input.infraCommit) && SHA.test(input.expectedHead) && NONCE.test(input.operationNonce), '초기화 C/HEAD/nonce 오류');
  validateOwner(input.owner);
  assert(input.owner.repository === 'soma-376/infra', '초기화는 infra 운영 경로가 소유한다');
  const activation = validateActivation(input.activation);
  assert(HASH.test(input.normalBundleEvidenceSha256) && HASH.test(input.renderEvidenceSha256), '정상 B Argo 상태·동일 C 렌더 수락 증거가 필요하다');
  assert(input.provenance && /^[1-9]\d*$/.test(input.provenance.artifactId) && HASH.test(input.provenance.artifactSha256), '원본 artifact provenance가 필요하다');
  const bundle = validateManifest(candidateBytes, input.provenance);
  assert(bundle.B === input.normalBundleManifestSha256, '운영 수락한 정상 B와 다르다');
  for (const app of APPS) {
    const value = yaml(generated.get(`dev/generated/${app}.yaml`));
    assert(value.image?.digest === bundle.manifest.images[app].digest, '현재 실행한 정상 이미지 묶음이어야 한다');
    assert(value.deliveryVerification === undefined, '검증 Job 설정을 제거한 generated values가 필요하다');
  }
  const snapshot = snapshotFiles(generated, bundle, { infraCommit: input.infraCommit, operationNonce: input.operationNonce });
  return { input, activation, bundle, snapshot };
}
export async function initialize({ prepared, store, observe }) {
  const { input, activation, bundle, snapshot } = prepared;
  const currentHead = await store.refresh();
  assert(currentHead === input.expectedHead, '초기화 예상 private HEAD 불일치');
  const existing = await store.files(currentHead);
  assert(!['dev/bundle.json', 'dev/delivery-state.json', 'dev/desired.yaml', 'dev/activation.json', 'dev/root.yaml'].some(path => existing.has(path)),
    '기존 GitOps 상태는 초기화로 덮어쓸 수 없다');
  // V부터 PROJ-279 writer가 중단 marker를 감지한다. 불명확한 부분 성공을 자동 덮어쓰지 않는다.
  const V = await store.cas(currentHead, snapshot, '[PROJ-311] initialize verified normal bundle');
  const selection = { infraCommit: input.infraCommit, valuesCommit: V, bundleManifestSha256: bundle.B, operationNonce: input.operationNonce };
  const applications = activationApplications({ schemaVersion: 1, mode: 'gitops', infraRevision: selection.infraCommit,
    valuesRevision: V, bundleManifestSha256: bundle.B, inventory: activation.inventory });
  const changes = new Map([...applications, ...pinApplications(applications, selection), ['dev/activation.json', json(activation)]]);
  const P = await store.cas(V, changes, '[PROJ-311] select accepted initial GitOps release');
  selection.desiredCommit = P;
  let state = { schemaVersion: 1, state: 'deploying', generation: 1, owner: input.owner,
    expectedDesiredP: P, currentSelection: selection, operation: { kind: 'config', nonce: input.operationNonce, rollbackAttempted: false },
    lastKnownGood: null, failedReleases: [], resumeFence: null };
  let head = await store.writeState(P, state, '[PROJ-311] bind initial desired revision');
  // root/child 모두 이 실제 V/P에 도달하고 Argo 성공 조건을 만족한 뒤에만 첫 정상 선택을 확정한다.
  let observation;
  try { observation = await observe({ selection, bundle, activation, runtimeFingerprint: configurationFingerprint(snapshot) }); }
  catch { observation = { result: 'unknown', terminal: false, reason: 'initial_observation_unavailable', observedAt: new Date().toISOString(), applications: [] }; }
  const evidence = safeEvidence(observation, selection);
  const passed = observation.result === 'passed' && observation.terminal === true;
  state = passed ? { ...state, state: 'idle', owner: null, operation: null,
    lastKnownGood: { ...selection, evidenceSha256: sha256(evidence),
      configurationFingerprint: configurationFingerprint(snapshot) } } :
    { ...state, state: 'blocked', operation: { ...state.operation, blockedReason: 'initial_acceptance_incomplete' } };
  assert(await store.refresh() === head, '초기화 관측 중 HEAD 변경: 기존 owner를 덮어쓰지 않는다');
  await store.cas(head, new Map([['dev/delivery-state.json', json(state)], [`dev/evidence/${input.operationNonce}.json`, evidence]]), '[PROJ-311] record initial Argo acceptance');
  return { result: passed ? 'passed' : 'blocked' };
}
export async function acceptInitialization({ store, input, observe }) {
  const head = await store.refresh();
  assert(head === input.expectedHead, '초기 수락 재시도 HEAD 불일치');
  const state = validateState(await store.state(head));
  assert(['deploying', 'blocked'].includes(state.state) && state.operation.kind === 'config' && state.lastKnownGood === null &&
    state.generation === input.generation && ownerEqual(state.owner, input.owner), '초기화 owner·generation만 수락을 재시도할 수 있다');
  const current = await store.files(head); validateCurrent(current, state);
  const activation = validateActivation(parse(current.get('dev/activation.json'), '자동화 수락'));
  const selected = await store.files(state.currentSelection.valuesCommit);
  const bundle = validateManifest(selected.get('dev/bundle.json'));
  assert(bundle.B === state.currentSelection.bundleManifestSha256, '초기 선택 V/B 불일치');
  const configHash = configurationFingerprint(selected);
  const observation = await observe({ selection: state.currentSelection, bundle, activation, runtimeFingerprint: configHash });
  const evidence = safeEvidence(observation, state.currentSelection);
  assert(await store.refresh() === head, '수락 재시도 중 owner/HEAD 변경');
  const passed = observation.result === 'passed' && observation.terminal === true;
  const next = passed ? { ...state, state: 'idle', owner: null, operation: null, lastKnownGood: {
    ...state.currentSelection, evidenceSha256: sha256(evidence), configurationFingerprint: configHash } } :
    { ...state, state: 'blocked', operation: { ...state.operation, blockedReason: 'initial_acceptance_incomplete' } };
  await store.cas(head, new Map([['dev/delivery-state.json', json(next)], [`dev/evidence/${state.currentSelection.operationNonce}.json`, evidence]]), '[PROJ-311] accept initial current release');
  return { result: passed ? 'passed' : 'blocked' };
}
export async function main(args, env = process.env) {
  if (args.length === 2 && args[0] === '--accept-existing') {
    assert(env.DELIVERY_INITIALIZATION_ENABLED === 'true', '명시적 초기 수락 재시도가 필요하다');
    const input = parse(await readFile(args[1], 'utf8'), '초기 수락 재시도 입력');
    const store = await GitStore.open({ env }); let observer;
    try {
      const head = await store.refresh();
      observer = await runtimeObservers(validateActivation(parse(await store.read(head, 'dev/activation.json'))), { env, store });
      const result = await acceptInitialization({ store, input, observe: observer.observe });
      console.log(JSON.stringify(result)); return result.result === 'passed' ? 0 : 2;
    } finally { await observer?.close(); await store.close(); }
  }
  assert([8, 9].includes(args.length) && args[0] === '--input' && args[2] === '--candidate' && args[4] === '--generated-dir' && args[6] === '--output-dir' &&
    (args.length === 8 || args[8] === '--publish'), '사용법: initialize.mjs --input JSON --candidate B --generated-dir DIR --output-dir NEW_DIR [--publish]');
  const input = parse(await readFile(args[1], 'utf8'), '초기화 입력'), candidate = await readFile(args[3], 'utf8');
  const generated = new Map(await Promise.all(GENERATED.map(async name => [`dev/generated/${name}`, await readFile(join(args[5], name), 'utf8')])));
  const prepared = prepareInitialization(input, candidate, generated);
  const output = resolve(args[7]);
  await mkdir(output, { mode: 0o700 });
  await writeFile(join(output, 'root.yaml'), json(activationRoot()), { flag: 'wx', mode: 0o600 });
  for (const [path, content] of prepared.snapshot) {
    const destination = join(output, 'snapshot', path);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, content, { flag: 'wx', mode: 0o600 });
  }
  await writeFile(join(output, 'initialization-review.json'), json({ schemaVersion: 1, mode: 'review',
    infraCommit: input.infraCommit, bundleManifestSha256: prepared.bundle.B,
    expectedHead: input.expectedHead, operationNonce: input.operationNonce, acceptance: input.activation.readiness,
    valuesCommit: null, desiredCommit: null }), { flag: 'wx', mode: 0o600 });
  if (args.length === 8) { console.log('정상 B 초기화 검토 자료를 생성했다. Git 게시·활성화는 하지 않았다.'); return 0; }
  assert(env.DELIVERY_INITIALIZATION_ENABLED === 'true', '명시적 운영 수락 후 초기화 게시를 활성화해야 한다');
  await verifySourceBundle(prepared.bundle, input.provenance, { env, requireLatest: false });
  const store = await GitStore.open({ env }); let observer;
  try {
    observer = await runtimeObservers(prepared.activation, { env, store });
    const result = await initialize({ prepared, store, observe: observer.observe });
    console.log(JSON.stringify(result)); return result.result === 'passed' ? 0 : 2;
  } finally { await observer?.close(); await store.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(() => { console.error('초기화 검토 또는 수락 실패. 부분 게시를 덮어쓰지 않는다.'); process.exitCode = 1; });
}
