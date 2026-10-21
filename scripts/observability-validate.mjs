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
writeFileSync(resolve(temp, 'prometheus.yaml'), dump({scrape_configs:scrape}));
checked(promtool, ['check', 'config', resolve(temp, 'prometheus.yaml')]);
checked(promtool, ['check', 'rules', resolve(chart, 'rules/pulsemetry.yaml')]);
checked(promtool, ['test', 'rules', resolve(fixtures, 'rules.test.yaml')]);
const dashboards = Object.values(find('ConfigMap', 'pulsemetry-dashboards').data).map(JSON.parse);
assert.equal(dashboards.length, 7);
const expressions = [];
const usedCustomMetrics = new Set();
const usedNativeMetrics = new Set();
for (const dashboard of dashboards) {
  assert.equal(dashboard.timezone, 'utc');
  // 로그 조회는 Logs Insights 스캔 비용이 들어 지표 10초 주기와 분리한다.
  const logs = dashboard.panels.some(panel => (panel.targets ?? []).some(target => target.queryMode === 'Logs'));
  assert.deepEqual([dashboard.refresh, dashboard.time.from], logs ? ['1m', 'now-15m'] : ['10s', 'now-30m'], `${dashboard.uid} 갱신 주기`);
  for (const panel of dashboard.panels) {
    if (panel.type === 'timeseries') {
      assert.equal(panel.fieldConfig.defaults.noValue, '미수집');
      assert.equal(panel.fieldConfig.defaults.custom.spanNulls, false);
      assert.ok(panel.links.some(x => x.url.includes("pulsemetry-diagnostics") && x.url.includes("${pod:queryparam}")));
    }
    for (const target of panel.targets ?? []) {
      if (target.expr) {
        assert.doesNotMatch(target.expr, /or\s+vector\s*\(\s*0\s*\)/);
        const expr = target.expr.replaceAll('$__rate_interval', '1m').replaceAll('$__range', '5m');
        expressions.push({record:`dashboard_query_${expressions.length}`,expr});
        for (const metric of expr.match(/\bpulsemetry_[A-Za-z0-9_]+/g) ?? []) usedCustomMetrics.add(metric);
        for (const metric of expr.match(/\b(?:jvm_|tomcat_|hikaricp_|kafka_producer_|ClickHouse)[A-Za-z0-9_]+/g) ?? []) usedNativeMetrics.add(metric);
        if (/pulsemetry_|ClickHouse|jvm_|hikaricp_|tomcat_|kafka_producer_/.test(expr)) {
          for (const label of ['cluster="$cluster"','namespace="$namespace"','service=~"$service"','pod=~"$pod"']) assert.ok(expr.includes(label), `필터 누락: ${expr}`);
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
writeFileSync(resolve(temp, 'dashboard-queries.yaml'), dump({groups:[{name:'dashboard-query-check',rules:expressions}]}));
checked(promtool, ['check', 'rules', resolve(temp, 'dashboard-queries.yaml')]);
const scrapeFixture = readFileSync(resolve(fixtures, 'fixtures/backend-registry.prom'), 'utf8');
const names = new Set(scrapeFixture.split('\n').filter(x => x && !x.startsWith('#')).map(x => x.split(/[\s{]/)[0]));
for (const metric of usedCustomMetrics) assert.ok(names.has(metric), `실제 registry fixture에 없는 metric: ${metric}`);
const nativeFixture = ['fixtures/gateway-management.prom','fixtures/ingest-management.prom','clickhouse/dashboard-metrics.prom'].map(x => readFileSync(resolve(fixtures,x),'utf8')).join('\n');
const nativeNames = new Set(nativeFixture.split('\n').filter(x => x && !x.startsWith('#')).map(x => x.split(/[\s{]/)[0]));
for (const metric of usedNativeMetrics) assert.ok(nativeNames.has(metric), `실제 local scrape에 없는 metric: ${metric}`);
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
}
const arm64 = JSON.parse(readFileSync(resolve(fixtures,'fixtures/arm64-images.json'),'utf8'));
assert.equal(arm64.status,'PASS'); assert.equal(arm64.images.length,8);
assert.ok(arm64.images.every(x=>x.linux_arm64_digests.length));
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
console.log(`관측 차트/7 dashboards/${expressions.length} PromQL/${load(readFileSync(resolve(chart, "rules/pulsemetry.yaml"), "utf8")).groups.reduce((n,g) => n + g.rules.length, 0)} rules/metric fixture/실패 경계 통과 (live 미실행)`);
