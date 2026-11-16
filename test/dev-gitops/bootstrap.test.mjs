import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CATALOG, generateApplications } from '../../scripts/dev-argocd-applications.mjs';
import { prepareBootstrap, verifyBootstrapSources, publishBootstrap, main } from '../../scripts/dev-gitops/bootstrap.mjs';
import { SimpleGitStore } from '../../scripts/dev-gitops/publication.mjs';
import { json, parse } from '../../scripts/dev-gitops/contract.mjs';
import { C, inventory, provenance, repository } from './fixtures.mjs';

function input(fixture) {
  const applications = generateApplications({ schemaVersion: 1, mode: 'handoff', infraRevision: C,
    handoffRevision: fixture.expectedHead, inventory: inventory() }).definitions.map(entry => entry.application);
  const app = applications.find(item => item.metadata.name === 'pulsemetry-dev-observability');
  app.spec.ignoreDifferences = [{ group: 'admissionregistration.k8s.io', kind: 'ValidatingWebhookConfiguration',
    name: 'monitoring-admission', jqPathExpressions: ['.webhooks[]?.clientConfig.caBundle'] }];
  app.spec.syncPolicy.syncOptions.push('RespectIgnoreDifferences=true');
  app.metadata.labels = { retained: 'yes' };
  // 현재 네 앱과 플랫폼이 서로 다른 values commit을 읽어도 effective bytes를 하나로 모을 수 있다.
  for (const item of applications.filter(item => item.spec.project === 'pulsemetry-dev-workloads')) item.spec.sources[1].targetRevision = 'e'.repeat(40);
  return { schemaVersion: 1, expectedHead: fixture.expectedHead, applications };
}

function prepared(fixture, current = input(fixture)) {
  return prepareBootstrap(current, fixture.baseline.bytes, provenance(fixture.baseline),
    new Map([...fixture.generated].filter(([path]) => path.startsWith('dev/generated/'))));
}

test('수동 인계의 코드·release·비교 설정을 보존하고 root와 child 자동화만 켠다', async t => {
  const fixture = await repository(t, { handoffOnly: true }), current = input(fixture), value = prepared(fixture, current);
  assert.equal(value.applications.size, 18); assert.equal(value.infraCommit, C);
  assert.equal(value.snapshot.get('dev/bundle.json'), fixture.baseline.bytes);
  assert.equal(value.snapshot.has('dev/delivery-state.json'), false); assert.equal(value.snapshot.has('dev/activation.json'), false);
  assert.equal(value.sourceRevisions.get('dev/generated/telemetry-kafka-admin.yaml'), fixture.expectedHead);
  assert.equal(value.sourceRevisions.get('dev/generated/enrollment-api.yaml'), 'e'.repeat(40));
  for (const entry of CATALOG.applications) {
    const source = current.applications.find(item => item.metadata.name === entry.name);
    const actual = parse(value.applications.get(`dev/applications/${entry.id}.yaml`));
    assert.deepEqual(actual.spec.sources, source.spec.sources);
    assert.deepEqual(actual.spec.ignoreDifferences, source.spec.ignoreDifferences);
    assert.deepEqual(actual.spec.syncPolicy.syncOptions, source.spec.syncPolicy.syncOptions);
    assert.deepEqual(actual.metadata.labels, source.metadata.labels);
    assert.deepEqual(actual.spec.syncPolicy.automated, { enabled: true, selfHeal: true, prune: false, allowEmpty: false });
    assert.deepEqual(actual.spec.syncPolicy.retry, { limit: 0 });
    assert.equal(actual.metadata.annotations['argocd.argoproj.io/skip-reconcile'], undefined);
    assert.equal(actual.metadata.annotations['pulsemetry.io/handoff-status'], undefined);
  }
  assert.equal(value.root.spec.source.path, 'dev/applications');
  assert.equal(value.root.spec.source.targetRevision, 'main');
  assert.equal(value.root.metadata.finalizers, undefined);
});

test('Kubernetes가 생략하는 빈 label map은 root 선언에도 넣지 않는다', async t => {
  const fixture = await repository(t, { handoffOnly: true }), current = input(fixture);
  for (const app of current.applications) app.metadata.labels = {};
  const value = prepared(fixture, current);
  for (const text of value.applications.values()) assert.equal(parse(text).metadata.labels, undefined);
});

test('누락·중복·다른 code/namespace/source·위험한 sync 정책은 거부한다', async t => {
  const fixture = await repository(t, { handoffOnly: true });
  const invalid = [
    value => value.applications.pop(),
    value => { value.applications[0] = value.applications[1]; },
    value => { value.applications[0].spec.sources[0].targetRevision = 'f'.repeat(40); },
    value => { value.applications[0].spec.destination.namespace = 'default'; },
    value => { value.applications[0].metadata.resourceVersion = '123'; },
    value => { value.applications[0].spec.sources[0].repoURL = 'https://example.invalid/infra'; },
    value => { value.applications[0].spec.syncPolicy.automated.prune = true; },
    value => { value.applications[0].spec.syncPolicy.syncOptions.push('Replace=true'); },
  ];
  for (const mutate of invalid) { const value = input(fixture); mutate(value); assert.throws(() => prepared(fixture, value)); }
  const changed = new Map(fixture.generated);
  changed.set('dev/generated/enrollment-api.yaml', changed.get('dev/generated/enrollment-api.yaml').replace(fixture.baseline.manifest.images['enrollment-api'].digest, 'sha256:' + '0'.repeat(64)));
  assert.throws(() => prepareBootstrap(input(fixture), fixture.baseline.bytes, provenance(fixture.baseline), changed));
});

test('현재 Application 참조의 effective generated bytes를 게시 전에 모두 대조한다', async t => {
  const fixture = await repository(t, { handoffOnly: true }), value = prepared(fixture), calls = [];
  await verifyBootstrapSources(value, async (revision, path) => { calls.push([revision, path]); return fixture.generated.get(path); });
  assert.equal(calls.length, 13);
  await assert.rejects(verifyBootstrapSources(value, async (_revision, path) => fixture.generated.get(path) + '\n'), /generated/);
});

test('bare Git 초기 연결은 snapshot와 참조를 함께 게시하며 root는 children 경로 밖에 둔다', async t => {
  const fixture = await repository(t, { handoffOnly: true }), value = prepared(fixture);
  const store = await SimpleGitStore.open({ remote: fixture.remote, local: true, env: { PATH: process.env.PATH } });
  t.after(() => store.close());
  let verified = 0;
  const result = await publishBootstrap({ prepared: value, store, verify: async () => { verified++; } });
  assert.equal(result.result, 'published'); assert.equal(verified, 1);
  const current = await store.files(await store.refresh());
  assert.equal([...current.keys()].filter(path => path.startsWith('dev/applications/')).length, 18);
  assert.equal(current.has('dev/applications/root.yaml'), false);
  assert.equal(parse(current.get('dev/root.yaml')).metadata.name, 'pulsemetry-dev-root');
  assert.equal(parse(current.get('dev/desired.yaml')).schemaVersion, 2);
  for (const entry of CATALOG.applications) {
    const app = parse(current.get(`dev/applications/${entry.id}.yaml`));
    assert.equal(app.spec.sources[0].targetRevision, C);
    if (entry.generatedFile) assert.equal(app.spec.sources[1].targetRevision, result.valuesCommit);
  }
  assert.equal((await store.files(result.valuesCommit)).has('dev/desired.yaml'), false);
  await assert.rejects(publishBootstrap({ prepared: { ...value, expectedHead: result.desiredCommit }, store }), /덮어쓰지/);
});

test('초기 연결의 stale HEAD는 어떠한 새 선택도 쓰지 않는다', async t => {
  const fixture = await repository(t, { handoffOnly: true }), value = prepared(fixture);
  const store = await SimpleGitStore.open({ remote: fixture.remote, local: true, env: { PATH: process.env.PATH } });
  t.after(() => store.close());
  const changed = await store.commit(value.expectedHead, new Map([['dev/infra-commit.txt', 'f'.repeat(40) + '\n']]), 'concurrent change');
  await store.push(value.expectedHead, changed);
  await assert.rejects(publishBootstrap({ prepared: value, store }), /HEAD/);
  assert.equal(await store.refresh(), changed);
});

test('review CLI는 검토 파일만 만들며 명시적 publish 없이는 인증·네트워크를 사용하지 않는다', async t => {
  const fixture = await repository(t, { handoffOnly: true }), directory = join(fixture.root, 'input'), generated = join(directory, 'generated');
  await mkdir(generated, { recursive: true });
  await writeFile(join(directory, 'current.json'), json(input(fixture)));
  await writeFile(join(directory, 'completion.json'), fixture.baseline.bytes);
  await writeFile(join(directory, 'producer.json'), json(provenance(fixture.baseline)));
  for (const [path, text] of fixture.generated) if (path.startsWith('dev/generated/')) await writeFile(join(generated, path.split('/').at(-1)), text);
  const args = ['--input', join(directory, 'current.json'), '--candidate', join(directory, 'completion.json'),
    '--provenance', join(directory, 'producer.json'), '--generated-dir', generated, '--values-repository', directory,
    '--output-dir', join(fixture.root, 'review')];
  const dependencies = { readBlob: async (_revision, path) => fixture.generated.get(path),
    openStore: () => { throw new Error('must not open network store'); }, verifySource: () => { throw new Error('must not use network'); } };
  t.mock.method(console, 'log', () => {});
  assert.equal(await main(args, {}, dependencies), 0);
  const review = parse(await readFile(join(fixture.root, 'review/bootstrap-review.json'), 'utf8'));
  assert.equal(review.valuesCommit, null); assert.equal(review.desiredCommit, null);
  assert.equal(parse(await readFile(join(fixture.root, 'review/root.yaml'), 'utf8')).spec.syncPolicy.automated.enabled, true);
  const disabled = [...args.slice(0, -1), join(fixture.root, 'publish-disabled'), '--publish'];
  await assert.rejects(main(disabled, {}, dependencies), /명시적으로 활성화/);
});
