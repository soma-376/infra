// Loki 용량 시험·Fluent Bit 병행 시험의 판정(ADR-0039). 실행과 분리해 Docker 없이 실패 사례를 회귀 시험한다
// (test/scripts/observability-load-judge.test.ts). 함수는 실패 사유 목록을 돌려준다. 빈 목록이면 그 단계는 기준을 지켰다.
export const MiB = 1024 * 1024;

/** 쉼표로 받은 단계 이름. 같은 이름을 반복해도 한 번이다. */
export const uniquePhases = text => [...new Set(String(text).split(',').map(x => x.trim()).filter(Boolean))];

/** 필수 단계가 이름대로 모두 끝나고 기본 시간으로 돌았을 때만 PASS다. 실패가 하나라도 있으면 FAIL이다. */
export function finalStatus({ required, completed, full, failures }) {
  if (failures.length) return 'FAIL';
  return required.every(name => completed.includes(name)) && full ? 'PASS' : 'SHORT_RUN';
}

/** 처리율은 부하를 넣은 시간으로 나눈다. 넣기를 마친 뒤 기다린 시간은 분모에 넣지 않는다. */
export const perSecond = (bytes, pushSeconds) => bytes / pushSeconds;

/** 메모리·프로세스 상태. anonPeakRatio가 null이면(짧은 단계) anon 비율은 보지 않는다. */
export function judgeHealth({ memory, state }, { anonPeakRatio }) {
  const failures = [];
  if (!state.running || state.oomKilled || state.restartCount > 0) failures.push(`Loki 상태 ${JSON.stringify(state)}`);
  if (memory.oomKill > 0) failures.push(`oom_kill ${memory.oomKill}`);
  if (anonPeakRatio !== null && memory.sampledAnonMaxRatio > anonPeakRatio) failures.push(`anon 표본 최대가 limit의 ${anonPeakRatio * 100}%를 넘었다`);
  return failures;
}

/**
 * Loki 용량 시험 한 단계. ctx: rate·burst(bytes/s, bytes), targetBytesPerSecond(그 단계의 목표 부하), ceilingBytes, criteria.
 * phase: offeredBytes·acceptedBytes·pushSeconds·lines(reconcile)·memory·state·queries·cases.
 */
export function judgeCapacity(name, phase, ctx) {
  const failures = [];
  const offered = name === 'burst' ? null : perSecond(phase.offeredBytes, phase.pushSeconds);
  const accepted = name === 'burst' ? null : perSecond(phase.acceptedBytes, phase.pushSeconds);
  // 생성기가 목표 부하를 실제로 냈는지 본다. 못 냈으면 그 단계는 기준을 시험하지 못한 것이다.
  if (offered !== null && offered < ctx.targetBytesPerSecond * 0.9) failures.push(`제공 부하 ${(offered / MiB).toFixed(2)}MiB/s가 목표의 90%에 못 미쳤다`);
  if (phase.lines && !phase.lines.matches) failures.push('수락·거절과 Loki 조회가 다르다');
  if (phase.lines?.errorBatches) failures.push(`오류 batch ${phase.lines.errorBatches}`);
  if (name === 'sustained') {
    // 상한 아래로 넣었으니 거의 전부 받아야 한다. "수락 0줄 = 조회 0줄"을 통과로 보지 않는다.
    if (phase.acceptedBytes < phase.offeredBytes * 0.99) failures.push(`수락 ${(phase.acceptedBytes / MiB).toFixed(1)}MiB가 제공의 99%에 못 미쳤다`);
    if (phase.lines.rejectedBatches) failures.push(`거절 batch ${phase.lines.rejectedBatches}`);
    if (!phase.queries.length || phase.queries.some(x => x.status !== 200)) failures.push('대표 조회 실패');
    if (phase.queries.length < Math.floor(phase.pushSeconds / 60) - 1) failures.push(`대표 조회 ${phase.queries.length}회는 분당 1회보다 적다`);
    if (phase.memory.anonSlopeMiBPerMinute === null || phase.memory.anonSlopeMiBPerMinute > ctx.criteria.anonSlopeMiBPerMinute) failures.push(`후반 anon 기울기 ${phase.memory.anonSlopeMiBPerMinute}MiB/분`);
  }
  if (name === 'overload') {
    if (!phase.lines.rejectedBatches) failures.push('429가 나지 않았다 — 제한이 동작했는지 알 수 없다');
    if (accepted > ctx.rate * 1.05 + ctx.burst / phase.pushSeconds) failures.push(`수락 ${(accepted / MiB).toFixed(2)}MiB/s가 상한을 넘었다`);
    if (accepted < ctx.rate * 0.9) failures.push(`수락 ${(accepted / MiB).toFixed(2)}MiB/s가 상한의 90%에 못 미쳤다`);
  }
  if (name === 'burst') {
    for (const c of phase.cases) {
      if (c.actual !== c.expect) failures.push(`${c.label}: 기대 ${c.expect}, 실제 ${c.actual}`);
      if (c.found !== (c.actual === 'accepted' ? c.lines : 0)) failures.push(`${c.label}: 조회 ${c.found}줄`);
    }
    if (phase.cases.length < 12) failures.push(`burst 경우 ${phase.cases.length}개`);
  }
  if (name === 'wal') {
    // 복구 상한은 메모리에 올린 양이다. 디스크 WAL은 압축될 수 있어 수락한 줄 bytes로 비교한다.
    if (phase.acceptedBytes <= ctx.ceilingBytes) failures.push('수락량이 복구 상한보다 작아 상한을 시험하지 못했다');
    if (!phase.ready) failures.push('재시작 뒤 Ready가 되지 않았다');
  }
  return failures;
}

/**
 * Fluent Bit 병행 시험 한 단계. phase: written·standInCount·lokiCount·lokiLost·standInMissing·fluentBit(loki·http 지표 증가분).
 * CloudWatch 대역은 어느 단계에서도 빠지면 안 된다. Loki 손실은 단계마다 기준이 다르고, 있다면 모두 Fluent Bit drop 지표로 설명돼야 한다.
 */
export function judgeHarness(name, phase) {
  const failures = [];
  const loki = phase.fluentBit.loki;
  if (!phase.written) failures.push('쓴 줄이 없다');
  if (phase.standInMissing) failures.push(`CloudWatch 대역 누락 ${phase.standInMissing}`);
  if (name === 'normal' || name === 'outage') {
    if (phase.lokiLost) failures.push(`Loki 누락 ${phase.lokiLost}`);
    if (loki.dropped_records_total || loki.retries_failed_total) failures.push(`Loki 출력 drop ${loki.dropped_records_total}·재시도 실패 ${loki.retries_failed_total}`);
  }
  if (name === 'outage' && !loki.retries_total) failures.push('Loki 재시도가 없었다 — 장애가 실제로 걸렸는지 알 수 없다');
  if (name === 'overload') {
    if (!phase.lokiCount) failures.push('Loki가 한 줄도 받지 않았다');
    if (phase.lokiLost !== loki.dropped_records_total) failures.push(`Loki 손실 ${phase.lokiLost}이 drop 지표 ${loki.dropped_records_total}로 설명되지 않는다`);
  }
  return failures;
}
