// EKS 관측만 수행한다. apply/sync/exec/port-forward 및 Secret 원문 조회 경로는 없다.
import { request } from 'node:https';
import { CATALOG } from '../dev-argocd-applications.mjs';
import { runAws, startSsmTunnel, METADATA_ACCEPT } from '../dev-generated-values-inputs.mjs';
import { APPS, FINGERPRINTS, HASH, assert, classifyReceipt, json, parse, sha256 } from './contract.mjs';

const noPending = app => !app.operation && !['Running', 'Terminating'].includes(app.status?.operationState?.phase);
const expectedRevisions = (entry, selection) => entry.generatedFile ? [selection.infraCommit, selection.valuesCommit] : [selection.infraCommit];
const equal = (a, b) => Array.isArray(a) && a.length === b.length && a.every((value, index) => value === b[index]);
function revisions(status) { return status?.revisions ?? (status?.revision ? [status.revision] : []); }
export function currentApplication(app, entry, selection) {
  const wanted = expectedRevisions(entry, selection);
  return app.metadata?.name === entry.name && equal(app.spec?.sources?.map(source => source.targetRevision), wanted) &&
    equal(app.status?.sync?.comparedTo?.sources?.map(source => source.targetRevision), wanted) && equal(revisions(app.status?.sync), wanted);
}
export function evaluateStage({ app, job, pods, workloadPods, entry, selection, bundle, verifier, now = Date.now() }) {
  const expected = { operationNonce: selection.operationNonce, stage: entry.id, infraCommit: selection.infraCommit,
    bundleManifestSha256: bundle.B, imageDigest: bundle.manifest.images[entry.id].digest,
    contractSha256: bundle.manifest.deploymentContracts[entry.id].sha256 };
  const result = { result: 'unknown', reason: 'stage_incomplete' };
  if (!currentApplication(app, entry, selection) || !noPending(app)) return result;
  const operation = app.status?.operationState;
  if (!equal(revisions(operation?.syncResult), expectedRevisions(entry, selection))) return result;
  if (job?.metadata?.labels?.['pulsemetry.dev/operation-nonce'] !== selection.operationNonce ||
      !job.metadata.uid || !job.status?.startTime || !operation.startedAt ||
      Date.parse(job.status.startTime) < Date.parse(operation.startedAt)) return result;
  const owned = pods.filter(pod => pod.metadata?.ownerReferences?.some(owner => owner.kind === 'Job' && owner.uid === job.metadata.uid));
  if (owned.length !== 1 || owned[0].metadata.labels?.['pulsemetry.dev/operation-nonce'] !== selection.operationNonce) return result;
  const pod = owned[0];
  const verifierStatus = pod.status?.containerStatuses?.find(container => container.name === 'verifier');
  if (!verifier || pod.spec?.containers?.find(container => container.name === 'verifier')?.image !== `${verifier.repository}@${verifier.digest}` ||
      !verifierStatus?.imageID?.endsWith(`@${verifier.arm64ManifestDigest}`)) return result;
  const terminated = verifierStatus.state?.terminated;
  if (!terminated || ![0, 1, 2].includes(terminated.exitCode) || typeof terminated.message !== 'string' || Buffer.byteLength(terminated.message) >= 4096) return result;
  let receipt;
  try { receipt = parse(terminated.message, '검증 receipt'); } catch { return result; }
  const classification = classifyReceipt(receipt, expected);
  if (Date.parse(receipt.checkedAt) < Date.parse(operation.startedAt) || Date.parse(receipt.checkedAt) > now + 60_000) return result;
  if ((classification === 'passed' && terminated.exitCode !== 0) || (classification === 'failed' && terminated.exitCode !== 1)) return result;
  if (classification === 'passed') {
    if (operation.phase !== 'Succeeded' || app.status?.sync?.status !== 'Synced' || app.status?.health?.status !== 'Healthy' || job.status.succeeded !== 1) return result;
    const running = workloadPods.filter(candidate => candidate.metadata?.deletionTimestamp === undefined && candidate.status?.phase === 'Running');
    if (running.length !== 1) return result;
    const containers = running[0].status?.containerStatuses ?? [];
    const workload = containers.find(container => container.name === entry.id && container.imageID?.endsWith(`@${bundle.manifest.images[entry.id].arm64ManifestDigest}`));
    if (!workload?.ready || running[0].spec?.containers?.find(container => container.name === workload.name)?.image?.split('@')[1] !== expected.imageDigest) return result;
  } else if (classification === 'failed' && (!['Failed', 'Error'].includes(operation.phase) || job.status.failed !== 1)) return result;
  return { result: classification, reason: classification === 'failed' ? 'verified_function_failure' : 'verified_stage', receipt,
    evidence: { id: entry.id, uid: app.metadata.uid, jobUid: job.metadata.uid, podUid: pod.metadata.uid,
      result: classification, receiptSha256: sha256(terminated.message), startedAt: operation.startedAt, finishedAt: operation.finishedAt } };
}
export function credentialEnv(credentials, base = process.env) {
  assert(credentials?.AccessKeyId && credentials.SecretAccessKey && credentials.SessionToken && Date.parse(credentials.Expiration) > Date.now() + 60_000, '관측 역할 임시 자격증명 오류');
  const env = { ...base };
  for (const key of Object.keys(env)) if (/^AWS_(PROFILE|DEFAULT_PROFILE|ROLE_|WEB_IDENTITY|CONTAINER_|ENDPOINT_URL|ACCESS_KEY|SECRET_ACCESS|SESSION_TOKEN)/.test(key)) delete env[key];
  return { ...env, AWS_CONFIG_FILE: '/dev/null', AWS_SHARED_CREDENTIALS_FILE: '/dev/null', AWS_ACCESS_KEY_ID: credentials.AccessKeyId,
    AWS_SECRET_ACCESS_KEY: credentials.SecretAccessKey, AWS_SESSION_TOKEN: credentials.SessionToken, AWS_REGION: 'ap-northeast-2', AWS_EC2_METADATA_DISABLED: 'true' };
}
export async function openObserver(config, { env = process.env } = {}) {
  assert(/^arn:aws:iam::\d{12}:role\/soma-376-dev-eks-delivery-observer$/.test(config?.roleArn), '전용 관측 역할만 허용한다');
  assert(/^i-[a-f0-9]{8,17}$/.test(config.relayInstanceId), 'EKS relay instance 오류');
  const assumed = await runAws(['sts', 'assume-role', '--role-arn', config.roleArn, '--role-session-name', 'dev-gitops-observer', '--duration-seconds', '3600'], { env });
  const observerEnv = credentialEnv(assumed.Credentials, env);
  const description = await runAws(['eks', 'describe-cluster', '--name', 'soma-376-dev-eks'], { env: observerEnv });
  const cluster = description.cluster;
  const endpoint = new URL(cluster.endpoint);
  assert(endpoint.protocol === 'https:' && endpoint.hostname.endsWith('.eks.amazonaws.com') && cluster.certificateAuthority?.data, 'EKS TLS endpoint 오류');
  const tunnel = await startSsmTunnel({ instanceId: config.relayInstanceId, documentName: 'soma-376-dev-eks-api-tunnel', env: observerEnv });
  let token, expiration = 0;
  async function get(path, metadata = false) {
    assert(path.startsWith('/apis/argoproj.io/v1alpha1/namespaces/argocd/applications/') ||
      path.startsWith('/apis/batch/v1/namespaces/pulsemetry-dev/jobs/') ||
      path.startsWith('/apis/apps/v1/namespaces/pulsemetry-dev/deployments/') ||
      path.startsWith('/apis/secrets-store.csi.x-k8s.io/v1/namespaces/pulsemetry-dev/secretproviderclasses/') ||
      path === '/apis/secrets-store.csi.x-k8s.io/v1/namespaces/pulsemetry-dev/secretproviderclasspodstatuses' ||
      path.startsWith('/api/v1/namespaces/pulsemetry-dev/pods?') ||
      path === '/api/v1/namespaces/pulsemetry-dev/pods' ||
      (metadata && /^\/api\/v1\/namespaces\/pulsemetry-dev\/secrets\/[a-z0-9-]+$/.test(path)), '관측 API 경로 오류');
    if (Date.now() > expiration - 60_000) {
      const value = await runAws(['eks', 'get-token', '--cluster-name', 'soma-376-dev-eks'], { env: observerEnv });
      token = value.status?.token; expiration = Date.parse(value.status?.expirationTimestamp);
      assert(typeof token === 'string' && expiration > Date.now(), 'EKS 인증 토큰 오류');
    }
    return new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: tunnel.port, servername: endpoint.hostname,
        ca: Buffer.from(cluster.certificateAuthority.data, 'base64'), rejectUnauthorized: true,
        method: 'GET', path, headers: { Host: endpoint.hostname, Authorization: `Bearer ${token}`,
          Accept: metadata ? METADATA_ACCEPT : 'application/json' }, timeout: 15_000 }, response => {
        let body = '', size = 0;
        response.on('data', chunk => { size += chunk.length; if (size > 2 * 1024 * 1024) req.destroy(); else body += chunk; });
        response.on('end', () => {
          if (response.statusCode !== 200) return reject(new Error('Kubernetes 읽기 응답 오류'));
          try {
            const value = parse(body, 'Kubernetes 응답');
            if (metadata) assert(value.kind === 'PartialObjectMetadata' && value.apiVersion === 'meta.k8s.io/v1' && !('data' in value) && !('stringData' in value), 'Secret metadata 전용 응답이 필요하다');
            resolve(value);
          } catch { reject(new Error('Kubernetes 응답 형식 오류')); }
        });
      });
      req.on('timeout', () => req.destroy()); req.on('error', () => reject(new Error('Kubernetes TLS 읽기 실패'))); req.end();
    });
  }
  return { get, close: tunnel.close };
}
export async function observeDeployment({ client, selection, bundle, activation, runtimeFingerprint, fingerprints,
  rootRevisionContainsSelection = async () => false,
  timeoutMs = 20 * 60_000, intervalMs = 5_000, now = () => Date.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const start = now();
  while (now() - start < timeoutMs) {
    try {
      const applications = await Promise.all(CATALOG.applications.map(entry => client.get(`/apis/argoproj.io/v1alpha1/namespaces/argocd/applications/${entry.name}`)));
      const parent = await client.get('/apis/argoproj.io/v1alpha1/namespaces/argocd/applications/pulsemetry-dev-root');
      const outcomes = [];
      for (const id of APPS) {
        const index = CATALOG.applications.findIndex(entry => entry.id === id), entry = CATALOG.applications[index];
        const release = activation.inventory.find(item => item.id === id)?.releaseName;
        assert(/^[a-z0-9-]{1,53}$/.test(release), '검증 release 이름 오류');
        const job = await client.get(`/apis/batch/v1/namespaces/pulsemetry-dev/jobs/${release}-verify`).catch(() => null);
        const pods = await client.get(`/api/v1/namespaces/pulsemetry-dev/pods?labelSelector=${encodeURIComponent(`job-name=${release}-verify`)}`);
        const workloadPods = await client.get(`/api/v1/namespaces/pulsemetry-dev/pods?labelSelector=${encodeURIComponent(`app.kubernetes.io/instance=${release},app.kubernetes.io/component!=deployment-verifier`)}`);
        outcomes.push(evaluateStage({ app: applications[index], job, pods: pods.items ?? [], workloadPods: workloadPods.items ?? [], entry, selection, bundle, verifier: activation.verifier, now: now() }));
      }
      const terminal = applications.every(noPending) && noPending(parent);
      if (terminal && outcomes.some(outcome => outcome.result === 'failed')) return { result: 'failed', terminal, reason: 'verified_function_failure',
        observedAt: new Date(now()).toISOString(), applications: outcomes.flatMap(outcome => outcome.evidence ? [outcome.evidence] : []) };
      const ready = applications.every((app, index) => currentApplication(app, CATALOG.applications[index], selection) &&
        app.status?.sync?.status === 'Synced' && app.status?.health?.status === 'Healthy' && app.status?.operationState?.phase === 'Succeeded');
      const rootReady = parent.spec?.source?.repoURL === 'https://github.com/soma-376/infra-generated-values.git' &&
        parent.spec.source.targetRevision === 'main' && parent.spec.source.path === 'dev/applications' &&
        parent.status?.sync?.comparedTo?.source?.repoURL === parent.spec.source.repoURL &&
        parent.status.sync.comparedTo.source.targetRevision === 'main' && parent.status.sync.comparedTo.source.path === 'dev/applications' &&
        parent.status?.sync?.status === 'Synced' && parent.status?.health?.status === 'Healthy' && parent.status?.operationState?.phase === 'Succeeded';
      if (terminal && rootReady && ready && outcomes.every(outcome => outcome.result === 'passed') &&
        await rootRevisionContainsSelection(parent.status.sync.revision, selection.desiredCommit)) {
        const actual = await fingerprints();
        for (const key of FINGERPRINTS) assert(HASH.test(actual[key]), '관측 fingerprint 누락');
        return { result: 'passed', terminal, reason: 'verified_release', observedAt: new Date(now()).toISOString(),
          fingerprints: actual, applications: outcomes.map(outcome => outcome.evidence), root: { uid: parent.metadata.uid,
            revision: parent.status.sync.revision, startedAt: parent.status.operationState.startedAt, finishedAt: parent.status.operationState.finishedAt } };
      }
    } catch { /* 네트워크/인증/조회 실패를 앱의 확정 실패로 바꾸지 않는다. */ }
    await sleep(intervalMs);
  }
  return { result: 'unknown', terminal: false, reason: 'observation_deadline', observedAt: new Date(now()).toISOString(), applications: [] };
}
