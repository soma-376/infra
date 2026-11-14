// 초기화도 원본 생산 성공·artifact·실제 패키지를 검증한다. candidate의 코드는 실행하지 않는다.
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert, HASH, SHA, sha256, parse, validateManifest } from './contract.mjs';

const REPO = 'soma-376/pulsemetry-backend';
const WORKFLOW = `${REPO}/.github/workflows/deploy_dev.yml@refs/heads/develop`;
const LIMIT = 4 * 1024 * 1024;
const root = dirname(fileURLToPath(import.meta.url));
const iso = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) && Number.isFinite(Date.parse(value));
const id = value => Number.isSafeInteger(value) && value > 0;

async function bounded(response) {
  assert(response.body, 'GitHub 응답 body 누락');
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      assert(size <= LIMIT, 'GitHub 응답 크기 초과');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks);
}

export async function sourceRequest(path, { env = process.env, binary = false } = {}) {
  const ordinary = typeof path === 'string' && /^(actions\/[A-Za-z0-9_/.?=&-]+|commits\/develop)$/.test(path) && !path.includes('..');
  const comparison = typeof path === 'string' && /^compare\/[a-f0-9]{40}\.\.\.[a-f0-9]{40}$/.test(path);
  assert(env.GH_TOKEN && (ordinary || comparison), '원본 API 경로 오류');
  const response = await fetch(`https://api.github.com/repos/${REPO}/${path}`, {
    headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    signal: AbortSignal.timeout(30_000), redirect: 'manual',
  });
  if (binary && response.status === 302) {
    const url = new URL(response.headers.get('location'));
    assert(url.protocol === 'https:' && !url.username && !url.password &&
      (url.hostname.endsWith('.blob.core.windows.net') || url.hostname.endsWith('.githubusercontent.com')), 'artifact 다운로드 host 오류');
    await response.body?.cancel();
    // GitHub token은 서명된 blob URL로 보내지 않는다.
    const download = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(60_000) });
    assert(download.ok, '원본 artifact 다운로드 실패');
    return bounded(download);
  }
  assert(response.ok, '원본 GitHub API 조회 실패');
  const bytes = await bounded(response);
  return binary ? bytes : parse(bytes.toString('utf8'), 'GitHub 생산 증거');
}

async function pages(request, path, key) {
  const items = [], ids = new Set(); let expected;
  for (let page = 1; page <= 100; page++) {
    const response = await request(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    assert(Number.isSafeInteger(response.total_count) && response.total_count >= 0 && response.total_count <= 10_000 && Array.isArray(response[key]), '원본 목록 형식 오류');
    expected ??= response.total_count;
    assert(expected === response.total_count, '조회 중 원본 목록 변경');
    for (const item of response[key]) {
      assert(id(item.id) && !ids.has(item.id), '원본 목록 식별자 중복');
      ids.add(item.id); items.push(item);
    }
    if (items.length === expected) return items;
    assert(items.length < expected && response[key].length === 100, '원본 목록 불완전');
  }
  throw new Error('원본 목록 한도 초과');
}

async function helper(command, input, { env = process.env } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'source-proof-'));
  try {
    const source = join(directory, 'input'), output = join(directory, 'output');
    await writeFile(source, input, { mode: 0o600 });
    await new Promise((resolve, reject) => execFile('python3', [join(root, 'source-proof.py'), command, source, output],
      { env, timeout: command === 'archive' ? 30_000 : 20 * 60_000, maxBuffer: 1024 }, error => error ? reject(new Error('원본 archive 또는 이미지 패키지 검증 실패')) : resolve()));
    return command === 'archive' ? await readFile(output) : undefined;
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function verifySourceBundle(bundle, provenance, {
  env = process.env, requireLatest = false, now = () => Date.now(),
  request = (path, binary = false) => sourceRequest(path, { env, binary }),
  unpack = bytes => helper('archive', bytes, { env }),
  verifyImages = bytes => helper('images', bytes, { env }),
} = {}) {
  assert(provenance && Object.keys(provenance).sort().join(',') === [
    'repository', 'workflowRef', 'workflowRunId', 'workflowRunAttempt', 'backendCommit', 'createdAt', 'conclusion', 'event', 'headBranch', 'artifactId', 'artifactSha256',
  ].sort().join(','), '필수 원본 provenance가 필요하다');
  for (const key of ['workflowRunId', 'workflowRunAttempt', 'artifactId']) assert(typeof provenance[key] === 'string' && /^[1-9]\d*$/.test(provenance[key]), '원본 식별자 오류');
  assert(provenance.repository === REPO && provenance.workflowRef === WORKFLOW && provenance.conclusion === 'success' && provenance.headBranch === 'develop' &&
    ['push', 'workflow_dispatch'].includes(provenance.event) && SHA.test(provenance.backendCommit) && iso(provenance.createdAt) && HASH.test(provenance.artifactSha256), '원본 provenance 출처 오류');
  const checked = validateManifest(bundle.bytes, provenance);
  assert(checked.B === bundle.B, '입력 B hash 불일치');
  bundle = checked;
  for (const key of ['repository', 'workflowRef', 'workflowRunId', 'workflowRunAttempt', 'backendCommit']) assert(bundle.manifest[key] === provenance[key], 'B와 원본 실행 불일치');
  const run = await request(`actions/runs/${provenance.workflowRunId}/attempts/${provenance.workflowRunAttempt}`);
  assert(run.status === 'completed' && run.conclusion === 'success' && run.repository?.full_name === REPO && run.head_repository?.full_name === REPO &&
    run.path?.split('@')[0] === '.github/workflows/deploy_dev.yml' && run.head_branch === 'develop' && run.event === provenance.event &&
    String(run.id) === provenance.workflowRunId && String(run.run_attempt) === provenance.workflowRunAttempt && run.head_sha === provenance.backendCommit &&
    id(run.workflow_id), '원본 attempt 전체 성공 증거 오류');
  const current = await request(`actions/runs/${provenance.workflowRunId}`);
  assert(String(current.id) === provenance.workflowRunId && current.status === 'completed' && current.conclusion === 'success' &&
    String(current.run_attempt) === provenance.workflowRunAttempt, '원본 run의 최신 attempt가 성공해야 한다');
  assert(current.head_sha === run.head_sha && current.workflow_id === run.workflow_id && current.event === run.event &&
    current.head_branch === run.head_branch && current.repository?.full_name === REPO && current.head_repository?.full_name === REPO &&
    current.path?.split('@')[0] === '.github/workflows/deploy_dev.yml' &&
    iso(current.created_at) && current.created_at === provenance.createdAt, '원본 run과 attempt의 출처·생성 시각 불일치');
  const workflow = await request('actions/workflows/deploy_dev.yml');
  assert(workflow.id === run.workflow_id && workflow.path === '.github/workflows/deploy_dev.yml', '허용 workflow ID 오류');
  const jobs = await pages(request, `actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`, 'jobs');
  for (const name of ['Gradle build (Testcontainers)', 'Build and publish images to ECR']) {
    const matches = jobs.filter(job => job.name === name);
    assert(matches.length === 1 && matches[0].status === 'completed' && matches[0].conclusion === 'success' && matches[0].run_id === run.id &&
      matches[0].run_attempt === run.run_attempt && matches[0].head_sha === run.head_sha, '필수 생산 job 출처·성공 오류');
  }
  const artifacts = await pages(request, `actions/runs/${run.id}/artifacts`, 'artifacts');
  const matches = artifacts.filter(item => item.name === `dev-image-bundle-${run.id}-${run.run_attempt}`);
  assert(matches.length === 1, '원본 artifact 누락 또는 중복');
  const artifact = matches[0];
  assert(String(artifact.id) === provenance.artifactId && artifact.expired === false && iso(artifact.expires_at) && Date.parse(artifact.expires_at) > now() &&
    artifact.workflow_run?.id === run.id && artifact.workflow_run?.head_sha === run.head_sha, '원본 artifact 만료·출처 오류');
  const archive = await request(`actions/artifacts/${artifact.id}/zip`, true);
  assert(Buffer.isBuffer(archive) && archive.length <= LIMIT && sha256(archive) === provenance.artifactSha256 && artifact.digest === `sha256:${provenance.artifactSha256}`, '원본 ZIP hash 오류');
  const original = await unpack(archive);
  assert(Buffer.isBuffer(original) && original.equals(Buffer.from(bundle.bytes, 'utf8')) && sha256(original) === bundle.B, '원본 artifact와 B 바이트 불일치');
  const develop = await request('commits/develop');
  assert(SHA.test(develop.sha), '현재 develop SHA 오류');
  const ancestry = await request(`compare/${run.head_sha}...${develop.sha}`);
  assert(['ahead', 'identical'].includes(ancestry.status), '현재 develop 이력 밖 생산 실행');
  if (requireLatest) {
    const runs = await pages(request, 'actions/workflows/deploy_dev.yml/runs?branch=develop&status=success', 'workflow_runs');
    assert(!runs.some(item => iso(item.created_at) && (Date.parse(item.created_at) > Date.parse(current.created_at) ||
      (item.created_at === current.created_at && item.id > current.id))), '더 새로운 성공 생산 실행이 있다');
  }
  await verifyImages(original);
  const afterInspection = await request(`actions/runs/${provenance.workflowRunId}`);
  assert(String(afterInspection.id) === provenance.workflowRunId && afterInspection.status === 'completed' && afterInspection.conclusion === 'success' &&
    String(afterInspection.run_attempt) === provenance.workflowRunAttempt && afterInspection.head_sha === provenance.backendCommit, '이미지 검사 중 원본 실행 변경');
  return { verified: true, bundleManifestSha256: bundle.B, artifactSha256: provenance.artifactSha256 };
}
