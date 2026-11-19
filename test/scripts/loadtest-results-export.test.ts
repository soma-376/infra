import { execFile, spawnSync } from 'node:child_process';
import { createServer, Server } from 'node:http';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

// 결과 추출 스크립트를 127.0.0.1 임시 포트의 가짜 Prometheus 에 붙여 질의·판정·비밀 제외·drain-plan 을 확인한다.
// 클러스터·AWS 에 연결하지 않는다. 스크립트는 별도 node 로 돌린다(이 프로세스가 가짜 서버를 돌리므로 비동기로).
const script = resolve(__dirname, '../../scripts/loadtest-results-export.mjs');
const run = (args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>(done => {
  execFile(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 60_000 }, (error, stdout, stderr) => {
    done({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr });
  });
});

const T0 = Date.parse('2026-11-18T10:00:00.000Z') / 1000;
const steps = [
  { step: 's01', targetRps: 5, start: T0 + 30, end: T0 + 330, p95Ms: 80, p99Ms: 200, errorRate: 0, expectedEvents: 1500, expectedMetricPoints: 500 },
  { step: 's02', targetRps: 10, start: T0 + 360, end: T0 + 660, p95Ms: 90, p99Ms: 250, errorRate: 0, expectedEvents: 3000, expectedMetricPoints: 1000 },
  { step: 's03', targetRps: 15, start: T0 + 690, end: T0 + 990, p95Ms: 1400, p99Ms: 2800, errorRate: 0, expectedEvents: 4500, expectedMetricPoints: 1500 },
];
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
// 가짜 Prometheus 의 상황. 기본은 정상이고, 시험마다 바꾼다.
let mode: { restartAt?: string; staleLagAt?: string; chRestartAt?: string } = {};
const summary = {
  summaryVersion: 3, testid: 'pipeline-01', scenario: 'stair', campaign: 'camp-a', tenantId: '00000000-0000-4000-8000-0000000000aa', installations: 60,
  scenarioStart: iso(T0), plannedSeconds: 1020,
  steps: steps.map(s => ({ step: s.step, targetRps: s.targetRps, holdStart: iso(s.start), holdEnd: iso(s.end), holdSeconds: 300,
    p95Ms: s.p95Ms, p99Ms: s.p99Ms, errorRate: s.errorRate, expectedEvents: s.expectedEvents, expectedMetricPoints: s.expectedMetricPoints,
    completed: true, scheduledIterations: s.targetRps * 300, droppedIterations: 0 })),
  totals: { requests: 9000 },
};

// lag: s01·s02 동안은 평탄, s03 동안 4000 증가. s02 의 완료 p95 는 s01 의 2배 안.
const lagAt = (time: number) => (time <= T0 + 690 ? 50 : 50 + ((time - (T0 + 690)) / 300) * 4000);
// 판정 창: 지연·처리율은 유지 구간 끝, 0이어야 하는 카운터와 수집 증거는 끝 + 경계 지연(20s).
const DELAY = 20;
const stepAt = (time: number) => steps.find(s => time === s.end || time === s.end + DELAY)!;
const boundaryStep = (time: number) => steps.find(s => time === s.start || time === s.end);
const instant = (query: string, time: number): number | null => {
  const s = stepAt(time);
  if (query.startsWith('timestamp(pulsemetry:kafka_committed_lag:sum')) {
    // 같은 표본 상황: 그 단계의 두 경계가 모두 시작 60초 전의 같은 표본을 돌려준다.
    const b = boundaryStep(time);
    if (b && mode.staleLagAt === b.step) return b.start - 60;
    return time - 5;
  }
  if (query.startsWith('pulsemetry:kafka_committed_lag:sum')) return lagAt(time);
  if (!s) return null;
  // 수집 증거(창 320s, scrape 10s → 최소 표본 31).
  if (query.startsWith('min(min_over_time(up{')) return 1;
  if (query.startsWith('min(count_over_time(up{')) return 32;
  if (query.startsWith('count(count_over_time(process_start_time_seconds')) return 1;
  if (query.startsWith('count(process_start_time_seconds')) return 1;
  if (query.startsWith('sum(changes(process_start_time_seconds')) return mode.restartAt === s.step ? 1 : 0;
  if (query.startsWith('sum(resets(ClickHouseAsyncMetrics_Uptime')) return mode.chRestartAt === s.step ? 1 : 0;
  if (query.includes('k6_http_reqs_total')) return s.targetRps;
  if (query.includes('pulsemetry_gateway_request_duration_seconds_bucket')) return query.startsWith('histogram_quantile(0.95') ? 0.04 : 0.12;
  if (query.startsWith('deriv(')) return s.step === 's03' ? 13.3 : 0;
  if (query.includes('accepted_to_completion')) return { s01: 1.2, s02: 2.0, s03: 2.2 }[s.step]!;
  if (query.includes('outcome=~"permanent_.*"')) return 0;
  if (query.includes('retry_exhausted')) return 0;
  if (query.includes('DelayedInserts')) return 0;
  if (query.includes('FailedInsertQuery')) return 0;
  if (query.includes('InsertedRows')) return (s.expectedEvents + s.expectedMetricPoints) * 1.1;
  if (query.includes('container_cpu_usage_seconds_total')) return 0.42;
  if (query.includes('jvm_memory_used_bytes')) return 512 * 1048576;
  return null;
};

let server: Server;
let base: string;
const received: string[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://127.0.0.1');
    const query = url.searchParams.get('query') ?? '';
    received.push(`${url.pathname} ${query}`);
    const send = (data: unknown) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ status: 'success', data })); };
    if (url.pathname === '/api/v1/query') {
      const value = instant(query, Number(url.searchParams.get('time')));
      return send({ resultType: 'vector', result: value === null ? [] : [{ metric: {}, value: [Number(url.searchParams.get('time')), String(value)] }] });
    }
    if (url.pathname === '/api/v1/query_range') {
      const start = Number(url.searchParams.get('start'));
      return send({ resultType: 'matrix', result: [{ metric: {}, values: [[start, '1'], [start + 15, '2']] }] });
    }
    response.writeHead(404); response.end();
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', () => done()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>(done => server.close(() => done())));

describe('부하 시험 결과 추출', () => {
  let work: string;
  beforeEach(() => { work = mkdtempSync(resolve(tmpdir(), 'loadtest-export-')); received.length = 0; mode = {}; });
  afterEach(() => rmSync(work, { recursive: true, force: true }));

  const inputs = (summaryOverride: any = summary) => {
    // kubectl logs 출력 그대로(표지 사이 JSON)를 받는다.
    writeFileSync(resolve(work, 'k6.log'), `level=info msg="..."\n===LOADTEST-SUMMARY-BEGIN===\n${JSON.stringify(summaryOverride)}\n===LOADTEST-SUMMARY-END===\n`);
    writeFileSync(resolve(work, 'config.json'), JSON.stringify({ items: [
      { kind: 'Deployment', metadata: { name: 'telemetry-gateway' }, spec: { replicas: 1, template: { spec: { nodeSelector: { 'karpenter.sh/nodepool': 'pulsemetry-dev-apps' },
        containers: [{ name: 'telemetry-gateway', image: 'ecr/gateway@sha256:1111', resources: { limits: { cpu: '2' } },
          env: [{ name: 'PULSEMETRY_KAFKA_TOPIC', value: 'pulsemetry-dev-telemetry-ingress-main' }, { name: 'PULSEMETRY_ADMIN_API_TOKEN', value: 'tok-should-not-leak' }] }] } } } },
      { kind: 'Secret', metadata: { name: 'x' }, data: { key: 'c2VjcmV0LWRvLW5vdC1sZWFr' } },
    ] }));
  };
  const exportArgs = (out: string, extra: string[] = []) => ['--prometheus', base, '--cluster', 'fixture-eks', '--testid', 'pipeline-01',
    '--summary', resolve(work, 'k6.log'), '--config-snapshot', resolve(work, 'config.json'), '--out', out, ...extra];

  test('단계마다 범위 질의를 저장하고 유지 구간 창으로 두 층을 판정한다', async () => {
    inputs();
    const out = resolve(work, 'result');
    const result = await run(exportArgs(out));
    expect([result.code, result.stderr]).toEqual([0, '']);
    expect(result.stdout).toContain('① 10 RPS, ② 10 RPS');
    expect(readdirSync(out).sort()).toEqual(['REPORT.md', 'config.json', 'judgement.json', 'queries', 'summary.json']);
    expect(readdirSync(resolve(out, 'queries')).sort()).toEqual(['s01.json', 's02.json', 's03.json']);

    const judgement = JSON.parse(readFileSync(resolve(out, 'judgement.json'), 'utf8'));
    expect(judgement.limits).toEqual({
      gateway: { rps: 10, step: 's02', firstFailure: 's03' },
      pipeline: { rps: 10, step: 's02', firstFailure: 's03' },
    });
    const s03 = judgement.steps[2];
    expect(s03.gateway.reasons).toEqual(['k6 p95 1.4s > 1s']);
    expect(s03.pipeline.reasons).toEqual(['lag 증가 4000 > 150']);
    expect(judgement.steps[0].values).toMatchObject({ actualRps: 5, dropped: 0, serverP95Seconds: 0.04, lagGrowth: 0, completionP95Seconds: 1.2, chStorageRatio: 1.1,
      permanent: 0, retryExhausted: 0, chDelayed: 0, chFailed: 0, notes: {} });

    // 질의는 testid·cluster 로 좁혀지고, 범위 질의는 대시보드 식(rate 1m)을 쓴다.
    const k6Queries = received.filter(line => line.includes('k6_'));
    expect(k6Queries.length).toBeGreaterThan(0);
    for (const line of k6Queries) expect(line).toContain('testid="pipeline-01"');
    expect(received.some(line => line.startsWith('/api/v1/query_range') && line.includes('[1m]'))).toBe(true);
    expect(received.some(line => line.startsWith('/api/v1/query ') && line.includes('[300s]'))).toBe(true);
    // 0이어야 하는 카운터는 창을 경계 지연만큼 늘리고, 처음 생긴 시계열의 첫 값을 더한다.
    expect(received.some(line => line.includes('pulsemetry_pipeline_attempts_total') && line.includes('[320s]') && line.includes(' unless '))).toBe(true);
    expect(received.some(line => line.includes('k6_dropped_iterations_total'))).toBe(false);
    expect(received.every(line => !line.includes('$'))).toBe(true);
    // 가짜 서버는 PromQL 을 해석하지 않는다. 보낸 식을 실제 파서(promtool)로 검사한다.
    if (process.env.PROMTOOL_BIN) {
      const unique = [...new Set(received.map(line => line.slice(line.indexOf(' ') + 1)))];
      const rules = resolve(work, 'queries.rules.yaml');
      writeFileSync(rules, JSON.stringify({ groups: [{ name: 'loadtest-export', rules: unique.map((expr, i) => ({ record: `loadtest_export_${i}`, expr })) }] }));
      const check = spawnSync(process.env.PROMTOOL_BIN, ['check', 'rules', rules], { encoding: 'utf8' });
      expect([check.status, check.stderr]).toEqual([0, '']);
      expect(unique.length).toBeGreaterThan(20);
    }

    const report = readFileSync(resolve(out, 'REPORT.md'), 'utf8');
    expect(report).toContain('① Gateway 수용: 10 RPS (s02) — 처음 실패 s03');
    expect(report).toContain('| s03 | 15 |');
    expect(report).toContain('lag 증가 4000 > 150');

    // 구성 스냅샷: Secret·비밀로 보이는 env 값은 남지 않는다.
    const everything = ['config.json', 'judgement.json', 'REPORT.md', 'summary.json'].map(file => readFileSync(resolve(out, file), 'utf8')).join('\n');
    for (const secret of ['tok-should-not-leak', 'c2VjcmV0LWRvLW5vdC1sZWFr']) expect(everything).not.toContain(secret);
    const config = JSON.parse(readFileSync(resolve(out, 'config.json'), 'utf8'));
    expect(config.workloads[0].containers[0].image).toBe('ecr/gateway@sha256:1111');
    expect(config.workloads[0].containers[0].env).toEqual([
      { name: 'PULSEMETRY_ADMIN_API_TOKEN', value: '<redacted>' }, { name: 'PULSEMETRY_KAFKA_TOPIC', value: 'pulsemetry-dev-telemetry-ingress-main' },
    ]);
  });

  test('ingest 가 재시작한 단계는 영구 거부·재시도 소진이 미수집이고 ②가 그 단계에서 끊긴다', async () => {
    inputs();
    mode = { restartAt: 's02' };
    const out = resolve(work, 'result');
    expect((await run(exportArgs(out))).code).toBe(0);
    const judgement = JSON.parse(readFileSync(resolve(out, 'judgement.json'), 'utf8'));
    expect(judgement.limits.pipeline).toEqual({ rps: 5, step: 's01', firstFailure: 's02' });
    expect(judgement.steps[1].pipeline.reasons).toEqual(['영구 거부 미수집(ingest 재시작)', '재시도 소진 미수집(ingest 재시작)']);
    expect(judgement.steps[1].values).toMatchObject({ permanent: null, retryExhausted: null, chDelayed: 0, chFailed: 0 });
  });

  test('ClickHouse 가 재시작한 단계는 지연·실패 INSERT 가 미수집이다(재시작 전 수집 안 된 실패는 되살릴 수 없다)', async () => {
    inputs();
    mode = { chRestartAt: 's02' };
    const out = resolve(work, 'result');
    expect((await run(exportArgs(out))).code).toBe(0);
    const judgement = JSON.parse(readFileSync(resolve(out, 'judgement.json'), 'utf8'));
    expect(judgement.steps[1].pipeline.reasons).toEqual(['CH 지연 INSERT 미수집(clickhouse 재시작)', 'CH 실패 INSERT 미수집(clickhouse 재시작)']);
    expect(judgement.steps[1].values).toMatchObject({ permanent: 0, retryExhausted: 0, chDelayed: null, chFailed: null });
    expect(judgement.limits.pipeline).toEqual({ rps: 5, step: 's01', firstFailure: 's02' });
    expect(received.some(line => line.includes('resets(ClickHouseAsyncMetrics_Uptime{') && line.includes('[320s]'))).toBe(true);
  });

  test('중단된 단계는 두 층 모두 한계 산정에서 빠진다', async () => {
    inputs({ ...summary, steps: summary.steps.map((s: any) => (s.step === 's02' ? { ...s, completed: false, droppedIterations: null } : s)) });
    const out = resolve(work, 'result');
    expect((await run(exportArgs(out))).code).toBe(0);
    const judgement = JSON.parse(readFileSync(resolve(out, 'judgement.json'), 'utf8'));
    expect(judgement.limits).toEqual({
      gateway: { rps: 5, step: 's01', firstFailure: 's02' },
      pipeline: { rps: 5, step: 's01', firstFailure: 's02' },
    });
    for (const layer of ['gateway', 'pipeline']) expect(judgement.steps[1][layer].reasons[0]).toBe('미완료 단계 — 유지 구간을 끝까지 실행하지 않아 한계 산정에서 뺀다');
  });

  test('lag 경계가 같은 표본이면 증가량을 0으로 쓰지 않고 미수집으로 둔다', async () => {
    inputs();
    mode = { staleLagAt: 's01' };
    const out = resolve(work, 'result');
    expect((await run(exportArgs(out))).code).toBe(0);
    const judgement = JSON.parse(readFileSync(resolve(out, 'judgement.json'), 'utf8'));
    expect(judgement.steps[0].values.lagGrowth).toBeNull();
    expect(judgement.steps[0].pipeline.reasons).toEqual(['lag 미수집(경계 표본이 30s 보다 오래됨)']);
    expect(judgement.limits.pipeline).toEqual({ rps: null, step: null, firstFailure: 's01' });
  });

  test('summary 에 단계별 drop 이 없으면 ①은 0 이 아니라 미수집이다', async () => {
    inputs({ ...summary, summaryVersion: 1, steps: summary.steps.map(({ droppedIterations, scheduledIterations, completed, ...rest }: any) => rest) });
    const out = resolve(work, 'result');
    expect((await run(exportArgs(out))).code).toBe(0);
    const judgement = JSON.parse(readFileSync(resolve(out, 'judgement.json'), 'utf8'));
    // 이전 summary 는 completed 도 없어 모든 단계가 미완료다 — 두 층 모두 한계가 없다.
    expect(judgement.limits.gateway).toEqual({ rps: null, step: null, firstFailure: 's01' });
    expect(judgement.limits.pipeline).toEqual({ rps: null, step: null, firstFailure: 's01' });
    expect(judgement.steps[0].gateway.reasons).toEqual(expect.arrayContaining([expect.stringMatching(/^dropped 미수집\(summary 에 단계별 drop 이 없다/)]));
  });

  test('임계값 인자를 바꾸면 판정이 바뀐다', async () => {
    inputs();
    const out = resolve(work, 'result');
    const result = await run(exportArgs(out, ['--max-p95-seconds', '2', '--lag-growth-per-rps', '300']));
    expect(result.code).toBe(0);
    const judgement = JSON.parse(readFileSync(resolve(out, 'judgement.json'), 'utf8'));
    expect(judgement.limits.gateway).toEqual({ rps: 15, step: 's03', firstFailure: null });
    expect(judgement.limits.pipeline).toEqual({ rps: 15, step: 's03', firstFailure: null });
  });

  test('testid 불일치·비어 있지 않은 출력·필수 인자 누락은 거부한다', async () => {
    inputs();
    expect((await run(exportArgs(resolve(work, 'a'), ['--testid', 'other']))).stderr).toContain('testid');
    writeFileSync(resolve(work, 'occupied'), 'x');
    const busy = resolve(work);
    const occupied = await run(exportArgs(busy));
    expect([occupied.code, occupied.stderr.includes('비어 있지 않다')]).toEqual([1, true]);
    const missing = await run(['--prometheus', base, '--testid', 'pipeline-01']);
    expect([missing.code, missing.stderr.includes('--cluster')]).toEqual([1, true]);
    expect(existsSync(resolve(work, 'a'))).toBe(false);
  });

  test('Prometheus 오류는 실패로 끝난다', async () => {
    inputs();
    const result = await run([...exportArgs(resolve(work, 'b')).map(value => (value === base ? `${base}/broken/` : value))]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('실패');
  });

  test('drain-plan 은 backlog·배수 시간·예산 안의 최대 MAX 를 낸다', async () => {
    const result = await run(['drain-plan', '--pipeline-limit', '50', '--start', '20', '--step', '20', '--max', '300', '--hold', '2m', '--budget', '3600']);
    expect(result.code).toBe(0);
    const plan = JSON.parse(result.stdout);
    expect(plan).toMatchObject({ pipelineLimit: 50, holdSeconds: 120, budgetSeconds: 3600, withinBudget: false });
    expect(plan.backlog).toBe([60, 80, 100, 120, 140, 160, 180, 200, 220, 240, 260, 280, 300].reduce((sum, r) => sum + (r - 50) * 120, 0));
    expect(plan.suggestedDrainSeconds).toBeLessThanOrEqual(3600);
    expect(result.stderr).toContain('예산 안의 최대 MAX');
  });
});
