import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { dump, load } from 'js-yaml';
import { CATALOG, INFRA_REPOSITORY, VALUES_REPOSITORY } from '../../scripts/dev-argocd-applications.mjs';
import { APPS, json } from '../../scripts/dev-gitops/contract.mjs';
import { makeSnapshot, readYaml } from '../../scripts/dev-gitops/simple-release.mjs';
import { publishPrepared, selectedRelease } from '../../scripts/dev-gitops/publication.mjs';
import { syncGeneratedValues } from '../../scripts/dev-generated-values-sync.mjs';
import { generateValues, parseRuntimeValues } from '../../scripts/eks-values.mjs';
import profiles from '../../lib/dev/deployment-profile.cjs';
import { C, makeBundle, provenance } from './fixtures.mjs';

const source = 'd'.repeat(40);
const account = '111111111111';
const env = { GITHUB_REPOSITORY: 'soma-376/infra', GITHUB_SHA: source, GITHUB_RUN_ID: '500',
  GITHUB_RUN_ATTEMPT: '1', AWS_ACCOUNT_ID: account, GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/develop' };
const repo = resolve(import.meta.dirname, '../..');

class MemoryStore {
  constructor() { this.head = '1'.padStart(40, '0'); this.trees = new Map([[this.head, new Map([['README.md', 'fixture\n']])]]); this.commits = 0; this.pushes = 0; this.closed = 0; }
  async refresh() { return this.head; }
  async files(sha) { assert.ok(this.trees.has(sha)); return new Map(this.trees.get(sha)); }
  async commit(parent, changes) {
    const sha = (++this.commits + 1).toString(16).padStart(40, '0');
    this.trees.set(sha, new Map([...await this.files(parent), ...changes]));
    return sha;
  }
  async push(expected, sha) { assert.equal(expected, this.head); this.head = sha; this.pushes++; }
  async close() { this.closed++; }
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'config-publication-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'config/dev'), { recursive: true });
  const runtime = load(await readFile(join(repo, 'test/fixtures/eks-runtime.yaml'), 'utf8'));
  runtime.ingestMode = 'kafka';
  runtime.userAuth.allowedOrigins = ['https://dashboard.example.invalid'];
  runtime.userAuth.allowedRedirectUris = ['https://dashboard.example.invalid/auth/callback'];
  runtime.oidc = { enabled: false, clients: [], callbackBaseUrl: 'https://api.example.invalid',
    failureRedirectUri: 'https://dashboard.example.invalid/auth/callback' };
  await writeFile(join(root, 'config/dev/runtime.yaml'), dump(runtime));
  await writeFile(join(root, 'config/dev/deployment.json'), JSON.stringify({ publicBaseUrl: 'https://api.example.invalid',
    frontendOrigin: 'https://dashboard.example.invalid', runtimeValuesFile: 'runtime.yaml',
    certificates: { defaultId: '11111111-1111-4111-8111-111111111111', additional: [] },
    context: { devOidcClientKeys: [], devAllowedCidr: '0.0.0.0/0', devHttpRedirectEnabled: true,
      devEksArchivePrefix: 'eks', devEksOtlpTarget: 'gateway', devKafkaProvider: 'strimzi', devMskRetirementStage: 'network-removed' } }));
  const outputs = JSON.parse(await readFile(join(repo, 'test/fixtures/argocd-render-outputs.json'), 'utf8'));
  outputs.DevEdgeStack.ValidationPublicBaseUrl = 'https://api.example.invalid';
  const metadata = { items: ['soma-376-dev-telemetry-cluster-ca-cert', ...['gateway', 'ingest', 'topic-admin', 'offset-admin'].map(role => `pulsemetry-${role}-main`)]
    .map((name, i) => ({ metadata: { name, namespace: 'pulsemetry-dev', uid: `fixture-${i}`, resourceVersion: '123' } })) };
  const bundle = makeBundle({ commit: 'a'.repeat(40), run: '200', imageSeed: 'current' });
  const producer = provenance(bundle);
  const registry = options.imageAccount ?? account;
  const references = Object.fromEntries(Object.entries({ enrollment: 'enrollment-api', ingest: 'telemetry-ingest', gateway: 'telemetry-gateway', dashboard: 'dashboard-api' })
    .map(([key, app]) => [key, `${registry}.dkr.ecr.ap-northeast-2.amazonaws.com/soma-376/${app}@${bundle.manifest.images[app].digest}`]));
  const profile = profiles.readDeploymentProfile(join(root, 'config/dev/deployment.json'));
  const values = generateValues(outputs, references, parseRuntimeValues(dump(runtime)), undefined, undefined, profile, JSON.stringify(metadata));
  const generated = new Map(Object.entries(values).map(([name, value]) => [`dev/generated/${name}`, dump(value)]));
  const applications = new Map(CATALOG.applications.map(entry => [`dev/applications/${entry.id}.yaml`, json({
    apiVersion: 'argoproj.io/v1alpha1', kind: 'Application', metadata: { name: entry.name, namespace: 'argocd' },
    spec: { project: entry.project, destination: { server: 'https://kubernetes.default.svc', namespace: entry.namespace },
      sources: [{ repoURL: INFRA_REPOSITORY, path: entry.chart, targetRevision: C,
        ...(entry.renderer === 'strimzi-cmp' ? { plugin: { name: 'pulsemetry-strimzi-v1' } } : { helm: { releaseName: entry.id } }) },
      ...(entry.generatedFile ? [{ repoURL: VALUES_REPOSITORY, ref: 'values', targetRevision: 'a'.repeat(40) }] : [])],
      syncPolicy: { automated: { enabled: false, selfHeal: false, prune: false, allowEmpty: false }, retry: { limit: 0 } } } })]));
  const store = new MemoryStore();
  if (!options.noSelection) await publishPrepared({ store, expectedHead: store.head,
    snapshot: makeSnapshot(generated, bundle.bytes, producer, C), applications, infraCommit: C });
  store.pushes = 0;
  const before = store.head;
  const checks = { evidence: 0, baseline: 0, metadata: 0, collected: 0, collectedClosed: 0, opened: 0, renders: 0, directory: undefined };
  const dependencies = {
    createPipeline: () => ({ verifyPublication: () => ({ plan: { generatedValues: { enabled: true, mode: options.mode ?? 'simple-v2' } }, receipt: {} }),
      checkPublicationBaseline: () => { checks.baseline++; } }),
    githubClient: () => async path => { assert.equal(path, '/repos/soma-376/infra/commits/develop'); return { sha: options.staleSource ? C : source }; },
    verifyPublicationEvidence: async () => { checks.evidence++; },
    openStore: async () => { checks.opened++; return store; },
    collectInputs: async input => {
      assert.deepEqual(input, { accountId: account, runId: '500', runAttempt: '1' }); checks.collected++;
      return { outputs, metadata, verifyMetadata: async () => { checks.metadata++; if (options.changedMetadata && checks.metadata === 2) throw Error('metadata changed'); },
        close: async () => { checks.collectedClosed++; } };
    },
    validateValues: async ({ directory, images, expectedValues }) => {
      checks.directory = directory;
      for (const app of APPS) assert.equal(images[app].digest, bundle.manifest.images[app].digest);
      for (const [name, value] of Object.entries(expectedValues)) assert.deepEqual(load(await readFile(join(directory, name), 'utf8')), value);
    },
    validateRenders: ({ applications: current }) => { checks.renders++; assert.equal(current.size, 18); if (options.badRender) throw Error('render failed'); },
  };
  return { root, store, before, bundle, producer, checks, dependencies };
}

test('설정 게시가 현재 네 이미지와 원본 증거·수동 sync 정책을 보존하고 입력을 재검증한다', async t => {
  const f = await fixture(t);
  const result = await syncGeneratedValues({ root: f.root, directory: f.root, env, dependencies: f.dependencies });
  assert.equal(result.result, 'published'); assert.equal(f.store.pushes, 1);
  const current = await selectedRelease(f.store, f.store.head);
  assert.equal(current.selection.infraCommit, source);
  assert.equal(current.bundle.bytes, f.bundle.bytes); assert.deepEqual(current.producer, f.producer);
  for (const app of APPS) assert.equal(readYaml(current.generated.get(`dev/generated/${app}.yaml`)).image.digest, f.bundle.manifest.images[app].digest);
  assert.equal(readYaml(current.applications.get('dev/applications/telemetry-gateway.yaml')).spec.syncPolicy.automated.enabled, false);
  assert.equal(f.checks.evidence, 2); assert.equal(f.checks.baseline, 2); assert.equal(f.checks.metadata, 2);
  assert.equal(f.checks.renders, 1); assert.equal(f.checks.collectedClosed, 1); assert.equal(f.store.closed, 1);
  assert.equal(existsSync(f.checks.directory), false);
});

for (const [label, options, expected] of [
  ['과거 plan 모드', { mode: 'legacy' }, /새 plan/],
  ['stale source', { staleSource: true }, /develop/],
  ['다른 AWS 계정의 이미지', { imageAccount: '222222222222' }, /계정/],
  ['게시 직전 metadata 변경', { changedMetadata: true }, /metadata changed/],
  ['Application 렌더 실패', { badRender: true }, /render failed/],
  ['초기 선택 누락', { noSelection: true }, /YAML 입력 크기/],
]) test(`${label}이면 Git을 게시하지 않고 생성한 자원을 정리한다`, async t => {
  const f = await fixture(t, options);
  await assert.rejects(syncGeneratedValues({ root: f.root, directory: f.root, env, dependencies: f.dependencies }), expected);
  assert.equal(f.store.head, f.before); assert.equal(f.store.pushes, 0);
  assert.equal(f.store.closed, f.checks.opened);
  assert.equal(f.checks.collectedClosed, f.checks.collected);
  if (f.checks.directory) assert.equal(existsSync(f.checks.directory), false);
});
