import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
const { dump } = require('js-yaml');

/**
 * 부하 시험 대시보드(ADR-0064)의 판정 식을 promtool 단위 시험으로 고정한다.
 * lag 기울기·유지 구간 p95·오류율은 결과 추출 스크립트(loadtest-results-export.mjs)도 같은 식을 쓴다.
 */
const suite = process.env.PROMTOOL_BIN ? describe : describe.skip;
const dashboard = JSON.parse(readFileSync(resolve(__dirname, '../../helm/observability/pulsemetry-observability/dashboards/pulsemetry-loadtest.json'), 'utf8'));
const substitute = (expr: string) => expr
  .replaceAll('$__rate_interval', '2m').replaceAll('$environment', 'dev').replaceAll('$cluster', 'fixture-eks')
  .replaceAll('$namespace', 'pulsemetry-dev').replaceAll('$pod', '.*').replaceAll('$testid', 'fixture-run')
  .replaceAll('$kafka_cluster', 'fixture-kafka').replaceAll('$topic', 'fixture-topic').replaceAll('$consumer_group', 'fixture-group');
const query = (title: string, refId = 'A') => {
  const panel = dashboard.panels.find((p: any) => p.title === title);
  expect([title, Boolean(panel)]).toEqual([title, true]);
  return substitute(panel.targets.find((t: any) => t.refId === refId).expr);
};
const annotation = () => substitute(dashboard.annotations.list.find((a: any) => a.name === '목표 RPS 변경').expr);

const k6 = 'cluster="fixture-eks",testid="fixture-run"';
const lagLabels = 'cluster="fixture-eks",kafka_cluster="fixture-kafka",topic="fixture-topic",consumergroup="fixture-group"';

suite('부하 시험 대시보드의 판정 식', () => {
  test('lag 기울기·유지 구간 p95·오류율·단계 주석을 계산하고 미수신은 비워 둔다', () => {
    const temp = mkdtempSync(resolve(tmpdir(), 'loadtest-dashboard-promql-'));
    try {
      const file = resolve(temp, 'queries.test.yaml');
      writeFileSync(file, dump({ rule_files: [], evaluation_interval: '1m', tests: [
        { interval: '1m', input_series: [
          // lag 이 분당 60(초당 1)씩 쌓이는 경우와 그대로인 경우.
          { series: `pulsemetry:kafka_committed_lag:sum{${lagLabels}}`, values: '0+60x10' },
          { series: `pulsemetry:kafka_committed_lag:sum{cluster="fixture-eks",kafka_cluster="fixture-kafka",topic="other",consumergroup="fixture-group"}`, values: '100x10' },
          // 유지 구간 OTLP 요청: 90% 는 100ms 이하, 나머지는 1s 이하 → p95 = 100 + 900 × (95−90)/(100−90) = 550ms.
          { series: `k6_http_req_duration_milliseconds_bucket{${k6},name="/v1/logs",phase="hold",le="100"}`, values: '0+90x5' },
          { series: `k6_http_req_duration_milliseconds_bucket{${k6},name="/v1/logs",phase="hold",le="1000"}`, values: '0+100x5' },
          { series: `k6_http_req_duration_milliseconds_bucket{${k6},name="/v1/logs",phase="hold",le="+Inf"}`, values: '0+100x5' },
          // 상승 구간·토큰 교환·다른 실행의 느린 요청은 섞이지 않는다.
          { series: `k6_http_req_duration_milliseconds_bucket{${k6},name="/v1/logs",phase="ramp",le="+Inf"}`, values: '0+1000x5' },
          { series: `k6_http_req_duration_milliseconds_bucket{${k6},name="telemetry-token",phase="hold",le="+Inf"}`, values: '0+1000x5' },
          { series: `k6_http_req_duration_milliseconds_bucket{cluster="fixture-eks",testid="other",name="/v1/logs",phase="hold",le="+Inf"}`, values: '0+1000x5' },
          // 오류율: OTLP 요청 100 중 1 실패. 토큰 교환 실패와 다른 실행은 제외한다.
          { series: `k6_http_req_failed_total{${k6},name="/v1/logs",condition="nonzero"}`, values: '0+1x5' },
          { series: `k6_http_req_failed_total{${k6},name="/v1/logs",condition="zero"}`, values: '0+99x5' },
          { series: `k6_http_req_failed_total{${k6},name="telemetry-token",condition="nonzero"}`, values: '0+50x5' },
          { series: `k6_http_req_failed_total{cluster="fixture-eks",testid="other",name="/v1/logs",condition="nonzero"}`, values: '0+50x5' },
        ], promql_expr_test: [
          { expr: query('lag 기울기 (2분)'), eval_time: '5m', exp_samples: [
            { labels: `{${lagLabels}}`, value: 1 },
          ] },
          // 550 의 부동소수 계산값이다(promtool 은 정확히 비교한다).
          { expr: query('k6 응답 p95·p99 (유지 구간)', 'A'), eval_time: '3m', exp_samples: [{ labels: '{}', value: 549.9999999999998 }] },
          { expr: query('k6 오류율'), eval_time: '3m', exp_samples: [{ labels: '{}', value: 0.01 }] },
        ] },
        // 다른 topic 의 평탄한 lag 은 기울기 0 이다(필터가 topic 을 지킨다).
        { interval: '1m', input_series: [
          { series: `pulsemetry:kafka_committed_lag:sum{${lagLabels}}`, values: '100x10' },
        ], promql_expr_test: [
          { expr: query('lag 기울기 (2분)'), eval_time: '5m', exp_samples: [{ labels: `{${lagLabels}}`, value: 0 }] },
        ] },
        // 목표 RPS 가 5 → 10 으로 바뀐 시각에만 주석이 생긴다.
        { interval: '10s', input_series: [
          { series: `k6_loadtest_target_rps{${k6},scenario="stair"}`, values: '5x5 10x10' },
        ], promql_expr_test: [
          { expr: annotation(), eval_time: '70s', exp_samples: [{ labels: '{}', value: 1 }] },
          { expr: annotation(), eval_time: '30s', exp_samples: [] },
          { expr: annotation(), eval_time: '150s', exp_samples: [] },
        ] },
        // 미실행·미수신은 0 이 아니라 빈 값이다.
        { interval: '1m', input_series: [], promql_expr_test: [
          { expr: query('k6 오류율'), eval_time: '3m', exp_samples: [] },
          { expr: query('k6 응답 p95·p99 (유지 구간)', 'A'), eval_time: '3m', exp_samples: [] },
          { expr: query('Dropped iteration'), eval_time: '3m', exp_samples: [] },
          { expr: query('lag 기울기 (2분)'), eval_time: '3m', exp_samples: [] },
        ] },
      ] }));
      const result = spawnSync(process.env.PROMTOOL_BIN!, ['test', 'rules', file], { encoding: 'utf8' });
      expect([result.status, result.stdout.slice(-3000), result.stderr]).toEqual([0, expect.any(String), '']);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  test('모든 k6 질의는 testid 로 좁히고 서버 질의는 구성요소 service 를 고정한다', () => {
    for (const panel of dashboard.panels) for (const target of panel.targets ?? []) {
      if (/\bk6_/.test(target.expr)) expect([panel.title, target.expr.includes('testid="$testid"')]).toEqual([panel.title, true]);
      if (/pulsemetry_gateway_/.test(target.expr)) expect(target.expr).toContain('service="telemetry-gateway"');
      if (/pulsemetry_pipeline_/.test(target.expr)) expect(target.expr).toContain('service="telemetry-ingest"');
      if (/ClickHouse/.test(target.expr)) expect(target.expr).toContain('service="clickhouse"');
    }
    expect(dashboard.uid).toBe('pulsemetry-loadtest');
    expect(dashboard.title).toBe('Pulsemetry · 부하 시험');
    expect(dashboard.templating.list.map((v: any) => v.name)).toEqual(expect.arrayContaining(['cluster', 'namespace', 'pod', 'testid']));
  });
});
