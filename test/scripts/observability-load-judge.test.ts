import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

// Loki 용량·Fluent Bit 병행 시험의 판정을 Docker 없이 실패 사례로 회귀 시험한다(ADR-0039).
const call = (fn: string, ...args: unknown[]) => {
  const result = spawnSync(process.execPath, [resolve(__dirname, 'fixtures/load-judge-call.mjs')], { input: JSON.stringify({ fn, args }), encoding: 'utf8' });
  expect(result.stderr).toBe('');
  return JSON.parse(result.stdout);
};
const MiB = 1024 * 1024;
const ctx = { rate: 2 * MiB, burst: 4 * MiB, ceilingBytes: 512 * MiB, criteria: { anonPeakRatio: 0.8, anonSlopeMiBPerMinute: 2 } };
const lines = (extra = {}) => ({ matches: true, errorBatches: 0, rejectedBatches: 0, ...extra });
const queries = (n: number) => Array.from({ length: n }, () => ({ status: 200 }));
const memory = { anonSlopeMiBPerMinute: 0, sampledAnonMaxRatio: 0.4, oomKill: 0 };
const sustained = (extra = {}) => ({
  offeredBytes: 1.9 * MiB * 1800, acceptedBytes: 1.9 * MiB * 1800, pushSeconds: 1800, lines: lines(), queries: queries(30), memory, ...extra,
});

describe('Loki 용량 시험 판정', () => {
  test('정상 지속 수신은 통과한다', () => {
    expect(call('judgeCapacity', 'sustained', sustained(), { ...ctx, targetBytesPerSecond: 1.9 * MiB })).toEqual([]);
  });

  test('모든 요청이 429로 거절되면 "수락 0줄 = 조회 0줄"이어도 실패다', () => {
    const failures = call('judgeCapacity', 'sustained', sustained({ acceptedBytes: 0, lines: lines({ rejectedBatches: 6800 }) }), { ...ctx, targetBytesPerSecond: 1.9 * MiB });
    expect(failures.join('\n')).toContain('99%에 못 미쳤다');
    expect(failures.join('\n')).toContain('거절 batch');
  });

  test('생성기가 목표 부하를 내지 못하면 실패다', () => {
    const failures = call('judgeCapacity', 'sustained', sustained({ offeredBytes: 0.5 * MiB * 1800, acceptedBytes: 0.5 * MiB * 1800 }), { ...ctx, targetBytesPerSecond: 1.9 * MiB });
    expect(failures.join('\n')).toContain('목표의 90%');
  });

  test('초과 수신의 처리율은 부하를 넣은 시간으로 나눈다 — 끝난 뒤 기다린 시간은 넣지 않는다', () => {
    // 이전 증거: 수락 1203.7MiB, 부하 600초, 끝난 뒤 30초 대기. 600초로 나누면 2.0MiB/s다.
    expect(call('perSecond', 1203.7 * MiB, 600) / MiB).toBeCloseTo(2.006, 2);
    const phase = { offeredBytes: 5.5 * MiB * 600, acceptedBytes: 1203.7 * MiB, pushSeconds: 600, lines: lines({ rejectedBatches: 4189 }) };
    expect(call('judgeCapacity', 'overload', phase, { ...ctx, targetBytesPerSecond: 5.5 * MiB })).toEqual([]);
  });

  test('초과 수신에서 상한보다 많이 받거나 429가 없으면 실패다', () => {
    const over = { offeredBytes: 5.5 * MiB * 600, acceptedBytes: 3 * MiB * 600, pushSeconds: 600, lines: lines({ rejectedBatches: 10 }) };
    expect(call('judgeCapacity', 'overload', over, { ...ctx, targetBytesPerSecond: 5.5 * MiB }).join('\n')).toContain('상한을 넘었다');
    const noLimit = { ...over, acceptedBytes: 2 * MiB * 600, lines: lines() };
    expect(call('judgeCapacity', 'overload', noLimit, { ...ctx, targetBytesPerSecond: 5.5 * MiB }).join('\n')).toContain('429가 나지 않았다');
  });

  test('WAL 수락량이 복구 상한보다 작으면 상한을 시험하지 못한 것이다', () => {
    const phase = { offeredBytes: 300 * MiB, acceptedBytes: 300 * MiB, pushSeconds: 300, lines: lines(), ready: true };
    expect(call('judgeCapacity', 'wal', phase, { ...ctx, targetBytesPerSecond: 0.98 * MiB }).join('\n')).toContain('복구 상한');
  });

  test('OOM·재시작·anon 초과는 실패다', () => {
    const state = { running: true, oomKilled: false, restartCount: 0 };
    expect(call('judgeHealth', { memory, state }, { anonPeakRatio: 0.8 })).toEqual([]);
    expect(call('judgeHealth', { memory: { ...memory, oomKill: 1 }, state }, { anonPeakRatio: 0.8 })).toHaveLength(1);
    expect(call('judgeHealth', { memory: { ...memory, sampledAnonMaxRatio: 0.9 }, state: { ...state, restartCount: 1 } }, { anonPeakRatio: 0.8 })).toHaveLength(2);
  });
});

describe('부하 시험 최종 판정', () => {
  test('같은 단계 이름을 반복해도 다른 필수 단계를 대신하지 않는다', () => {
    const phases = call('uniquePhases', 'sustained,sustained,sustained,sustained');
    expect(phases).toEqual(['sustained']);
    expect(call('finalStatus', { required: ['sustained', 'overload', 'burst', 'wal'], completed: phases, full: true, failures: [] })).toBe('SHORT_RUN');
  });

  test('실패가 있으면 FAIL, 필수 단계를 기본 시간으로 모두 마쳐야 PASS다', () => {
    const required = ['normal', 'overload', 'outage'];
    expect(call('finalStatus', { required, completed: required, full: true, failures: ['x'] })).toBe('FAIL');
    expect(call('finalStatus', { required, completed: required, full: false, failures: [] })).toBe('SHORT_RUN');
    expect(call('finalStatus', { required, completed: required, full: true, failures: [] })).toBe('PASS');
  });
});

describe('Fluent Bit 병행 시험 판정', () => {
  const fb = (loki = {}) => ({ http: { dropped_records_total: 0 }, loki: { dropped_records_total: 0, retries_failed_total: 0, retries_total: 5, ...loki } });
  test('장애 복구에서 Loki 로그를 잃으면 대역 출력이 온전해도 실패다', () => {
    const failures = call('judgeHarness', 'outage', { written: 36000, standInMissing: 0, lokiCount: 0, lokiLost: 36000, fluentBit: fb({ dropped_records_total: 36000 }) });
    expect(failures.join('\n')).toContain('Loki 누락 36000');
  });

  test('장애에 재시도가 없었으면 장애가 실제로 걸렸는지 알 수 없다', () => {
    expect(call('judgeHarness', 'outage', { written: 36000, standInMissing: 0, lokiCount: 36000, lokiLost: 0, fluentBit: fb({ retries_total: 0 }) }).join('\n')).toContain('재시도가 없었다');
  });

  test('상한 초과의 Loki 손실은 drop 지표로 모두 설명돼야 한다', () => {
    const base = { written: 659076, standInMissing: 0, lokiCount: 374970, lokiLost: 284106 };
    expect(call('judgeHarness', 'overload', { ...base, fluentBit: fb({ dropped_records_total: 284106 }) })).toEqual([]);
    expect(call('judgeHarness', 'overload', { ...base, fluentBit: fb({ dropped_records_total: 1000 }) }).join('\n')).toContain('설명되지 않는다');
  });

  test('CloudWatch 대역 누락은 어느 단계에서도 실패다', () => {
    expect(call('judgeHarness', 'overload', { written: 10, standInMissing: 1, lokiCount: 9, lokiLost: 1, fluentBit: fb({ dropped_records_total: 1 }) }).join('\n')).toContain('대역 누락');
  });
});
