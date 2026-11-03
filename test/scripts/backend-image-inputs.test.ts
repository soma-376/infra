import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const fixture = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/backend-image-publication.json'), 'utf8'));
const moduleUrl = pathToFileURL(resolve(__dirname, '../../scripts/backend-image-inputs.mjs')).href;
const prefix = '/repos/soma-376/pulsemetry-backend/actions';
const apps = ['enrollment-api', 'telemetry-ingest', 'dashboard-api', 'telemetry-gateway'];
type Json = Record<string, any>;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

// ESM 코드를 실제 Node runtime으로 읽는다. 네트워크·GitHub 자격은 주입한 응답으로 대체한다.
const driver = `
import { readFileSync } from 'node:fs';
import { collectBackendImageInputs, validateBackendImageInputs, createBackendGithubClient } from ${JSON.stringify(moduleUrl)};
const data = JSON.parse(readFileSync(0, 'utf8')), requests = [];
try {
  let value;
  if (data.operation === 'validate') value = validateBackendImageInputs(data.value);
  else if (data.operation === 'client') {
    const client = createBackendGithubClient({ token: 'fixture-token', fetchImpl: async (url, options) => {
      requests.push({ url: String(url), authorization: options.headers?.Authorization ?? null, redirect: options.redirect });
      if (data.networkError) throw new Error('fixture-token private signed URL');
      const response = data.responses.shift();
      return new Response(response.body ?? '', { status: response.status, headers: response.headers });
    } });
    value = await client(data.endpoint, { text: data.text });
  } else {
    const github = async (endpoint, options) => {
      requests.push({ endpoint, text: options?.text ?? false });
      if (endpoint.includes('/workflows/deploy_dev.yml/runs?')) {
        const page = Number(new URL('https://api.github.com' + endpoint).searchParams.get('page'));
        return data.pages?.[page - 1] ?? { total_count: data.runs.length, workflow_runs: data.runs };
      }
      if (endpoint.endsWith('/logs')) {
        if (data.logsError) throw new Error('logs expired');
        return data.log;
      }
      if (endpoint.includes('/jobs?')) return { total_count: data.jobs.length, jobs: data.jobs };
      if (endpoint.endsWith('/attempts/' + data.selected.run_attempt)) return data.selected;
      throw new Error('unexpected GitHub endpoint');
    };
    value = await collectBackendImageInputs({ accountId: data.accountId ?? '111111111111', github });
  }
  process.stdout.write(JSON.stringify({ value, requests }));
} catch (error) { process.stdout.write(JSON.stringify({ error: error.message, requests })); }
`;

function source(): Json {
  const older = { ...clone(fixture.run), id: 399, created_at: '2026-10-29T01:00:00Z', updated_at: '2026-11-01T01:00:00Z' };
  return { runs: [older, clone(fixture.run)], selected: clone(fixture.run), jobs: [clone(fixture.job)], log: fixture.log.join('\n') + '\n' };
}
function invoke(data: Json = source()): Json {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', driver], { input: JSON.stringify(data), encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout);
}

describe('backend 성공 attempt의 정제된 이미지 승인 입력', () => {
  test('생성 시각이 가장 최근인 성공 run의 정확한 attempt와 네 manifest digest를 고정한다', () => {
    const data = source(), result = invoke(data);
    expect(result.error).toBeUndefined();
    expect(result.value).toEqual({
      schemaVersion: 1, repository: 'soma-376/pulsemetry-backend', workflow: '.github/workflows/deploy_dev.yml',
      sourceSha: 'a'.repeat(40), runId: '400', runAttempt: '2', jobId: '500', createdAt: fixture.run.created_at,
      logSha256: createHash('sha256').update(data.log).digest('hex'),
      images: Object.fromEntries(apps.map((app, i) => [app, { digest: 'sha256:' + 'bcde'[i].repeat(64), platform: 'linux/arm64' }])),
    });
    expect(result.requests.map((request: Json) => request.endpoint)).toEqual([
      `${prefix}/workflows/deploy_dev.yml/runs?branch=develop&status=success&per_page=100&page=1`,
      `${prefix}/runs/400/attempts/2`, `${prefix}/runs/400/attempts/2/jobs?per_page=100&page=1`, `${prefix}/jobs/500/logs`,
    ]);
    expect(JSON.stringify(result.value)).not.toMatch(/111111111111|amazonaws|EXAMPLE|ImageID|invocation|fixture-token/);
  });

  test('100개를 넘는 목록도 pagination하며 최근 갱신 시각 대신 생성 시각으로 고른다', () => {
    const data = source();
    data.pages = [
      { total_count: 101, workflow_runs: Array.from({ length: 100 }, (_, i) => ({ ...clone(fixture.run), id: 1000 + i, created_at: '2026-10-28T01:00:00Z' })) },
      { total_count: 101, workflow_runs: [clone(fixture.run)] },
    ];
    const result = invoke(data);
    expect(result.error).toBeUndefined();
    expect(result.value.runId).toBe('400');
    expect(result.requests[1].endpoint).toContain('page=2');
  });

  test.each([
    ['성공 run 없음', (data: Json) => { data.runs = []; }, /성공한/],
    ['다른 저장소', (data: Json) => { data.runs[1].repository.full_name = 'someone/fork'; }, /repository/],
    ['다른 head 저장소', (data: Json) => { data.runs[1].head_repository.full_name = 'someone/fork'; }, /repository/],
    ['다른 branch', (data: Json) => { data.runs[1].head_branch = 'main'; }, /branch/],
    ['다른 workflow', (data: Json) => { data.runs[1].path = '.github/workflows/build.yml'; }, /workflow/],
    ['실패 run', (data: Json) => { data.runs[1].conclusion = 'failure'; }, /conclusion/],
    ['다른 attempt 응답', (data: Json) => { data.selected.run_attempt = 3; }, /attempt|unexpected/],
    ['다른 attempt의 job', (data: Json) => { data.jobs[0].run_attempt = 1; }, /job attempt/],
    ['다른 SHA의 job', (data: Json) => { data.jobs[0].head_sha = 'f'.repeat(40); }, /job SHA/],
    ['실패 job', (data: Json) => { data.jobs[0].conclusion = 'failure'; }, /job conclusion/],
    ['중복 job', (data: Json) => { data.jobs.push({ ...clone(data.jobs[0]), id: 501 }); }, /job 누락 또는 중복/],
    ['Gateway skip', (data: Json) => { data.jobs[0].steps[3].conclusion = 'skipped'; }, /step conclusion/],
    ['Gateway 누락', (data: Json) => { data.jobs[0].steps.pop(); }, /step 누락/],
    ['중복 앱 step', (data: Json) => { data.jobs[0].steps[3].name = data.jobs[0].steps[0].name; }, /앱 또는 번호/],
    ['중복 step 번호', (data: Json) => { data.jobs[0].steps[3].number = data.jobs[0].steps[0].number; }, /번호 중복/],
    ['로그 만료', (data: Json) => { data.logsError = true; }, /logs expired/],
  ] as Array<[string, (value: Json) => void, RegExp]>)('%s는 이전 run이나 태그로 대체하지 않는다', (_name, change, message) => {
    const data = source(); change(data);
    const result = invoke(data);
    expect(result.error).toMatch(message);
    expect(result.value).toBeUndefined();
    expect(result.requests.some((request: Json) => request.endpoint.includes('/runs/399'))).toBe(false);
  });
});

describe('Docker 최종 manifest와 Buildx metadata 대조', () => {
  const replace = (from: string, to: string) => (data: Json) => { data.log = data.log.replace(from, to); };
  test.each([
    ['build platform', replace('  platforms: linux/arm64', '  platforms: linux/amd64'), /platform/],
    ['tag SHA', replace(':sha-' + 'a'.repeat(40), ':sha-' + 'f'.repeat(40)), /image SHA/],
    ['tag 계정', replace('111111111111.dkr.ecr', '222222222222.dkr.ecr'), /account/],
    ['불명확한 mutable tag', replace(':sha-' + 'a'.repeat(40), ':dev'), /tag 형식/],
    ['config ImageID 오인', replace('##[group]Digest\n2026-10-30T01:10:00.0000000Z sha256:' + 'b'.repeat(64), '##[group]Digest\n2026-10-30T01:10:00.0000000Z sha256:' + '1'.repeat(64)), /manifest\/config/],
    ['metadata digest', replace('"containerimage.digest": "sha256:' + 'b'.repeat(64), '"containerimage.digest": "sha256:' + 'f'.repeat(64)), /metadata digest/],
    ['manifest 종류', replace('application/vnd.oci.image.manifest.v1+json', 'application/vnd.oci.image.index.v1+json'), /manifest 종류/],
    ['descriptor architecture', replace('"architecture": "arm64"', '"architecture": "amd64"'), /architecture/],
    ['provenance attempt', replace('"github_run_attempt": "2"', '"github_run_attempt": "1"'), /github_run_attempt/],
    ['provenance run', replace('"github_run_id": "400"', '"github_run_id": "399"'), /github_run_id/],
    ['provenance SHA', replace('"vcs:revision": "' + 'a'.repeat(40), '"vcs:revision": "' + 'f'.repeat(40)), /provenance SHA/],
    ['provenance platform', replace('"platform": "linux/arm64"', '"platform": "linux/amd64"'), /provenance platform/],
    ['다른 build action', replace('10e90e3645eae34f1e60eeb005ba3a3d33f178e8', 'f'.repeat(40)), /action 버전/],
    ['중복 앱 target', replace('  target: telemetry-gateway', '  target: enrollment-api'), /target 누락 또는 중복/],
    ['잘린 Metadata', (data: Json) => { data.log = data.log.slice(0, data.log.lastIndexOf('##[group]Metadata') + 30); }, /Metadata/],
    ['누락 build 로그', (data: Json) => { data.log = data.log.slice(0, data.log.lastIndexOf('##[group]Run docker/build-push-action')); }, /build 로그/],
    ['형식 변경', replace('##[group]Digest', '##[group]New digest format'), /Digest 로그/],
    ['중복 Digest', (data: Json) => { data.log += '\n##[group]Digest\nsha256:' + 'e'.repeat(64) + '\n##[endgroup]\n'; }, /Digest 로그/],
  ] as Array<[string, (value: Json) => void, RegExp]>)('%s 오류를 거부한다', (_name, change, message) => {
    const data = source(); change(data);
    expect(invoke(data).error).toMatch(message);
  });

  test('마스킹되지 않은 ECR 이름도 앱별 repository와 SHA를 대조한다', () => {
    const data = source();
    for (const app of apps) {
      const start = data.log.indexOf('  target: ' + app);
      const end = data.log.indexOf('##[group]Run docker/build-push-action', start);
      const block = data.log.slice(start, end === -1 ? data.log.length : end);
      data.log = data.log.replace(block, block.replaceAll('ecr.***.amazonaws.com/***', `ecr.ap-northeast-2.amazonaws.com/soma-376/${app}`));
    }
    expect(invoke(data).error).toBeUndefined();
    data.log = data.log.replace('soma-376/enrollment-api', 'soma-376/dashboard-api');
    expect(invoke(data).error).toMatch(/repository/);
  });

  test('승인 입력에 원문·계정·다른 앱을 추가할 수 없다', () => {
    const value = invoke().value;
    expect(invoke({ operation: 'validate', value }).error).toBeUndefined();
    for (const addition of [{ accountId: '111111111111' }, { rawLog: source().log }, { token: 'fixture-token' }]) {
      expect(invoke({ operation: 'validate', value: { ...value, ...addition } }).error).toMatch(/필드/);
    }
    value.images.extra = value.images['enrollment-api'];
    expect(invoke({ operation: 'validate', value }).error).toMatch(/네 앱/);
  });
});

describe('backend 로그 HTTP 경계', () => {
  test('서명된 로그 redirect에 GitHub token을 전달하지 않는다', () => {
    const result = invoke({ operation: 'client', endpoint: `${prefix}/jobs/500/logs`, text: true,
      responses: [{ status: 302, headers: { location: 'https://productionresultssa0.blob.core.windows.net/fixture/log?signed=fixture' } }, { status: 200, body: 'sanitized-log' }] });
    expect(result.value).toBe('sanitized-log');
    expect(result.requests[0].authorization).toBe('Bearer fixture-token');
    expect(result.requests[1].authorization).toBeNull();
  });
  test.each(['http://github.com/log', 'https://attacker.example/log', 'https://github.com.attacker.example/log'])('잘못된 redirect %s를 거부한다', location => {
    const result = invoke({ operation: 'client', endpoint: `${prefix}/jobs/500/logs`, text: true,
      responses: [{ status: 302, headers: { location } }] });
    expect(result.error).toMatch(/redirect host/);
    expect(result.requests).toHaveLength(1);
  });
  test('HTTP 오류와 네트워크 예외의 본문을 노출하지 않는다', () => {
    const expired = invoke({ operation: 'client', endpoint: `${prefix}/jobs/500/logs`, text: true,
      responses: [{ status: 410, body: 'private response with fixture-token' }] });
    expect(expired.error).toContain('HTTP 410');
    expect(expired.error).not.toContain('fixture-token');
    const network = invoke({ operation: 'client', endpoint: `${prefix}/jobs/500/logs`, text: true, networkError: true });
    expect(network.error).toBe('backend 이미지 입력: GitHub 응답을 읽을 수 없다');
  });
});
