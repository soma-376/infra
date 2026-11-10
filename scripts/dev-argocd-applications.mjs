// PROJ-287: 배포하지 않는 검토용 Application 정의만 생성한다. 외부 조회·Git 게시·활성화는 하지 않는다.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const INFRA_REPOSITORY = 'https://github.com/soma-376/infra.git';
export const VALUES_REPOSITORY = 'https://github.com/soma-376/infra-generated-values.git';
export const CATALOG = JSON.parse(readFileSync(resolve(root, 'helm/dev/gitops/catalog.json'), 'utf8'));
const fullSha = /^[0-9a-f]{40}$/;
const digest = /^[0-9a-f]{64}$/;
const releaseName = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/;
const crdOwners = new Set(['lbc', 'csi', 'strimzi-operator', 'observability']);
const automation = (id) => ({
  automated: { enabled: false, prune: false, selfHeal: false, allowEmpty: false },
  // 큰 CRD의 client-side last-applied annotation 한도를 피한다. Replace/Force는 허용하지 않는다.
  syncOptions: ['FailOnSharedResource=true', ...(crdOwners.has(id) ? ['ServerSideApply=true'] : [])],
});
const annotations = () => ({
  // 이 annotation은 비교·동기화까지 중지한다. 생성기에 이를 푸는 옵션을 제공하지 않는다.
  'argocd.argoproj.io/skip-reconcile': 'true',
  'pulsemetry.io/handoff-status': 'blocked',
});
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys, label) => {
  if (!object(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error(`${label}: 허용하지 않은 필드가 있다`);
};

export function validateApplicationInput(input) {
  exactKeys(input, ['schemaVersion', 'mode', 'infraRevision', 'handoffRevision', 'valuesRevision', 'bundleManifestSha256', 'inventory'], '입력');
  if (input.schemaVersion !== 1 || !['handoff', 'gitops'].includes(input.mode)) throw new Error('schemaVersion=1과 handoff 또는 gitops mode가 필요하다');
  if (!fullSha.test(input.infraRevision ?? '')) throw new Error('infraRevision은 lowercase full commit SHA여야 한다');
  if (input.mode === 'handoff') {
    if (!fullSha.test(input.handoffRevision ?? '') || input.valuesRevision !== undefined || input.bundleManifestSha256 !== undefined) {
      throw new Error('handoff는 H만 받는다. 정상 V/B나 root 배포 선택을 만들지 않는다');
    }
  } else if (!fullSha.test(input.valuesRevision ?? '') || !digest.test(input.bundleManifestSha256 ?? '') || input.handoffRevision !== undefined) {
    throw new Error('gitops는 full SHA V와 원본 B의 SHA-256을 요구하며 H를 받지 않는다');
  }
  if (!Array.isArray(input.inventory) || input.inventory.length !== CATALOG.applications.length) throw new Error('실제 release/namespace inventory 17개가 필요하다');
  const byId = new Map();
  const releases = new Set();
  for (const item of input.inventory) {
    exactKeys(item, ['id', 'releaseName', 'namespace'], 'inventory');
    const entry = CATALOG.applications.find(candidate => candidate.id === item.id);
    if (!entry || byId.has(item.id)) throw new Error('inventory에 미허용 또는 중복 id가 있다');
    if (typeof item.releaseName !== 'string' || item.releaseName.length > 53 || !releaseName.test(item.releaseName)) throw new Error('inventory releaseName은 실제 Helm release 이름이어야 한다');
    if (item.namespace !== entry.namespace) throw new Error('inventory namespace가 dev 관리 경계와 다르다');
    const key = `${item.namespace}/${item.releaseName}`;
    if (releases.has(key)) throw new Error('같은 namespace/release를 둘 이상의 Application이 소유할 수 없다');
    releases.add(key);
    byId.set(item.id, item);
  }
  return byId;
}

function childDefinition(entry, inventory, input, snapshot) {
  const source = { repoURL: INFRA_REPOSITORY, targetRevision: input.infraRevision, path: entry.chart };
  if (entry.renderer === 'strimzi-cmp') {
    source.plugin = { name: 'pulsemetry-strimzi-v1', env: [{ name: 'RELEASE_NAME', value: inventory.releaseName }] };
  } else {
    source.helm = {
      releaseName: inventory.releaseName,
      kubeVersion: '1.36.0',
      // native renderer는 Argo 3.5의 Helm 4다. version:v3는 Helm 3 고정 수단이 아니다.
      valueFiles: [
        ...entry.staticValues.map(file => posix.relative(entry.chart, file)),
        ...(entry.generatedFile ? [`$values/dev/generated/${entry.generatedFile}`] : []),
      ],
      ignoreMissingValueFiles: false,
      skipCrds: false,
      skipTests: true,
    };
  }
  const sources = [source];
  if (entry.generatedFile) sources.push({ repoURL: VALUES_REPOSITORY, targetRevision: snapshot, ref: 'values' });
  const application = {
    apiVersion: 'argoproj.io/v1alpha1', kind: 'Application',
    metadata: {
      name: entry.name, namespace: 'argocd',
      annotations: { ...annotations(), 'argocd.argoproj.io/sync-wave': String(entry.wave), 'pulsemetry.io/definition-id': entry.id },
    },
    spec: {
      project: entry.project, sources,
      destination: { server: 'https://kubernetes.default.svc', namespace: inventory.namespace },
      syncPolicy: automation(entry.id),
    },
  };
  return {
    id: entry.id, state: entry.blockReason ? 'quarantined' : 'review-only', deployable: false,
    blockReason: entry.blockReason, application,
  };
}

export function generateApplications(input) {
  const inventory = validateApplicationInput(input);
  const snapshot = input.mode === 'handoff' ? input.handoffRevision : input.valuesRevision;
  const definitions = CATALOG.applications.map(entry => childDefinition(entry, inventory.get(entry.id), input, snapshot));
  // H에는 root/P를 붙이지 않는다. 정상 B 검증 이후의 root 모양도 중지된 검토 자료로만 만든다.
  const rootTemplate = input.mode === 'gitops' ? {
    apiVersion: 'argoproj.io/v1alpha1', kind: 'Application',
    metadata: { name: 'pulsemetry-dev-root', namespace: 'argocd', annotations: annotations() },
    spec: {
      project: 'pulsemetry-dev-root',
      source: { repoURL: VALUES_REPOSITORY, targetRevision: 'main', path: 'dev/applications', directory: { recurse: false } },
      destination: { server: 'https://kubernetes.default.svc', namespace: 'argocd' },
      syncPolicy: automation(),
    },
  } : null;
  return {
    schemaVersion: 1, mode: input.mode,
    revisions: { infra: input.infraRevision, [input.mode === 'handoff' ? 'handoff' : 'values']: snapshot,
      ...(input.mode === 'gitops' ? { bundleManifestSha256: input.bundleManifestSha256 } : {}) },
    readiness: {
      status: 'blocked', deployable: false, deployableApplicationCount: 0,
      reasons: [
        'PROJ-287은 로컬 선언·테스트 범위다. 실제 inventory·권한·렌더 동일성·기능 인계는 검증하지 않았다.',
        CATALOG.applications.find(entry => entry.id === 'lbc').blockReason,
        '관측 admission hook·인증서·RBAC와 반복 sync, CMP 게시 이미지 및 실제 렌더 검증이 필요하다.',
        'root 및 자동 sync/self-heal 활성화는 PROJ-310 인계 관문과 정상 B 검증 이후의 별도 작업이다.',
      ],
    },
    definitions, rootTemplate,
  };
}

export function writeApplicationReview(input, directory) {
  const review = generateApplications(input);
  const output = resolve(directory);
  // 기존 디렉터리·심볼릭 링크와 private 배포 상태를 덮어쓰지 않는다.
  mkdirSync(output, { mode: 0o700 });
  writeFileSync(resolve(output, 'application-review.json'), `${JSON.stringify(review, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return review;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 4 || args[0] !== '--input' || args[2] !== '--output-dir') throw new Error('사용법: node scripts/dev-argocd-applications.mjs --input <JSON> --output-dir <새 로컬 디렉터리>');
    const review = writeApplicationReview(JSON.parse(readFileSync(args[1], 'utf8')), args[3]);
    console.log(`Application ${review.definitions.length}개 검토 자료를 생성했다. handoff=blocked, 배포 가능한 Application=0.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
