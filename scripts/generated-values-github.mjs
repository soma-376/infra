// API 응답·자격 원문은 오류에 포함하지 않는다. workflow별 최소 권한 token을 호출자가 공급한다.
export function githubClient(token) {
  if (!token) throw new Error('GitHub 조회 자격 누락');
  return async (path) => {
    if (!path.startsWith('/repos/soma-376/')) throw new Error('GitHub 조회 경로 오류');
    try {
      const response = await fetch(`https://api.github.com${path}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
        signal: AbortSignal.timeout(30_000), redirect: 'error',
      });
      if (!response.ok) throw new Error();
      return await response.json();
    } catch { throw new Error('GitHub 증거 조회 실패'); }
  };
}

export async function verifyPublicationEvidence({ receipt, receiptArtifactId, github, now = Date.now() }) {
  const base = '/repos/soma-376/infra/actions';
  const run = await github(`${base}/runs/${receipt.runId}/attempts/${receipt.runAttempt}`);
  if (String(run.id) !== receipt.runId || String(run.run_attempt) !== receipt.runAttempt ||
      run.head_sha !== receipt.sourceSha || run.head_branch !== 'develop' || !['in_progress', 'completed'].includes(run.status) ||
      run.event !== receipt.event || run.path !== '.github/workflows/dev-cdk-deploy.yml') {
    throw new Error('원본 승인·배포 실행 식별자 불일치');
  }
  // publisher 실패 때문에 workflow 전체가 실패할 수 있다. 원본 attempt의 두 job만 성공을 요구한다.
  const jobs = [];
  let total;
  for (let page = 1; ; page++) {
    const data = await github(`${base}/runs/${receipt.runId}/attempts/${receipt.runAttempt}/jobs?per_page=100&page=${page}`);
    if (!Array.isArray(data.jobs) || !Number.isSafeInteger(data.total_count) || data.total_count < 2 || data.total_count > 1000) throw new Error('원본 job 증거 오류');
    if (total === undefined) total = data.total_count;
    if (total !== data.total_count) throw new Error('원본 job 목록 변경');
    jobs.push(...data.jobs);
    if (jobs.length > total || jobs.some(job => !Number.isSafeInteger(job.id) || job.id < 1) ||
        new Set(jobs.map(job => job.id)).size !== jobs.length) throw new Error('원본 job 목록 중복·식별자 오류');
    if (jobs.length === total) break;
    if (!data.jobs.length || page >= 100) throw new Error('원본 job 목록 불완전');
  }
  for (const name of ['plan', 'deploy']) {
    const matches = jobs.filter(job => job.name === name);
    if (matches.length !== 1 || matches[0].status !== 'completed' || matches[0].conclusion !== 'success' ||
        String(matches[0].run_id) !== receipt.runId || String(matches[0].run_attempt) !== receipt.runAttempt ||
        matches[0].head_sha !== receipt.sourceSha) throw new Error(`원본 ${name} job 성공 증거 오류`);
  }
  for (const [id, prefix] of [[receipt.planArtifactId, 'dev-cdk-plan'], [receiptArtifactId, 'dev-cdk-receipt']]) {
    const artifact = await github(`${base}/artifacts/${id}`);
    if (String(artifact.id) !== id || artifact.expired !== false || !Number.isFinite(Date.parse(artifact.expires_at)) ||
        Date.parse(artifact.expires_at) <= now || artifact.name !== `${prefix}-${receipt.runId}-${receipt.runAttempt}` ||
        String(artifact.workflow_run?.id) !== receipt.runId || artifact.workflow_run?.head_sha !== receipt.sourceSha) {
      throw new Error('원본 artifact 누락·만료·출처 불일치');
    }
  }
}
