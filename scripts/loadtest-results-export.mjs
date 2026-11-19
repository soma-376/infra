#!/usr/bin/env node
// dev 부하 시험(ADR-0064) 결과 추출과 두 층 한계 판정. Prometheus 보존이 7일이라 실행 직후 파일로 남긴다.
//
//   node scripts/loadtest-results-export.mjs --prometheus http://127.0.0.1:9090 --cluster <EKS 이름> --testid <id> \
//     --summary <k6 summary 또는 kubectl logs 파일> --config-snapshot <kubectl get deploy,sts,cm -o json> --out <디렉터리> [임계값]
//   node scripts/loadtest-results-export.mjs drain-plan --pipeline-limit <rps> --start 20 --step 20 --max 300 --hold 2m [--budget 3600]
//
// 조회만 한다(클러스터·AWS 에 쓰지 않는다). 단계 구간은 k6 summary 의 유지 구간 절대 시각이다.
// 범위 질의는 대시보드(pulsemetry-loadtest.json)와 같은 식이고, 판정 값은 유지 구간 전체 창으로 다시 계산한다.
// - 단계별 dropped·k6 지연·오류율은 k6 summary(실행 끝의 k6 자체 집계)에서 읽는다 — 수집 시점과 무관하다.
// - 0이어야 하는 카운터는 창을 [유지 시작, 유지 끝 + 경계 지연]으로 늘리고, 그 창의 수집 증거(재시작·Pod 교체·scrape)를
//   먼저 확인한다. 증거가 부족하면 미수집이다(lib/loadtest-queries.mjs).
// - lag 증가는 두 경계의 표본 시각을 확인한다(같은 표본·오래된 표본이면 미수집).
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_CRITERIA, configSnapshot, drainPlan, extractSummary, judgeRun, parseDuration, renderReport } from './lib/loadtest-judge.mjs';
import { boundaryGrowth, counterIncrease, evidenceProblem, evidenceQueries } from './lib/loadtest-queries.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dashboardFile = resolve(root, 'helm/observability/pulsemetry-observability/dashboards/pulsemetry-loadtest.json');

// dev main 기본값(eks-values.mjs 가 검사하는 이름). 다르면 인자로 준다.
const DEFAULTS = {
  namespace: 'pulsemetry-dev',
  environment: 'dev',
  'kafka-cluster': 'soma-376-dev-telemetry',
  topic: 'pulsemetry-dev-telemetry-ingress-main',
  'consumer-group': 'pulsemetry-dev-telemetry-ingest-main',
  'range-step': '15s',
  // Prometheus scrape·기록 규칙 간격(dev 10s). 경계 지연은 유지 구간 끝 직전 이벤트가 찍힐 때까지의 여유(2 × scrape),
  // 표본 최대 나이는 경계 표본이 이보다 오래되면 미수집으로 보는 값(3 × 규칙 간격)이다.
  'scrape-interval': '10s',
  'boundary-delay': '20s',
  'max-sample-age': '30s',
  // ClickHouse 추정 시작 시각(표본 시각 − 가동 초)이 창 안에서 이보다 크게 움직이면 재시작으로 본다.
  // 비동기 지표 갱신 주기(기본 1s)와 scrape 지연을 감안한 값이다(24.8 로컬 측정 흔들림 약 1s).
  'max-start-shift': '3s',
};

// 대시보드 패널(제목·refId) → 저장할 범위 질의 이름. 식은 대시보드에서 읽는다 — 같은 식을 두 곳에 쓰지 않는다.
const RANGE_QUERIES = [
  ['target_rps', '목표 RPS 대 실제 요청률', 'A'],
  ['actual_rps', '목표 RPS 대 실제 요청률', 'B'],
  ['k6_p95_ms', 'k6 응답 p95·p99 (유지 구간)', 'A'],
  ['k6_p99_ms', 'k6 응답 p95·p99 (유지 구간)', 'B'],
  ['k6_error_rate', 'k6 오류율', 'A'],
  ['gateway_p95', 'Gateway 응답 p95·p99', 'A'],
  ['gateway_p99', 'Gateway 응답 p95·p99', 'B'],
  ['gateway_results', 'Gateway 요청 결과 / 초', 'A'],
  ['kafka_lag', '확인된 commit 기준 lag', 'A'],
  ['kafka_lag_slope', 'lag 기울기 (2분)', 'A'],
  ['completion_p95', '접수 → 완료 p95', 'A'],
  ['ingest_attempts', '처리 시도 결과 / 초', 'A'],
  ['clickhouse_inserted_rows', '삽입 행 / 초', 'A'],
  ['clickhouse_parts', 'MergeTree parts', 'A'],
  ['heap_used', 'JVM heap 사용·committed·max', 'A'],
  ['cpu_limit_ratio', 'Pod CPU / limit', 'A'],
  ['cpu_throttling', 'CPU throttling 비율', 'A'],
  ['k6_pod_cpu', 'k6 Pod CPU', 'A'],
];

function selectors(vars) {
  const k6 = `cluster="${vars.cluster}",testid="${vars.testid}"`;
  const app = service => `environment="${vars.environment}",cluster="${vars.cluster}",namespace="${vars.namespace}",service="${service}",pod=~".*"`;
  return {
    k6,
    gateway: app('telemetry-gateway'),
    ingest: app('telemetry-ingest'),
    clickhouse: `job="clickhouse",cluster="${vars.cluster}",namespace="${vars.namespace}",service="clickhouse",pod=~".*"`,
    apps: `environment="${vars.environment}",cluster="${vars.cluster}",namespace="${vars.namespace}",service=~"telemetry-gateway|telemetry-ingest",pod=~".*"`,
    kafka: `topic="${vars.topic}",consumergroup="${vars.consumerGroup}",cluster="${vars.cluster}",kafka_cluster="${vars.kafkaCluster}"`,
    pods: `namespace="${vars.namespace}",container!="",container!="POD",cluster="${vars.cluster}",pod=~"(telemetry-gateway|telemetry-ingest)-.+|clickhouse-[0-9]+"`,
    limits: `namespace="${vars.namespace}",cluster="${vars.cluster}",resource="cpu",pod=~"(telemetry-gateway|telemetry-ingest)-.+|clickhouse-[0-9]+"`,
  };
}

/** 유지 구간 전체 창의 판정 값. 모두 holdEnd 시각의 instant 질의다. H = 유지 구간 초. */
function windowQueries(vars, holdSeconds) {
  const s = selectors(vars);
  const w = `${Math.max(1, Math.round(holdSeconds))}s`;
  const quantile = (q, metric, selector) => `histogram_quantile(${q},sum by(le)(increase(${metric}{${selector}}[${w}])))`;
  return {
    actualRps: `sum(increase(k6_http_reqs_total{${s.k6},name=~"/v1/.*"}[${w}])) / ${Math.round(holdSeconds)}`,
    serverP95Seconds: quantile(0.95, 'pulsemetry_gateway_request_duration_seconds_bucket', s.gateway),
    serverP99Seconds: quantile(0.99, 'pulsemetry_gateway_request_duration_seconds_bucket', s.gateway),
    lagSlope: `deriv(pulsemetry:kafka_committed_lag:sum{${s.kafka}}[${w}])`,
    completionP95Seconds: quantile(0.95, 'pulsemetry_pipeline_accepted_to_completion_seconds_bucket', s.ingest),
    chInsertedRows: `sum(increase(ClickHouseProfileEvents_InsertedRows{${s.clickhouse}}[${w}]))`,
    cpuLimitRatioMax: `max(max_over_time((sum by(pod)(rate(container_cpu_usage_seconds_total{${s.pods}}[1m])) / sum by(pod)(kube_pod_container_resource_limits{${s.limits}}))[${w}:15s]))`,
    heapMaxBytes: `max(max_over_time((sum by(service)(jvm_memory_used_bytes{${s.apps},area="heap"}))[${w}:15s]))`,
  };
}

/** 0이어야 하는 카운터. 값을 낸 대상(ingest·clickhouse)의 수집 증거가 있어야 쓴다. */
function zeroCounterQueries(vars, window) {
  const s = selectors(vars);
  return {
    permanent: { source: 'ingest', query: counterIncrease('pulsemetry_pipeline_attempts_total', `${s.ingest},outcome=~"permanent_.*"`, window) },
    retryExhausted: { source: 'ingest', query: counterIncrease('pulsemetry_pipeline_retry_exhausted_total', s.ingest, window) },
    chDelayed: { source: 'clickhouse', query: counterIncrease('ClickHouseProfileEvents_DelayedInserts', s.clickhouse, window) },
    chFailed: { source: 'clickhouse', query: counterIncrease('ClickHouseProfileEvents_FailedInsertQuery', s.clickhouse, window) },
  };
}

function evidenceSources(vars, window) {
  const s = selectors(vars);
  return {
    ingest: evidenceQueries(`up{${s.ingest}}`, `process_start_time_seconds{${s.ingest}}`, window),
    // ClickHouse 는 StatefulSet 이라 Pod 이름이 같아도 컨테이너·프로세스는 바뀔 수 있다 — 가동 시간의 감소와 추정 시작 시각 이동으로 재시작을 본다.
    clickhouse: evidenceQueries(`up{${s.clickhouse}}`, null, window, `ClickHouseAsyncMetrics_Uptime{${s.clickhouse}}`),
  };
}

const lagQuery = vars => `pulsemetry:kafka_committed_lag:sum{${selectors(vars).kafka}}`;

function dashboardQueries(vars) {
  const dashboard = JSON.parse(readFileSync(dashboardFile, 'utf8'));
  const substitute = expr => expr
    .replaceAll('$__rate_interval', '1m').replaceAll('$environment', vars.environment).replaceAll('$cluster', vars.cluster)
    .replaceAll('$namespace', vars.namespace).replaceAll('$pod', '.*').replaceAll('$testid', vars.testid)
    .replaceAll('$kafka_cluster', vars.kafkaCluster).replaceAll('$topic', vars.topic).replaceAll('$consumer_group', vars.consumerGroup);
  return RANGE_QUERIES.map(([name, title, refId]) => {
    const panel = dashboard.panels.find(item => item.title === title);
    const target = panel?.targets?.find(item => item.refId === refId);
    if (!target) throw new Error(`대시보드에 ${title}/${refId} 가 없다 — RANGE_QUERIES 를 대시보드와 맞춘다`);
    return [name, substitute(target.expr)];
  });
}

async function prometheus(base, path, params) {
  const url = new URL(path, base.endsWith('/') ? base : `${base}/`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.status !== 'success') throw new Error(`Prometheus ${path} ${response.status}: ${body?.error ?? '응답 오류'} — ${params.query}`);
  return body.data;
}

/** instant 결과의 값 하나. 여러 시계열이면 최댓값(이미 sum/max 로 줄인 식만 쓴다). 결과 없음·NaN 은 null 이다. */
function scalar(data) {
  const values = (data.result ?? []).map(item => Number(item.value?.[1])).filter(Number.isFinite);
  return values.length ? Math.max(...values) : null;
}

const toSeconds = iso => Math.floor(Date.parse(iso) / 1000);

async function exportRun(args) {
  for (const key of ['prometheus', 'cluster', 'testid', 'summary', 'config-snapshot', 'out']) {
    if (!args[key]) throw new Error(`--${key} 가 필요하다`);
  }
  const summary = extractSummary(readFileSync(args.summary, 'utf8'));
  if (summary.testid !== args.testid) throw new Error(`summary 의 testid(${summary.testid})가 --testid(${args.testid})와 다르다`);
  if (!Array.isArray(summary.steps) || !summary.steps.length) throw new Error('summary 에 단계가 없다');
  if (summary.steps.some(step => !step.holdStart || !step.holdEnd)) throw new Error('summary 단계에 유지 구간 절대 시각이 없다(setup 실패 실행?)');
  const snapshot = configSnapshot(JSON.parse(readFileSync(args['config-snapshot'], 'utf8')));
  const out = resolve(args.out);
  if (existsSync(out) && readdirSync(out).length) throw new Error(`${out} 가 비어 있지 않다 — 실행마다 새 디렉터리를 쓴다`);
  mkdirSync(resolve(out, 'queries'), { recursive: true });

  const vars = {
    testid: args.testid, cluster: args.cluster, namespace: args.namespace, environment: args.environment,
    kafkaCluster: args['kafka-cluster'], topic: args.topic, consumerGroup: args['consumer-group'],
  };
  const criteria = {
    maxP95Seconds: Number(args['max-p95-seconds'] ?? DEFAULT_CRITERIA.maxP95Seconds),
    maxP99Seconds: Number(args['max-p99-seconds'] ?? DEFAULT_CRITERIA.maxP99Seconds),
    maxErrorRate: Number(args['max-error-rate'] ?? DEFAULT_CRITERIA.maxErrorRate),
    maxDropped: Number(args['max-dropped'] ?? DEFAULT_CRITERIA.maxDropped),
    lagMinGrowth: Number(args['lag-min-growth'] ?? DEFAULT_CRITERIA.lagMinGrowth),
    lagGrowthPerRps: Number(args['lag-growth-per-rps'] ?? DEFAULT_CRITERIA.lagGrowthPerRps),
    completionP95Factor: Number(args['completion-p95-factor'] ?? DEFAULT_CRITERIA.completionP95Factor),
  };
  for (const [key, value] of Object.entries(criteria)) if (!Number.isFinite(value) || value < 0) throw new Error(`임계값 ${key} 가 0 이상의 수가 아니다`);
  const rangeStep = parseDuration(args['range-step'], 'range-step');
  const scrapeSeconds = parseDuration(args['scrape-interval'], 'scrape-interval');
  const delaySeconds = parseDuration(args['boundary-delay'], 'boundary-delay');
  const maxAgeSeconds = parseDuration(args['max-sample-age'], 'max-sample-age');
  const maxStartShiftSeconds = parseDuration(args['max-start-shift'], 'max-start-shift');
  if (!(scrapeSeconds > 0)) throw new Error('scrape-interval 은 0보다 커야 한다');
  const lastEnd = Math.max(...summary.steps.map(step => toSeconds(step.holdEnd)));
  if (Date.now() / 1000 < lastEnd + delaySeconds + 2 * scrapeSeconds) {
    throw new Error(`마지막 유지 구간 끝(${new Date(lastEnd * 1000).toISOString()}) + 경계 지연 ${delaySeconds}s 뒤에 실행한다`);
  }
  const ranges = dashboardQueries(vars);

  const steps = [];
  for (const step of summary.steps) {
    const start = toSeconds(step.holdStart);
    const end = toSeconds(step.holdEnd);
    const holdSeconds = end - start;
    if (!(holdSeconds > 0)) throw new Error(`${step.step} 유지 구간이 비었다`);
    const saved = {};
    for (const [name, query] of ranges) {
      saved[name] = { query, data: await prometheus(args.prometheus, 'api/v1/query_range', { query, start, end, step: rangeStep }) };
    }
    writeFileSync(resolve(out, 'queries', `${step.step}.json`), `${JSON.stringify({ step: step.step, holdStart: step.holdStart, holdEnd: step.holdEnd, ranges: saved }, null, 2)}\n`);

    const notes = {};
    const values = { k6P95Ms: step.p95Ms ?? null, k6P99Ms: step.p99Ms ?? null, errorRate: step.errorRate ?? null, notes };
    // 단계별 drop 은 k6 summary 의 값이다(summaryVersion 2). 없으면 미수집 — Prometheus 의 drop 카운터는 첫 drop 을 놓친다.
    values.dropped = Number.isFinite(step.droppedIterations) ? step.droppedIterations : null;
    if (values.dropped === null) notes.dropped = 'summary 에 단계별 drop 이 없다 — summaryVersion 2 이상의 k6 스크립트로 실행한다';
    const instant = async (query, time) => scalar(await prometheus(args.prometheus, 'api/v1/query', { query, time }));
    for (const [name, query] of Object.entries(windowQueries(vars, holdSeconds))) values[name] = await instant(query, end);

    // 0이어야 하는 카운터: 창 [start, end + 경계 지연], 그 창의 수집 증거를 먼저 본다.
    const windowSeconds = holdSeconds + delaySeconds;
    const evalTime = end + delaySeconds;
    const minSamples = Math.floor(windowSeconds / scrapeSeconds) - 1;
    const problems = {};
    for (const [source, queries] of Object.entries(evidenceSources(vars, `${windowSeconds}s`))) {
      const observed = {};
      for (const [key, query] of Object.entries(queries)) observed[key] = await instant(query, evalTime);
      problems[source] = evidenceProblem(source, observed, minSamples, maxStartShiftSeconds);
    }
    for (const [name, { source, query }] of Object.entries(zeroCounterQueries(vars, `${windowSeconds}s`))) {
      if (problems[source]) { values[name] = null; notes[name] = problems[source]; continue; }
      values[name] = await instant(query, evalTime);
    }

    // lag 증가: 두 경계의 실제 표본 시각을 확인한다.
    const sampleAt = async time => ({ value: await instant(lagQuery(vars), time), ts: await instant(`timestamp(${lagQuery(vars)})`, time) });
    const growth = boundaryGrowth(await sampleAt(start), await sampleAt(end), start, end, maxAgeSeconds);
    values.lagGrowth = growth.value;
    if (growth.note) notes.lagGrowth = growth.note;
    const expected = (step.expectedEvents ?? 0) + (step.expectedMetricPoints ?? 0);
    values.chStorageRatio = values.chInsertedRows === null || !expected ? null : values.chInsertedRows / expected;
    // 중단·미실행 단계(summary completed 가 true 가 아님)는 판정기가 두 층 모두의 한계 산정에서 뺀다.
    steps.push({ step: step.step, targetRps: step.targetRps, holdStart: step.holdStart, holdEnd: step.holdEnd, holdSeconds, completed: step.completed === true, values });
  }

  const judgement = { testid: args.testid, scenario: summary.scenario, ...judgeRun(steps, criteria) };
  const meta = { testid: args.testid, scenario: summary.scenario, scenarioStart: summary.scenarioStart, plannedSeconds: summary.plannedSeconds,
    campaign: summary.campaign, tenantId: summary.tenantId, installations: summary.installations };
  writeFileSync(resolve(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(resolve(out, 'config.json'), `${JSON.stringify(snapshot, null, 2)}\n`);
  writeFileSync(resolve(out, 'judgement.json'), `${JSON.stringify(judgement, null, 2)}\n`);
  writeFileSync(resolve(out, 'REPORT.md'), renderReport(judgement, meta));
  const { gateway, pipeline } = judgement.limits;
  console.log(`썼다: ${out} — ① ${gateway.rps ?? '없음'} RPS, ② ${pipeline.rps ?? '없음'} RPS (단계 ${steps.length}개)`);
}

function plan(args) {
  for (const key of ['pipeline-limit', 'start', 'step', 'max', 'hold']) if (!args[key]) throw new Error(`--${key} 가 필요하다`);
  const result = drainPlan({
    pipelineLimit: Number(args['pipeline-limit']), start: Number(args.start), step: Number(args.step), max: Number(args.max),
    holdSeconds: parseDuration(args.hold, 'hold'), budgetSeconds: parseDuration(args.budget ?? '3600', 'budget'),
  });
  console.log(JSON.stringify(result, null, 2));
  console.error(`backlog ${result.backlog} records, 배수 ${Math.round(result.drainSeconds)}s (예산 ${result.budgetSeconds}s ${result.withinBudget ? '이내' : '초과'})`
    + ` — 예산 안의 최대 MAX: ${result.suggestedMax ?? '없음'}`);
}

const options = Object.fromEntries([
  'prometheus', 'cluster', 'testid', 'summary', 'config-snapshot', 'out', 'namespace', 'environment', 'kafka-cluster', 'topic', 'consumer-group', 'range-step',
  'scrape-interval', 'boundary-delay', 'max-sample-age', 'max-start-shift',
  'max-p95-seconds', 'max-p99-seconds', 'max-error-rate', 'max-dropped', 'lag-min-growth', 'lag-growth-per-rps', 'completion-p95-factor',
  'pipeline-limit', 'start', 'step', 'max', 'hold', 'budget',
].map(name => [name, { type: 'string' }]));

async function main() {
  const { values, positionals } = parseArgs({ options, allowPositionals: true });
  const args = { ...DEFAULTS, ...Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) };
  if (positionals[0] === 'drain-plan') return plan(args);
  if (positionals.length) throw new Error(`모르는 명령: ${positionals.join(' ')}`);
  return exportRun(args);
}

main().catch(error => {
  console.error(`실패: ${error.message}`);
  process.exitCode = 1;
});
