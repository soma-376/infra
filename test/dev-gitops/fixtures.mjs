import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { CATALOG, INFRA_REPOSITORY, VALUES_REPOSITORY } from '../../scripts/dev-argocd-applications.mjs';
import { APPS, json, sha256, validateManifest } from '../../scripts/dev-gitops/contract.mjs';
import { configurationFingerprint } from '../../scripts/dev-gitops/release.mjs';
import { GitStore } from '../../scripts/dev-gitops/git-store.mjs';

export const C = 'c'.repeat(40);
export const INITIAL_NONCE = '0'.repeat(32);
export const GENERATED_FILES = ['base.yaml', 'lbc.yaml', 'runtime.yaml', 'enrollment-api.yaml',
  'telemetry-ingest.yaml', 'telemetry-gateway.yaml', 'telemetry-kafka-admin.yaml', 'dashboard-api.yaml',
  'clickhouse.yaml', 'fluent-bit.yaml', 'ascp.yaml', 'observability.yaml', 'kafka-strimzi.yaml'];
export const OWNER = { repository: 'soma-376/pulsemetry-backend',
  workflowRef: 'soma-376/pulsemetry-backend/.github/workflows/promote_dev.yml@refs/heads/main',
  workflowRunId: '900', workflowRunAttempt: '1' };
export function makeBundle({ commit = 'b'.repeat(40), run = '201', imageSeed = 'candidate' } = {}) {
  const images = {}, deploymentContracts = {};
  for (const app of APPS) {
    const content = json({ schemaVersion: 1, app, backendCommit: commit, migrations: [], envelope: 'v1' });
    const hash = sha256(content);
    deploymentContracts[app] = { content, sha256: hash };
    images[app] = { repository: `soma-376/${app}`, digest: `sha256:${sha256(`${imageSeed}/${app}`)}`,
      platform: 'linux/arm64', arm64ManifestDigest: `sha256:${sha256(`${imageSeed}/${app}`)}`, deploymentContractSha256: hash };
  }
  const manifest = { schemaVersion: 1, status: 'complete', repository: 'soma-376/pulsemetry-backend',
    backendCommit: commit, workflowRef: 'soma-376/pulsemetry-backend/.github/workflows/deploy_dev.yml@refs/heads/develop',
    workflowRunId: run, workflowRunAttempt: '1', images, deploymentContracts,
    enrollmentAssets: { lockSha256: sha256('fixed asset lock') } };
  return validateManifest(json(manifest));
}
export function provenance(bundle, overrides = {}) {
  const { repository, backendCommit, workflowRef, workflowRunId, workflowRunAttempt } = bundle.manifest;
  return { repository, backendCommit, workflowRef, workflowRunId, workflowRunAttempt,
    conclusion: 'success', event: 'push', headBranch: 'develop', createdAt: '2026-11-06T03:00:00Z',
    artifactId: '301', artifactSha256: sha256(`artifact archive:${bundle.B}`), ...overrides };
}
export function values(app, bundle, newline = '\n') {
  const image = bundle.manifest.images[app], contract = bundle.manifest.deploymentContracts[app];
  return [`# 원래 주석·줄바꿈·인용을 보존한다`, `image:`,
    `  repository: "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/soma-376/${app}"`,
    `  digest: '${image.digest}'  # 빌드 digest`, `deliveryVerification:`, `  enabled: true`,
    `  operationNonce: "${INITIAL_NONCE}"`, `  infraCommit: '${C}'`,
    `  bundleManifestSha256: '${bundle.B}'`, `  imageDigest: '${image.digest}'`,
    `  contractSha256: '${contract.sha256}'`, `  contract: ${JSON.stringify(contract.content)}`,
    `  image:`, `    repository: 'verifier.example.invalid/fixed'`, `    digest: 'sha256:${'f'.repeat(64)}'`,
    `runtime:`, `  literal: 'value # 원래 문자열'`, `  replicas: 1`, ``].join(newline);
}
export function fingerprints(runtimeFingerprint) {
  return { schemaFingerprint: sha256('schema'), runtimeFingerprint,
    keyTlsFingerprint: sha256('key versions and TLS metadata'), envelopeFingerprint: sha256('envelope') };
}
export function observation({ runtimeFingerprint, result = 'passed', terminal = true, ...overrides }) {
  return { result, terminal, reason: result === 'passed' ? 'verified' : 'verification_failed',
    observedAt: '2026-11-06T04:00:00Z', fingerprints: fingerprints(runtimeFingerprint), applications: [], ...overrides };
}
function rawGit(directory, args) {
  return execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, LANG: 'C.UTF-8', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'local fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'local fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } }).trimEnd();
}
async function commitFiles(directory, files, message) {
  for (const [name, content] of files) { const path = join(directory, name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, content); }
  rawGit(directory, ['add', '.']); rawGit(directory, ['commit', '--quiet', '-m', message]);
  return rawGit(directory, ['rev-parse', 'HEAD']);
}
async function localStore(root, remote, name) {
  const directory = join(root, name); await mkdir(directory);
  const store = new GitStore(directory, { env: { PATH: process.env.PATH } });
  // 로컬 bare 저장소를 사용하는 테스트에서만 file protocol을 연다.
  store.env.GIT_CONFIG_VALUE_1 = 'always';
  await store.git(['init', '--quiet']); await store.git(['remote', 'add', 'origin', remote]); await store.refresh();
  return store;
}
export const inventory = () => CATALOG.applications.map(entry => ({ id: entry.id, namespace: entry.namespace,
  releaseName: entry.id, installation: entry.id === 'cert-manager' ? 'new' : 'existing' }));
export const activation = () => ({ schemaVersion: 1, readiness: { handoffAccepted: true,
  infraPublisherAccepted: true, normalBundleAccepted: true, acceptanceEvidenceSha256: sha256('local accepted fixture') },
  inventory: inventory(), verifier: { repository: 'verifier.example.invalid/fixed', digest: `sha256:${'f'.repeat(64)}`, arm64ManifestDigest: `sha256:${'f'.repeat(64)}` } });
export async function repository(t, { handoffOnly = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'proj311-local-git-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = join(root, 'values.git'), seed = join(root, 'seed');
  await mkdir(remote); await mkdir(seed);
  rawGit(remote, ['init', '--bare', '--quiet', '--initial-branch=main']);
  rawGit(seed, ['init', '--quiet', '--initial-branch=main']);
  rawGit(seed, ['remote', 'add', 'origin', remote]);
  const baseline = makeBundle({ commit: 'a'.repeat(40), run: '200', imageSeed: 'baseline' });
  const files = new Map(GENERATED_FILES.map(name => [`dev/generated/${name}`,
    APPS.some(app => name === `${app}.yaml`) ? values(name.slice(0, -5), baseline) : `# ${name}\nfixed: preserved\n`]));
  if (!handoffOnly) files.set('dev/bundle.json', baseline.bytes);
  files.set('dev/infra-commit.txt', `${C}\n`);
  if (!handoffOnly) files.set('dev/activation.json', json(activation()));
  const V = await commitFiles(seed, files, 'initial immutable snapshot');
  if (handoffOnly) {
    rawGit(seed, ['push', '--quiet', 'origin', 'main']);
    return { root, remote, baseline, generated: files, expectedHead: V,
      clone: name => localStore(root, remote, name), store: await localStore(root, remote, 'writer') };
  }
  const selection = { infraCommit: C, valuesCommit: V, bundleManifestSha256: baseline.B, operationNonce: INITIAL_NONCE };
  const selected = new Map();
  for (const entry of CATALOG.applications) {
    selected.set(`dev/applications/${entry.id}.yaml`, json({ apiVersion: 'argoproj.io/v1alpha1', kind: 'Application',
      metadata: { name: entry.name, namespace: 'argocd', annotations: { 'argocd.argoproj.io/sync-wave': String(entry.wave) } },
      spec: { project: entry.project, destination: { namespace: entry.namespace },
        sources: [{ repoURL: INFRA_REPOSITORY, path: entry.chart, targetRevision: C },
          ...(entry.generatedFile ? [{ repoURL: VALUES_REPOSITORY, ref: 'values', targetRevision: V }] : [])],
        syncPolicy: { automated: { enabled: true, selfHeal: true, prune: false, allowEmpty: false }, retry: { limit: 0 } } } }));
  }
  selected.set('dev/desired.yaml', json({ schemaVersion: 1, ...selection }));
  const P = await commitFiles(seed, selected, 'initial desired selection');
  selection.desiredCommit = P;
  const runtimeFingerprint = configurationFingerprint(files);
  const state = { schemaVersion: 1, state: 'idle', generation: 0, owner: null, operation: null,
    currentSelection: selection, expectedDesiredP: P, lastKnownGood: { ...selection,
      evidenceSha256: sha256('initial accepted evidence'), configurationFingerprint: runtimeFingerprint, fingerprints: fingerprints(runtimeFingerprint) },
    failedReleases: [], resumeFence: null };
  const Q = await commitFiles(seed, new Map([['dev/delivery-state.json', json(state)]]), 'bind initial desired');
  rawGit(seed, ['push', '--quiet', 'origin', 'main']);
  return { root, remote, baseline, V, P, Q, state, runtimeFingerprint, clone: name => localStore(root, remote, name), store: await localStore(root, remote, 'writer') };
}
export function promotionArgs(fixture, overrides = {}) {
  const candidate = makeBundle(); let sequence = 1;
  return { store: fixture.store, candidateBytes: candidate.bytes, provenance: provenance(candidate), owner: OWNER,
    observe: async ({ runtimeFingerprint }) => observation({ runtimeFingerprint }),
    compatibility: async ({ runtimeFingerprint }) => ({ terminal: true, fingerprints: fingerprints(runtimeFingerprint) }),
    isDescendant: async () => true, now: () => '2026-11-06T05:00:00Z',
    nonce: () => String(sequence++).repeat(32), ...overrides };
}
