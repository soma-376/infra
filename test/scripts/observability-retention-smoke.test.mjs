// 검증기가 조회 공백·미생성 파일을 삭제 성공으로 오판하지 않는지 검사한다.
import assert from 'node:assert/strict';
import test from 'node:test';
import { deletionVerdict, isolatedConfigs, metricSum, storageObjects } from '../../scripts/observability-retention-smoke.mjs';

test('보존 판정은 만료전 생존·5분 경과·최초 저장·파일 부재·삭제 작업·Ready를 모두 요구한다', () => {
  const good = { mapped: ['fixture-chunk'], remaining: [], deletedCount: 1, ready: 200, elapsedSeconds: 300, survivalBeforeExpiry: true };
  assert.equal(deletionVerdict(good), true);
  for (const bad of [{ mapped: [] }, { remaining: ['fixture-chunk'] }, { deletedCount: 0 }, { ready: 503 }, { elapsedSeconds: 299 }, { survivalBeforeExpiry: false }]) {
    assert.equal(deletionVerdict({ ...good, ...bad }), false);
  }
  // 실행 중 cache 조회는 기록하되, 별도 재시작 후 세 번의 부재 검사를 대체하지 않는다.
  assert.equal(deletionVerdict({ ...good, query: 'PRESENT' }), true);
});

test('격리 보존 값은 원본 객체와 수신/저장소 계약을 바꾸지 않는다', () => {
  const original = {
    loki: { limits_config: { retention_period: '72h', max_query_lookback: '72h', reject_old_samples_max_age: '72h' },
      ingester: { wal: { replay_memory_ceiling: '512MB' } }, compactor: { retention_enabled: true }, schema_config: { configs: [{ index: { period: '24h' } }] } },
    tempo: { backend_scheduler: { provider: { compaction: { compaction: { block_retention: '48h' } } } },
      backend_worker: { compaction: { block_retention: '48h' } }, storage: { trace: { backend: 'local' } } },
  };
  const before = JSON.stringify(original);
  const result = isolatedConfigs(original);
  assert.equal(JSON.stringify(original), before);
  assert.equal(result.loki.limits_config.retention_period, '5m');
  assert.equal(result.loki.limits_config.reject_old_samples_max_age, '72h');
  assert.equal(result.loki.schema_config.configs[0].index.period, '24h');
  assert.equal(result.tempo.backend_worker.compaction.block_retention, '5m');
  assert.equal(result.tempo.storage.trace.backend, 'local');
  assert.throws(() => isolatedConfigs({ ...original, tempo: { ...original.tempo, backend_worker: undefined } }), /worker도 48h/);
  assert.throws(() => isolatedConfigs({ ...original, tempo: { ...original.tempo, backend_worker: { compaction: { block_retention: '336h' } } } }), /worker도 48h/);
});

test('삭제 지표는 정확한 metric·성공 label만 더한다', () => {
  const input = '# HELP delete_count count\ndelete_count{status="success"} 2\ndelete_count{status="failure"} 5\ndelete_count_extra 99\n';
  assert.equal(metricSum(input, 'delete_count', 'status="success"'), 2);
  assert.equal(metricSum(input, 'absent'), 0);
});

test('Loki 분할 key와 Tempo metadata 삭제 후 남은 data/WAL을 추적한다', () => {
  const block = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const loki = [{ path: `chunks/fake/abc/${Buffer.from('a:b:c').toString('base64')}` }, { path: 'chunks/index/irrelevant' }];
  const tempo = [{ path: `traces/single-tenant/${block}/meta.json` }, { path: `traces/single-tenant/${block}/data.parquet` },
    { path: `live-store/traces/${block}+single-tenant+vParquet5/0001` }, { path: 'traces/single-tenant/index.json.gz' }];
  const initial = storageObjects(loki, tempo);
  assert.equal(initial.loki.length, 1);
  assert.equal(initial.tempo.length, 3);
  const remaining = storageObjects([], tempo.slice(1), initial.tempoBlockIds);
  assert.equal(remaining.tempo.length, 2);
});
