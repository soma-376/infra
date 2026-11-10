import { createHash } from 'node:crypto';

export const BACKEND_REPOSITORY = 'soma-376/pulsemetry-backend';
export const BACKEND_WORKFLOW = '.github/workflows/deploy_dev.yml';
export const BACKEND_APPS = ['enrollment-api', 'telemetry-ingest', 'dashboard-api', 'telemetry-gateway'];
const BUILD_ACTION = '10e90e3645eae34f1e60eeb005ba3a3d33f178e8';
const PREFIX = `/repos/${BACKEND_REPOSITORY}/actions`;
const HASH = /^[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ID = /^[1-9]\d*$/;
const fail = message => { throw new Error(`backend 이미지 입력: ${message}`); };
const same = (actual, expected, label) => { if (actual !== expected) fail(`${label} 불일치`); };
const hash = value => createHash('sha256').update(value).digest('hex');

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join('|') !== [...expected].sort().join('|')) fail(`${label} 필드 오류`);
}
function identifier(value, label) {
  if (!(typeof value === 'string' && ID.test(value)) && !(Number.isSafeInteger(value) && value > 0)) fail(`${label} 오류`);
  return String(value);
}
function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) || !Number.isFinite(Date.parse(value))) fail('run 생성 시각 오류');
  return value;
}

// 승인 artifact에는 원문 로그, registry URI, 계정, actor, endpoint를 복제하지 않는다.
export function validateBackendImageInputs(value) {
  exactKeys(value, ['schemaVersion', 'repository', 'workflow', 'sourceSha', 'runId', 'runAttempt', 'jobId', 'createdAt', 'logSha256', 'images'], '승인 입력');
  same(value.schemaVersion, 1, 'schema');
  same(value.repository, BACKEND_REPOSITORY, 'repository');
  same(value.workflow, BACKEND_WORKFLOW, 'workflow');
  if (!SHA.test(value.sourceSha ?? '') || !HASH.test(value.logSha256 ?? '')) fail('SHA 또는 로그 hash 오류');
  for (const key of ['runId', 'runAttempt', 'jobId']) {
    if (typeof value[key] !== 'string') fail(`${key} 형식 오류`);
    identifier(value[key], key);
  }
  timestamp(value.createdAt);
  exactKeys(value.images, BACKEND_APPS, '네 앱');
  for (const app of BACKEND_APPS) {
    exactKeys(value.images[app], ['digest', 'platform'], `${app} 이미지`);
    if (!DIGEST.test(value.images[app].digest ?? '')) fail(`${app} digest 오류`);
    same(value.images[app].platform, 'linux/arm64', `${app} platform`);
  }
  return value;
}

function validateRun(run) {
  identifier(run?.id, 'run ID'); identifier(run?.run_attempt, 'run attempt');
  identifier(run?.workflow_id, 'workflow ID');
  same(run?.repository?.full_name, BACKEND_REPOSITORY, 'run repository');
  same(run?.head_repository?.full_name, BACKEND_REPOSITORY, 'head repository');
  same(run?.head_branch, 'develop', 'run branch');
  same(run?.path, BACKEND_WORKFLOW, 'run workflow');
  same(run?.status, 'completed', 'run status');
  same(run?.conclusion, 'success', 'run conclusion');
  if (!['push', 'workflow_dispatch'].includes(run?.event)) fail('run 이벤트 오류');
  if (!SHA.test(run?.head_sha ?? '')) fail('run SHA 오류');
  timestamp(run.created_at);
  return run;
}

async function pages(github, endpoint, key) {
  const items = [], ids = new Set();
  let total;
  for (let page = 1; page <= 10; page++) {
    const response = await github(`${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    if (!Number.isSafeInteger(response?.total_count) || response.total_count < 0 || response.total_count > 1000 || !Array.isArray(response[key])) fail('GitHub 목록 응답 범위 오류');
    if (total === undefined) total = response.total_count;
    same(response.total_count, total, '조회 중 목록 크기');
    if (response[key].length > 100 || (response[key].length === 0 && items.length < total)) fail('GitHub 목록 누락');
    for (const item of response[key]) {
      const id = identifier(item?.id, '목록 ID');
      if (ids.has(id)) fail('GitHub 목록 중복');
      ids.add(id); items.push(item);
    }
    if (items.length === total) return items;
    if (items.length > total || response[key].length < 100) fail('GitHub 목록 개수 불일치');
  }
  fail('GitHub 목록 pagination 한도');
}

function group(block, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const groups = [...block.matchAll(new RegExp(`^##\\[group\\]${escaped}\\n([\\s\\S]*?)^##\\[endgroup\\]$`, 'gm'))];
  if (groups.length !== 1) fail(`${name} 로그 누락 또는 중복`);
  return groups[0][1].trim();
}
function input(block, key) {
  const values = [...block.matchAll(new RegExp(`^  ${key}: (.+)$`, 'gm'))].map(match => match[1]);
  if (values.length !== 1) fail(`${key} build 입력 누락 또는 중복`);
  return values[0];
}
function imageTag(value, { accountId, sourceSha, app }) {
  // 기존 workflow의 region·repository Secret은 로그에서 ***로 마스킹된다.
  // 그 경우 앱 경계는 build target과 Buildx provenance의 target으로 검증한다.
  if (typeof value !== 'string') fail(`${app} image tag 누락`);
  const match = /^(\d{12})\.dkr\.ecr\.(ap-northeast-2|\*\*\*)\.amazonaws\.com\/(soma-376\/[a-z-]+|\*\*\*):sha-([a-f0-9]{40})$/.exec(value);
  if (!match) fail(`${app} ECR SHA tag 형식 오류`);
  same(match[1], accountId, `${app} image account`);
  same(match[4], sourceSha, `${app} image SHA`);
  if (match[3] !== '***') same(match[3], `soma-376/${app}`, `${app} image repository`);
}

export function parseBackendImageLog(log, { accountId, sourceSha, runId, runAttempt, apps = BACKEND_APPS }) {
  if (typeof log !== 'string' || !log || Buffer.byteLength(log) > 32 * 1024 * 1024) fail('로그 누락 또는 크기 초과');
  if (!/^\d{12}$/.test(accountId ?? '') || !SHA.test(sourceSha ?? '')) fail('계정 또는 SHA 오류');
  // timestamp와 ANSI 색만 제거한다. 원문 hash는 정규화 이전 bytes를 사용한다.
  const normalized = log.replace(/\x1b\[[0-9;]*m/g, '').replace(/\r\n/g, '\n')
    .replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z /gm, '');
  const starts = [...normalized.matchAll(/^##\[group\]Run docker\/build-push-action@([^\n]+)$/gm)];
  if (starts.length !== BACKEND_APPS.length) fail('네 앱 build 로그 누락 또는 중복');
  const images = {};
  for (let i = 0; i < starts.length; i++) {
    same(starts[i][1], BUILD_ACTION, 'build action 버전');
    const block = normalized.slice(starts[i].index, starts[i + 1]?.index ?? normalized.length);
    const setupEnd = block.indexOf('##[endgroup]');
    if (setupEnd < 0) fail('build 입력 로그 잘림');
    const setup = block.slice(0, setupEnd), app = input(setup, 'target');
    if (!BACKEND_APPS.includes(app) || images[app]) fail('앱 target 누락 또는 중복');
    same(app, apps[i], 'job step과 build target 순서');
    same(input(setup, 'platforms'), 'linux/arm64', `${app} platform`);
    same(input(setup, 'push'), 'true', `${app} push`);
    same(input(setup, 'provenance'), 'false', `${app} provenance`);
    const tag = input(setup, 'tags');
    imageTag(tag, { accountId, sourceSha, app });
    const digest = group(block, 'Digest'), configDigest = group(block, 'ImageID');
    if (!DIGEST.test(digest) || !DIGEST.test(configDigest) || digest === configDigest) fail(`${app} manifest/config digest 오류`);
    let metadata;
    try { metadata = JSON.parse(group(block, 'Metadata')); } catch { fail(`${app} Metadata JSON 형식 오류`); }
    same(metadata['containerimage.digest'], digest, `${app} metadata digest`);
    same(metadata['containerimage.config.digest'], configDigest, `${app} config digest`);
    const descriptor = metadata['containerimage.descriptor'];
    same(descriptor?.digest, digest, `${app} descriptor digest`);
    if (!['application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'].includes(descriptor?.mediaType)) fail(`${app} 최종 image manifest 종류 오류`);
    same(descriptor?.platform?.os, 'linux', `${app} descriptor OS`);
    same(descriptor?.platform?.architecture, 'arm64', `${app} descriptor architecture`);
    if (descriptor.platform.variant !== undefined && descriptor.platform.variant !== 'v8') fail(`${app} descriptor variant 오류`);
    same(metadata['image.name'], tag, `${app} metadata image tag`);
    const invocation = metadata['buildx.build.provenance']?.invocation;
    same(invocation?.parameters?.args?.target, app, `${app} provenance target`);
    const source = invocation?.parameters?.root?.request?.args;
    same(source?.target, app, `${app} provenance root target`);
    same(source?.['vcs:revision'], sourceSha, `${app} provenance SHA`);
    same(source?.['vcs:source'], `https://github.com/${BACKEND_REPOSITORY}`, `${app} provenance source`);
    const environment = invocation?.environment;
    for (const [key, expected] of Object.entries({ github_job: 'deploy', github_repository: BACKEND_REPOSITORY,
      github_run_id: String(runId), github_run_attempt: String(runAttempt), github_workflow_sha: sourceSha, platform: 'linux/arm64' })) {
      same(environment?.[key], expected, `${app} provenance ${key}`);
    }
    images[app] = { digest, platform: 'linux/arm64' };
  }
  return images;
}

export function createBackendGithubClient({ token = process.env.BACKEND_GH_TOKEN, fetchImpl = fetch } = {}) {
  if (typeof token !== 'string' || !token || /[\r\n]/.test(token)) fail('backend 조회 token 누락');
  return async (endpoint, { text = false } = {}) => {
    if (typeof endpoint !== 'string' || !endpoint.startsWith(`${PREFIX}/`) || endpoint.includes('..')) fail('허용하지 않은 GitHub 경로');
    let response;
    try {
      response = await fetchImpl(`https://api.github.com${endpoint}`, { method: 'GET', redirect: 'manual',
        signal: AbortSignal.timeout(60_000), headers: { Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' } });
      if (text && response.status === 302) {
        const location = new URL(response.headers.get('location'));
        if (location.protocol !== 'https:' || location.username || location.password ||
            !(/\.blob\.core\.windows\.net$/.test(location.hostname) || /(?:^|\.)githubusercontent\.com$/.test(location.hostname) || /(?:^|\.)github\.com$/.test(location.hostname))) fail('로그 redirect host 오류');
        // 서명된 로그 URL에는 GitHub App token을 전달하지 않는다.
        response = await fetchImpl(location, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(60_000) });
      }
      if (!response.ok) fail(`GitHub 조회 실패 (HTTP ${response.status})`);
      const body = await response.text();
      if (Buffer.byteLength(body) > 32 * 1024 * 1024) fail('GitHub 응답 크기 초과');
      return text ? body : JSON.parse(body);
    } catch (error) {
      // 예외·응답 본문에는 signed URL 또는 token이 포함될 수 있다.
      if (error.message?.startsWith('backend 이미지 입력:')) throw error;
      fail('GitHub 응답을 읽을 수 없다');
    }
  };
}

export async function collectBackendImageInputs({ github, accountId = process.env.AWS_ACCOUNT_ID, token } = {}) {
  if (!/^\d{12}$/.test(accountId ?? '')) fail('AWS 계정 입력 오류');
  const request = github ?? createBackendGithubClient({ token });
  const runs = await pages(request, `${PREFIX}/workflows/deploy_dev.yml/runs?branch=develop&status=success`, 'workflow_runs');
  if (!runs.length) fail('성공한 backend develop 실행 없음');
  runs.forEach(validateRun);
  runs.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || (BigInt(b.id) > BigInt(a.id) ? 1 : -1));
  const selected = runs[0], runId = String(selected.id), runAttempt = String(selected.run_attempt);
  const run = validateRun(await request(`${PREFIX}/runs/${runId}/attempts/${runAttempt}`));
  for (const key of ['id', 'run_attempt', 'workflow_id', 'head_sha', 'created_at', 'event']) same(run[key], selected[key], `선택 attempt ${key}`);
  const jobs = await pages(request, `${PREFIX}/runs/${runId}/attempts/${runAttempt}/jobs`, 'jobs');
  const matches = jobs.filter(job => job.name === 'Build and publish images to ECR');
  if (matches.length !== 1) fail('이미지 게시 job 누락 또는 중복');
  const job = matches[0];
  same(String(job.run_id), runId, 'job run'); same(String(job.run_attempt), runAttempt, 'job attempt');
  same(job.head_sha, run.head_sha, 'job SHA');
  same(job.status, 'completed', 'job status'); same(job.conclusion, 'success', 'job conclusion');
  if (!Array.isArray(job.steps)) fail('job steps 누락');
  const builds = job.steps.filter(step => /^Build and push /.test(step.name ?? ''));
  if (builds.length !== BACKEND_APPS.length) fail('네 앱 build step 누락 또는 중복');
  const apps = [];
  for (const step of [...builds].sort((a, b) => a.number - b.number)) {
    const app = step.name.slice('Build and push '.length);
    if (!BACKEND_APPS.includes(app) || apps.includes(app) || !Number.isSafeInteger(step.number) || step.number <= 0) fail('build step 앱 또는 번호 오류');
    if (builds.some(other => other !== step && other.number === step.number)) fail('build step 번호 중복');
    same(step.status, 'completed', `${app} step status`); same(step.conclusion, 'success', `${app} step conclusion`);
    apps.push(app);
  }
  const jobId = identifier(job.id, 'job ID');
  const log = await request(`${PREFIX}/jobs/${jobId}/logs`, { text: true });
  const images = parseBackendImageLog(log, { accountId, sourceSha: run.head_sha, runId, runAttempt, apps });
  return validateBackendImageInputs({ schemaVersion: 1, repository: BACKEND_REPOSITORY, workflow: BACKEND_WORKFLOW,
    sourceSha: run.head_sha, runId, runAttempt, jobId, createdAt: run.created_at, logSha256: hash(log), images });
}
