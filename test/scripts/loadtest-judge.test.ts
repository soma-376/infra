import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

// dev 부하 시험(ADR-0064)의 두 층 판정·배수 계획·구성 스냅샷을 실패 사례로 회귀 시험한다. 모듈은 ESM 이라 별도 node 로 부른다.
const judgeModule = resolve(__dirname, '../../scripts/lib/loadtest-judge.mjs');
const call = (fn: string, ...args: unknown[]) => {
  const code = `import * as judge from ${JSON.stringify(judgeModule)};
let input = ''; process.stdin.on('data', chunk => input += chunk).on('end', () => {
  const { fn, args } = JSON.parse(input);
  try { process.stdout.write(JSON.stringify({ ok: judge[fn](...args) })); } catch (error) { process.stdout.write(JSON.stringify({ error: error.message })); }
});`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { input: JSON.stringify({ fn, args }), encoding: 'utf8' });
  expect(result.stderr).toBe('');
  const parsed = JSON.parse(result.stdout);
  if (parsed.error) throw new Error(parsed.error);
  return parsed.ok;
};

const gatewayOk = { k6P95Ms: 120, k6P99Ms: 400, errorRate: 0, serverP95Seconds: 0.05, serverP99Seconds: 0.2, dropped: 0 };
const pipelineOk = { lagGrowth: 20, completionP95Seconds: 1.5, retryExhausted: 0, permanent: 0, chDelayed: 0, chFailed: 0 };
const step = (name: string, targetRps: number, values: Record<string, unknown>) => ({ step: name, targetRps, values: { ...gatewayOk, ...pipelineOk, ...values } });

describe('① Gateway 수용 판정', () => {
  test('기준 안이면 통과한다', () => {
    expect(call('judgeGateway', gatewayOk)).toEqual([]);
  });

  test('dropped 는 k6 summary 의 단계별 값이다 — 없으면 0이 아니라 미수집이고 사유를 붙인다', () => {
    expect(call('judgeGateway', { ...gatewayOk, dropped: null })).toEqual(['dropped 미수집']);
    expect(call('judgeGateway', { ...gatewayOk, dropped: null, notes: { dropped: 'summary 에 단계별 drop 이 없다' } }))
      .toEqual(['dropped 미수집(summary 에 단계별 drop 이 없다)']);
  });

  test('k6·서버 p95·p99·오류율·dropped 를 각각 본다', () => {
    const reasons = call('judgeGateway', { k6P95Ms: 1200, k6P99Ms: 3500, errorRate: 0.002, serverP95Seconds: 1.1, serverP99Seconds: 3.2, dropped: 4 }).join('\n');
    for (const text of ['k6 p95 1.2s > 1s', 'k6 p99 3.5s > 3s', '서버 p95 1.1s > 1s', '서버 p99 3.2s > 3s', '오류율 0.002 > 0.001', 'dropped 4 > 0']) {
      expect(reasons).toContain(text);
    }
  });

  test('미수집은 통과가 아니다', () => {
    expect(call('judgeGateway', { ...gatewayOk, serverP95Seconds: null, errorRate: null })).toEqual(['서버 p95 미수집', '오류율 미수집']);
  });

  test('임계값을 인자로 바꾼다', () => {
    expect(call('judgeGateway', { ...gatewayOk, k6P95Ms: 1500 }, { maxP95Seconds: 2, maxP99Seconds: 3, maxErrorRate: 0.001, maxDropped: 0 })).toEqual([]);
  });
});

describe('② 파이프라인 지속 판정', () => {
  test('lag 증가 상한은 max(100, 목표 RPS × 10) 이다', () => {
    expect(call('judgePipeline', { ...pipelineOk, lagGrowth: 100 }, 5, null)).toEqual([]);
    expect(call('judgePipeline', { ...pipelineOk, lagGrowth: 101 }, 5, null)).toEqual(['lag 증가 101 > 100']);
    expect(call('judgePipeline', { ...pipelineOk, lagGrowth: 600 }, 60, null)).toEqual([]);
    expect(call('judgePipeline', { ...pipelineOk, lagGrowth: 601 }, 60, null)).toEqual(['lag 증가 601 > 600']);
  });

  test('완료 p95 는 직전 통과 단계의 2배까지다', () => {
    expect(call('judgePipeline', { ...pipelineOk, completionP95Seconds: 3 }, 10, 1.5)).toEqual([]);
    expect(call('judgePipeline', { ...pipelineOk, completionP95Seconds: 3.1 }, 10, 1.5)).toEqual(['접수→완료 p95 3.1s > 직전 통과 1.5s × 2']);
  });

  test('영구 거부·재시도 소진·CH 지연/실패 INSERT 는 0 이어야 하고 미수집은 실패다', () => {
    const reasons = call('judgePipeline', { ...pipelineOk, permanent: 2, retryExhausted: 1, chDelayed: 3, chFailed: null, lagGrowth: null }, 10, null);
    expect(reasons).toEqual(['lag 미수집', '영구 거부 2 > 0', '재시도 소진 1 > 0', 'CH 지연 INSERT 3 > 0', 'CH 실패 INSERT 미수집']);
  });

  test('음수 카운터 증가량(초기화·표본 문제)은 통과가 아니라 미수집이다', () => {
    expect(call('judgePipeline', { ...pipelineOk, permanent: -3 }, 10, null)).toEqual(['영구 거부 미수집(음수 -3 — 카운터 초기화·표본 문제)']);
  });

  test('수집 증거가 부족해 비운 값은 사유와 함께 실패한다', () => {
    const values = { ...pipelineOk, permanent: null, lagGrowth: null, notes: { permanent: 'ingest 재시작', lagGrowth: '시작·끝이 같은 표본' } };
    expect(call('judgePipeline', values, 10, null)).toEqual(['lag 미수집(시작·끝이 같은 표본)', '영구 거부 미수집(ingest 재시작)']);
  });
});

describe('실행 전체 판정과 한계', () => {
  test('미완료 단계(유지 구간을 끝까지 실행하지 않음)는 값이 통과여도 두 층 모두 한계에서 빠진다', () => {
    const result = call('judgeRun', [step('s01', 5, {}), { ...step('s02', 10, {}), completed: false }, step('s03', 15, {})]);
    expect(result.steps.map((s: any) => [s.step, s.gateway.pass, s.pipeline.pass])).toEqual([['s01', true, true], ['s02', false, false], ['s03', true, true]]);
    expect(result.limits).toEqual({ gateway: { rps: 5, step: 's01', firstFailure: 's02' }, pipeline: { rps: 5, step: 's01', firstFailure: 's02' } });
    expect(result.steps[1].pipeline.reasons).toEqual(['미완료 단계 — 유지 구간을 끝까지 실행하지 않아 한계 산정에서 뺀다']);
  });

  test('한계는 처음부터 이어서 통과한 마지막 단계다. 실패 뒤의 통과는 세지 않는다', () => {
    const result = call('judgeRun', [
      step('s01', 5, {}),
      step('s02', 10, { completionP95Seconds: 2.5 }),
      step('s03', 15, { lagGrowth: 5000 }),
      step('s04', 20, { k6P95Ms: 1800 }),
      step('s05', 25, {}),
    ]);
    expect(result.steps.map((s: any) => [s.step, s.gateway.pass, s.pipeline.pass])).toEqual([
      ['s01', true, true], ['s02', true, true], ['s03', true, false], ['s04', false, true], ['s05', true, true],
    ]);
    expect(result.limits).toEqual({
      gateway: { rps: 15, step: 's03', firstFailure: 's04' },
      pipeline: { rps: 10, step: 's02', firstFailure: 's03' },
    });
  });

  test('완료 p95 비교는 직전에 ②를 통과한 단계 기준이다', () => {
    const result = call('judgeRun', [
      step('s01', 5, { completionP95Seconds: 1 }),
      step('s02', 10, { completionP95Seconds: 5, lagGrowth: 9999 }),
      step('s03', 15, { completionP95Seconds: 2.5 }),
    ]);
    // s02 는 lag 로 실패해 기준이 되지 않는다. s03 의 2.5s 는 s01 의 1s × 2 를 넘는다.
    expect(result.steps[2].pipeline.reasons).toEqual(['접수→완료 p95 2.5s > 직전 통과 1s × 2']);
  });

  test('모두 통과하면 마지막 단계가 한계이고 첫 실패가 없다. 첫 단계 실패면 한계가 없다', () => {
    expect(call('judgeRun', [step('s01', 5, {}), step('s02', 10, {})]).limits.gateway).toEqual({ rps: 10, step: 's02', firstFailure: null });
    expect(call('judgeRun', [step('s01', 5, { errorRate: 0.5 })]).limits.gateway).toEqual({ rps: null, step: null, firstFailure: 's01' });
  });
});

describe('배수 계획', () => {
  test('backlog·배수 시간·예산 안의 최대 MAX 를 계산한다', () => {
    // ② = 50 RPS, 20→300 RPS +20, 유지 120초. 60 부터 backlog: Σ(r − 50)×120.
    const result = call('drainPlan', { pipelineLimit: 50, start: 20, step: 20, max: 300, holdSeconds: 120, budgetSeconds: 3600 });
    const expected = [60, 80, 100, 120, 140, 160, 180, 200, 220, 240, 260, 280, 300].reduce((sum, r) => sum + (r - 50) * 120, 0);
    expect(result.backlog).toBe(expected);
    expect(result.drainSeconds).toBeCloseTo(expected / 50);
    expect(result.withinBudget).toBe(false);
    // MAX=200: Σ(r−50)·120 for 60..200 = 120·(10+30+…+150)=120·640=76800 → 1536s ≤ 3600; 220 → +170·120 → 97200 → 1944s; … 280 → 2·… 확인
    const within = (max: number) => [20, 40, 60, 80, 100, 120, 140, 160, 180, 200, 220, 240, 260, 280, 300].filter(r => r <= max)
      .reduce((sum, r) => sum + Math.max(0, r - 50) * 120, 0) / 50 <= 3600;
    const best = [300, 280, 260, 240, 220, 200].find(within);
    expect(result.suggestedMax).toBe(best);
    expect(result.suggestedDrainSeconds).toBeLessThanOrEqual(3600);
    expect(result.steps[0]).toEqual({ rps: 20, backlog: 0 });
  });

  test('② 위로 올라가지 않으면 backlog 가 없다. 잘못된 입력은 거부한다', () => {
    expect(call('drainPlan', { pipelineLimit: 100, start: 5, step: 5, max: 60, holdSeconds: 300 })).toMatchObject({ backlog: 0, drainSeconds: 0, withinBudget: true, suggestedMax: 60 });
    expect(() => call('drainPlan', { pipelineLimit: 0, start: 5, step: 5, max: 60, holdSeconds: 300 })).toThrow('pipeline-limit');
    expect(() => call('drainPlan', { pipelineLimit: 10, start: 50, step: 5, max: 10, holdSeconds: 300 })).toThrow('start·step·max');
  });

  test('기간 해석은 k6 와 같다', () => {
    expect(['90', '30s', '5m', '1h', '1m30s'].map(value => call('parseDuration', value))).toEqual([90, 30, 300, 3600, 90]);
    expect(() => call('parseDuration', '5 minutes')).toThrow('꼴');
  });
});

describe('summary·구성 스냅샷', () => {
  test('kubectl logs 의 표지 사이 JSON 을 꺼낸다. 표지가 없으면 JSON 그대로다', () => {
    const json = { testid: 'x', steps: [] };
    expect(call('extractSummary', `k6 로그\n===LOADTEST-SUMMARY-BEGIN===\n${JSON.stringify(json)}\n===LOADTEST-SUMMARY-END===\n`)).toEqual(json);
    expect(call('extractSummary', JSON.stringify(json))).toEqual(json);
  });

  test('구성 스냅샷은 PULSEMETRY_* env·이미지·자원·replica·갱신 방식·nodeSelector 만 남기고 비밀 값을 버린다', () => {
    // ingest 는 PROJ-346 의 replica 2·RollingUpdate 모양이다. 갱신 방식은 Deployment strategy·StatefulSet updateStrategy 를 그대로 옮긴다.
    const rolling = { type: 'RollingUpdate', rollingUpdate: { maxSurge: 1, maxUnavailable: 0 } };
    const snapshot = call('configSnapshot', { items: [
      { kind: 'StatefulSet', metadata: { name: 'clickhouse' }, status: { readyReplicas: 1 }, spec: { replicas: 1,
        updateStrategy: { type: 'RollingUpdate', rollingUpdate: { partition: 0 } }, template: { spec: { containers: [{ name: 'clickhouse', image: 'x/ch@sha256:def' }] } } } },
      { kind: 'Deployment', metadata: { name: 'telemetry-gateway' }, spec: { replicas: 1, template: { spec: { containers: [] } } } },
      { kind: 'Deployment', metadata: { name: 'telemetry-ingest' }, status: { readyReplicas: 2 }, spec: { replicas: 2, strategy: rolling, template: { spec: {
        nodeSelector: { 'karpenter.sh/nodepool': 'pulsemetry-dev-apps' },
        containers: [{ name: 'telemetry-ingest', image: 'x/ingest@sha256:abc', resources: { requests: { cpu: '500m' } }, env: [
          { name: 'PULSEMETRY_KAFKA_MAX_POLL_RECORDS', value: '5' },
          { name: 'PULSEMETRY_DB_PASSWORD', value: 'hunter2-secret-value' },
          { name: 'PULSEMETRY_TOKEN_HASH_SECRET', valueFrom: { secretKeyRef: { name: 's', key: 'k' } } },
          { name: 'SPRING_DATASOURCE_PASSWORD', value: 'other-secret' },
        ] }],
      } } } },
      { kind: 'ConfigMap', metadata: { name: 'runtime' }, data: { PULSEMETRY_INGEST_MODE: 'kafka', PULSEMETRY_API_KEY: 'k-secret', 'application.yaml': 'password: x' } },
      { kind: 'Secret', metadata: { name: 'db' }, data: { password: 'aHVudGVyMg==' } },
    ] });
    const text = JSON.stringify(snapshot);
    for (const secret of ['hunter2-secret-value', 'other-secret', 'k-secret', 'aHVudGVyMg==', 'password: x']) expect(text).not.toContain(secret);
    expect(snapshot.workloads.map((w: any) => [w.name, w.replicas, w.strategy])).toEqual([
      ['clickhouse', 1, { type: 'RollingUpdate', rollingUpdate: { partition: 0 } }],
      // 갱신 방식이 없는 입력(kubectl 출력에는 늘 있다)은 null 이다 — 기본값을 추정해 채우지 않는다.
      ['telemetry-gateway', 1, null],
      ['telemetry-ingest', 2, rolling],
    ]);
    expect(snapshot.workloads[2]).toEqual({
      kind: 'Deployment', name: 'telemetry-ingest', replicas: 2, readyReplicas: 2, strategy: rolling, nodeSelector: { 'karpenter.sh/nodepool': 'pulsemetry-dev-apps' },
      containers: [{ name: 'telemetry-ingest', image: 'x/ingest@sha256:abc', resources: { requests: { cpu: '500m' } }, env: [
        { name: 'PULSEMETRY_DB_PASSWORD', value: '<redacted>' },
        { name: 'PULSEMETRY_KAFKA_MAX_POLL_RECORDS', value: '5' },
        { name: 'PULSEMETRY_TOKEN_HASH_SECRET', valueFrom: 'secretKeyRef' },
      ] }],
    });
    expect(snapshot.configMaps).toEqual([{ name: 'runtime', data: { PULSEMETRY_INGEST_MODE: 'kafka', PULSEMETRY_API_KEY: '<redacted>' } }]);
  });
});
