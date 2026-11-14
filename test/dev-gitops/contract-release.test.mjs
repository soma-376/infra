import test from 'node:test';
import assert from 'node:assert/strict';
import { APPS, json, sha256, validateManifest, imageVector } from '../../scripts/dev-gitops/contract.mjs';
import { GENERATED, updateImageValues, stripMutable, snapshotFiles, yaml } from '../../scripts/dev-gitops/release.mjs';
import { eligible, validateActivation } from '../../scripts/dev-gitops/engine.mjs';
import { C, GENERATED_FILES, makeBundle, provenance, values, activation } from './fixtures.mjs';

test('완료 B는 원본 바이트이며 이미지 벡터는 JSON key 순서와 재포장에 영향받지 않는다', () => {
  const bundle = makeBundle();
  const repacked = validateManifest(JSON.stringify(bundle.manifest));
  assert.notEqual(repacked.B, bundle.B);
  assert.equal(repacked.vector, bundle.vector);
  assert.equal(bundle.B, sha256(bundle.bytes));
  const reordered = structuredClone(bundle.manifest);
  reordered.images = Object.fromEntries(Object.entries(reordered.images).reverse());
  assert.equal(imageVector(reordered), bundle.vector);
  assert.throws(() => validateManifest(bundle.bytes.replace('"schemaVersion": 1,', '"schemaVersion": 1, "schemaVersion": 1,')));
});

test('부분 이미지·비 ARM64·다른 실행·변조 계약을 완료 묶음으로 수락하지 않는다', () => {
  const bundle = makeBundle();
  for (const mutate of [
    value => delete value.images['telemetry-gateway'],
    value => value.images['dashboard-api'].platform = 'linux/amd64',
    value => value.images['enrollment-api'].repository = 'attacker/enrollment-api',
    value => value.deploymentContracts['telemetry-ingest'].content += ' ',
    value => value.images['telemetry-gateway'].deploymentContractSha256 = 'f'.repeat(64),
  ]) {
    const invalid = structuredClone(bundle.manifest); mutate(invalid);
    assert.throws(() => validateManifest(json(invalid)));
  }
  assert.throws(() => validateManifest(bundle.bytes, provenance(bundle, { workflowRunAttempt: '2' })));
  assert.throws(() => validateManifest(bundle.bytes, provenance(bundle, { conclusion: 'failure' })));
  assert.throws(() => validateManifest(bundle.bytes, provenance(bundle, { headBranch: 'feature/candidate' })));
});

test('generated 13개는 비관리 Kafka admin 사본도 보존한다', () => {
  assert.deepEqual([...GENERATED].sort(), [...GENERATED_FILES].sort());
  const previous = makeBundle({ imageSeed: 'old' }), candidate = makeBundle();
  const files = new Map(GENERATED_FILES.map(name => [`dev/generated/${name}`,
    APPS.some(app => name === `${app}.yaml`) ? values(name.slice(0, -5), previous) : `# preserve ${name}\nfixed: yes\n`]));
  const result = snapshotFiles(files, candidate, { infraCommit: C, operationNonce: 'd'.repeat(32) });
  assert.equal(result.get('dev/generated/telemetry-kafka-admin.yaml'), files.get('dev/generated/telemetry-kafka-admin.yaml'));
  assert.equal(result.get('dev/bundle.json'), candidate.bytes);
  for (const name of GENERATED_FILES.filter(name => !APPS.some(app => name === `${app}.yaml`))) {
    assert.equal(result.get(`dev/generated/${name}`), files.get(`dev/generated/${name}`));
  }
});

test('이미지 변경은 CRLF·주석과 모든 비이미지 바이트를 보존한다', () => {
  const previous = makeBundle({ imageSeed: 'old' }), candidate = makeBundle();
  for (const app of APPS) {
    const source = values(app, previous, '\r\n');
    const updated = updateImageValues(source, app, candidate, { infraCommit: C, operationNonce: 'd'.repeat(32) });
    assert.equal(stripMutable(updated), stripMutable(source));
    assert.equal(updated.match(/\r\n/g).length, source.match(/\r\n/g).length);
    assert.ok(updated.includes("  literal: 'value # 원래 문자열'\r\n"));
    assert.ok(updated.includes('  # 빌드 digest\r\n'));
    const decoded = yaml(updated);
    assert.equal(decoded.image.repository, yaml(source).image.repository);
    assert.equal(decoded.image.digest, candidate.manifest.images[app].digest);
    assert.equal(decoded.deliveryVerification, undefined);
  }
});

test('중복·alias·block scalar 등 모호한 변경 경로는 재직렬화하지 않고 거부한다', () => {
  const previous = makeBundle({ imageSeed: 'old' }), candidate = makeBundle();
  const source = values('enrollment-api', previous);
  for (const invalid of [
    source.replace('image:\n', 'image: &shared\n'),
    source.replace('  digest:', '  digest: invalid\n  digest:'),
    source.replace('  digest: ', '  digest: |\n    '),
  ]) assert.throws(() => updateImageValues(invalid, 'enrollment-api', candidate, { infraCommit: C, operationNonce: 'd'.repeat(32) }));
});

test('누적 실패 B·전체 벡터와 실패 이전 생성 run은 자동 재개하지 못한다', async () => {
  const failed = makeBundle({ imageSeed: 'failed', commit: 'a'.repeat(40) });
  const record = { bundleManifestSha256: failed.B, imageVectorSha256: failed.vector,
    backendCommit: failed.manifest.backendCommit, failureRecordedAt: '2026-11-06T01:00:00Z' };
  await assert.rejects(eligible(failed, provenance(failed), [record], async () => true));
  const repackaged = makeBundle({ imageSeed: 'failed', run: '999' });
  await assert.rejects(eligible(repackaged, provenance(repackaged), [record], async () => true));
  const candidate = makeBundle();
  await assert.rejects(eligible(candidate, provenance(candidate, { createdAt: record.failureRecordedAt }), [record], async () => true));
  await assert.rejects(eligible(candidate, provenance(candidate), [record], async () => false));
  const sameSource = makeBundle({ commit: record.backendCommit });
  await assert.rejects(eligible(sameSource, provenance(sameSource), [record], async () => true));
  await eligible(candidate, provenance(candidate), [record], async () => true);
});

test('기존 Job 설정은 이미지 게시기가 임의 삭제하지 않고 설정 변경을 요구한다', () => {
  const previous = makeBundle({ imageSeed: 'old' }), candidate = makeBundle();
  const source = values('enrollment-api', previous) + 'deliveryVerification:\n  enabled: true\n';
  assert.throws(() => updateImageValues(source, 'enrollment-api', candidate, { infraCommit: C, operationNonce: 'd'.repeat(32) }), /infra 설정 변경/);
});

test('H 인계 또는 설정 publisher·정상 B 수락 누락은 activation으로 인정하지 않는다', () => {
  const accepted = activation();
  validateActivation(accepted);
  for (const key of ['handoffAccepted', 'infraPublisherAccepted', 'normalBundleAccepted']) {
    assert.throws(() => validateActivation({ ...accepted, readiness: { ...accepted.readiness, [key]: false } }));
  }
  assert.throws(() => validateActivation({ ...accepted, inventory: [] }));
  assert.throws(() => validateActivation({ ...accepted, inventory: Array(18).fill(accepted.inventory[0]) }));
});
