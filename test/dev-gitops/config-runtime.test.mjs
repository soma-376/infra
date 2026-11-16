import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { load } from 'js-yaml';
import { prepareConfigurationRuntime } from '../../scripts/dev-gitops/config-runtime.mjs';
import { APPS } from '../../scripts/dev-gitops/contract.mjs';
import { GENERATED } from '../../scripts/dev-gitops/release.mjs';
import { makeBundle, values } from './fixtures.mjs';

const accountId = '123456789012';
const git = (root, args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8',
  env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } }).trim();
async function fixture(t, options = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'config-runtime-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'config/dev'), { recursive: true });
  const resource = { requests: { cpu: '250m', memory: '2Gi' }, limits: { cpu: '1', memory: '2560Mi' } };
  await writeFile(join(root, 'config/dev/deployment.json'), JSON.stringify({ runtimeValuesFile: 'runtime.yaml' }));
  await writeFile(join(root, 'config/dev/runtime.yaml'), JSON.stringify({ clickhouse: { resources: resource } }));
  git(root, ['init', '--quiet']); git(root, ['add', '.']); git(root, ['commit', '--quiet', '-m', 'fixture']);
  const sourceCommit = git(root, ['rev-parse', 'HEAD']);
  const bundle = makeBundle();
  const selectedFiles = new Map(GENERATED.map(n => [`dev/generated/${n}`, APPS.some(a => n === `${a}.yaml`) ? values(n.slice(0, -5), bundle) : 'fixed: baseline\n']));
  selectedFiles.set('dev/bundle.json', bundle.bytes);
  const selection = { infraCommit: 'a'.repeat(40), valuesCommit: 'b'.repeat(40), bundleManifestSha256: bundle.B, desiredCommit: 'c'.repeat(40), operationNonce: 'd'.repeat(32) };
  const state = { collects: 0, closes: 0, checks: 0, validations: 0, generated: [], mutateInput: false, failValidation: false, tamperDisk: false };
  const metadata = { items: [{ metadata: { name: 'fixture', resourceVersion: '1' } }] };
  const dependencies = { loadSourceTools: async () => ({
    readProfile: path => ({ runtimeValuesPath: resolve(root, 'config/dev', JSON.parse(git(root, ['show', 'HEAD:config/dev/deployment.json'])).runtimeValuesFile) }),
    parseRuntime: text => JSON.parse(text),
    collectInputs: async input => {
      state.collects++; assert.deepEqual(input, { accountId, runId: '11', runAttempt: '2' });
      return { outputs: { current: state.mutateInput ? 'changed' : 'baseline' }, metadata,
        verifyMetadata: async () => { state.checks++; }, close: async () => { state.closes++; } };
    },
    generate: (outputs, images, runtime, _a, _b, profile, rawMetadata) => {
      assert.deepEqual(JSON.parse(rawMetadata), metadata); assert.ok(profile.runtimeValuesPath.startsWith(root));
      state.generated.push({ outputs, images, runtime });
      return Object.fromEntries(GENERATED.map(name => [name, APPS.some(app => name === `${app}.yaml`)
        ? { image: { repository: images[{ 'enrollment-api': 'enrollment', 'telemetry-ingest': 'ingest', 'telemetry-gateway': 'gateway', 'dashboard-api': 'dashboard' }[name.slice(0, -5)]].split('@')[0], digest: bundle.manifest.images[name.slice(0, -5)].digest } }
        : name === 'clickhouse.yaml' ? { resources: runtime.clickhouse.resources } : { fixed: outputs.current }]));
    },
    validateValues: async ({ directory, expectedValues, images }) => {
      state.validations++; if (state.failValidation) throw new Error('sensitive-marker');
      if (state.tamperDisk) await writeFile(join(directory, 'base.yaml'), 'sensitive-marker');
      const hashes = {};
      for (const name of GENERATED) {
        const bytes = await readFile(join(directory, name));
        if (!state.tamperDisk) assert.deepEqual(load(bytes.toString()), expectedValues[name]);
        hashes[name] = createHash('sha256').update(bytes).digest('hex');
      }
      assert.equal(Object.keys(images).length, 4);return { hashes };
    },
  }) };
  return { root, resource, sourceCommit, selectedFiles, selection, state, dependencies,
    input: { root, sourceCommit, accountId, runId: '11', runAttempt: '2', selectedFiles, selection, helm: 'fixture-helm' },
    ...options };
}
const validation = (runtime, fixture) => runtime.validateCandidate({ sourceCommit: fixture.sourceCommit, candidate: runtime.candidate,
  currentSelection: fixture.selection, bundleManifest: fixture.selectedFiles.get('dev/bundle.json') });

test('고정 source에서 현재 선택한 네 이미지와 ClickHouse 자원을 생성하고 매 검증마다 입력·metadata를 재조회한다', async t => {
  const f = await fixture(t), r = await prepareConfigurationRuntime(f.input, f.dependencies);
  assert.equal(r.candidate.size, 13);
  assert.deepEqual(load(r.candidate.get('dev/generated/clickhouse.yaml')).resources, f.resource);
  assert.equal(f.state.collects, 2); assert.equal(f.state.closes, 1);
  for (const app of APPS) assert.equal(load(r.candidate.get(`dev/generated/${app}.yaml`)).image.digest, makeBundle().manifest.images[app].digest);
  await validation(r, f);
  assert.equal(f.state.collects, 3); assert.equal(f.state.validations, 2); assert.equal(f.state.checks, 6);
  await r.close(); await r.close(); assert.equal(f.state.closes, 3);
  await assert.rejects(validation(r, f), /설정 실행 입력/);
});

test('source HEAD 불일치·dirty checkout·선택 이미지 변경은 수집 전 거부한다', async t => {
  const f = await fixture(t);
  await assert.rejects(prepareConfigurationRuntime({ ...f.input, sourceCommit: 'f'.repeat(40) }, f.dependencies), /설정 실행 입력/);
  await writeFile(join(f.root, 'config/dev/runtime.yaml'), 'sensitive-marker');
  await assert.rejects(prepareConfigurationRuntime(f.input, f.dependencies), /설정 실행 입력/);
  git(f.root, ['checkout', '--', 'config/dev/runtime.yaml']);
  f.selectedFiles.set('dev/generated/enrollment-api.yaml', 'image:\n  repository: bad\n  digest: bad\n');
  await assert.rejects(prepareConfigurationRuntime(f.input, f.dependencies), /설정 실행 입력/);
  assert.equal(f.state.collects, 0);
});

test('assume-unchanged로 숨긴 tracked 변경도 blob 대조가 거부한다', async t => {
  const f = await fixture(t);
  git(f.root, ['update-index', '--assume-unchanged', 'config/dev/runtime.yaml']);
  await writeFile(join(f.root, 'config/dev/runtime.yaml'), 'sensitive-marker');
  assert.equal(git(f.root, ['status', '--porcelain']), '');
  await assert.rejects(prepareConfigurationRuntime(f.input, f.dependencies), /설정 실행 입력/);
  assert.equal(f.state.collects, 0);
});

test('검증 중 source 변경·입력 drift·외부 후보 변경을 거부한다', async t => {
  const f = await fixture(t), r = await prepareConfigurationRuntime(f.input, f.dependencies);
  t.after(() => r.close());
  r.candidate.set('dev/generated/base.yaml', 'sensitive-marker');
  await assert.rejects(validation(r, f), error => !error.message.includes('sensitive-marker'));
  r.candidate.delete('dev/generated/base.yaml');
  // 원래 Map은 외부 변경으로 손상되지 않는다. 새 candidate로 다시 준비한다.
  await r.close();
  const r2 = await prepareConfigurationRuntime(f.input, f.dependencies);t.after(() => r2.close());
  f.state.mutateInput = true;
  await assert.rejects(validation(r2, f), /설정 실행 입력/);
  f.state.mutateInput = false;
  await writeFile(join(f.root, 'config/dev/runtime.yaml'), 'sensitive-marker');
  await assert.rejects(validation(r2, f), error => !error.message.includes('sensitive-marker'));
});

test('렌더 검증 실패와 disk 바이트 변조는 고정 오류로 실패하고 모든 수집기를 정리한다', async t => {
  for (const mode of ['failValidation', 'tamperDisk']) {
    const f = await fixture(t);f.state[mode] = true;
    await assert.rejects(prepareConfigurationRuntime(f.input, f.dependencies), error => !error.message.includes('sensitive-marker'));
    assert.equal(f.state.collects, 2);assert.equal(f.state.closes, 2);
  }
});

test('실제 profile/runtime parser와 생성기가 현재 B 및 운영 메모리를 재생성한다', async t => {
  const f = await fixture(t);
  const { generateValues, parseRuntimeValues } = await import('../../scripts/eks-values.mjs');
  const { default: profiles } = await import('../../lib/dev/deployment-profile.cjs');
  const runtime = load(await readFile(new URL('../fixtures/eks-runtime.yaml', import.meta.url), 'utf8'));
  Object.assign(runtime, { ingestMode: 'kafka', clickhouse: { resources: f.resource },
    oidc: { enabled: false, callbackBaseUrl: 'https://api.example.test', failureRedirectUri: 'https://web.example.test/auth/callback' } });
  runtime.userAuth.allowedOrigins = ['https://web.example.test'];
  runtime.userAuth.allowedRedirectUris = ['https://web.example.test/auth/callback'];
  const profile = { publicBaseUrl: 'https://api.example.test', frontendOrigin: 'https://web.example.test', runtimeValuesFile: 'runtime.yaml',
    certificates: { defaultId: '11111111-1111-4111-8111-111111111111', additional: [] },
    context: { devOidcClientKeys: [], devAllowedCidr: '0.0.0.0/0', devHttpRedirectEnabled: true, devEksArchivePrefix: 'eks', devEksOtlpTarget: 'gateway', devKafkaProvider: 'strimzi', devMskRetirementStage: 'network-removed' } };
  await writeFile(join(f.root, 'config/dev/deployment.json'), JSON.stringify(profile));
  await writeFile(join(f.root, 'config/dev/runtime.yaml'), JSON.stringify(runtime));
  git(f.root, ['add', '.']); git(f.root, ['commit', '--quiet', '-m', 'real parser fixture']);
  f.input.sourceCommit = git(f.root, ['rev-parse', 'HEAD']);
  const outputs = JSON.parse(await readFile(new URL('../scripts/fixtures/eks-outputs.json', import.meta.url), 'utf8'));
  for (const group of Object.values(outputs)) for (const [key, value] of Object.entries(group)) group[key] = value.replaceAll('111111111111', accountId);
  for (const key of Object.keys(outputs.DevEksStack)) if (key.startsWith('Msk')) delete outputs.DevEksStack[key];
  Object.assign(outputs.DevEksStack, { KafkaProvider: 'strimzi', KafkaStage: 'main', ArchivePrefix: 'eks',
    KafkaTopicName: 'pulsemetry-dev-telemetry-ingress-main', KafkaConsumerGroupName: 'pulsemetry-dev-telemetry-ingest-main',
    EksKafkaAvailabilityZone: 'ap-northeast-2a', EksKafkaNodeSecurityGroupId: 'sg-0123456789abcdef3' });
  Object.assign(outputs.DevEdgeStack, { ValidationPublicBaseUrl: profile.publicBaseUrl, ValidationOtlpTarget: 'gateway' });
  const metadata = { items: ['soma-376-dev-telemetry-cluster-ca-cert', ...['gateway', 'ingest', 'topic-admin', 'offset-admin'].map(role => `pulsemetry-${role}-main`)]
    .map((name, i) => ({ metadata: { name, namespace: 'pulsemetry-dev', uid: `fixture-${i}`, resourceVersion: '123' } })) };
  const original = await f.dependencies.loadSourceTools();
  const r = await prepareConfigurationRuntime(f.input, { loadSourceTools: async () => ({ ...original,
    readProfile: profiles.readDeploymentProfile, parseRuntime: parseRuntimeValues, generate: generateValues,
    collectInputs: async () => ({ outputs, metadata, verifyMetadata: async () => {}, close: async () => {} }) }) });
  t.after(() => r.close());
  assert.deepEqual(load(r.candidate.get('dev/generated/clickhouse.yaml')).resources, f.resource);
  for (const app of APPS) assert.equal(load(r.candidate.get(`dev/generated/${app}.yaml`)).image.digest, makeBundle().manifest.images[app].digest);
  assert.equal(load(r.candidate.get('dev/generated/telemetry-ingest.yaml')).ingestMode, 'kafka');
});
