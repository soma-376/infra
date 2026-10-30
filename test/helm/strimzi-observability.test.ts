import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
const { loadAll, load, dump } = require('js-yaml');

const enabled = Boolean(process.env.HELM_BIN && process.env.PROMTOOL_BIN);
const suite = enabled ? describe : describe.skip;
const root = resolve(__dirname, '../..');
const chart = resolve(root, 'helm/observability/pulsemetry-observability');
const fixture = resolve(root, 'helm/observability/tests/strimzi-values.yaml');
const command = (bin: string, args: string[]) => {
  const result = spawnSync(bin, args, { encoding: 'utf8', cwd: root, timeout: 120_000, maxBuffer: 24 * 1024 * 1024 });
  expect(result.error).toBeUndefined();
  if (result.status !== 0) throw new Error(`${bin} ${args.join(" ")}\n${result.stdout.slice(-6000)}\n${result.stderr}`);
  expect(result.stderr).toBe('');
  return result.stdout;
};

suite('Strimzi 관측 계약', () => {
  test('MSK 입력 없이 내부 Pod metrics·경보·대시보드를 렌더하고 실제 PromQL을 검증한다', () => {
    const helm = process.env.HELM_BIN!;
    const promtool = process.env.PROMTOOL_BIN!;
    const temp = mkdtempSync(resolve(tmpdir(), 'strimzi-observability-test-'));
    try {
      const rendered = command(helm, ['template', 'observability', chart, '-n', 'pulsemetry-observability', '-f', fixture]);
      const resources: any[] = loadAll(rendered).filter(Boolean);
      const find = (kind: string, name?: string) => resources.find(x => x.kind === kind && (!name || x.metadata.name === name));
      const monitors = resources.filter(x => x.kind === 'PodMonitor');
      expect(monitors.map(x => x.metadata.name)).toEqual(['strimzi-jmx', 'strimzi-exporter', 'strimzi-cluster-operator', 'strimzi-entity-operator']);
      expect(monitors.map(x => x.spec.podMetricsEndpoints.map((e: any) => e.port))).toEqual([
        ['tcp-prometheus'], ['tcp-prometheus'], ['http'], ['healthcheck-to', 'healthcheck-uo'],
      ]);
      expect(monitors.map(x => x.spec.namespaceSelector.matchNames)).toEqual([
        ['pulsemetry-dev'], ['pulsemetry-dev'], ['strimzi-system'], ['pulsemetry-dev'],
      ]);
      for (const monitor of monitors) {
        expect(monitor.metadata.namespace).toBe('pulsemetry-observability');
        expect(monitor.metadata.labels['observability.pulsemetry.io/stack']).toBe('pulsemetry');
        for (const endpoint of monitor.spec.podMetricsEndpoints) {
          expect(endpoint.relabelings).toContainEqual({ targetLabel: 'cluster', replacement: 'fixture-eks' });
          expect(endpoint.metricRelabelings).toContainEqual({ sourceLabels: ['exported_cluster'], regex: '(.+)', targetLabel: 'kafka_cluster', replacement: '$1' });
        }
      }
      // 공급자 전환 후 MSK endpoint·AWS/Kafka 지표를 조회하지 않는다. 일반 앱/로그 CloudWatch는 유지한다.
      const prometheus = find('Prometheus').spec;
      const scrapeSecret = find('Secret', prometheus.additionalScrapeConfigs.name);
      expect(load(Buffer.from(scrapeSecret.data[prometheus.additionalScrapeConfigs.key], 'base64').toString())).toEqual([]);
      const groups = resources.filter(x => x.kind === 'PrometheusRule').flatMap(x => x.spec.groups);
      expect(JSON.stringify(groups)).not.toMatch(/msk-jmx|msk-node|MskUnder|:msk_/);
      const allRules = groups.flatMap(x => x.rules);
      expect(allRules.map(x => x.alert)).toEqual(expect.arrayContaining([
        'KafkaUnderMinimumIsr', 'KafkaOfflinePartitions', 'KafkaDiskSpaceLow', 'KafkaConsumerLagHigh',
        'KafkaAuthenticationFailures', 'KafkaCertificateExpirySoon', 'KafkaCertificateRenewalObserved', 'KafkaSafetyMetricsMissing',
      ]));
      const strimziRules = find('PrometheusRule', 'pulsemetry-strimzi').spec;
      writeFileSync(resolve(temp, 'strimzi-rendered-rules.yaml'), dump(strimziRules));
      writeFileSync(resolve(temp, 'all-rules.yaml'), dump({ groups }));
      command(promtool, ['check', 'rules', resolve(temp, 'all-rules.yaml')]);
      const tests = load(readFileSync(resolve(root, 'helm/observability/tests/strimzi-rules.test.yaml'), 'utf8'));
      tests.rule_files = [resolve(temp, 'strimzi-rendered-rules.yaml')];
      writeFileSync(resolve(temp, 'rules.test.yaml'), dump(tests));
      command(promtool, ['test', 'rules', resolve(temp, 'rules.test.yaml')]);
      const dashboards: any[] = Object.values(find('ConfigMap', 'pulsemetry-dashboards').data).map(x => JSON.parse(x as string));
      expect(dashboards).toHaveLength(9);
      expect(dashboards.map(x => x.uid)).toContain('pulsemetry-kafka');
      expect(dashboards.filter(x => x.tags.includes('pulsemetry'))).toHaveLength(8);
      const history = dashboards.find(x => x.uid === 'pulsemetry-msk');
      expect(history.title).toContain('전환 전 이력');
      expect(history.tags).toContain('pulsemetry-history');
      expect(history.tags).not.toContain('pulsemetry');
      expect(history.panels).toHaveLength(1);
      expect(history.panels[0].type).toBe('text');
      expect(history.panels[0].targets).toBeUndefined();
      expect(history.panels[0].options.content).toContain('/d/pulsemetry-kafka');
      expect(history.panels[0].options.content).toContain('https://team376.atlassian.net/browse/PROJ-285');
      expect(history.panels[0].options.content).toContain('https://github.com/soma-376/infra/pull/85');
      expect(JSON.stringify(dashboards).match(/AWS\/Kafka|__MSK_CLUSTER__|__BROKER_LOG_GROUP__|msk-jmx|msk-node/g)).toBeNull();
      for (const uid of ['pulsemetry-overview', 'pulsemetry-pipeline', 'pulsemetry-kafka']) {
        const dashboard = dashboards.find(x => x.uid === uid);
        const lag = dashboard.panels.find((p: any) => p.title === '확인된 commit 기준 lag');
        const uncommitted = dashboard.panels.find((p: any) => p.title === '미커밋 partition 수');
        expect(lag.type).toBe('stat');
        expect(lag.targets[0]).toMatchObject({ instant: true, range: false });
        expect(lag.fieldConfig.defaults).toMatchObject({ noValue: '미수집', decimals: 0 });
        expect(lag.options).toMatchObject({ graphMode: 'none', reduceOptions: { calcs: ['lastNotNull'] } });
        expect(lag.targets[0].expr).toContain('pulsemetry:kafka_committed_lag:sum{');
        expect(lag.description).toContain('전체 backlog를 뜻하지 않는다');
        expect(uncommitted.type).toBe('stat');
        expect(uncommitted.targets[0].expr).toContain('pulsemetry:kafka_uncommitted_partitions:count{');
        expect(uncommitted.targets[0].instant).toBe(true);
        expect(uncommitted.targets[0].range).toBe(false);
        expect(uncommitted.fieldConfig.defaults.noValue).toBe('미수집');
        for (const filter of ['cluster="$cluster"', 'kafka_cluster="$kafka_cluster"', 'topic="$topic"', 'consumergroup="$consumer_group"']) {
          expect(lag.targets[0].expr).toContain(filter);
          expect(uncommitted.targets[0].expr).toContain(filter);
        }
        expect(uncommitted.gridPos).toEqual({ x: lag.gridPos.x + 8, y: lag.gridPos.y, w: 4, h: 8 });
        expect(lag.gridPos.w).toBe(8);
        expect(new Set(dashboard.panels.map((p: any) => p.id)).size).toBe(dashboard.panels.length);
      }
      expect(JSON.stringify(dashboards)).not.toContain('kafka_consumergroup_lag{');
      const expressions: any[] = [];
      for (const dashboard of dashboards) for (const panel of dashboard.panels) for (const target of panel.targets ?? []) {
        if (target.expr && (target.datasource?.uid ?? panel.datasource?.uid) === 'pulsemetry-prometheus') {
          expect(target.expr).not.toMatch(/or\s+vector\s*\(\s*0\s*\)/);
          expressions.push({ record: `strimzi_dashboard_query_${expressions.length}`, expr: target.expr.replaceAll('$__rate_interval', '1m').replaceAll('$__range', '5m') });
        }
      }
      writeFileSync(resolve(temp, 'dashboard-queries.yaml'), dump({ groups: [{ name: 'strimzi-dashboard-queries', rules: expressions }] }));
      command(promtool, ['check', 'rules', resolve(temp, 'dashboard-queries.yaml')]);
      // 퇴역 구성요소의 과거 표본은 남아 있어도 현재 상태표에는 합쳐지지 않는다.
      const status = dashboards.find(x => x.uid === 'pulsemetry-overview').panels.find((p: any) => p.title === '구성요소별 수집 상태');
      expect(status.targets[0].expr).toBe('pulsemetry:collection_state');
      const historyTargets = status.targets.filter((t: any) => ['B', 'C'].includes(t.refId));
      for (const target of historyTargets) expect(target.expr).toContain('and on (component, dashboard) pulsemetry:collection_state');
      writeFileSync(resolve(temp, 'collection-query.test.yaml'), dump({
        rule_files: [], evaluation_interval: '1m', tests: [{
          interval: '1m', input_series: [
            { series: 'pulsemetry:collection_state{component="strimzi-exporter",dashboard="pulsemetry-kafka"}', values: '2+0x10' },
            { series: 'pulsemetry:collection_success:ratio{component="strimzi-exporter",dashboard="pulsemetry-kafka"}', values: '1+0x10' },
            { series: 'pulsemetry:collection_last_success:timestamp{component="strimzi-exporter",dashboard="pulsemetry-kafka"}', values: '0+60x10' },
            { series: 'pulsemetry:collection_state{component="msk-jmx",dashboard="pulsemetry-msk"}', values: '2+0x4 stale _ _ _ _ _' },
            { series: 'pulsemetry:collection_success:ratio{component="msk-jmx",dashboard="pulsemetry-msk"}', values: '1+0x4 stale _ _ _ _ _' },
            { series: 'pulsemetry:collection_last_success:timestamp{component="msk-jmx",dashboard="pulsemetry-msk"}', values: '0+60x4 stale _ _ _ _ _' },
            { series: 'pulsemetry:collection_success:ratio{component="strimzi-exporter",dashboard="retired-dashboard"}', values: '1+0x10' },
            { series: 'pulsemetry:collection_last_success:timestamp{component="strimzi-exporter",dashboard="retired-dashboard"}', values: '0+60x10' },
          ],
          promql_expr_test: historyTargets.map((target: any) => ({
            expr: target.expr.replaceAll('$__range', '1h'), eval_time: '10m',
            exp_samples: [{ labels: '{component="strimzi-exporter",dashboard="pulsemetry-kafka"}', value: target.refId === 'B' ? 1 : 0 }],
          })),
        }],
      }));
      command(promtool, ['test', 'rules', resolve(temp, 'collection-query.test.yaml')]);
      const brokerLog = dashboards.find(x => x.uid === 'pulsemetry-diagnostics').panels.find((p: any) => p.title === 'Kafka broker Pod 로그');
      expect(brokerLog.targets[0].logGroupNames).toEqual(['/eks/dev/application']);
      expect(brokerLog.targets[0].expression).toContain('soma-376-dev-telemetry-dual-role-');
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });

  test('MSK 호환 렌더는 Strimzi lag 규칙·미커밋 패널을 추가하지 않는다', () => {
    const rendered = command(process.env.HELM_BIN!, ['template', 'observability', chart, '-n', 'pulsemetry-observability', '-f', resolve(root, 'helm/observability/tests/generated-values.yaml')]);
    const resources: any[] = loadAll(rendered).filter(Boolean);
    const dashboards = Object.values(resources.find(x => x.kind === 'ConfigMap' && x.metadata.name === 'pulsemetry-dashboards').data).map(x => JSON.parse(x as string));
    expect(dashboards.map(x => x.uid)).toContain('pulsemetry-msk');
    expect(dashboards.map(x => x.uid)).not.toContain('pulsemetry-kafka');
    expect(dashboards).toHaveLength(8);
    const msk = dashboards.find(x => x.uid === 'pulsemetry-msk');
    expect(msk.title).toBe('Pulsemetry · MSK');
    expect(msk.tags).toContain('pulsemetry');
    expect(msk.panels.some((p: any) => p.targets?.length)).toBe(true);
    expect(JSON.stringify(dashboards)).not.toContain('and on (component, dashboard) pulsemetry:collection_state');
    expect(JSON.stringify(dashboards)).not.toMatch(/pulsemetry:kafka_committed_lag:sum|pulsemetry:kafka_uncommitted_partitions:count/);
    expect(resources.some(x => x.kind === 'PrometheusRule' && x.metadata.name === 'pulsemetry-strimzi')).toBe(false);
  });

  test.each([
    ['global.pulsemetry.kafkaClusterName=', 'Kafka 이름 누락'],
    ['global.pulsemetry.kafkaProvider=unknown', '알 수 없는 공급자'],
    ['global.pulsemetry.kafkaProvider=msk', 'MSK 전환 시 cluster/broker DNS 입력 누락'],
    ['global.pulsemetry.environment=perf', 'dev 전용 Strimzi 범위'],
  ])('%s: %s는 시작 전에 거부한다', (override) => {
    const result = spawnSync(process.env.HELM_BIN!, ['template', 'observability', chart, '-n', 'pulsemetry-observability', '-f', fixture, '--set', override], { encoding: 'utf8', timeout: 120_000 });
    expect(result.status).not.toBe(0);
  });
});
