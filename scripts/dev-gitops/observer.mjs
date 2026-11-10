// Argo Application만 읽는다. workload·Job·DB·Secret 관측이나 변경 경로는 없다.
import { request } from 'node:https';
import { CATALOG } from '../dev-argocd-applications.mjs';
import { runAws, startSsmTunnel } from '../dev-generated-values-inputs.mjs';
import { SHA, assert, parse } from './contract.mjs';

const noPending = app => !app?.operation && (!app?.status?.operationState ||
  ['Succeeded', 'Failed', 'Error'].includes(app.status.operationState.phase));
const completed = app => noPending(app) && ['Succeeded', 'Failed', 'Error'].includes(app?.status?.operationState?.phase) &&
  Number.isFinite(Date.parse(app.status.operationState.startedAt)) && Number.isFinite(Date.parse(app.status.operationState.finishedAt)) &&
  Date.parse(app.status.operationState.finishedAt) >= Date.parse(app.status.operationState.startedAt);
const expectedRevisions = (entry, selection) => entry.generatedFile ? [selection.infraCommit, selection.valuesCommit] : [selection.infraCommit];
const equal = (a, b) => Array.isArray(a) && a.length === b.length && a.every((value, index) => value === b[index]);
function revisions(status) { return status?.revisions ?? (status?.revision ? [status.revision] : []); }
function operationEvidence(operation, single = false) {
  if (!operation) return {};
  const evidence = {};
  if (['Succeeded', 'Failed', 'Error'].includes(operation.phase)) evidence.phase = operation.phase;
  for (const key of ['startedAt', 'finishedAt']) if (Number.isFinite(Date.parse(operation[key]))) evidence[key] = operation[key];
  const values = revisions(operation.syncResult);
  if (values.length >= 1 && values.length <= (single ? 1 : 2) && values.every(revision => SHA.test(revision))) {
    if (single) evidence.operationRevision = values[0]; else evidence.operationRevisions = values;
  }
  return evidence;
}
export function currentApplication(app, entry, selection) {
  const wanted = expectedRevisions(entry, selection);
  return app?.metadata?.name === entry.name && equal(app.spec?.sources?.map(source => source.targetRevision), wanted) &&
    equal(app.status?.sync?.comparedTo?.sources?.map(source => source.targetRevision), wanted) && equal(revisions(app.status?.sync), wanted);
}
export function evaluateStage({ app, entry, selection }) {
  const result = { result: 'unknown', reason: 'stage_incomplete' };
  if (!currentApplication(app, entry, selection) || !noPending(app) || !app.metadata.uid) return result;
  const operation = app.status.operationState;
  // 같은 manifest인 새 V나 최초 인수에는 sync가 없을 수 있다. 실패에만 현재 operation 귀속을 요구한다.
  const currentFailure = ['Failed', 'Error'].includes(operation?.phase) &&
    equal(revisions(operation.syncResult), expectedRevisions(entry, selection));
  if (currentFailure && !completed(app)) return result;
  const classification = currentFailure ? 'failed' :
    app.status.sync.status === 'Synced' && app.status.health?.status === 'Healthy' ? 'passed' : 'unknown';
  if (classification === 'unknown') return result;
  return { result: classification, reason: classification === 'failed' ? 'argo_operation_failed' : 'argo_stage_ready',
    evidence: { id: entry.id, uid: app.metadata.uid, result: classification, revisions: revisions(app.status.sync),
      ...operationEvidence(operation) } };
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
  const allowedPaths = new Set([...CATALOG.applications.map(entry => entry.name), 'pulsemetry-dev-root']
    .map(name => `/apis/argoproj.io/v1alpha1/namespaces/argocd/applications/${name}`));
  async function get(path) {
    assert(allowedPaths.has(path), '관측 API 경로 오류');
    if (Date.now() > expiration - 60_000) {
      const value = await runAws(['eks', 'get-token', '--cluster-name', 'soma-376-dev-eks'], { env: observerEnv });
      token = value.status?.token; expiration = Date.parse(value.status?.expirationTimestamp);
      assert(typeof token === 'string' && expiration > Date.now(), 'EKS 인증 토큰 오류');
    }
    return new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: tunnel.port, servername: endpoint.hostname,
        ca: Buffer.from(cluster.certificateAuthority.data, 'base64'), rejectUnauthorized: true,
        method: 'GET', path, headers: { Host: endpoint.hostname, Authorization: `Bearer ${token}`,
          Accept: 'application/json' }, timeout: 15_000 }, response => {
        let body = '', size = 0;
        response.on('data', chunk => { size += chunk.length; if (size > 2 * 1024 * 1024) req.destroy(); else body += chunk; });
        response.on('end', () => {
          if (response.statusCode !== 200) return reject(new Error('Kubernetes 읽기 응답 오류'));
          try {
            const value = parse(body, 'Kubernetes 응답');
            resolve(value);
          } catch { reject(new Error('Kubernetes 응답 형식 오류')); }
        });
      });
      req.on('timeout', () => req.destroy()); req.on('error', () => reject(new Error('Kubernetes TLS 읽기 실패'))); req.end();
    });
  }
  return { get, close: tunnel.close };
}
export async function observeDeployment({ client, selection,
  rootRevisionContainsSelection = async () => false,
  timeoutMs = 20 * 60_000, intervalMs = 5_000, now = () => Date.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const start = now();
  while (now() - start < timeoutMs) {
    try {
      const applications = await Promise.all(CATALOG.applications.map(entry => client.get(`/apis/argoproj.io/v1alpha1/namespaces/argocd/applications/${entry.name}`)));
      const parent = await client.get('/apis/argoproj.io/v1alpha1/namespaces/argocd/applications/pulsemetry-dev-root');
      const outcomes = applications.map((app, index) => evaluateStage({ app, entry: CATALOG.applications[index], selection }));
      const terminal = applications.every(noPending) && noPending(parent);
      const rootRevision = parent.status?.sync?.revision;
      const rootCurrent = parent.metadata?.name === 'pulsemetry-dev-root' && parent.metadata.uid &&
        parent.spec?.source?.repoURL === 'https://github.com/soma-376/infra-generated-values.git' &&
        parent.spec.source.targetRevision === 'main' && parent.spec.source.path === 'dev/applications' &&
        parent.status?.sync?.comparedTo?.source?.repoURL === parent.spec.source.repoURL &&
        parent.status.sync.comparedTo.source.targetRevision === 'main' &&
        parent.status.sync.comparedTo.source.path === 'dev/applications' && SHA.test(rootRevision) &&
        await rootRevisionContainsSelection(rootRevision, selection.desiredCommit);
      if (terminal && rootCurrent) {
        const operation = parent.status.operationState;
        const operationRevision = operation?.syncResult?.revision;
        // main의 bind/fence/evidence commit은 root manifest를 바꾸지 않아 마지막 operation이 P에 남을 수 있다.
        const failureCurrent = ['Failed', 'Error'].includes(operation?.phase) && SHA.test(operationRevision) &&
          (operationRevision === rootRevision || await rootRevisionContainsSelection(operationRevision, selection.desiredCommit));
        const rootResult = failureCurrent ? (completed(parent) ? 'failed' : 'unknown') :
          parent.status.sync.status === 'Synced' && parent.status.health?.status === 'Healthy' ? 'passed' : 'unknown';
        const evidence = { observedAt: new Date(now()).toISOString(),
          applications: outcomes.flatMap(outcome => outcome.evidence ? [outcome.evidence] : []),
          root: { uid: parent.metadata.uid, revision: rootRevision, result: rootResult, ...operationEvidence(operation, true) } };
        if (rootResult === 'failed' || outcomes.some(outcome => outcome.result === 'failed')) {
          return { result: 'failed', terminal, reason: 'argo_operation_failed', ...evidence };
        }
        if (rootResult === 'passed' && outcomes.every(outcome => outcome.result === 'passed')) {
          return { result: 'passed', terminal, reason: 'argo_release_ready', ...evidence };
        }
      }
    } catch { /* 네트워크/인증/조회 실패를 Argo의 확정 실패로 바꾸지 않는다. */ }
    await sleep(intervalMs);
  }
  return { result: 'unknown', terminal: false, reason: 'observation_deadline', observedAt: new Date(now()).toISOString(), applications: [] };
}
