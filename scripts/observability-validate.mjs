#!/usr/bin/env node
// 실제 Helm 렌더·PromQL 문법/동작·계측 계약을 검증한다. AWS에 연결하거나 배포하지 않는다.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load, loadAll, dump } from 'js-yaml';
import { validateLokiSelector } from './lib/observability-logql.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const chart = resolve(root, 'helm/observability/pulsemetry-observability');
const fixtures = resolve(root, 'helm/observability/tests');
const helm = process.env.HELM_BIN;
const promtool = process.env.PROMTOOL_BIN;
if (!helm || !promtool) throw new Error('HELM_BIN·PROMTOOL_BIN을 고정 버전 실행 파일로 지정해야 한다');
const temp = mkdtempSync(resolve(tmpdir(), 'observability-check-'));
const checked = (bin, args, options = {}) => {
  const result = spawnSync(bin, args, { cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 24 * 1024 * 1024, ...options });
  assert.equal(result.status, 0, `${bin} ${args.join(' ')}\n${result.stdout}\n${result.stderr}\n${result.error ?? ""}`);
  return result.stdout;
};
const lock = JSON.parse(readFileSync(resolve(root, 'helm/observability/dependencies.lock.json'), 'utf8'));
const archive = readFileSync(resolve(chart, 'charts', `${lock.chart.name}-${lock.chart.version}.tgz`));
assert.equal(createHash('sha256').update(archive).digest('hex'), lock.chart.sha256);
assert.match(checked(promtool, ['--version']), /version 3\.9\.1\b/);
const fixture = resolve(fixtures, 'generated-values.yaml');
const base = ['template', 'observability', chart, '-n', 'pulsemetry-observability', '-f', fixture];
checked(helm, ['lint', chart, '-n', 'pulsemetry-observability', '-f', fixture]);
const rendered = checked(helm, base);
const resources = loadAll(rendered).filter(Boolean);
const find = (kind, name) => {
  const result = resources.find(x => x.kind === kind && (!name || x.metadata.name === name));
  assert.ok(result, `missing ${kind}/${name}`);
  return result;
};
for (const resource of resources) {
  if (resource.kind === 'Service') assert.equal(resource.spec.type ?? 'ClusterIP', 'ClusterIP');
  assert.notEqual(resource.kind, 'Ingress');
  if (['Deployment', 'Job'].includes(resource.kind)) {
    const pod = resource.spec.template.spec;
    assert.equal(pod.nodeSelector['kubernetes.io/arch'], 'arm64');
    assert.equal(pod.nodeSelector['pulsemetry.io/workload'], 'observability');
    assert.ok(pod.tolerations.some(x => x.key === 'workload' && x.value === 'observability'));
  }
}
const prometheus = find('Prometheus').spec;
assert.equal(prometheus.retention, '7d');
assert.equal(prometheus.retentionSize, '20GB');
assert.equal(prometheus.storage.volumeClaimTemplate.spec.resources.requests.storage, '30Gi');
assert.equal(prometheus.scrapeInterval, '10s');
assert.equal(prometheus.scrapeNativeHistograms, true);
assert.equal(prometheus.enableRemoteWriteReceiver, true);
assert.deepEqual(prometheus.serviceMonitorNamespaceSelector, {matchLabels: {'kubernetes.io/metadata.name': 'pulsemetry-observability'}});
assert.equal(prometheus.persistentVolumeClaimRetentionPolicy.whenDeleted, 'Retain');
const grafana = find('Deployment', 'pulsemetry-grafana').spec.template.spec;
assert.equal(grafana.serviceAccountName, 'grafana');
assert.ok(grafana.containers[0].env.some(x => x.name === 'GF_SECURITY_ADMIN_PASSWORD__FILE'));
assert.ok(!resources.some(x => x.kind === 'Secret' && x.data?.['admin-password']));
assert.ok(!find('SecretProviderClass').spec.secretObjects);
assert.equal(find('PersistentVolumeClaim', 'pulsemetry-grafana').spec.resources.requests.storage, '5Gi');
assert.equal(find('Deployment', 'kubernetes-events').spec.replicas, 1);
assert.equal(find('Deployment', 'kubernetes-events').spec.strategy.type, 'Recreate');
assert.equal(find('PersistentVolumeClaim', 'kubernetes-events-state').spec.resources.requests.storage, '1Gi');
assert.deepEqual(find('ClusterRole', 'pulsemetry-observability-events').rules, [{apiGroups:[''],resources:['events'],verbs:['get','list','watch']}]);
const nodeExporter = resources.find(x => x.kind === 'DaemonSet');
assert.ok(nodeExporter.spec.template.spec.tolerations.some(x => x.operator === 'Exists' && !x.key));
for (const [name, path] of [['telemetry-gateway', '/actuator/prometheus'], ['telemetry-ingest', '/actuator/prometheus'], ['clickhouse', '/metrics']]) {
  const monitor = find('ServiceMonitor', name).spec;
  assert.deepEqual(monitor.namespaceSelector.matchNames, ['pulsemetry-dev']);
  assert.equal(monitor.endpoints[0].port, 'metrics');
  assert.equal(monitor.endpoints[0].path, path);
}
// cAdvisor·probes도 별도 relabel 설정을 받아야 cluster 필터에서 사라지지 않는다.
const kubeletMonitor = resources.find(x => x.kind==='ServiceMonitor' && x.metadata.name.endsWith('-kubelet'));
for (const endpoint of kubeletMonitor.spec.endpoints) {
  assert.ok(endpoint.relabelings.some(x=>x.targetLabel==='cluster' && x.replacement==='fixture-eks'));
  assert.ok(endpoint.relabelings.some(x=>x.targetLabel==='environment' && x.replacement==='dev'));
}
const scrapeSecret = find('Secret', prometheus.additionalScrapeConfigs.name);
const scrape = load(Buffer.from(scrapeSecret.data[prometheus.additionalScrapeConfigs.key], 'base64').toString());
assert.equal(scrape.length, 2);
for (const [i, port] of [11001, 11002].entries()) {
  assert.equal(scrape[i].static_configs[0].targets.length, 3);
  assert.ok(scrape[i].static_configs[0].targets.every(x => x.endsWith(`:${port}`)));
}
// MSK JMX endpoint는 10초 간격에서 429로 표본을 거부했다. 간격을 되돌리면 JMX rate 패널의 범위도 다시 정해야 한다.
assert.deepEqual([scrape[0].job_name, scrape[0].scrape_interval, scrape[0].scrape_timeout], ['msk-jmx', '60s', '10s']);
writeFileSync(resolve(temp, 'prometheus.yaml'), dump({scrape_configs:scrape}));
checked(promtool, ['check', 'config', resolve(temp, 'prometheus.yaml')]);
checked(promtool, ['check', 'rules', resolve(chart, 'rules/pulsemetry.yaml')]);
checked(promtool, ['test', 'rules', resolve(fixtures, 'rules.test.yaml')]);
const dashboards = Object.values(find('ConfigMap', 'pulsemetry-dashboards').data).map(JSON.parse);
assert.equal(dashboards.length, 8);
assert.ok(dashboards.some(x => x.uid === 'pulsemetry-traces'), 'trace 대시보드(ADR-0039)');
// 빈 패널 문구는 이유를 구분하는 고정 집합만 쓴다. 0이나 숫자로 빈값을 덮지 않는다.
const noValueTexts = new Set([
  '미수집',
  '값 없음 · 첫 화면 수집 상태 확인',
  'Kafka 미적용(http) 또는 미수집 · 모드 패널 확인',
  '값 없음 · 종료 이력 없음 또는 미수집',
  '값 없음 · Gateway는 Hikari 미적용',
  '값 없음 · k6 미실행 또는 미수신 · testid·기간 확인',
  '값 없음 · 미발생·미실행·미수신 가능 · testid·기간 확인',
]);
// Loki stream label은 Fluent Bit Loki 출력의 다섯 개뿐이다(ADR-0039).
const lokiLabels = new Set(['environment', 'cluster', 'namespace', 'service_name', 'container']);
const targetUid = (target, panel) => target.datasource?.uid ?? panel.datasource?.uid;
const usedPlatformMetrics = new Set();
const expressions = [];
const usedCustomMetrics = new Set();
const usedNativeMetrics = new Set();
for (const dashboard of dashboards) {
  assert.equal(dashboard.timezone, 'utc');
  // 로그·trace 조회는 Logs Insights 스캔 비용·Tempo 검색 비용이 들어 지표 10초 주기와 분리한다.
  const logs = dashboard.panels.some(panel => (panel.targets ?? []).some(target => target.queryMode === 'Logs'
    || ['pulsemetry-loki', 'pulsemetry-tempo'].includes(targetUid(target, panel))));
  assert.deepEqual([dashboard.refresh, dashboard.time.from], logs ? ['1m', 'now-15m'] : ['10s', 'now-30m'], `${dashboard.uid} 갱신 주기`);
  for (const panel of dashboard.panels) {
    if (panel.type === 'timeseries') {
      assert.ok(noValueTexts.has(panel.fieldConfig.defaults.noValue), `${dashboard.uid}/${panel.title} noValue: ${panel.fieldConfig.defaults.noValue}`);
      assert.ok(panel.description?.trim(), `${dashboard.uid}/${panel.title} 설명 없음`);
      assert.equal(panel.fieldConfig.defaults.custom.spanNulls, false);
      assert.ok(panel.links.some(x => x.url.includes("pulsemetry-diagnostics") && x.url.includes("${pod:queryparam}")));
    }
    for (const target of panel.targets ?? []) {
      const uid = targetUid(target, panel);
      if (uid === 'pulsemetry-loki') {
        // LogQL은 promtool로 검사하지 않는다. 환경·클러스터로 좁히고 허용 label만 쓴다.
        validateLokiSelector(target.expr, lokiLabels);
        continue;
      }
      if (uid === 'pulsemetry-tempo') {
        assert.equal(dashboard.uid, 'pulsemetry-traces', 'TraceQL 패널은 trace 대시보드에만 둔다');
        assert.equal(target.queryType, 'traceql');
        assert.ok(target.query.trim().startsWith('{'), `TraceQL: ${target.query}`);
        continue;
      }
      if (target.expr) {
        assert.equal(uid, 'pulsemetry-prometheus', `${dashboard.uid}/${panel.title} PromQL datasource`);
        assert.doesNotMatch(target.expr, /or\s+vector\s*\(\s*0\s*\)/);
        for (const metric of target.expr.match(/\b(?:loki_|tempo_|otelcol_)[a-z0-9_]+/g) ?? []) usedPlatformMetrics.add(metric);
        // datasource 기본 간격(10s)의 $__rate_interval은 60초 JMX 표본을 담지 못한다.
        if (target.expr.includes('job="msk-jmx"')) {
          assert.equal(panel.interval, '1m', `${dashboard.uid}/${panel.title} JMX 최소 간격`);
          // $__rate_interval의 scrape 간격 항은 쿼리 Min step(target.interval)만 따른다. 패널 Min interval은 반영되지 않는다.
          if (target.expr.includes('$__rate_interval')) assert.equal(target.interval, '1m', `${dashboard.uid}/${panel.title} JMX rate 쿼리 Min step`);
        }
        const expr = target.expr.replaceAll('$__rate_interval', '1m').replaceAll('$__range', '5m');
        expressions.push({record:`dashboard_query_${expressions.length}`,expr});
        for (const metric of expr.match(/\bpulsemetry_[A-Za-z0-9_]+/g) ?? []) usedCustomMetrics.add(metric);
        for (const metric of expr.match(/\b(?:jvm_|tomcat_|hikaricp_|kafka_producer_|ClickHouse)[A-Za-z0-9_]+/g) ?? []) usedNativeMetrics.add(metric);
        if (/pulsemetry_|ClickHouse|jvm_|hikaricp_|tomcat_|kafka_producer_/.test(expr)) {
          for (const label of ['cluster="$cluster"','namespace="$namespace"','pod=~"$pod"']) assert.ok(expr.includes(label), `필터 누락: ${expr}`);
          // ClickHouse 화면은 서버 지표(clickhouse)와 ingest의 앱 지표를 서비스 선택과 분리해 고정 service로 조회한다.
          if (dashboard.uid === 'pulsemetry-clickhouse') {
            assert.ok(expr.includes(/pulsemetry_clickhouse_/.test(expr) ? 'service="telemetry-ingest"' : 'service="clickhouse"'), `ClickHouse service 고정 누락: ${expr}`);
          } else assert.ok(expr.includes('service=~"$service"'), `필터 누락: ${expr}`);
        }
      }
      if (target.queryMode === 'Logs') {
        assert.ok(!target.expression.includes('like /ERROR|WARN'));
        assert.equal(target.region, 'ap-northeast-2');
        assert.ok(!JSON.stringify(target).includes('__CONTROL_PLANE_LOG_GROUP__'));
      }
      if (target.queryMode === 'Metrics') {
        assert.equal(target.period, '60');
        if (target.metricName.includes('Lag')) assert.deepEqual(Object.keys(target.dimensions).sort(), ['Cluster Name', 'Consumer Group', 'Topic']);
      }
    }
  }
}
// 첫 화면은 구성요소별 수집 상태를 먼저 보여 준다. 상태 값의 의미는 rules/pulsemetry.yaml의 collection group과 같다.
const overview = dashboards.find(x => x.uid === 'pulsemetry-overview');
const summary = overview.panels.find(x => x.gridPos.y === 0);
assert.equal(summary?.type, 'table', '수집 경로 첫 행에 수집 상태 표가 없다');
assert.deepEqual(summary.targets.map(x => x.expr.match(/pulsemetry:collection_[a-z_]+:?[a-z0-9]*/)?.[0]),
  ['pulsemetry:collection_state', 'pulsemetry:collection_success:ratio', 'pulsemetry:collection_last_success:timestamp']);
const stateMapping = summary.fieldConfig.overrides.find(x => x.matcher.options === '현재 상태').properties.find(x => x.id === 'mappings').value[0].options;
assert.deepEqual(Object.keys(stateMapping).sort(), ['-1', '-2', '0', '1', '2']);
writeFileSync(resolve(temp, 'dashboard-queries.yaml'), dump({groups:[{name:'dashboard-query-check',rules:expressions}]}));
checked(promtool, ['check', 'rules', resolve(temp, 'dashboard-queries.yaml')]);
// Backend 사본은 생성 commit과 SHA256을 함께 고정한다. 사본을 바꾸면 provenance도 같이 바꾼다.
const provenance = JSON.parse(readFileSync(resolve(fixtures, 'fixtures/provenance.json'), 'utf8'));
assert.match(provenance.source.commit, /^[0-9a-f]{40}$/);
for (const item of provenance.fixtures) {
  assert.equal(createHash('sha256').update(readFileSync(resolve(fixtures, 'fixtures', item.file))).digest('hex'), item.sha256, `${item.file} SHA256이 provenance와 다르다`);
}
// registry 단위 테스트와 두 앱의 실제 HTTP scrape 중 하나에는 있어야 한다(listener_running은 ingest 실행 시에만 생긴다).
const scrapeFixture = ['backend-registry.prom','gateway-management.prom','ingest-management.prom'].map(x => readFileSync(resolve(fixtures, 'fixtures', x), 'utf8')).join('\n');
const names = new Set(scrapeFixture.split('\n').filter(x => x && !x.startsWith('#')).map(x => x.split(/[\s{]/)[0]));
for (const metric of usedCustomMetrics) assert.ok(names.has(metric), `실제 registry fixture에 없는 metric: ${metric}`);
// 재시도 소진·commit 실패 경보와 패널의 increase()는 Backend가 실패 전부터 0으로 노출한다는 전제다. ingest HTTP scrape로 확인한다.
const ingestScrape = readFileSync(resolve(fixtures, 'fixtures/ingest-management.prom'), 'utf8');
for (const metric of ['pulsemetry_pipeline_retry_exhausted_total', 'pulsemetry_pipeline_commit_failures_total']) {
  assert.match(ingestScrape, new RegExp(`^${metric}\\{`, 'm'), `ingest scrape에 실패 전 노출된 ${metric}가 없다`);
}
const nativeFixture = ['fixtures/gateway-management.prom','fixtures/ingest-management.prom','clickhouse/dashboard-metrics.prom'].map(x => readFileSync(resolve(fixtures,x),'utf8')).join('\n');
const nativeNames = new Set(nativeFixture.split('\n').filter(x => x && !x.startsWith('#')).map(x => x.split(/[\s{]/)[0]));
for (const metric of usedNativeMetrics) assert.ok(nativeNames.has(metric), `실제 local scrape에 없는 metric: ${metric}`);
// Loki·Tempo·Collector 지표 이름은 고정 이미지의 실제 /metrics에서 뽑은 목록과 대조한다(ADR-0039).
const platformNames = new Set(readFileSync(resolve(fixtures, 'fixtures/platform-trace-metrics.prom'), 'utf8').split('\n').filter(x => x && !x.startsWith('#')));
for (const rule of load(readFileSync(resolve(chart, 'rules/pulsemetry.yaml'), 'utf8')).groups.flatMap(g => g.rules)) {
  for (const metric of rule.expr.match(/\b(?:loki_|tempo_|otelcol_)[a-z0-9_]+/g) ?? []) usedPlatformMetrics.add(metric);
}
for (const metric of usedPlatformMetrics) assert.ok(platformNames.has(metric), `실제 /metrics에 없는 지표: ${metric}`);
// datasource는 기존 둘에 Loki·Tempo를 더한 네 개다. prune: true라 배열 전체가 선언이다.
const datasources = load(find('ConfigMap', 'pulsemetry-grafana').data['datasources.yaml']).datasources;
assert.deepEqual(datasources.map(x => x.uid), ['pulsemetry-prometheus', 'pulsemetry-cloudwatch', 'pulsemetry-loki', 'pulsemetry-tempo']);
assert.deepEqual(datasources.filter(x => x.isDefault).map(x => x.uid), ['pulsemetry-prometheus']);
const lokiSource = datasources.find(x => x.uid === 'pulsemetry-loki');
const tempoSource = datasources.find(x => x.uid === 'pulsemetry-tempo');
assert.equal(lokiSource.url, 'http://pulsemetry-loki.pulsemetry-observability.svc:3100');
assert.equal(tempoSource.url, 'http://pulsemetry-tempo.pulsemetry-observability.svc:3200');
assert.deepEqual(lokiSource.jsonData.derivedFields.map(x => [x.matcherRegex, x.datasourceUid, x.url]), [['trace_id=([0-9a-f]{32})', 'pulsemetry-tempo', '$${__value.raw}']]);
assert.equal(tempoSource.jsonData.tracesToLogsV2.datasourceUid, 'pulsemetry-loki');
assert.equal(tempoSource.jsonData.tracesToLogsV2.query, '{$${__tags}} |= "trace_id=$${__trace.traceId}"');
for (const tag of tempoSource.jsonData.tracesToLogsV2.tags) assert.ok(lokiLabels.has(tag.value), `trace→logs tag는 Loki label이다: ${tag.value}`);
for (const [name, port] of [['loki', 'http-metrics'], ['tempo', 'tempo-prom-metrics'], ['otel-platform', 'metrics']]) {
  const monitor = find('ServiceMonitor', name).spec;
  assert.deepEqual(monitor.namespaceSelector.matchNames, ['pulsemetry-observability']);
  assert.deepEqual([monitor.endpoints[0].port, monitor.endpoints[0].path], [port, '/metrics']);
  assert.ok(monitor.endpoints[0].relabelings.some(x => x.targetLabel === 'job' && x.replacement === name));
}
const fluentFixture = readFileSync(resolve(fixtures,'fluent-bit/v2-metrics.prom'),'utf8');
const fluentNames = new Set(fluentFixture.split('\n').flatMap(x=>x.startsWith('# TYPE ')?[x.split(' ')[2]]:(!x || x.startsWith('#')?[]:[x.split(/[\s{]/)[0]])));
for (const rule of expressions) for (const metric of rule.expr.match(/\bfluentbit_[a-z0-9_]+/g)??[]) assert.ok(fluentNames.has(metric),`v2 fixture에 없는 metric: ${metric}`);
for (const name of ['fluent-bit','kubernetes-events']) {
  const endpoints=find('ServiceMonitor',name).spec.endpoints;
  assert.equal(endpoints.length,1);assert.equal(endpoints[0].path,'/api/v2/metrics/prometheus');
}
// 실제 Backend scrape의 앱 공통 tag는 target label과 겹친다. honorLabels=false라 exported_* 사본이 생기므로 버린다.
const appTags = ['gateway-management.prom','ingest-management.prom'].map(x => readFileSync(resolve(fixtures,'fixtures',x),'utf8'));
for (const tag of ['application','environment','service']) assert.ok(appTags.every(text => text.includes(`${tag}="`)), `앱 scrape에 ${tag} tag 없음`);
for (const name of ['telemetry-gateway','telemetry-ingest','clickhouse']) {
  const endpoint=find('ServiceMonitor',name).spec.endpoints[0];
  assert.equal(endpoint.honorLabels,false);
  const dropped = endpoint.metricRelabelings.filter(x => x.action==='labeldrop').map(x => new RegExp(`^(?:${x.regex})$`));
  for (const label of ['exported_application','exported_environment','exported_service','tenant_id']) assert.ok(dropped.some(x => x.test(label)), `${name}: ${label} 미삭제`);
  for (const label of ['application','environment','service','cluster','signal','outcome']) assert.ok(!dropped.some(x => x.test(label)), `${name}: ${label}를 지우면 안 된다`);
  for (const [targetLabel,replacement] of [['cluster','fixture-eks'],['environment','dev'],['service',name]]) {
    assert.ok(endpoint.relabelings.some(x => x.targetLabel===targetLabel && x.replacement===replacement));
  }
  const mode = endpoint.relabelings.filter(x => x.targetLabel === 'ingest_mode');
  assert.deepEqual(mode.map(x => x.sourceLabels), name === 'telemetry-ingest' ? [['__meta_kubernetes_pod_annotation_pulsemetry_io_ingest_mode']] : [], `${name}: ingest_mode relabel`);
}
const arm64 = JSON.parse(readFileSync(resolve(fixtures,'fixtures/arm64-images.json'),'utf8'));
assert.equal(arm64.status,'PASS'); assert.equal(arm64.images.length,8);
assert.ok(arm64.images.every(x=>x.linux_arm64_digests.length));
// 렌더된 모든 실행 이미지는 ARM64 증거의 tag와 multi-arch index digest를 함께 가진다.
const pinned = new Map(arm64.images.map(x => [x.image.replace(/^docker\.io\//, ''), `sha256:${x.manifest_index_sha256}`]));
const running = [prometheus.image, ...resources.filter(x => ['Deployment','DaemonSet','Job'].includes(x.kind))
  .flatMap(x => [...(x.spec.template.spec.initContainers ?? []), ...x.spec.template.spec.containers]).map(x => x.image),
  ...find('Deployment','pulsemetry-monitoring-operator').spec.template.spec.containers[0].args
    .filter(x => x.startsWith('--prometheus-config-reloader=')).map(x => x.split('=')[1])];
assert.equal(new Set(running.map(x => x.split('@')[0])).size, pinned.size, `실행 이미지 종류: ${[...new Set(running)]}`);
for (const image of running) {
  const [reference, digest] = image.replace(/^docker\.io\//, '').split('@');
  assert.equal(digest, pinned.get(reference), `digest 미고정 또는 증거와 다름: ${image}`);
}
// perf values는 주소·식별자를 복제하지 않고 같은 차트의 환경 입력만 바꾼다.
const perf = loadAll(checked(helm, [...base, '-f', resolve(root, 'helm/observability/values-perf.yaml')])).filter(Boolean);
assert.deepEqual(perf.find(x => x.kind === 'ServiceMonitor' && x.metadata.name === 'telemetry-gateway').spec.namespaceSelector.matchNames, ['pulsemetry-perf']);
const regionalFixture = load(readFileSync(fixture,'utf8'));
regionalFixture.global.pulsemetry.region='eu-west-1';
regionalFixture.global.pulsemetry.grafanaAdminSecretArn=regionalFixture.global.pulsemetry.grafanaAdminSecretArn.replace('ap-northeast-2','eu-west-1');
regionalFixture.global.pulsemetry.mskBrokers=regionalFixture.global.pulsemetry.mskBrokers.map(x=>x.replace('ap-northeast-2','eu-west-1'));
const regionalPath=resolve(temp,'regional.yaml');writeFileSync(regionalPath,dump(regionalFixture));
const regional = loadAll(checked(helm,[...base,'-f',regionalPath])).filter(Boolean);
assert.equal(regional.find(x=>x.kind==='Deployment'&&x.metadata.name==='pulsemetry-grafana').spec.template.spec.containers[0].env.find(x=>x.name==='AWS_REGION').value,'eu-west-1');
for (const overrides of [
  ['--set', 'global.pulsemetry.mskBrokers={b-1.fixture.c2.kafka.ap-northeast-2.amazonaws.com}'],
  ['--set', 'monitoring.grafana.service.type=LoadBalancer'],
  ['--set', 'monitoring.prometheus.ingress.enabled=true'],
  ['--set', 'monitoring.grafana.adminPassword=not-a-real-secret'],
  ['--set', 'global.pulsemetry.targetNamespace=unrelated'],
]) {
  const failed = spawnSync(helm, [...base, ...overrides], {cwd:root,encoding:'utf8'});
  assert.notEqual(failed.status, 0, `잘못된 입력이 허용됨: ${overrides.join(' ')}`);
}
if (process.env.KUBECONFORM_BIN) {
  // dependency의 CRD schema 자체를 사용하여 Prometheus/ServiceMonitor/Rule 객체를 검증한다.
  const crds = loadAll(checked(helm, ['show','crds',resolve(chart,'charts',`${lock.chart.name}-${lock.chart.version}.tgz`)])).filter(Boolean);
  const schemaDir = resolve(temp, 'schemas'); mkdirSync(schemaDir);
  for (const crd of crds) for (const version of crd.spec.versions) {
    const schema = version.schema.openAPIV3Schema;
    schema.additionalProperties = false;
    writeFileSync(resolve(schemaDir, `${crd.spec.names.kind.toLowerCase()}_${crd.spec.group}_${version.name}.json`), JSON.stringify(schema));
  }
  const monitoringResources = resources.filter(x => x.apiVersion.startsWith('monitoring.coreos.com/'));
  const path = resolve(temp, 'monitoring.yaml'); writeFileSync(path, monitoringResources.map(x => dump(x)).join('---\n'));
  checked(process.env.KUBECONFORM_BIN, ['-strict','-summary','-schema-location',`${schemaDir}/{{.ResourceKind}}_{{.Group}}_{{.ResourceAPIVersion}}.json`,path]);
}
console.log(`관측 차트/8 dashboards/${expressions.length} PromQL/${load(readFileSync(resolve(chart, "rules/pulsemetry.yaml"), "utf8")).groups.reduce((n,g) => n + g.rules.length, 0)} rules/metric fixture/실패 경계 통과 (live 미실행)`);
