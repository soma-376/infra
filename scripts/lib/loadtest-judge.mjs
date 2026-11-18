// dev 부하 시험(ADR-0064)의 두 층 한계 판정과 배수 계획. 실행·조회와 분리해 실패 사례를 회귀 시험한다
// (test/scripts/loadtest-judge.test.ts). 판정 함수는 실패 사유 목록을 돌려준다. 빈 목록이면 그 단계는 그 층을 통과했다.
//
//   ① Gateway 수용: k6·서버 p95 ≤ 1s, p99 ≤ 3s, 오류율 ≤ 0.1%, dropped 0
//   ② 파이프라인 지속: 유지 구간 lag 증가 ≤ max(100, 목표 RPS × 10), 접수→완료 p95 ≤ 직전 통과 단계의 2배,
//      영구 거부·재시도 소진·ClickHouse 지연/실패 INSERT 증가 0
// 위 값이 기본값이다. 확정은 팀 결정이며 전부 인자로 바꾼다. 빈 값(미수집)은 0이나 통과로 보지 않는다.
// 증거가 부족해 값을 내지 못한 이유는 values.notes[키] 에 있고, 실패 사유에 함께 적는다.

export const DEFAULT_CRITERIA = Object.freeze({
  maxP95Seconds: 1,
  maxP99Seconds: 3,
  maxErrorRate: 0.001,
  maxDropped: 0,
  lagMinGrowth: 100,
  lagGrowthPerRps: 10,
  completionP95Factor: 2,
});

/** "90"·90·"30s"·"5m"·"1h"·"1m30s" → 초. k6 lib/config.js·helm/dev/loadtest 와 같은 규칙이다. */
export function parseDuration(value, name = 'duration') {
  const text = String(value).trim();
  if (/^\d+$/.test(text)) return Number(text);
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(text);
  if (!text || !match) throw new Error(`${name}=${text} 는 90·30s·5m·1h·1m30s 꼴이어야 한다`);
  return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
}

const present = value => typeof value === 'number' && Number.isFinite(value);
const missing = (values, label, key) => `${label} 미수집${values.notes?.[key] ? `(${values.notes[key]})` : ''}`;
const format = (value, digits = 3) => (present(value) ? Number(value.toFixed(digits)).toString() : '미수집');

/** ① 한 단계. values: k6P95Ms·k6P99Ms·errorRate·dropped(k6 summary), serverP95Seconds·serverP99Seconds(Prometheus). */
export function judgeGateway(values, criteria = DEFAULT_CRITERIA) {
  const reasons = [];
  const limit = (label, value, max, unit = '') => {
    if (!present(value)) reasons.push(`${label} 미수집`);
    else if (value > max) reasons.push(`${label} ${format(value)}${unit} > ${max}${unit}`);
  };
  limit('k6 p95', present(values.k6P95Ms) ? values.k6P95Ms / 1000 : null, criteria.maxP95Seconds, 's');
  limit('k6 p99', present(values.k6P99Ms) ? values.k6P99Ms / 1000 : null, criteria.maxP99Seconds, 's');
  limit('서버 p95', values.serverP95Seconds, criteria.maxP95Seconds, 's');
  limit('서버 p99', values.serverP99Seconds, criteria.maxP99Seconds, 's');
  limit('오류율', values.errorRate, criteria.maxErrorRate);
  // dropped 는 k6 summary 의 단계별 값(예정 반복 − 유지 구간 요청)이다. Prometheus 수집 시점과 무관하고, 없으면 미수집이다.
  if (!present(values.dropped)) reasons.push(missing(values, 'dropped', 'dropped'));
  else if (values.dropped > criteria.maxDropped) reasons.push(`dropped ${format(values.dropped, 0)} > ${criteria.maxDropped}`);
  return reasons;
}

/**
 * ② 한 단계. values: lagGrowth·completionP95Seconds·retryExhausted·permanent·chDelayed·chFailed.
 * previousCompletionP95Seconds 는 직전에 ②를 통과한 단계의 값이다. 첫 단계(또는 이전 통과 없음)는 비교하지 않는다.
 */
export function judgePipeline(values, targetRps, previousCompletionP95Seconds, criteria = DEFAULT_CRITERIA) {
  const reasons = [];
  const lagLimit = Math.max(criteria.lagMinGrowth, targetRps * criteria.lagGrowthPerRps);
  if (!present(values.lagGrowth)) reasons.push(missing(values, 'lag', 'lagGrowth'));
  else if (values.lagGrowth > lagLimit) reasons.push(`lag 증가 ${format(values.lagGrowth, 0)} > ${lagLimit}`);
  if (!present(values.completionP95Seconds)) reasons.push('접수→완료 p95 미수집');
  else if (present(previousCompletionP95Seconds) && values.completionP95Seconds > previousCompletionP95Seconds * criteria.completionP95Factor) {
    reasons.push(`접수→완료 p95 ${format(values.completionP95Seconds)}s > 직전 통과 ${format(previousCompletionP95Seconds)}s × ${criteria.completionP95Factor}`);
  }
  for (const [label, key] of [['영구 거부', 'permanent'], ['재시도 소진', 'retryExhausted'], ['CH 지연 INSERT', 'chDelayed'], ['CH 실패 INSERT', 'chFailed']]) {
    // 카운터 증가량은 음수일 수 없다. 음수면 초기화·표본 문제라 0(통과)으로 읽지 않고 미수집으로 본다.
    if (!present(values[key])) reasons.push(missing(values, label, key));
    else if (values[key] < 0) reasons.push(`${label} 미수집(음수 ${format(values[key], 0)} — 카운터 초기화·표본 문제)`);
    else if (values[key] > 0) reasons.push(`${label} ${format(values[key], 0)} > 0`);
  }
  return reasons;
}

/**
 * 단계 목록 전체를 판정한다. 한계는 첫 단계부터 이어서 통과한 마지막 단계의 목표 RPS 다.
 * 한 번 실패한 뒤의 통과는 한계로 세지 않는다 — 그 위는 backlog·자원 상태가 섞여 있다.
 */
export function judgeRun(steps, criteria = DEFAULT_CRITERIA) {
  let previousCompletion = null;
  const judged = steps.map(step => {
    const gateway = judgeGateway(step.values, criteria);
    const pipeline = judgePipeline(step.values, step.targetRps, previousCompletion, criteria);
    if (!pipeline.length) previousCompletion = step.values.completionP95Seconds;
    return { ...step, gateway: { pass: !gateway.length, reasons: gateway }, pipeline: { pass: !pipeline.length, reasons: pipeline } };
  });
  const limit = layer => {
    let last = null;
    for (const step of judged) {
      if (!step[layer].pass) return { rps: last?.targetRps ?? null, step: last?.step ?? null, firstFailure: step.step };
      last = step;
    }
    return { rps: last?.targetRps ?? null, step: last?.step ?? null, firstFailure: null };
  };
  return { criteria, steps: judged, limits: { gateway: limit('gateway'), pipeline: limit('pipeline') } };
}

/** 단계 목표 RPS 목록 — START 부터 STEP 씩 MAX 를 넘지 않는 데까지(k6 lib/schedule.js stairRates 와 같다). */
export function stairRates(start, step, max) {
  if (!(start >= 1 && step >= 1 && max >= start)) throw new Error(`start·step·max 가 맞지 않는다: ${start}·${step}·${max}`);
  const rates = [];
  for (let rate = start; rate <= max; rate += step) rates.push(rate);
  return rates;
}

/**
 * 배수 계획. backlog = Σ max(0, 단계 RPS − ②) × 유지 시간, 배수 시간 = backlog ÷ ②.
 * 상승 구간은 넣지 않는다(계획과 같은 근사). 예산을 넘지 않는 최대 MAX 를 단계 단위로 제안한다.
 */
export function drainPlan({ pipelineLimit, start, step, max, holdSeconds, budgetSeconds = 3600 }) {
  if (!(pipelineLimit > 0)) throw new Error('pipeline-limit 은 0보다 커야 한다');
  if (!(holdSeconds > 0)) throw new Error('hold 는 0보다 커야 한다');
  const evaluate = rates => {
    const backlog = rates.reduce((sum, rate) => sum + Math.max(0, rate - pipelineLimit) * holdSeconds, 0);
    return { backlog, drainSeconds: backlog / pipelineLimit };
  };
  const rates = stairRates(start, step, max);
  const plan = evaluate(rates);
  let suggestedMax = null;
  let suggested = null;
  for (let index = rates.length; index >= 1; index -= 1) {
    const candidate = evaluate(rates.slice(0, index));
    if (candidate.drainSeconds <= budgetSeconds) {
      suggestedMax = rates[index - 1];
      suggested = candidate;
      break;
    }
  }
  return {
    pipelineLimit, start, step, max, holdSeconds, budgetSeconds,
    steps: rates.map(rate => ({ rps: rate, backlog: Math.max(0, rate - pipelineLimit) * holdSeconds })),
    backlog: plan.backlog,
    drainSeconds: plan.drainSeconds,
    withinBudget: plan.drainSeconds <= budgetSeconds,
    suggestedMax,
    suggestedDrainSeconds: suggested?.drainSeconds ?? null,
  };
}

export const SUMMARY_BEGIN = '===LOADTEST-SUMMARY-BEGIN===';
export const SUMMARY_END = '===LOADTEST-SUMMARY-END===';

/** k6 summary — `kubectl logs` 출력(표지 사이 한 줄) 또는 SUMMARY_FILE JSON 그대로. 표지가 여러 개면 마지막 것이다. */
export function extractSummary(text) {
  const end = text.lastIndexOf(SUMMARY_END);
  if (end >= 0) {
    const begin = text.lastIndexOf(SUMMARY_BEGIN, end);
    if (begin < 0) throw new Error('summary 시작 표지가 없다');
    return JSON.parse(text.slice(begin + SUMMARY_BEGIN.length, end).trim());
  }
  return JSON.parse(text);
}

// env 이름이 이 모양이면 값이 비밀일 수 있어 값을 버린다. 이름은 남긴다(설정 여부는 비교할 수 있게).
const SECRET_NAME = /SECRET|PASSWORD|PASSWD|TOKEN|PRIVATE|CREDENTIAL|_KEY$|_KEYS$|API_KEY|DSN|AUTH/i;

/**
 * 구성 스냅샷 — `kubectl get deploy,sts,cm -n pulsemetry-dev -o json` 에서 replica·resources·env(PULSEMETRY_*)·이미지·nodeSelector 만.
 * Secret 참조(valueFrom)는 참조라는 사실만, 비밀로 보이는 이름의 값은 `<redacted>` 로 둔다. Secret·ConfigMap 의 다른 값은 옮기지 않는다.
 */
export function configSnapshot(list) {
  const items = Array.isArray(list?.items) ? list.items : [];
  const env = entries => (entries ?? [])
    .filter(entry => /^PULSEMETRY_|^JDK_JAVA_OPTIONS$|^JAVA_TOOL_OPTIONS$/.test(entry.name))
    .map(entry => {
      if (entry.valueFrom) return { name: entry.name, valueFrom: Object.keys(entry.valueFrom)[0] };
      return { name: entry.name, value: SECRET_NAME.test(entry.name) ? '<redacted>' : entry.value ?? '' };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const workloads = items.filter(item => ['Deployment', 'StatefulSet'].includes(item.kind)).map(item => {
    const pod = item.spec?.template?.spec ?? {};
    return {
      kind: item.kind,
      name: item.metadata?.name,
      replicas: item.spec?.replicas ?? null,
      readyReplicas: item.status?.readyReplicas ?? null,
      nodeSelector: pod.nodeSelector ?? {},
      containers: [...(pod.initContainers ?? []), ...(pod.containers ?? [])].map(container => ({
        name: container.name,
        image: container.image,
        resources: container.resources ?? {},
        env: env(container.env),
      })),
    };
  });
  const configMaps = items.filter(item => item.kind === 'ConfigMap').map(item => ({
    name: item.metadata?.name,
    data: Object.fromEntries(Object.entries(item.data ?? {})
      .filter(([key]) => /^PULSEMETRY_/.test(key))
      .map(([key, value]) => [key, SECRET_NAME.test(key) ? '<redacted>' : value])),
  })).filter(item => Object.keys(item.data).length);
  return { workloads: workloads.sort((a, b) => a.name.localeCompare(b.name)), configMaps: configMaps.sort((a, b) => a.name.localeCompare(b.name)) };
}

const cell = (value, digits = 3) => format(value, digits);
const pass = result => (result.pass ? '통과' : '실패');

/** REPORT.md — 단계별 표·두 층 한계·실패 사유. 시각은 UTC 다. */
export function renderReport(judgement, meta) {
  const lines = [];
  lines.push(`# 부하 시험 결과 — ${meta.testid}`, '');
  lines.push(`- 시나리오: ${meta.scenario} · 시작 ${meta.scenarioStart ?? '미상'} (UTC) · 계획 ${meta.plannedSeconds ?? '?'}초`);
  lines.push(`- 캠페인: ${meta.campaign ?? '미상'} · tenant ${meta.tenantId ?? '미상'} · 설치 ${meta.installations ?? '?'}개`);
  lines.push(`- 판정 기준: ① p95 ≤ ${judgement.criteria.maxP95Seconds}s · p99 ≤ ${judgement.criteria.maxP99Seconds}s · 오류율 ≤ ${judgement.criteria.maxErrorRate} · dropped ≤ ${judgement.criteria.maxDropped}; `
    + `② lag 증가 ≤ max(${judgement.criteria.lagMinGrowth}, 목표 RPS × ${judgement.criteria.lagGrowthPerRps}) · 완료 p95 ≤ 직전 통과 × ${judgement.criteria.completionP95Factor} · 영구 거부·재시도 소진·CH 지연/실패 0`);
  lines.push('');
  lines.push('## 한계', '');
  for (const [label, key] of [['① Gateway 수용', 'gateway'], ['② 파이프라인 지속', 'pipeline']]) {
    const limit = judgement.limits[key];
    lines.push(`- ${label}: ${limit.rps === null ? '통과한 단계 없음' : `${limit.rps} RPS (${limit.step})`}${limit.firstFailure ? ` — 처음 실패 ${limit.firstFailure}` : ' — 모든 단계 통과(한계는 더 높을 수 있다)'}`);
  }
  lines.push('');
  lines.push('## 단계별', '');
  lines.push('| 단계 | 목표 RPS | 실제 RPS | k6 p95 (ms) | k6 p99 (ms) | 서버 p95 (s) | 서버 p99 (s) | 오류율 | dropped | lag 증가 | lag 기울기 (/s) | 완료 p95 (s) | CH 저장률 | CPU/limit 최대 | heap 최대 (MiB) | ① | ② |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|');
  for (const step of judgement.steps) {
    const v = step.values;
    lines.push(`| ${step.step} | ${step.targetRps} | ${cell(v.actualRps, 2)} | ${cell(v.k6P95Ms, 1)} | ${cell(v.k6P99Ms, 1)} | ${cell(v.serverP95Seconds)} | ${cell(v.serverP99Seconds)} | `
      + `${cell(v.errorRate, 5)} | ${cell(v.dropped, 0)} | ${cell(v.lagGrowth, 0)} | ${cell(v.lagSlope, 2)} | ${cell(v.completionP95Seconds)} | `
      + `${cell(v.chStorageRatio, 3)} | ${cell(v.cpuLimitRatioMax, 3)} | ${present(v.heapMaxBytes) ? cell(v.heapMaxBytes / 1048576, 0) : '미수집'} | ${pass(step.gateway)} | ${pass(step.pipeline)} |`);
  }
  lines.push('');
  lines.push('CH 저장률 = 유지 구간 ClickHouse 삽입 행 ÷ 그 단계 200 응답의 기대 events+metric points. 삽입 행은 다른 tenant 를 포함하므로 1을 넘을 수 있다.');
  lines.push('');
  const failures = judgement.steps.flatMap(step => [
    ...step.gateway.reasons.map(reason => `- ${step.step} ①: ${reason}`),
    ...step.pipeline.reasons.map(reason => `- ${step.step} ②: ${reason}`),
  ]);
  lines.push('## 실패 사유', '', ...(failures.length ? failures : ['- 없음']), '');
  lines.push('미수집은 실패로 센다 — 0이나 통과가 아니다. 원자료는 `queries/`, 판정은 `judgement.json`, 구성은 `config.json` 이다.', '');
  return lines.join('\n');
}
