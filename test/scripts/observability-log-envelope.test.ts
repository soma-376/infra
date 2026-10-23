import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEV_TELEMETRY_LOG_EVENTS } from '../../lib/dev/eks-telemetry-alarms';

const { load } = require('js-yaml');
const root = resolve(__dirname, '../..');
const fixtures = resolve(root, 'helm/observability/tests');
const samples = readFileSync(resolve(fixtures, 'fluent-bit/metric-filter-samples.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map(line => JSON.parse(line));
const evidence = JSON.parse(readFileSync(resolve(fixtures, 'fluent-bit/envelope-evidence.json'), 'utf8'));

test('실제 Fluent Bit envelope 샘플이 CDK 실패 event 5종을 하나 이상씩 담고 음성 샘플을 포함한다', () => {
  const events = [...new Set(samples.map(sample => sample.expectedEvent).filter(Boolean))].sort();
  expect(events).toEqual(Object.keys(DEV_TELEMETRY_LOG_EVENTS).sort());
  expect(samples.filter(sample => !sample.expectedEvent).length).toBeGreaterThanOrEqual(3);
  for (const sample of samples) {
    const record = JSON.parse(sample.message);
    // CloudWatch 이벤트에 원문과 식별 metadata가 함께 있어야 한다.
    expect(record).toEqual(expect.objectContaining({ environment: 'dev', log: expect.any(String), stream: expect.any(String) }));
    expect(record.kubernetes).toEqual(expect.objectContaining({ namespace_name: 'pulsemetry-dev', container_name: expect.any(String) }));
    expect(record.kubernetes.annotations).toBeUndefined();
  }
});

test('로컬 대조 스크립트가 각 filter의 기대 샘플만 일치시킨다', () => {
  const result = spawnSync(process.execPath, [resolve(root, 'scripts/observability-metric-filter-check.mjs')], { encoding: 'utf8' });
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
  expect(result.stdout).toContain('PASS: 5개 실패 event filter');
});

test('Fluent Bit은 label로 구성요소를 식별하고 annotation·임의 JSON 병합을 보내지 않는다', () => {
  const values = load(readFileSync(resolve(root, 'helm/dev/runtime/fluent-bit-values.yaml'), 'utf8'));
  const kubernetes = values.config.filters.split('[FILTER]').find((block: string) => /Name kubernetes/.test(block));
  for (const option of ['Merge_Log Off', 'Keep_Log On', 'Labels On', 'Annotations Off']) expect(kubernetes).toContain(option);
  expect(values.config.outputs).not.toMatch(/\blog_key\b/);
});

test('Loki overlay는 CloudWatch 출력을 그대로 두고 label 다섯 개의 Loki 출력만 더한다 (ADR-0039)', () => {
  const base = load(readFileSync(resolve(root, 'helm/dev/runtime/fluent-bit-values.yaml'), 'utf8')).config.outputs;
  const overlay = load(readFileSync(resolve(root, 'helm/dev/runtime/fluent-bit-loki-values.yaml'), 'utf8'));
  expect(Object.keys(overlay)).toEqual(['config']);
  expect(Object.keys(overlay.config)).toEqual(['outputs']);
  expect(overlay.config.outputs.startsWith(base)).toBe(true);
  const added = overlay.config.outputs.slice(base.length);
  expect(added.match(/\[OUTPUT\]/g)).toHaveLength(1);
  expect(added).toMatch(/Name loki/);
  const labels = added.match(/Labels (.*)/)![1].split(',').map((item: string) => item.trim().split('=')[0]);
  expect(labels).toEqual(['environment', 'cluster', 'namespace', 'service_name', 'container']);
  expect(added).not.toMatch(/\blog_key\b/);
});

test('대시보드·런북의 로그 query 필드는 실제 envelope 필드다', () => {
  const fields = new Set([...evidence.topLevelFields, ...evidence.kubernetesFields.map((key: string) => `kubernetes.${key}`)]);
  // 최상위 component·node 필드는 만들지 않는다. 구성요소는 app.kubernetes.io/name label이다.
  expect(fields.has('component')).toBe(false);
  expect(fields.has('node')).toBe(false);
  const dashboard = JSON.parse(readFileSync(resolve(root, 'helm/observability/pulsemetry-observability/dashboards/pulsemetry-diagnostics.json'), 'utf8'));
  const queries = dashboard.panels.flatMap((panel: any) => (panel.targets ?? [])
    .filter((target: any) => target.queryMode === 'Logs' && target.logGroupNames.some((name: string) => /APPLICATION|OBSERVABILITY/.test(name)))
    .map((target: any) => target.expression));
  const runbook = readFileSync(resolve(root, 'docs/runbooks/dev-observability.md'), 'utf8');
  // `app.kubernetes.io/name` 같은 label key는 필드 참조가 아니다.
  const referenced = [...queries, runbook].join('\n').match(/(?<![.\w])kubernetes\.[a-z_]+|\b(?:stream|log|environment|cluster)\b(?=\s*[,|=])/g) ?? [];
  expect(queries.length).toBeGreaterThan(0);
  expect([...new Set(referenced)].filter(field => !fields.has(field))).toEqual([]);
});
