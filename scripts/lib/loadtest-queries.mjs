// dev 부하 시험(ADR-0064) 결과 추출의 판정 질의와 증거 판단. 결과 추출(scripts/loadtest-results-export.mjs)과
// PromQL 반례 시험(test/scripts/loadtest-queries.test.ts, promtool)이 같은 식을 쓰도록 여기에 둔다.
//
// 원칙: 증거가 부족하면 0(통과)으로 채우지 않고 미수집으로 남긴다. 판정기(loadtest-judge.mjs)는 미수집을 실패로 본다.

/**
 * 0이어야 하는 카운터(영구 거부·재시도 소진·ClickHouse 지연/실패 INSERT)의 창 안 증가량.
 * - 초기화(재시작)는 increase() 가 처리한다. 단순 "끝 − 시작" 차감은 초기화에서 음수가 된다.
 * - 처음 증가할 때 생기는 카운터는 increase() 가 첫 값을 셀 수 없다. 창 시작 시점에 없던 시계열은 첫 값(min)을 더한다.
 *   창 시작 직전 5분(lookback) 안에 표본이 없던 오래된 시계열도 새 시계열로 읽혀 많게 셀 수 있다 — 실패 쪽으로만 기운다.
 * - 시계열이 아예 없으면 0이다. 그래서 이 값은 수집이 이어졌다는 증거(evidenceQueries)를 확인한 뒤에만 쓴다.
 */
export function counterIncrease(metric, selector, window) {
  const series = `${metric}{${selector}}`;
  return `(sum(increase(${series}[${window}])) or vector(0)) + (sum(min_over_time(${series}[${window}]) unless ${series} offset ${window}) or vector(0))`;
}

/**
 * 창 안의 수집 증거. 모두 창 끝 시각의 instant 질의다.
 * - up: scrape 성공 여부와 표본 수.
 * - startSeries(프로세스 시작 시각, 없으면 생략): 값이 바뀌면 재시작, 창 안에서 본 시계열이 끝에 살아 있는 수보다 많으면 Pod 교체.
 * - uptimeSeries(가동 초, 없으면 생략): 계속 커지는 값이라 시작 시각처럼 changes() 로 보면 정상 증가도 재시작이 된다.
 *   재시작 직전 scrape 되지 않은 증가는 increase() 로 되살릴 수 없어서 두 신호로 재시작을 본다.
 *   · uptimeResets: 값이 줄어든 횟수.
 *   · uptimeStartShift: 추정 시작 시각(표본 시각 − 가동 초)이 창 안에서 움직인 폭. 직전 표본의 가동 초가 작을 때
 *     (재시작 직후 다시 재시작) 새 가동 초가 더 커서 resets 로는 안 보이는 재시작을 잡는다. 정상이면 비동기 지표
 *     갱신 주기 정도만 흔들린다. 1s 간격 subquery 라 창 시작 직전 표본 하나가 섞인다 — 실패 쪽으로만 기운다.
 */
export function evidenceQueries(up, startSeries, window, uptimeSeries = null) {
  const queries = {
    upMin: `min(min_over_time(${up}[${window}]))`,
    upSamples: `min(count_over_time(${up}[${window}]))`,
  };
  if (startSeries) {
    Object.assign(queries, {
      seen: `count(count_over_time(${startSeries}[${window}]))`,
      live: `count(${startSeries})`,
      restarts: `sum(changes(${startSeries}[${window}]))`,
    });
  }
  if (uptimeSeries) {
    const start = `(timestamp(${uptimeSeries}) - ${uptimeSeries})`;
    Object.assign(queries, {
      uptimeResets: `sum(resets(${uptimeSeries}[${window}]))`,
      uptimeStartShift: `max(max_over_time(${start}[${window}:1s]) - min_over_time(${start}[${window}:1s]))`,
    });
  }
  return queries;
}

/**
 * evidenceQueries 의 값 → 미수집 사유(없으면 null). minSamples 는 창 길이 ÷ scrape 간격 − 1 이다.
 * maxStartShiftSeconds 는 추정 시작 시각의 허용 흔들림이다(결과 추출 --max-start-shift).
 */
export function evidenceProblem(label, values, minSamples, maxStartShiftSeconds = 3) {
  if (values.upMin === null || values.upSamples === null) return `${label} 수집 지표 없음`;
  if (values.upMin < 1) return `${label} scrape 실패 구간 있음`;
  if (values.upSamples < minSamples) return `${label} scrape 표본 부족(${values.upSamples}/${minSamples})`;
  if ('live' in values) {
    if (values.live === null || values.live < 1) return `${label} 시작 시각 지표 없음`;
    if (values.seen !== values.live) return `${label} Pod 교체`;
    if (values.restarts !== 0) return `${label} 재시작`;
  }
  if ('uptimeResets' in values) {
    if (values.uptimeResets == null || values.uptimeStartShift == null) return `${label} 가동 시간 지표 없음`;
    if (values.uptimeResets !== 0) return `${label} 재시작`;
    if (values.uptimeStartShift > maxStartShiftSeconds) {
      return `${label} 재시작(추정 시작 시각 ${Number(values.uptimeStartShift.toFixed(1))}s 이동)`;
    }
  }
  return null;
}

/**
 * 구간 양 끝의 표본으로 증가량을 낸다. 표본 시각이 경계보다 maxAgeSeconds 넘게 오래됐거나(평가 건너뜀·수집 중단),
 * 두 경계가 같은 표본을 썼으면 null 과 사유를 돌려준다. 다른 표본의 값이 같으면 0 이다.
 */
export function boundaryGrowth(startSample, endSample, startTime, endTime, maxAgeSeconds) {
  if (!startSample || !endSample || startSample.value === null || endSample.value === null
    || startSample.ts === null || endSample.ts === null) return { value: null, note: '경계 표본 없음' };
  if (startTime - startSample.ts > maxAgeSeconds || endTime - endSample.ts > maxAgeSeconds) {
    return { value: null, note: `경계 표본이 ${maxAgeSeconds}s 보다 오래됨` };
  }
  if (endSample.ts <= startSample.ts) return { value: null, note: '시작·끝이 같은 표본' };
  return { value: endSample.value - startSample.value, note: null };
}
