// PROJ-311: 두 게시기가 공유하는 입력·상태 경계. 조회 원문은 오류에 포함하지 않는다.
import { createHash } from 'node:crypto';
import { load, JSON_SCHEMA } from 'js-yaml';

export const APPS = ['enrollment-api', 'telemetry-ingest', 'telemetry-gateway', 'dashboard-api'];
export const SHA = /^[a-f0-9]{40}$/;
export const HASH = /^[a-f0-9]{64}$/;
export const DIGEST = /^sha256:[a-f0-9]{64}$/;
export const NONCE = /^[a-f0-9]{32}$/;
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const json = value => `${JSON.stringify(value, null, 2)}\n`;
export const assert = (condition, reason) => { if (!condition) throw new Error(reason); };
export const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function exact(value, keys, label) {
  assert(object(value) && Object.keys(value).every(key => keys.includes(key)), `${label}: 미허용 필드`);
}
export function parse(text, label = 'JSON') {
  assert(typeof text === 'string' && Buffer.byteLength(text) <= 2 * 1024 * 1024, `${label}: 크기 오류`);
  try {
    // JSON.parse가 마지막 값만 남기는 중복 키도 거부한다.
    load(text, { schema: JSON_SCHEMA });
    return JSON.parse(text);
  } catch { throw new Error(`${label}: 형식 오류`); }
}
export function validateManifest(bytes, provenance) {
  const manifest = parse(bytes, '완료 manifest');
  assert(manifest.schemaVersion === 1 && manifest.status === 'complete', '완료되지 않은 manifest');
  assert(manifest.repository === 'soma-376/pulsemetry-backend' && SHA.test(manifest.backendCommit), 'backend 원본 오류');
  assert(/^\d+$/.test(manifest.workflowRunId) && /^[1-9]\d*$/.test(manifest.workflowRunAttempt), '생산 실행 식별자 오류');
  assert(typeof manifest.workflowRef === 'string' && manifest.workflowRef.startsWith('soma-376/pulsemetry-backend/.github/workflows/deploy_dev.yml@'), '생산 workflow 오류');
  exact(manifest.images, APPS, '이미지');
  exact(manifest.deploymentContracts, APPS, '이미지 계약');
  for (const app of APPS) {
    const image = manifest.images[app], contract = manifest.deploymentContracts[app];
    assert(object(image) && image.repository === `soma-376/${app}` && DIGEST.test(image.digest) && image.platform === 'linux/arm64', '네 ARM64 이미지가 필요하다');
    assert(DIGEST.test(image.arm64ManifestDigest), 'immutable root에서 검증한 ARM64 manifest digest가 필요하다');
    assert(object(contract) && typeof contract.content === 'string' && Buffer.byteLength(contract.content) < 256 * 1024, '이미지 계약 크기 오류');
    assert(HASH.test(contract.sha256) && sha256(contract.content) === contract.sha256 && image.deploymentContractSha256 === contract.sha256, '이미지 계약 해시 불일치');
    const value = parse(contract.content, '이미지 계약');
    assert(value.schemaVersion === 1 && value.app === app && value.backendCommit === manifest.backendCommit, '이미지 계약 버전·앱·source 오류');
  }
  if (provenance) {
    for (const key of ['repository', 'backendCommit', 'workflowRef', 'workflowRunId', 'workflowRunAttempt']) {
      assert(provenance[key] === manifest[key], '원본 실행과 manifest 불일치');
    }
    assert(provenance.conclusion === 'success' && provenance.headBranch === 'develop' && ['push', 'workflow_dispatch'].includes(provenance.event), '성공한 develop 생산 실행이 필요하다');
    assert(Number.isFinite(Date.parse(provenance.createdAt)), '원본 실행 생성 시각 오류');
  }
  return { manifest, bytes, B: sha256(bytes), vector: imageVector(manifest) };
}
export function imageVector(manifest) {
  return sha256(APPS.map(app => `${app}=${manifest.images[app].repository}@${manifest.images[app].digest}\n`).join(''));
}
export function ownerEqual(a, b) {
  return object(a) && object(b) && ['repository', 'workflowRef', 'workflowRunId', 'workflowRunAttempt'].every(key => a[key] === b[key]);
}
export function validateOwner(owner) {
  exact(owner, ['repository', 'workflowRef', 'workflowRunId', 'workflowRunAttempt'], 'owner');
  assert(['soma-376/pulsemetry-backend', 'soma-376/infra'].includes(owner.repository), 'owner repository 오류');
  assert(typeof owner.workflowRef === 'string' && owner.workflowRef.startsWith(`${owner.repository}/.github/workflows/`), 'owner workflow 오류');
  assert(/^\d+$/.test(owner.workflowRunId) && /^[1-9]\d*$/.test(owner.workflowRunAttempt), 'owner 실행 오류');
}
export function validateSelection(value) {
  assert(object(value) && SHA.test(value.infraCommit) && SHA.test(value.valuesCommit) && HASH.test(value.bundleManifestSha256), 'C/V/B 선택 오류');
  if (value.desiredCommit !== undefined) assert(SHA.test(value.desiredCommit), 'P 선택 오류');
  if (value.operationNonce !== undefined) assert(NONCE.test(value.operationNonce), '배포 nonce 오류');
  return value;
}
export function validateState(state) {
  assert(object(state) && state.schemaVersion === 1 && ['idle', 'deploying', 'rolling_back', 'blocked'].includes(state.state), '공통 상태 오류');
  assert(Number.isSafeInteger(state.generation) && state.generation >= 0 && SHA.test(state.expectedDesiredP), 'generation/P 오류');
  if (state.state === 'idle') assert(state.owner === null && state.operation === null, 'idle owner 오류');
  else { validateOwner(state.owner); assert(object(state.operation) && ['image', 'config', 'rollback'].includes(state.operation.kind), 'operation 오류'); }
  validateSelection(state.currentSelection);
  assert(state.currentSelection.desiredCommit === state.expectedDesiredP, '현재 선택 P 불일치');
  if (state.lastKnownGood) validateSelection(state.lastKnownGood);
  assert(Array.isArray(state.failedReleases), '실패 이력이 필요하다');
  for (const failure of state.failedReleases) {
    assert(HASH.test(failure.bundleManifestSha256) && HASH.test(failure.imageVectorSha256) && SHA.test(failure.backendCommit) && Number.isFinite(Date.parse(failure.failureRecordedAt)), '실패 이력 오류');
  }
  return state;
}
export function owns(state, owner, generation) {
  return state.state !== 'idle' && state.generation === generation && ownerEqual(state.owner, owner);
}
export function assertOwned(state, owner, generation) {
  validateState(state);
  assert(owns(state, owner, generation), '배포 owner 소실: 상태 기록도 중지한다');
}
export function acquire(state, owner, nonce) {
  validateState(state); validateOwner(owner);
  assert(state.state === 'idle', '다른 배포 또는 보류가 공통 잠금을 소유한다');
  assert(NONCE.test(nonce), '배포 nonce 오류');
  return { ...state, generation: state.generation + 1, owner, state: 'deploying', operation: { kind: 'image', nonce, rollbackAttempted: false } };
}
export function classifyReceipt(receipt, expected) {
  if (!object(receipt) || Buffer.byteLength(JSON.stringify(receipt)) >= 4096 || receipt.schemaVersion !== 1) return 'unknown';
  for (const key of ['operationNonce', 'stage', 'infraCommit', 'bundleManifestSha256', 'imageDigest', 'contractSha256']) {
    if (receipt[key] !== expected[key]) return 'unknown';
  }
  if (!['passed', 'failed', 'unknown'].includes(receipt.result) || !Array.isArray(receipt.checks) || !Number.isFinite(Date.parse(receipt.checkedAt))) return 'unknown';
  if (receipt.result !== 'unknown' && (!HASH.test(receipt.evidenceSha256) || !receipt.checks.length)) return 'unknown';
  return receipt.result;
}
export const FINGERPRINTS = ['schemaFingerprint', 'runtimeFingerprint', 'keyTlsFingerprint', 'envelopeFingerprint'];
export function compatible(previous, current) {
  return object(previous) && object(current) && FINGERPRINTS.every(key => HASH.test(previous[key]) && previous[key] === current[key]);
}
