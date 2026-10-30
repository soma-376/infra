import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { hasSecretLiteral } from '../../lib/perf/contract/bundle';
import { main as values } from '../../scripts/perf-values';
import { DIGEST, KID, MSK_BOOTSTRAP, MSK_NODES, REGISTRY, RUNTIME_VALUES, describeStacks, perfRequest } from './perf-fixtures';

let directory: string;
const path = (name: string) => join(directory, name);
const json = (name: string, value: unknown) => { writeFileSync(path(name), JSON.stringify(value, null, 2)); return path(name); };
const stacks = describeStacks();

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'perf-values-'));
  writeFileSync(path('request.json'), perfRequest());
  json('stacks.json', stacks);
  json('bootstrap.json', MSK_BOOTSTRAP);
  json('nodes.json', MSK_NODES);
  writeFileSync(path('runtime.yaml'), RUNTIME_VALUES);
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
const silence = () => jest.spyOn(console, 'log').mockImplementation(() => undefined);

function valuesArgs(extra: Record<string, string> = {}): string[] {
  const options: Record<string, string> = {
    '--request': path('request.json'), '--outputs': path('stacks.json'), '--runtime-values': path('runtime.yaml'),
    '--msk-bootstrap': path('bootstrap.json'), '--msk-nodes': path('nodes.json'), '--output-dir': path('generated'), ...extra,
  };
  return Object.entries(options).flat();
}
const generated = (name: string): any => load(readFileSync(path(`generated/${name}`), 'utf8'));

describe('perf-values', () => {
  test('합성 output·프로필·요청에서 Helm values 10개를 만들고 비밀 원문이 없다', () => {
    silence();
    expect(values(valuesArgs()).sort()).toEqual([
      'clickhouse.yaml', 'enrollment-api.yaml', 'jobs.yaml', 'observability.yaml', 'platform.yaml', 'runtime.yaml',
      'telemetry-gateway.yaml', 'telemetry-ingest.yaml', 'telemetry-kafka-admin.yaml',
    ].sort());
    for (const name of readdirSync(path('generated'))) expect([name, hasSecretLiteral(generated(name))]).toEqual([name, false]);
    const enrollment = generated('enrollment-api.yaml');
    expect(enrollment.telemetryJwt).toMatchObject({ enabled: true, issueEnabled: true, activeKid: KID, secretProviderClass: 'enrollment-api-telemetry-jwt' });
    expect(enrollment.replicaCount).toBe(1);
    expect(enrollment.placement).toEqual({ nodePool: 'perf-system', taint: null });
    expect(enrollment.env.PULSEMETRY_DB_URL).toMatch(/\?ApplicationName=pulsemetry-enrollment-api$/);
    expect(enrollment.resources).toEqual({ requests: { cpu: '500m', memory: '1Gi' }, limits: { cpu: null, memory: '1Gi' } });
    expect(enrollment.image).toEqual({ repository: `${REGISTRY}/enrollment-api`, digest: DIGEST('1') });
    const ingest = generated('telemetry-ingest.yaml');
    expect(ingest.kafka).toMatchObject({ topic: 'pulsemetry-perf-telemetry-ingress', consumerGroup: 'pulsemetry-perf-telemetry-ingest', iamSessionName: 'pulsemetry-perf-telemetry-ingest' });
    expect(ingest.placement).toEqual({ nodePool: 'perf-pipeline', taint: 'pipeline' });
    expect(ingest.env).toMatchObject({ PULSEMETRY_ARCHIVE_PREFIX: 'perf', PULSEMETRY_CLICKHOUSE_URL: 'http://clickhouse.pulsemetry-perf.svc.cluster.local:8123' });
    expect(generated('telemetry-gateway.yaml').placement).toEqual({ nodePool: 'perf-gateway', taint: 'gateway' });
    expect(generated('clickhouse.yaml')).toMatchObject({ image: { digest: DIGEST('4') }, storage: { className: 'pulsemetry-perf-gp3', size: '100Gi' } });
    const platform = generated('platform.yaml');
    expect(platform.disruptionBudgetNodes).toBe('0');
    expect(Object.keys(platform.pools).sort()).toEqual(['clickhouse', 'gateway', 'generator', 'observability', 'pipeline', 'system']);
    expect(new Set(Object.values(platform.pools).map((pool: any) => pool.securityGroupId)).size).toBe(6);
    const jobs = generated('jobs.yaml').infra;
    expect(jobs.evidencePrefix).toBe('runs/');
    expect(jobs.rawArchiveUri).toBe('s3://perfdatastack-perfrawsignalbucket-fixture/perf/');
    expect(jobs.imageRepositories).toEqual({ k6Runner: `${REGISTRY}/perf-k6-runner`, perfTools: `${REGISTRY}/perf-tools` });
    expect(Object.keys(jobs.jobs).sort()).toEqual(['prepare', 'runner', 'seed', 'sentinel', 'smoke', 'verify']);
    expect(jobs.jobs.runner).toMatchObject({ serviceAccount: 'k6-runner', nodePool: 'perf-generator', taint: 'generator' });
    expect(jobs.msk).toEqual({ clusterName: 'soma-376-perf-telemetry', consumerGroup: 'pulsemetry-perf-telemetry-ingest', topic: 'pulsemetry-perf-telemetry-ingress' });
    const observability = generated('observability.yaml');
    expect(observability.global.pulsemetry).toMatchObject({ environment: 'perf', targetNamespace: 'pulsemetry-perf', clusterName: 'soma-376-perf-eks' });
    expect(observability.global.pulsemetry.mskBrokers).toHaveLength(3);
  });

  test('enrollment replica 0 입력을 values에 그대로 둔다', () => {
    silence();
    writeFileSync(path('runtime.yaml'), RUNTIME_VALUES.replace('enrollmentReplicas: 1', 'enrollmentReplicas: 0'));
    values(valuesArgs());
    expect(generated('enrollment-api.yaml').replicaCount).toBe(0);
  });

  test.each([
    ['다른 프로필 SHA-256', () => writeFileSync(path('request.json'), perfRequest(r => { r.infra.profile_sha256 = 'f'.repeat(64); })), /profile_sha256/],
    ['배포와 다른 NAT 입력', () => writeFileSync(path('request.json'), perfRequest(r => { r.infra.parameters.natGateways = 3; })), /infra.parameters/],
    ['다른 환경의 Secret 참조', () => writeFileSync(path('request.json'), perfRequest(r => { r.secret_references['rds-credentials'].name = 'soma-376/perf/rds/master'; })), /rds-credentials/],
    ['draft request', () => writeFileSync(path('request.json'), readFileSync(join(__dirname, '../fixtures/perf-contract-v2/fixtures/schema/environment-request/request-draft-template.json'))), /ready/],
    ['dev MSK 주소', () => json('bootstrap.json', { BootstrapBrokerStringSaslIam: 'b-1.soma376devtelemetry.abc123.c2.kafka.ap-northeast-2.amazonaws.com:9098' }), /perf MSK/],
    ['평문 broker 주소', () => json('bootstrap.json', { BootstrapBrokerString: 'b-1.x:9092' }), /SaslIam/],
    ['broker 2대만 있는 list-nodes', () => json('nodes.json', { NodeInfoList: MSK_NODES.NodeInfoList.slice(0, 2) }), /3개/],
    ['사용자 JWT·OIDC runtime 입력', () => writeFileSync(path('runtime.yaml'), RUNTIME_VALUES + 'oidc:\n  enabled: true\n'), /만 받는다/],
    ['공개키에 없는 active kid', () => writeFileSync(path('runtime.yaml'), RUNTIME_VALUES.replace(`activeKid: ${KID}`, 'activeKid: other')), /activeKid/],
  ])('%s는 거부한다', (_name, mutate, message) => {
    mutate();
    expect(() => values(valuesArgs())).toThrow(message);
  });

  test('비밀 원문 모양 값이 있는 입력은 원문을 출력하지 않고 거부한다', () => {
    const token = `ptt_${'x'.repeat(24)}`;
    json('stacks.json', { Stacks: [...stacks.Stacks, { StackName: 'PerfEksStack', Outputs: [{ OutputKey: 'Leak', OutputValue: token }] }] });
    expect(() => values(valuesArgs())).toThrow(/비밀 원문/);
    try { values(valuesArgs()); } catch (error) { expect(String(error)).not.toContain(token); }
  });
});
