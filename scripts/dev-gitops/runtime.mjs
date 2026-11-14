import { openObserver, observeDeployment } from './observer.mjs';
import { SHA, assert } from './contract.mjs';

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
        run.path?.split('@')[0] === '.github/workflows/deploy_dev.yml', '현재 API와 원본 생산 증거 불일치');
      // attempt의 created_at은 재시도마다 달라진다. 최신성·실패 fence에는 원본 run 시각만 쓴다.
      assert(Number.isSafeInteger(currentRun.id) && currentRun.id > 0 && currentRun.id === run.id &&
        currentRun.head_sha === run.head_sha && currentRun.workflow_id === run.workflow_id &&
        currentRun.event === run.event && currentRun.head_branch === run.head_branch &&
        currentRun.repository?.full_name === run.repository.full_name &&
        currentRun.head_repository?.full_name === run.head_repository.full_name &&
        currentRun.path?.split('@')[0] === run.path.split('@')[0] &&
        typeof currentRun.created_at === 'string' && Number.isFinite(Date.parse(currentRun.created_at)) &&
        currentRun.created_at === provenance.createdAt, '원본 run과 attempt의 출처·생성 시각 불일치');
      const workflow = await github('actions/workflows/deploy_dev.yml', env);
      assert(run.workflow_id === workflow.id, '허용한 생산 workflow ID 불일치');
      const current = await github('commits/develop', env);
      const ancestry = await github(`compare/${run.head_sha}...${current.sha}`, env);
      assert(['ahead', 'identical'].includes(ancestry.status), '현재 develop 이력에서 벗어난 생산 실행');
      // event가 오래 대기했을 때 이미 완료된 후속 정상 묶음을 역행시키지 않는다.
      const latest = await github('actions/workflows/deploy_dev.yml/runs?branch=develop&status=success&per_page=100', env);
      const newer = latest.workflow_runs?.some(item => ['push', 'workflow_dispatch'].includes(item.event) &&
        item.head_repository?.full_name === 'soma-376/pulsemetry-backend' &&
        (Date.parse(item.created_at) > Date.parse(currentRun.created_at) ||
          (item.created_at === currentRun.created_at && item.id > currentRun.id)));
      if (newer) { const error = new Error('더 새로운 성공 생산 실행이 있다'); error.code = 'candidate_superseded'; throw error; }
    },
  };
}

export async function rootRevisionContainsSelection(store, revision, P) {
  if (!store || !SHA.test(revision) || !SHA.test(P)) return false;
  await store.refresh();
  if (await store.git(['merge-base', P, revision]) !== P) return false;
  // 상태 전용 후속 commit은 허용하되 다른 desired/Application 선언은 현재 P의 결과로 인정하지 않는다.
  // 조회 장애는 false로 숨기지 않아 과거 실패로 오인한 성공 판정을 막는다.
  return await store.git(['diff', '--name-only', P, revision, '--', 'dev/desired.yaml', 'dev/applications']) === '';
}

export async function runtimeObservers(activation, { env = process.env, store } = {}) {
  const client = await openObserver(activation.observer, { env });
  return {
    observe: input => observeDeployment({ ...input, client,
      rootRevisionContainsSelection: (revision, P) => rootRevisionContainsSelection(store, revision, P) }),
    close: client.close,
  };
}
