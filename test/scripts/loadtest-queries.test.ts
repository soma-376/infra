import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
const { dump } = require('js-yaml');

/**
 * 부하 시험 결과 추출(ADR-0064)의 판정 질의를 PromQL 반례로 고정한다. 식은 scripts/lib/loadtest-queries.mjs 가
 * 만든 그대로 쓴다(결과 추출과 같은 식). 반례: 처음 생긴 카운터의 첫 증가, 카운터 초기화, 변화 없음, 시계열 없음,
 * scrape 공백·실패, Pod 교체, 재시작, 경계에서 같은 lag 표본 재사용.
 */
// promtool 이 있어야 하는 반례만 조건부로 돌린다. 순수 JS 판단 검사는 늘 돈다.
const promtoolSuite = process.env.PROMTOOL_BIN ? describe : describe.skip;
const queriesModule = resolve(__dirname, '../../scripts/lib/loadtest-queries.mjs');
const call = (fn: string, ...args: unknown[]) => {
  const code = `import * as q from ${JSON.stringify(queriesModule)};
let input = ''; process.stdin.on('data', chunk => input += chunk).on('end', () => {
  const { fn, args } = JSON.parse(input);
  process.stdout.write(JSON.stringify(q[fn](...args)));
});`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { input: JSON.stringify({ fn, args }), encoding: 'utf8' });
  expect(result.stderr).toBe('');
  return JSON.parse(result.stdout);
};

const metric = 'pulsemetry_pipeline_attempts_total';
const ingest = 'job="ingest"';
const permanent = `${ingest},outcome=~"permanent_.*"`;
const series = (labels: string) => `${metric}{${labels},outcome="permanent_rejected"}`;

promtoolSuite('부하 시험 판정 질의의 PromQL 반례', () => {
  test('0이어야 하는 카운터와 수집 증거가 반례에서 의도대로 값을 낸다', () => {
    const increase = (window: string) => call('counterIncrease', metric, permanent, window);
    const evidence = (window: string) => call('evidenceQueries', 'up{job="ingest"}', 'process_start_time_seconds{job="ingest"}', window);
    const temp = mkdtempSync(resolve(tmpdir(), 'loadtest-queries-promql-'));
    try {
      const file = resolve(temp, 'queries.test.yaml');
      writeFileSync(file, dump({ rule_files: [], evaluation_interval: '10s', tests: [
        // 1) 처음 생긴 카운터: 60s 에 값 1로 생기고 그대로다. increase() 만으로는 0이라 영구 거부를 놓친다.
        { interval: '10s', input_series: [{ series: series(ingest), values: '_ _ _ _ _ _ 1 1 1 1 1 1 1' }], promql_expr_test: [
          { expr: `sum(increase(${metric}{${permanent}}[120s]))`, eval_time: '120s', exp_samples: [{ labels: '{}', value: 0 }] },
          { expr: `(${increase('120s')}) > bool 0`, eval_time: '120s', exp_samples: [{ labels: '{}', value: 1 }] },
        ] },
        // 2) 초기화: 5 → 6 → 재시작 → 2. 단순 차감은 −3(음수 → 기존 판정기는 통과), increase 는 초기화를 센다.
        { interval: '10s', input_series: [{ series: series(ingest), values: '4 5 6 2 2 2 2' }], promql_expr_test: [
          { expr: `sum(${metric}{${permanent}}) - sum(${metric}{${permanent}} offset 50s)`, eval_time: '60s', exp_samples: [{ labels: '{}', value: -3 }] },
          { expr: `(${increase('50s')}) > bool 0`, eval_time: '60s', exp_samples: [{ labels: '{}', value: 1 }] },
        ] },
        // 3) 창 전부터 있던 카운터가 변하지 않으면 0이다(새 시계열로 잘못 세지 않는다).
        { interval: '10s', input_series: [{ series: series(ingest), values: '3 3 3 3 3 3 3' }], promql_expr_test: [
          { expr: increase('40s'), eval_time: '60s', exp_samples: [{ labels: '{}', value: 0 }] },
        ] },
        // 4) 시계열이 아예 없으면 0이다 — 그래서 수집 증거를 먼저 확인한다.
        { interval: '10s', input_series: [], promql_expr_test: [
          { expr: increase('60s'), eval_time: '60s', exp_samples: [{ labels: '{}', value: 0 }] },
        ] },
        // 5) scrape 공백(표본 3 < 최소 5)과 실패(up 0).
        { interval: '10s', input_series: [{ series: 'up{job="ingest"}', values: '1 1 _ _ _ 1 1' }], promql_expr_test: [
          { expr: evidence('60s').upSamples, eval_time: '60s', exp_samples: [{ labels: '{}', value: 3 }] },
        ] },
        { interval: '10s', input_series: [{ series: 'up{job="ingest"}', values: '1 1 0 1 1 1 1' }], promql_expr_test: [
          { expr: evidence('60s').upMin, eval_time: '60s', exp_samples: [{ labels: '{}', value: 0 }] },
        ] },
        // 6) Pod 교체: 창 안에서 본 시계열 2개, 끝에 살아 있는 시계열 1개.
        { interval: '10s', input_series: [
          { series: 'process_start_time_seconds{job="ingest",pod="a"}', values: '100 100 100 stale' },
          { series: 'process_start_time_seconds{job="ingest",pod="b"}', values: '_ _ _ _ 200 200 200' },
        ], promql_expr_test: [
          { expr: evidence('60s').seen, eval_time: '60s', exp_samples: [{ labels: '{}', value: 2 }] },
          { expr: evidence('60s').live, eval_time: '60s', exp_samples: [{ labels: '{}', value: 1 }] },
        ] },
        // 7) 같은 Pod 의 재시작: 시작 시각이 바뀐다.
        { interval: '10s', input_series: [{ series: 'process_start_time_seconds{job="ingest",pod="a"}', values: '100 100 100 160 160 160 160' }], promql_expr_test: [
          { expr: evidence('60s').restarts, eval_time: '60s', exp_samples: [{ labels: '{}', value: 1 }] },
        ] },
        // 9) ClickHouse 가동 시간: 정상 증가는 재시작이 아니고(resets 0), 줄어들면 재시작이다(resets 1).
        //    시작 시각처럼 changes() 로 보면 정상 증가도 바뀜으로 센다.
        { interval: '10s', input_series: [{ series: 'ClickHouseAsyncMetrics_Uptime{job="clickhouse"}', values: '100 110 120 130 140 150 160' }], promql_expr_test: [
          { expr: call('evidenceQueries', 'up{job="clickhouse"}', null, '60s', 'ClickHouseAsyncMetrics_Uptime{job="clickhouse"}').uptimeResets, eval_time: '60s', exp_samples: [{ labels: '{}', value: 0 }] },
          { expr: 'sum(changes(ClickHouseAsyncMetrics_Uptime{job="clickhouse"}[60s]))', eval_time: '60s', exp_samples: [{ labels: '{}', value: 5 }] },
        ] },
        { interval: '10s', input_series: [{ series: 'ClickHouseAsyncMetrics_Uptime{job="clickhouse"}', values: '100 110 120 2 12 22 32' }], promql_expr_test: [
          { expr: call('evidenceQueries', 'up{job="clickhouse"}', null, '60s', 'ClickHouseAsyncMetrics_Uptime{job="clickhouse"}').uptimeResets, eval_time: '60s', exp_samples: [{ labels: '{}', value: 1 }] },
        ] },
        // 8) 기록 규칙이 20s 뒤로 멈추면 60s·90s 두 경계가 같은 20s 표본을 돌려준다(lookback 5m). 값은 같아도 증가 0이 아니다.
        { interval: '10s', input_series: [{ series: 'pulsemetry:kafka_committed_lag:sum{topic="t"}', values: '5 5 5' }], promql_expr_test: [
          { expr: 'timestamp(pulsemetry:kafka_committed_lag:sum{topic="t"})', eval_time: '60s', exp_samples: [{ labels: '{topic="t"}', value: 20 }] },
          { expr: 'timestamp(pulsemetry:kafka_committed_lag:sum{topic="t"})', eval_time: '90s', exp_samples: [{ labels: '{topic="t"}', value: 20 }] },
        ] },
      ] }));
      const result = spawnSync(process.env.PROMTOOL_BIN!, ['test', 'rules', file], { encoding: 'utf8' });
      expect([result.status, result.stdout + result.stderr]).toEqual([0, expect.stringContaining('SUCCESS')]);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

});

describe('부하 시험 판정의 증거 판단(JS)', () => {
  test('증거 판단과 경계 증가량은 부족한 증거를 0으로 채우지 않는다', () => {
    const ok = { upMin: 1, upSamples: 31, seen: 1, live: 1, restarts: 0 };
    expect(call('evidenceProblem', 'ingest', ok, 31)).toBeNull();
    expect(call('evidenceProblem', 'ingest', { ...ok, upSamples: 3 }, 5)).toBe('ingest scrape 표본 부족(3/5)');
    expect(call('evidenceProblem', 'ingest', { ...ok, upMin: 0 }, 31)).toBe('ingest scrape 실패 구간 있음');
    expect(call('evidenceProblem', 'ingest', { ...ok, seen: 2 }, 31)).toBe('ingest Pod 교체');
    expect(call('evidenceProblem', 'ingest', { ...ok, restarts: 1 }, 31)).toBe('ingest 재시작');
    expect(call('evidenceProblem', 'ingest', { ...ok, upMin: null }, 31)).toBe('ingest 수집 지표 없음');
    expect(call('evidenceProblem', 'clickhouse', { upMin: 1, upSamples: 31 }, 31)).toBeNull();
    expect(call('evidenceProblem', 'clickhouse', { upMin: 1, upSamples: 31, uptimeResets: 0 }, 31)).toBeNull();
    expect(call('evidenceProblem', 'clickhouse', { upMin: 1, upSamples: 31, uptimeResets: 1 }, 31)).toBe('clickhouse 재시작');
    expect(call('evidenceProblem', 'clickhouse', { upMin: 1, upSamples: 31, uptimeResets: null }, 31)).toBe('clickhouse 가동 시간 지표 없음');
    // up 이 1 로 이어져도(scrape 사이 재시작) 가동 시간이 줄었으면 재시작이다 — 0 → 실패 1 → 재시작 → 0 이 0 → 0 으로만 보이는 경우.
    expect(call('evidenceQueries', 'up{job="clickhouse"}', null, '60s', 'U{job="clickhouse"}')).toEqual({
      upMin: 'min(min_over_time(up{job="clickhouse"}[60s]))', upSamples: 'min(count_over_time(up{job="clickhouse"}[60s]))',
      uptimeResets: 'sum(resets(U{job="clickhouse"}[60s]))',
    });

    // 반례 8: 두 경계가 같은 20s 표본 → 미수집. 서로 다른 최신 표본의 값이 같으면 0.
    expect(call('boundaryGrowth', { value: 5, ts: 20 }, { value: 5, ts: 20 }, 60, 90, 30)).toEqual({ value: null, note: '경계 표본이 30s 보다 오래됨' });
    expect(call('boundaryGrowth', { value: 5, ts: 55 }, { value: 5, ts: 55 }, 60, 62, 30)).toEqual({ value: null, note: '시작·끝이 같은 표본' });
    expect(call('boundaryGrowth', { value: 5, ts: 55 }, { value: 5, ts: 85 }, 60, 90, 30)).toEqual({ value: 0, note: null });
    expect(call('boundaryGrowth', { value: 5, ts: 55 }, { value: 9, ts: 85 }, 60, 90, 30)).toEqual({ value: 4, note: null });
    expect(call('boundaryGrowth', { value: null, ts: null }, { value: 9, ts: 85 }, 60, 90, 30)).toEqual({ value: null, note: '경계 표본 없음' });
  });
});
