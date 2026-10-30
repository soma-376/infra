import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { App } from 'aws-cdk-lib/core';
import { loadPerfConfig, perfInfraParameters } from '../../lib/perf/config';
import { cpuQuantity, loadPerfProfile, memoryQuantity, parsePerfProfile } from '../../lib/perf/profile';

const root = resolve(__dirname, '../..');
const file = 'profiles/perf/fixed-v1.json';
const base = () => JSON.parse(readFileSync(join(root, file), 'utf8'));

test('fixed-v1은 가설 프로필이며 바이트 SHA-256과 저장소 상대 경로를 돌려준다', () => {
  const loaded = loadPerfProfile(file, root);
  expect(loaded.path).toBe(file);
  expect(loaded.sha256).toBe(createHash('sha256').update(readFileSync(join(root, file))).digest('hex'));
  const { profile } = loaded;
  expect(profile.status).toBe('hypothesis');
  expect(Object.fromEntries(Object.entries(profile.node_pools).map(([id, pool]) => [id, [pool.instance_type, pool.nodes, pool.dedicated]]))).toEqual({
    gateway: ['m7g.large', 1, true], pipeline: ['m7g.large', 1, true], clickhouse: ['r7g.large', 1, true],
    generator: ['c7g.large', 1, true], observability: ['m7g.large', 1, true], system: ['m7g.large', 1, false],
  });
  expect(profile.rds).toEqual({ engine_version: '16.13', instance_class: 'db.t4g.medium', storage_gib: 20, multi_az: false });
  expect(profile.msk).toMatchObject({ kafka_version: '3.9.x.kraft', broker_count: 3, instance_type: 'kafka.m7g.large', volume_gib: 100, partitions: 6, replication_factor: 3, min_insync_replicas: 2, retention_hours: 72 });
  expect(profile.retention).toEqual({ evidence_days: 90, raw_signal_days: 7, prometheus_days: 7, prometheus_bytes: 20_000_000_000, cloudwatch_log_days: 14 });
  expect(profile.network.nat_gateways).toBe(1);
});

describe('프로필 검사기는 잘못된 입력을 조용히 고치지 않는다', () => {
  const cases: [string, (p: any) => void, RegExp][] = [
    ['모르는 키', p => { p.extra = 1; }, /알 수 없는 키 extra/],
    ['x86 인스턴스', p => { p.node_pools.gateway.instance_type = 'm7i.large'; }, /Graviton/],
    ['spot', p => { p.node_pools.generator.capacity_type = 'spot'; }, /on-demand/],
    ['측정 pool의 공유', p => { p.node_pools.gateway.dedicated = false; }, /true다/],
    ['system pool taint', p => { p.node_pools.system.dedicated = true; }, /false다/],
    ['다른 pool 배치', p => { p.workloads['telemetry-gateway'].node_pool = 'system'; }, /"gateway"/],
    ['runner의 system 배치', p => { p.jobs.runner.node_pool = 'system'; }, /"generator"/],
    ['replica 2', p => { p.workloads['telemetry-ingest'].replicas = 2; }, /replicas/],
    ['MiB 단위가 아닌 memory', p => { p.workloads.clickhouse.memory_request_bytes += 1; p.workloads.clickhouse.memory_limit_bytes += 1; }, /MiB/],
    ['request보다 작은 limit', p => { p.workloads.clickhouse.memory_limit_bytes = 2 ** 30; }, /작을 수 없다/],
    ['dev와 겹치는 CIDR', p => { p.network.vpc_cidr = '10.1.0.0/16'; }, /겹치지/],
    ['NAT 0', p => { p.network.nat_gateways = 0; }, /nat_gateways/],
    ['broker 2대', p => { p.msk.broker_count = 2; }, /broker_count/],
    ['gp3 IOPS 상한', p => { p.clickhouse.volume_gib = 20; p.clickhouse.iops = 12000; }, /500 IOPS/],
    ['지원하지 않는 로그 보존', p => { p.retention.cloudwatch_log_days = 10; }, /CloudWatch/],
    ['정수 아닌 노드 수', p => { p.node_pools.system.nodes = 1.5; }, /정수/],
  ];
  test.each(cases)('%s', (_name, mutate, message) => {
    const profile = base();
    mutate(profile);
    expect(() => parsePerfProfile(profile)).toThrow(message);
  });
});

describe('파일 경로·이름·중복 키', () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'perf-profile-'));
    mkdirSync(join(directory, 'profiles/perf'), { recursive: true });
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  test('profiles/perf 밖의 파일은 거부한다', () => {
    writeFileSync(join(directory, 'fixed-v1.json'), JSON.stringify(base()));
    expect(() => loadPerfProfile('fixed-v1.json', directory)).toThrow(/profiles\/perf/);
  });
  test('id와 파일 이름이 다르면 거부한다', () => {
    writeFileSync(join(directory, 'profiles/perf/other.json'), JSON.stringify(base()));
    expect(() => loadPerfProfile('profiles/perf/other.json', directory)).toThrow(/파일 이름/);
  });
  test('중복 키는 거부한다', () => {
    const text = JSON.stringify(base()).replace('"status":"hypothesis"', '"status":"hypothesis","status":"ready"');
    writeFileSync(join(directory, 'profiles/perf/fixed-v1.json'), text);
    expect(() => loadPerfProfile('profiles/perf/fixed-v1.json', directory)).toThrow(/중복 키/);
  });
});

test('Kubernetes 수량 표기는 정수 단위를 보존한다', () => {
  expect([cpuQuantity(1500), cpuQuantity(2000), memoryQuantity(4 * 2 ** 30), memoryQuantity(512 * 2 ** 20)]).toEqual(['1500m', '2', '4Gi', '512Mi']);
  expect(() => memoryQuantity(1000)).toThrow(/MiB/);
});

describe('loadPerfConfig', () => {
  const app = (context: Record<string, unknown>) => new App({ context });
  test('environment ID는 필수이고 perf- slug여야 한다', () => {
    expect(() => loadPerfConfig(app({}))).toThrow(/perfEnvironmentId/);
    expect(() => loadPerfConfig(app({ perfEnvironmentId: 'dev-1' }))).toThrow(/perfEnvironmentId/);
    expect(() => loadPerfConfig(app({ perfEnvironmentId: 'perf-A' }))).toThrow(/perfEnvironmentId/);
  });
  test('NAT·broker volume 입력은 프로필 기본값을 덮어쓰고 infra.parameters에 기록된다', () => {
    const config = loadPerfConfig(app({ perfEnvironmentId: 'perf-20261101-a', perfNatGateways: '3', perfMskBrokerVolumeGiB: 200 }));
    expect(perfInfraParameters(config)).toEqual({ environmentId: 'perf-20261101-a', natGateways: 3, mskBrokerVolumeGiB: 200, clickhouseVolumeGiB: 100 });
    expect(perfInfraParameters(loadPerfConfig(app({ perfEnvironmentId: 'perf-x' })))).toMatchObject({ natGateways: 1, mskBrokerVolumeGiB: 100 });
  });
  test.each([['perfNatGateways', 0], ['perfNatGateways', '1.5'], ['perfMskBrokerVolumeGiB', 'big']])('%s=%s는 거부한다', (key, value) => {
    expect(() => loadPerfConfig(app({ perfEnvironmentId: 'perf-x', [key]: value }))).toThrow(key);
  });
});
