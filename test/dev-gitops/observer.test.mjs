import test from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG } from '../../scripts/dev-argocd-applications.mjs';
import { currentApplication, evaluateStage, observeDeployment, credentialEnv } from '../../scripts/dev-gitops/observer.mjs';
import { json, sha256, validateManifest } from '../../scripts/dev-gitops/contract.mjs';
import { C, makeBundle } from './fixtures.mjs';

function stage() {
  const entry = CATALOG.applications.find(value => value.id === 'enrollment-api'), bundle = makeBundle();
  const selection = { infraCommit: C, valuesCommit: 'd'.repeat(40), bundleManifestSha256: bundle.B,
    desiredCommit: 'e'.repeat(40), operationNonce: 'f'.repeat(32) };
  const revisions = [C, selection.valuesCommit], digest = bundle.manifest.images[entry.id].digest;
  const receipt = { schemaVersion: 1, operationNonce: selection.operationNonce, stage: entry.id, infraCommit: C,
    bundleManifestSha256: bundle.B, imageDigest: digest, contractSha256: bundle.manifest.deploymentContracts[entry.id].sha256,
    result: 'passed', checks: ['flyway', 'bootstrap'], checkedAt: '2026-11-06T01:02:00Z', evidenceSha256: sha256('verified stage') };
  const app = { metadata: { name: entry.name, uid: 'a1-a2' }, spec: { sources: revisions.map(targetRevision => ({ targetRevision })) },
    status: { sync: { comparedTo: { sources: revisions.map(targetRevision => ({ targetRevision })) }, revisions, status: 'Synced' },
      health: { status: 'Healthy' }, operationState: { phase: 'Succeeded', startedAt: '2026-11-06T01:00:00Z',
        finishedAt: '2026-11-06T01:03:00Z', syncResult: { revisions } } } };
  const job = { metadata: { uid: 'b1-b2', labels: { 'pulsemetry.dev/operation-nonce': selection.operationNonce } },
    status: { startTime: '2026-11-06T01:01:00Z', succeeded: 1 } };
  const verifier = { repository: 'example.invalid/verified-tool', digest: `sha256:${'1'.repeat(64)}`, arm64ManifestDigest: `sha256:${'2'.repeat(64)}` };
  const pods = [{ metadata: { uid: 'c1-c2', ownerReferences: [{ kind: 'Job', uid: job.metadata.uid }],
    labels: { 'pulsemetry.dev/operation-nonce': selection.operationNonce } },
    spec: { containers: [{ name: 'verifier', image: `${verifier.repository}@${verifier.digest}` }] },
    status: { containerStatuses: [{ name: 'verifier', imageID: `${verifier.repository}@${verifier.arm64ManifestDigest}`, state: { terminated: { exitCode: 0, message: json(receipt) } } }] } }];
  const workloadPods = [{ metadata: { uid: 'd1-d2' }, spec: { containers: [{ name: entry.id, image: `example.invalid/enrollment@${digest}` }] },
    status: { phase: 'Running', containerStatuses: [{ name: entry.id, ready: true, imageID: `example.invalid/enrollment@${digest}` }] } }];
  return { app, job, pods, workloadPods, entry, selection, bundle, verifier, now: Date.parse('2026-11-06T01:04:00Z') };
}

test('동일한 C/V·nonce·Job UID·operation·실행 digest의 종료 성공만 stage 성공이다', () => {
  const input = stage(), result = evaluateStage(input);
  assert.equal(currentApplication(input.app, input.entry, input.selection), true);
  assert.equal(result.result, 'passed'); assert.equal(result.evidence.jobUid, input.job.metadata.uid);
  assert.equal(result.evidence.podUid, input.pods[0].metadata.uid);
  assert.equal(result.evidence.receiptSha256, sha256(input.pods[0].status.containerStatuses[0].state.terminated.message));
});

test('이전 V·retained Job·이전 UID·진행 중 operation과 다른 실제 imageID는 unknown이다', () => {
  for (const mutate of [
    value => value.app.status.sync.revisions[1] = '0'.repeat(40),
    value => value.app.status.operationState.syncResult.revisions = [C, '0'.repeat(40)],
    value => value.job.metadata.labels['pulsemetry.dev/operation-nonce'] = '0'.repeat(32),
    value => value.pods[0].metadata.ownerReferences[0].uid = 'old-job',
    value => value.job.status.startTime = '2026-11-06T00:59:59Z',
    value => value.app.operation = { sync: {} },
    value => value.app.status.operationState.phase = 'Running',
    value => value.workloadPods[0].status.containerStatuses[0].imageID = 'example.invalid/old@sha256:' + '0'.repeat(64),
    value => value.pods[0].spec.containers[0].image = 'example.invalid/untrusted@' + value.verifier.digest,
    value => value.pods[0].status.containerStatuses[0].imageID = 'example.invalid/untrusted@sha256:' + '0'.repeat(64),
    value => value.workloadPods.push(structuredClone(value.workloadPods[0])),
  ]) {
    const input = stage(); mutate(input); assert.equal(evaluateStage(input).result, 'unknown');
  }
});

test('deadline·잘린 receipt·의미 없는 exit는 Job 실패만으로 이미지 확정 실패가 되지 않는다', () => {
  for (const mutate of [
    value => value.pods[0].status.containerStatuses[0].state.terminated.exitCode = 137,
    value => value.pods[0].status.containerStatuses[0].state.terminated.message = '{"schemaVersion":',
    value => value.pods[0].status.containerStatuses[0].state.terminated.message += ' '.repeat(4096),
    value => delete value.pods[0].status.containerStatuses[0].state.terminated,
  ]) {
    const input = stage(); input.app.status.operationState.phase = 'Failed'; input.job.status = { ...input.job.status, failed: 1 };
    delete input.job.status.succeeded; mutate(input);
    assert.equal(evaluateStage(input).result, 'unknown');
  }
});


test('index digest의 PodSpec과 검증된 ARM64 child imageID를 구분한다', () => {
  const input = stage(), app = input.entry.id, child = `sha256:${'9'.repeat(64)}`;
  input.bundle.manifest.images[app].arm64ManifestDigest = child;
  input.bundle = validateManifest(json(input.bundle.manifest));
  input.selection.bundleManifestSha256 = input.bundle.B;
  const termination = input.pods[0].status.containerStatuses[0].state.terminated;
  const receipt = JSON.parse(termination.message); receipt.bundleManifestSha256 = input.bundle.B;
  termination.message = json(receipt);
  input.workloadPods[0].status.containerStatuses[0].imageID = `example.invalid/enrollment@${child}`;
  assert.notEqual(child, input.bundle.manifest.images[app].digest);
  assert.equal(evaluateStage(input).result, 'passed');
  input.workloadPods[0].status.containerStatuses[0].imageID = `example.invalid/enrollment@${input.bundle.manifest.images[app].digest}`;
  assert.equal(evaluateStage(input).result, 'unknown');
});

test('현재 operation의 명시적인 실패 receipt와 exit 1만 확정 실패다', () => {
  const input = stage(); input.app.status.operationState.phase = 'Failed';
  input.job.status.failed = 1; delete input.job.status.succeeded;
  const termination = input.pods[0].status.containerStatuses[0].state.terminated;
  const receipt = JSON.parse(termination.message); receipt.result = 'failed';
  termination.message = json(receipt); termination.exitCode = 1;
  assert.equal(evaluateStage(input).result, 'failed');
  termination.exitCode = 2; assert.equal(evaluateStage(input).result, 'unknown');
});

test('조회 장애가 관측 deadline까지 지속되면 failed가 아니라 unknown이다', async () => {
  let clock = 0, called = 0;
  const result = await observeDeployment({ client: { get: async () => { called++; throw new Error('simulated private API failure'); } },
    ...stage(), activation: { inventory: [] }, runtimeFingerprint: 'a'.repeat(64), fingerprints: async () => { throw new Error('must not reach'); },
    now: () => clock, timeoutMs: 10, intervalMs: 5, sleep: async ms => { clock += ms; } });
  assert.equal(result.result, 'unknown'); assert.equal(result.terminal, false);
  assert.equal(result.reason, 'observation_deadline'); assert.ok(called >= 18);
});

test('관측 역할 환경은 원래 AWS profile·web identity·임의 endpoint를 상속하지 않는다', () => {
  const env = credentialEnv({ AccessKeyId: 'synthetic-access-key', SecretAccessKey: 'synthetic-secret', SessionToken: 'synthetic-session',
    Expiration: new Date(Date.now() + 300_000).toISOString() }, { PATH: '/test/bin', AWS_PROFILE: 'operator', AWS_ENDPOINT_URL: 'https://untrusted.invalid',
    AWS_WEB_IDENTITY_TOKEN_FILE: '/tmp/untrusted', AWS_ROLE_ARN: 'untrusted', AWS_ACCESS_KEY_ID: 'previous', AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://untrusted.invalid' });
  for (const key of ['AWS_PROFILE', 'AWS_ENDPOINT_URL', 'AWS_WEB_IDENTITY_TOKEN_FILE', 'AWS_ROLE_ARN', 'AWS_CONTAINER_CREDENTIALS_FULL_URI']) assert.equal(env[key], undefined);
  assert.equal(env.AWS_ACCESS_KEY_ID, 'synthetic-access-key'); assert.equal(env.AWS_CONFIG_FILE, '/dev/null');
  assert.equal(env.AWS_SHARED_CREDENTIALS_FILE, '/dev/null');
});
