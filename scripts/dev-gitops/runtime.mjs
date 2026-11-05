import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAws, startSsmTunnel, METADATA_ACCEPT } from '../dev-generated-values-inputs.mjs';
import { credentialEnv, openObserver, observeDeployment } from './observer.mjs';
import { CATALOG } from '../dev-argocd-applications.mjs';
import { APPS, SHA, HASH, FINGERPRINTS, assert, json, parse } from './contract.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
async function github(path, env) {
  const response = await fetch(`https://api.github.com/repos/soma-376/pulsemetry-backend/${path}`, {
    headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    signal: AbortSignal.timeout(30_000), redirect: 'error',
  });
  assert(response.ok, '원본 생산 실행 API 검증 실패');
  return response.json();
}
export function producerChecks(env = process.env) {
  assert(env.GH_TOKEN, '원본 실행 읽기 token이 필요하다');
  return {
    isDescendant: async (base, head) => (await github(`compare/${base}...${head}`, env)).status === 'ahead',
    revalidateCandidate: async (bundle, provenance) => {
      const run = await github(`actions/runs/${provenance.workflowRunId}/attempts/${provenance.workflowRunAttempt}`, env);
      const currentRun = await github(`actions/runs/${provenance.workflowRunId}`, env);
      assert(currentRun.status === 'completed' && currentRun.conclusion === 'success' && String(currentRun.run_attempt) === provenance.workflowRunAttempt,
        '새 attempt가 시작된 과거 완료 묶음은 재사용하지 않는다');
      assert(run.status === 'completed' && run.conclusion === 'success' && run.head_sha === bundle.manifest.backendCommit &&
        String(run.id) === provenance.workflowRunId && String(run.run_attempt) === provenance.workflowRunAttempt &&
        run.head_branch === 'develop' && ['push', 'workflow_dispatch'].includes(run.event) &&
        run.repository?.full_name === 'soma-376/pulsemetry-backend' && run.head_repository?.full_name === 'soma-376/pulsemetry-backend' &&
        run.path?.split('@')[0] === '.github/workflows/deploy_dev.yml' && run.created_at === provenance.createdAt, '현재 API와 원본 생산 증거 불일치');
      const workflow = await github('actions/workflows/deploy_dev.yml', env);
      assert(run.workflow_id === workflow.id, '허용한 생산 workflow ID 불일치');
      const current = await github('commits/develop', env);
      const ancestry = await github(`compare/${run.head_sha}...${current.sha}`, env);
      assert(['ahead', 'identical'].includes(ancestry.status), '현재 develop 이력에서 벗어난 생산 실행');
      // event가 오래 대기했을 때 이미 완료된 후속 정상 묶음을 역행시키지 않는다.
      const latest = await github('actions/workflows/deploy_dev.yml/runs?branch=develop&status=success&per_page=100', env);
      const newer = latest.workflow_runs?.some(item => ['push', 'workflow_dispatch'].includes(item.event) &&
        item.head_repository?.full_name === 'soma-376/pulsemetry-backend' && Date.parse(item.created_at) > Date.parse(run.created_at));
      if (newer) { const error = new Error('더 새로운 성공 생산 실행이 있다'); error.code = 'candidate_superseded'; throw error; }
    },
  };
}

// Python 검증기는 runner에서도 같은 실제 schema/runtime/key 알고리즘을 쓴다.
// 로컬 hop만 HTTP이며 EKS hop은 openObserver가 원래 hostname·CA로 TLS를 검증한다.
export async function readonlyProxy(client) {
  const server = createServer(async (req, res) => {
    if (req.method !== 'GET' || req.headers.authorization) { res.writeHead(403).end(); return; }
    try {
      const metadata = req.headers.accept === METADATA_ACCEPT;
      const result = await client.get(req.url, metadata);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
    } catch { res.writeHead(503).end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}
export async function actualFingerprints({ client, activation, bundle, env = process.env }) {
  const cfg = activation.databaseObserver;
  assert(/^arn:aws:iam::\d{12}:role\/soma-376-dev-delivery-db-reader$/.test(cfg?.roleArn) && /^i-[a-f0-9]{8,17}$/.test(cfg.relayInstanceId), '전용 DB 관측 identity가 필요하다');
  assert(cfg.probeSecretName === 'pulsemetry/dev/deployment-verifier-db-reader' && /^[a-zA-Z0-9-]{32,64}$/.test(cfg.probeSecretVersionId) &&
    /^gitops-[a-zA-Z0-9_-]{1,200}$/.test(cfg.probeSecretVersionStage), '고정 DB reader Secret version stage가 필요하다');
  assert(/^[a-z0-9.-]+\.rds\.amazonaws\.com$/.test(cfg.postgres?.host) && cfg.postgres.database === 'controlplane', '고정 dev PostgreSQL 입력 오류');
  assert(['require', 'verify-full'].includes(cfg.postgres.sslmode), 'DB TLS를 유지해야 한다');
  const assumed = await runAws(['sts', 'assume-role', '--role-arn', cfg.roleArn, '--role-session-name', 'dev-gitops-db-reader', '--duration-seconds', '3600'], { env });
  const dbEnv = credentialEnv(assumed.Credentials, env);
  async function checkVersion() {
    const description = await runAws(['secretsmanager', 'describe-secret', '--secret-id', cfg.probeSecretName], { env: dbEnv });
    assert(description.VersionIdsToStages?.[cfg.probeSecretVersionId]?.includes(cfg.probeSecretVersionStage), 'DB reader 고정 version stage 변경');
  }
  await checkVersion();
  const pods = await client.get(`/api/v1/namespaces/pulsemetry-dev/pods?labelSelector=${encodeURIComponent('app.kubernetes.io/name=clickhouse')}`);
  const ready = (pods.items ?? []).filter(pod => !pod.metadata.deletionTimestamp && pod.status?.phase === 'Running' &&
    pod.status?.conditions?.some(condition => condition.type === 'Ready' && condition.status === 'True'));
  assert(ready.length === 1 && /^10\.1\.\d{1,3}\.\d{1,3}$/.test(ready[0].status.podIP), '현재 Ready ClickHouse Pod 하나가 필요하다');
  const directory = await mkdtemp(join(tmpdir(), 'delivery-snapshot-'));
  let pg, ch, proxy;
  try {
    pg = await startSsmTunnel({ instanceId: cfg.relayInstanceId, documentName: 'soma-376-dev-db-postgres-tunnel', env: dbEnv });
    ch = await startSsmTunnel({ instanceId: cfg.relayInstanceId, documentName: 'soma-376-dev-db-clickhouse-tunnel', remoteHost: ready[0].status.podIP, env: dbEnv });
    proxy = await readonlyProxy(client);
    const config = { postgres: { ...cfg.postgres, hostaddr: '127.0.0.1', port: pg.port },
      clickhouse: { origin: `http://127.0.0.1:${ch.port}`, database: cfg.clickhouse?.database } };
    assert(/^[a-z][a-z0-9_]{0,62}$/.test(config.clickhouse.database), 'ClickHouse DB 입력 오류');
    await writeFile(join(directory, 'config.json'), json(config), { mode: 0o600 });
    const contract = bundle.manifest.deploymentContracts[APPS[0]].content;
    await writeFile(join(directory, 'contract.json'), contract, { mode: 0o600 });
    // resolver endpoint·Python 경로를 candidate/activation 입력이 바꿀 수 없게 고정한다.
    const childEnv = { PATH: env.PATH, LANG: 'C.UTF-8', HOME: directory,
      ...Object.fromEntries(Object.entries(dbEnv).filter(([key]) => /^AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|REGION|DEFAULT_REGION|CONFIG_FILE|SHARED_CREDENTIALS_FILE|EC2_METADATA_DISABLED)$/.test(key))),
      VERIFIER_KUBERNETES_PROXY_URL: proxy.url,
      DELIVERY_PROBE_CREDENTIAL_JSON: `{{resolve:secretsmanager:${cfg.probeSecretName}:SecretString::${cfg.probeSecretVersionStage}}}` };
    const output = await new Promise((resolve, reject) => execFile('python3', [join(root, 'scripts/dev-gitops/vendor/asm-exec'), '--', 'python3',
      join(root, 'scripts/deployment-verifier/snapshot.py'), '--config', join(directory, 'config.json'),
      '--contract', join(directory, 'contract.json'), '--all-fingerprints'],
    { env: childEnv, timeout: 180_000, maxBuffer: 4096, encoding: 'utf8' }, (error, stdout) => error ? reject(new Error('실제 DB/배포 지문 관측 불가')) : resolve(stdout)));
    const result = parse(output, '실제 지문');
    for (const key of FINGERPRINTS) assert(HASH.test(result[key]), '실제 지문 응답 오류');
    await checkVersion();
    return result;
  } finally {
    await proxy?.close(); await ch?.close(); await pg?.close(); await rm(directory, { recursive: true, force: true });
  }
}
export async function runtimeObservers(activation, { env = process.env, store } = {}) {
  const client = await openObserver(activation.observer, { env });
  const terminal = async () => {
    const apps = await Promise.all([...CATALOG.applications.map(entry => entry.name), 'pulsemetry-dev-root']
      .map(name => client.get(`/apis/argoproj.io/v1alpha1/namespaces/argocd/applications/${name}`)));
    return apps.every(app => !app.operation && !['Running', 'Terminating'].includes(app.status?.operationState?.phase));
  };
  return {
    observe: input => observeDeployment({ ...input, client,
      rootRevisionContainsSelection: async (revision, P) => {
        if (!store || !SHA.test(revision) || !SHA.test(P)) return false;
        try { await store.refresh(); await store.git(['merge-base', '--is-ancestor', P, revision]); return true; } catch { return false; }
      },
      fingerprints: () => actualFingerprints({ ...input, client, env }) }),
    compatibility: async input => {
      if (!await terminal()) return { terminal: false };
      const fingerprints = await actualFingerprints({ ...input, client, env });
      return { terminal: await terminal(), fingerprints };
    },
    close: client.close,
  };
}
