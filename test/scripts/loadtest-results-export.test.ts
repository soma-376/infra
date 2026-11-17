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
const summary = {
  summaryVersion: 1, testid: 'pipeline-01', scenario: 'stair', campaign: 'camp-a', tenantId: '00000000-0000-4000-8000-0000000000aa', installations: 60,
  scenarioStart: iso(T0), plannedSeconds: 1020,
  steps: steps.map(s => ({ step: s.step, targetRps: s.targetRps, holdStart: iso(s.start), holdEnd: iso(s.end), holdSeconds: 300,
    p95Ms: s.p95Ms, p99Ms: s.p99Ms, errorRate: s.errorRate, expectedEvents: s.expectedEvents, expectedMetricPoints: s.expectedMetricPoints })),
  totals: { requests: 9000 },
};

// lag: s01·s02 동안은 평탄, s03 동안 4000 증가. s02 의 완료 p95 는 s01 의 2배 안.
const lagAt = (time: number) => (time <= T0 + 690 ? 50 : 50 + ((time - (T0 + 690)) / 300) * 4000);
const stepAt = (time: number) => steps.find(s => time === s.end)!;
const instant = (query: string, time: number): number | null => {
  const s = stepAt(time);
  if (query.startsWith('pulsemetry:kafka_committed_lag:sum')) return lagAt(time);
  if (!s) return null;
  if (query.includes('k6_http_reqs_total')) return s.targetRps;
  if (query.includes('k6_dropped_iterations_total')) return null; // drop 없음 → 지표 없음
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
  beforeEach(() => { work = mkdtempSync(resolve(tmpdir(), 'loadtest-export-')); received.length = 0; });
  afterEach(() => rmSync(work, { recursive: true, force: true }));

  const inputs = () => {
    // kubectl logs 출력 그대로(표지 사이 JSON)를 받는다.
    writeFileSync(resolve(work, 'k6.log'), `level=info msg="..."\n===LOADTEST-SUMMARY-BEGIN===\n${JSON.stringify(summary)}\n===LOADTEST-SUMMARY-END===\n`);
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
    expect(judgement.steps[0].values).toMatchObject({ actualRps: 5, dropped: null, serverP95Seconds: 0.04, lagGrowth: 0, completionP95Seconds: 1.2, chStorageRatio: 1.1 });

    // 질의는 testid·cluster 로 좁혀지고, 범위 질의는 대시보드 식(rate 1m)을 쓴다.
    const k6Queries = received.filter(line => line.includes('k6_'));
    expect(k6Queries.length).toBeGreaterThan(0);
    for (const line of k6Queries) expect(line).toContain('testid="pipeline-01"');
    expect(received.some(line => line.startsWith('/api/v1/query_range') && line.includes('[1m]'))).toBe(true);
    expect(received.some(line => line.startsWith('/api/v1/query ') && line.includes('[300s]'))).toBe(true);
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
