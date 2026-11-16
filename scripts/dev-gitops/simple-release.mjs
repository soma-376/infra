// PROJ-334: 배포 대기·잠금 상태 없이 선택한 코드와 values의 연결만 검증한다.
import { load, JSON_SCHEMA } from 'js-yaml';
import { CATALOG, INFRA_REPOSITORY, VALUES_REPOSITORY } from '../dev-argocd-applications.mjs';
import { APPS, SHA, HASH, assert, parse, json, validateManifest } from './contract.mjs';
import { GENERATED, replaceScalar, stripMutable } from './release.mjs';

export { GENERATED };
export const SIMPLE_PATHS = new Set([
  ...GENERATED.map(name => `dev/generated/${name}`),
  ...CATALOG.applications.map(app => `dev/applications/${app.id}.yaml`),
  'dev/infra-commit.txt', 'dev/bundle.json', 'dev/producer.json', 'dev/desired.yaml', 'dev/root.yaml',
]);
export function readYaml(text) {
  assert(typeof text === 'string' && Buffer.byteLength(text) <= 2 * 1024 * 1024, 'YAML 입력 크기 오류');
  try { return load(text, { schema: JSON_SCHEMA }); }
  catch { throw new Error('YAML 입력 형식 오류'); }
}
export function validateSelection(selection) {
  assert(selection && SHA.test(selection.infraCommit) && SHA.test(selection.valuesCommit) && HASH.test(selection.bundleManifestSha256), '배포 선택 오류');
  return selection;
}
export function validateProducer(producer, bundle) {
  const fields = ['repository', 'workflowRef', 'workflowRunId', 'workflowRunAttempt', 'backendCommit', 'createdAt', 'conclusion', 'event', 'headBranch', 'artifactId', 'artifactSha256'];
  assert(producer && Object.keys(producer).sort().join() === fields.sort().join(), '생산 출처 필드 오류');
  assert(['workflowRunId', 'workflowRunAttempt', 'artifactId'].every(key => typeof producer[key]==='string' && /^[1-9]\d*$/.test(producer[key])) &&
    HASH.test(producer.artifactSha256) && Number.isFinite(Date.parse(producer.createdAt)), '생산 출처 값 오류');
  validateManifest(bundle.bytes, producer);
  assert(producer.workflowRef === 'soma-376/pulsemetry-backend/.github/workflows/deploy_dev.yml@refs/heads/develop', '생산 workflow 오류');
  return producer;
}
export function validateGenerated(generated, bundle) {
  assert(generated instanceof Map && generated.size === GENERATED.length && GENERATED.every(name => generated.has(`dev/generated/${name}`)), 'generated 13개가 필요하다');
  let account;
  for (const [path, text] of generated) {
    assert(GENERATED.some(name => path === `dev/generated/${name}`), 'generated 경로 오류');
    const value = readYaml(text);
    assert(value && typeof value === 'object' && !Array.isArray(value), 'generated mapping 오류');
    const app = APPS.find(name => path === `dev/generated/${name}.yaml`);
    if (!app) continue;
    const image = value.image;
    const match = new RegExp(`^(\\d{12})\\.dkr\\.ecr\\.ap-northeast-2\\.amazonaws\\.com/soma-376/${app}$`).exec(image?.repository ?? '');
    assert(match && image.digest === bundle.manifest.images[app].digest && value.deliveryVerification === undefined, '선택 이미지 또는 폐기된 검증 Job 오류');
    account ??= match[1];
    assert(account === match[1], '이미지 계정 불일치');
  }
}
export function validateApplication(app, entry) {
  assert(app?.apiVersion === 'argoproj.io/v1alpha1' && app.kind === 'Application' && app.metadata?.name === entry.name &&
    app.metadata.namespace === 'argocd' && !app.metadata.finalizers?.length && app.metadata.annotations?.['argocd.argoproj.io/skip-reconcile'] !== 'true', 'Application 식별자 오류');
  const spec = app.spec;
  assert(spec?.project === entry.project && spec.destination?.server === 'https://kubernetes.default.svc' && spec.destination.namespace === entry.namespace &&
    !spec.source && spec.sources?.length === (entry.generatedFile ? 2 : 1), 'Application 대상 오류');
  const source = spec.sources[0];
  assert(source.repoURL === INFRA_REPOSITORY && source.path === entry.chart && SHA.test(source.targetRevision), 'Application infra source 오류');
  if (entry.renderer === 'strimzi-cmp') {
    assert(source.plugin?.name === 'pulsemetry-strimzi-v1' && !source.helm, 'Strimzi CMP 오류');
  } else assert(source.helm && !source.plugin && typeof source.helm.releaseName === 'string' && /^[a-z0-9][a-z0-9-]{0,52}$/.test(source.helm.releaseName), 'Helm release 오류');
  if (entry.generatedFile) {
    const values = spec.sources[1];
    assert(values.repoURL === VALUES_REPOSITORY && values.ref === 'values' && SHA.test(values.targetRevision) && !values.path, 'Application values source 오류');
  }
  assert(spec.syncPolicy?.automated?.prune !== true && spec.syncPolicy?.automated?.allowEmpty !== true &&
    !spec.syncPolicy?.syncOptions?.some(value => /^(Force|Replace)=true$/.test(value)), '삭제·강제 교체 정책 금지');
  return app;
}
export function validateApplications(files, selection) {
  validateSelection(selection);
  const applications = new Map();
  for (const entry of CATALOG.applications) {
    const path = `dev/applications/${entry.id}.yaml`, text = files.get(path);
    const app = validateApplication(readYaml(text), entry);
    assert(app.spec.sources[0].targetRevision === selection.infraCommit &&
      (!entry.generatedFile || app.spec.sources[1].targetRevision === selection.valuesCommit), 'Application 선택 불일치');
    applications.set(path, text);
  }
  assert([...files.keys()].filter(path => path.startsWith('dev/applications/')).length === applications.size, 'Application 개수 오류');
  return applications;
}
export function pinSimpleApplications(applications, selection) {
  validateSelection(selection);
  assert(applications instanceof Map && applications.size === CATALOG.applications.length, 'Application 18개가 필요하다');
  const files = new Map();
  for (const entry of CATALOG.applications) {
    const path = `dev/applications/${entry.id}.yaml`, app = validateApplication(readYaml(applications.get(path)), entry);
    app.spec.sources[0].targetRevision = selection.infraCommit;
    if (entry.generatedFile) app.spec.sources[1].targetRevision = selection.valuesCommit;
    files.set(path, json(app));
  }
  return files;
}
export function desiredFiles(applications, selection) {
  return new Map([...pinSimpleApplications(applications, selection), ['dev/desired.yaml', json({ schemaVersion: 2,
    infraCommit: selection.infraCommit, valuesCommit: selection.valuesCommit, bundleManifestSha256: selection.bundleManifestSha256 })]]);
}
export function makeSnapshot(generated, bundleBytes, producer, infraCommit) {
  const producerBytes=typeof producer==='string'?producer:json(producer);
  producer=typeof producer==='string'?parse(producer,'생산 출처'):producer;
  const bundle = validateManifest(bundleBytes, producer);
  validateProducer(producer, bundle); validateGenerated(generated, bundle);
  assert(SHA.test(infraCommit), 'infra SHA 오류');
  return new Map([...generated, ['dev/bundle.json', bundleBytes], ['dev/producer.json', producerBytes], ['dev/infra-commit.txt', `${infraCommit}\n`]]);
}
export function readSimpleRelease(files) {
  assert(![...files.keys()].some(path => /^dev\/(delivery-state\.json|activation\.json|evidence\/)/.test(path)), '이전 GitOps 상태는 명시적으로 전환해야 한다');
  const desired = readYaml(files.get('dev/desired.yaml'));
  assert(desired?.schemaVersion === 2 && Object.keys(desired).sort().join() === ['schemaVersion','infraCommit','valuesCommit','bundleManifestSha256'].sort().join(), '간소화 배포 선택 v2가 필요하다');
  const selection = validateSelection(desired);
  const producer = parse(files.get('dev/producer.json'), '생산 출처');
  const bundle = validateManifest(files.get('dev/bundle.json'), producer);
  validateProducer(producer, bundle);
  assert(bundle.B === selection.bundleManifestSha256 && files.get('dev/infra-commit.txt') === `${selection.infraCommit}\n`, '선택 snapshot 불일치');
  const generated = new Map(GENERATED.map(name => [`dev/generated/${name}`, files.get(`dev/generated/${name}`)]));
  validateGenerated(generated, bundle);
  return { selection, producer, producerBytes:files.get('dev/producer.json'), bundle, generated };
}
export function imageSnapshot(current, bundle, producer) {
  const generated = new Map(current.generated);
  for (const app of APPS) {
    const path = `dev/generated/${app}.yaml`, before = generated.get(path);
    const after = replaceScalar(before, 'image', 'digest', bundle.manifest.images[app].digest);
    assert(stripMutable(before) === stripMutable(after), '비이미지 변경 금지');
    generated.set(path, after);
  }
  return makeSnapshot(generated, bundle.bytes, producer, current.selection.infraCommit);
}
