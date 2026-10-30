import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
const { dump } = require('js-yaml');

const suite = process.env.PROMTOOL_BIN ? describe : describe.skip;
const dashboard = JSON.parse(readFileSync(resolve(__dirname, '../../helm/observability/pulsemetry-observability/dashboards/pulsemetry-k6-readiness.json'), 'utf8'));
const query = (title: string) => dashboard.panels.find((p: any) => p.title === title).targets[0].expr
  .replaceAll('$__rate_interval', '2m').replaceAll('$environment_id', 'perf-fixture')
  .replaceAll('$environment', 'perf').replaceAll('$cluster', 'fixture-eks')
  .replaceAll('$testid', 'fixture-run').replaceAll('$generator_id', 'g0')
  .replaceAll('$generator_namespace', 'pulsemetry-perf-runner').replaceAll('$generator_pod', 'runner-a');

suite('k6 준비도의 구간·가중 집계', () => {
  test('다른 실행·warmup을 제외하고 실패율을 요청 수로 가중하며 미수집은 비워 둔다', () => {
    const labels = 'environment="perf",environment_id="perf-fixture",cluster="fixture-eks",testid="fixture-run",generator_id="g0"';
    const series = (metric: string, extra: string, values: string) => ({ series: `${metric}{${labels},${extra}}`, values });
    const temp = mkdtempSync(resolve(tmpdir(), 'k6-readiness-promql-'));
    try {
      const filename = resolve(temp, 'queries.test.yaml');
      writeFileSync(filename, dump({ rule_files: [], evaluation_interval: '1m', tests: [
        { interval: '1m', input_series: [
          series('k6_otlp_requests_failed_total', 'phase="hold",product="a"', '0+1x5'),
          series('k6_otlp_requests_completed_total', 'phase="hold",product="a"', '0+100x5'),
          series('k6_otlp_requests_failed_total', 'phase="hold",product="b"', '0+1x5'),
          series('k6_otlp_requests_completed_total', 'phase="hold",product="b"', '0+10x5'),
          series('k6_otlp_requests_failed_total', 'phase="warmup",product="a"', '0+1000x5'),
          { series: 'k6_otlp_requests_failed_total{environment="perf",environment_id="perf-fixture",cluster="fixture-eks",testid="other",generator_id="g0",phase="hold"}', values: '0+1000x5' },
          { series: 'container_cpu_usage_seconds_total{environment="perf",cluster="fixture-eks",namespace="pulsemetry-perf-runner",pod="runner-a",container="runner"}', values: '0+36x5' },
          { series: 'kube_pod_container_resource_limits{environment="perf",cluster="fixture-eks",namespace="pulsemetry-perf-runner",pod="runner-a",container="runner",resource="cpu",unit="core"}', values: '2+0x5' },
          { series: 'container_cpu_usage_seconds_total{environment="perf",cluster="fixture-eks",namespace="pulsemetry-perf-runner",pod="other",container="runner"}', values: '0+600x5' },
        ], promql_expr_test: [
          { expr: query('OTLP 실패율 (유지 구간)'), eval_time: '3m', exp_samples: [{ labels: '{}', value: 2 / 110 }] },
          { expr: query('발생기 Pod CPU / quota'), eval_time: '3m', exp_samples: [{ labels: '{}', value: 0.3 }] },
        ] },
        { interval: '1m', input_series: [], promql_expr_test: [
          { expr: query('OTLP 실패율 (유지 구간)'), eval_time: '3m', exp_samples: [] },
          { expr: query('Dropped iteration (실행 전체)'), eval_time: '3m', exp_samples: [] },
          { expr: query('remote-write 최근 표본 나이'), eval_time: '3m', exp_samples: [] },
        ] },
      ] }));
      const result = spawnSync(process.env.PROMTOOL_BIN!, ['test', 'rules', filename], { encoding: 'utf8', timeout: 30_000 });
      expect(result.error).toBeUndefined();
      if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
});
