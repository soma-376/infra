// YAML 전체를 다시 직렬화하지 않고 이미지와 검증용 여섯 scalar만 바꾼다.
import { load, JSON_SCHEMA } from 'js-yaml';
import { CATALOG, INFRA_REPOSITORY, VALUES_REPOSITORY, generateApplications } from '../dev-argocd-applications.mjs';
import { APPS, SHA, HASH, NONCE, assert, json, sha256, validateManifest, validateSelection } from './contract.mjs';

// 수동 offset-admin values도 사본 13개 계약에 포함하지만 Application으로 관리하지 않는다.
export const GENERATED = [...CATALOG.applications.filter(entry => entry.generatedFile).map(entry => entry.generatedFile), 'telemetry-kafka-admin.yaml'];
export const METADATA = ['operationNonce', 'infraCommit', 'bundleManifestSha256', 'imageDigest', 'contractSha256', 'contract'];
export function yaml(text) {
  assert(typeof text === 'string' && Buffer.byteLength(text) < 2 * 1024 * 1024, 'YAML 크기 오류');
  const value = load(text, { schema: JSON_SCHEMA });
  assert(value && typeof value === 'object' && !Array.isArray(value), 'YAML mapping이 필요하다');
  return value;
}
function scalarRange(text, section, key) {
  const sections = [...text.matchAll(new RegExp(`^${section}:[ \\t]*(?:#[^\\r\\n]*)?\\r?$`, 'gm'))];
  assert(sections.length === 1, '허용 경로의 단일 block mapping이 필요하다');
  const start = sections[0].index + sections[0][0].length;
  const endMatch = /^[^\s#][^\n]*$/m.exec(text.slice(start));
  const end = endMatch ? start + endMatch.index : text.length;
  const block = text.slice(start, end);
  const matches = [...block.matchAll(new RegExp(`^([ ]{2}${key}:[ \\t]*)([^\\r\\n]*)(\\r?)$`, 'gm'))];
  assert(matches.length === 1, '허용 경로 scalar가 없거나 중복이다');
  const match = matches[0];
  const raw = match[2];
  // 주석과 따옴표 속 #을 구별하고 원래 공백·주석을 남긴다.
  let quote = '', escaped = false, boundary = raw.length;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (escaped) { escaped = false; continue; }
    if (quote === '"' && c === '\\') { escaped = true; continue; }
    if (quote && c === quote) { if (quote === "'" && raw[i + 1] === "'") { i++; continue; } quote = ''; continue; }
    if (!quote && (c === '"' || c === "'")) { quote = c; continue; }
    if (!quote && c === '#' && (i === 0 || /\s/.test(raw[i - 1]))) { boundary = i; break; }
  }
  const value = raw.slice(0, boundary).trimEnd();
  assert(value && !/^[!&*>|]/.test(value) && !quote, '단순 단일 행 scalar만 수정할 수 있다');
  return { start: start + match.index + match[1].length, end: start + match.index + match[1].length + value.length };
}
export function replaceScalar(text, section, key, value) {
  const range = scalarRange(text, section, key);
  return `${text.slice(0, range.start)}${JSON.stringify(value)}${text.slice(range.end)}`;
}
export function stripMutable(text) {
  let result = replaceScalar(text, 'image', 'digest', '<image>');
  for (const key of METADATA) result = replaceScalar(result, 'deliveryVerification', key, '<metadata>');
  return result;
}
export function updateImageValues(text, app, bundle, selection) {
  const previous = yaml(text);
  const canonical = bundle.manifest.images[app].repository;
  assert(typeof previous.image?.repository === 'string' && new RegExp(`^\\d{12}\\.dkr\\.ecr\\.ap-northeast-2\\.amazonaws\\.com/${canonical}$`).test(previous.image.repository), '현재 V의 ECR repository가 앱 허용값과 다르다');
  assert(previous.deliveryVerification?.enabled === true, '고정 verifier가 활성화된 정상 V가 필요하다');
  assert(SHA.test(selection.infraCommit) && NONCE.test(selection.operationNonce), '검증 metadata 오류');
  const values = {
    operationNonce: selection.operationNonce, infraCommit: selection.infraCommit,
    bundleManifestSha256: bundle.B, imageDigest: bundle.manifest.images[app].digest,
    contractSha256: bundle.manifest.deploymentContracts[app].sha256,
    contract: bundle.manifest.deploymentContracts[app].content,
  };
  let updated = replaceScalar(text, 'image', 'digest', bundle.manifest.images[app].digest);
  for (const key of METADATA) updated = replaceScalar(updated, 'deliveryVerification', key, values[key]);
  assert(stripMutable(updated) === stripMutable(text), '비이미지 설정 byte 불변 위반');
  const decoded = yaml(updated);
  assert(decoded.image.repository === previous.image.repository && decoded.image.digest === values.imageDigest, '이미지 치환 오류');
  for (const key of METADATA) assert(decoded.deliveryVerification[key] === values[key], '검증 scalar 치환 오류');
  return updated;
}
export function snapshotFiles(current, bundle, selection) {
  const files = new Map();
  for (const name of GENERATED) {
    const path = `dev/generated/${name}`, text = current.get(path);
    assert(typeof text === 'string', '현재 V의 generated 13개가 필요하다');
    const app = APPS.find(value => name === `${value}.yaml`);
    files.set(path, app ? updateImageValues(text, app, bundle, selection) : text);
  }
  assert(GENERATED.length === 13, 'generated 파일 계약 변경은 별도 검토가 필요하다');
  files.set('dev/bundle.json', bundle.bytes);
  files.set('dev/infra-commit.txt', `${selection.infraCommit}\n`);
  return files;
}
export function pinApplications(files, selection) {
  validateSelection(selection);
  const changes = new Map();
  for (const entry of CATALOG.applications) {
    const path = `dev/applications/${entry.id}.yaml`;
    const app = yaml(files.get(path));
    assert(app.kind === 'Application' && app.metadata?.name === entry.name && app.spec?.project === entry.project, 'Application 식별자 오류');
    assert(app.metadata.namespace === 'argocd' && !app.metadata.finalizers?.length && app.spec.destination?.namespace === entry.namespace, 'Application 대상 경계 오류');
    assert(app.metadata.annotations?.['argocd.argoproj.io/skip-reconcile'] !== 'true', '비활성 인계 Application은 자동 승격할 수 없다');
    const policy = app.spec.syncPolicy;
    assert(policy?.automated?.enabled === true && policy.automated.selfHeal === true && policy.automated.prune === false && policy.automated.allowEmpty === false, '수락된 자동 sync 설정이 필요하다');
    assert(policy.retry?.limit === 0, '게시별 기능 검증을 반복하지 않도록 retry.limit=0이 필요하다');
    assert(!policy.syncOptions?.some(option => /^(ApplyOutOfSyncOnly|Force|Replace)=true$/.test(option)), '검증 hook을 우회하는 sync 옵션');
    assert(app.spec.sources?.length === (entry.generatedFile ? 2 : 1), 'Application source 개수 오류');
    const source = app.spec.sources[0];
    assert(source.repoURL === INFRA_REPOSITORY && source.path === entry.chart, '고정 infra source 오류');
    assert(SHA.test(source.targetRevision), '기존 C가 고정 SHA가 아니다');
    source.targetRevision = selection.infraCommit;
    if (entry.generatedFile) {
      const values = app.spec.sources[1];
      assert(values.repoURL === VALUES_REPOSITORY && values.ref === 'values' && SHA.test(values.targetRevision), '고정 values source 오류');
      values.targetRevision = selection.valuesCommit;
    }
    changes.set(path, json(app));
  }
  changes.set('dev/desired.yaml', json({ schemaVersion: 1, infraCommit: selection.infraCommit, valuesCommit: selection.valuesCommit,
    bundleManifestSha256: selection.bundleManifestSha256, operationNonce: selection.operationNonce }));
  return changes;
}
export function validateCurrent(files, state) {
  const desired = yaml(files.get('dev/desired.yaml'));
  for (const key of ['infraCommit', 'valuesCommit', 'bundleManifestSha256', 'operationNonce']) {
    assert(desired[key] === state.currentSelection[key], '공통 상태와 desired 선택 불일치');
  }
  const bundle = validateManifest(files.get('dev/bundle.json'));
  for (const entry of CATALOG.applications) {
    const app = yaml(files.get(`dev/applications/${entry.id}.yaml`));
    assert(app.spec?.sources?.[0]?.targetRevision === desired.infraCommit, 'Application C와 desired 불일치');
    if (entry.generatedFile) assert(app.spec.sources[1]?.targetRevision === desired.valuesCommit, 'Application V와 desired 불일치');
  }
  // main은 실패한 V 준비 commit을 포함할 수 있다. 선택된 V의 원본은 호출자가 별도로 읽는다.
  pinApplications(files, state.currentSelection);
  return { desired, bundle };
}
export function activationApplications(input) {
  const review = generateApplications(input);
  assert(input.mode === 'gitops', 'H는 자동화 초기화 입력이 아니다');
  const files = new Map();
  for (const definition of review.definitions) {
    const app = definition.application;
    delete app.metadata.annotations['argocd.argoproj.io/skip-reconcile'];
    app.metadata.annotations['pulsemetry.io/handoff-status'] = 'accepted';
    app.spec.syncPolicy.automated.enabled = true; app.spec.syncPolicy.automated.selfHeal = true;
    app.spec.syncPolicy.retry = { limit: 0 };
    files.set(`dev/applications/${definition.id}.yaml`, json(app));
  }
  const root = review.rootTemplate;
  delete root.metadata.annotations['argocd.argoproj.io/skip-reconcile'];
  root.metadata.annotations['pulsemetry.io/handoff-status'] = 'accepted';
  root.spec.syncPolicy.automated.enabled = true; root.spec.syncPolicy.automated.selfHeal = true;
  root.spec.syncPolicy.retry = { limit: 0 };
  files.set('dev/root.yaml', json(root));
  return files;
}
export function activationRoot() {
  // root는 main의 고정 경로만 읽으므로 아직 없는 V/P를 만들어 넣지 않는다.
  return { apiVersion: 'argoproj.io/v1alpha1', kind: 'Application', metadata: {
    name: 'pulsemetry-dev-root', namespace: 'argocd', annotations: { 'pulsemetry.io/handoff-status': 'accepted' } },
  spec: { project: 'pulsemetry-dev-root', source: { repoURL: VALUES_REPOSITORY, targetRevision: 'main', path: 'dev/applications', directory: { recurse: false } },
    destination: { server: 'https://kubernetes.default.svc', namespace: 'argocd' },
    syncPolicy: { automated: { enabled: true, prune: false, selfHeal: true, allowEmpty: false }, retry: { limit: 0 }, syncOptions: ['FailOnSharedResource=true'] } } };
}
export function configurationFingerprint(files) {
  return sha256(GENERATED.map(name => {
    const text = files.get(`dev/generated/${name}`);
    assert(typeof text === 'string', 'fingerprint 입력 파일 누락');
    return `${name}\0${APPS.some(app => name === `${app}.yaml`) ? stripMutable(text) : text}\0`;
  }).join(''));
}
