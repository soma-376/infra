import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve(__dirname, '../../scripts/dev-db-tunnel.mjs');
const account = '123456789012';
const clusterArn = `arn:aws:eks:ap-northeast-2:${account}:cluster/soma-376-dev-eks`;
const defaults = () => ({ DevDataStack: {
  DbRelayInstanceId: 'i-0123456789abcdef0',
  DbOperatorRoleArn: `arn:aws:iam::${account}:role/soma-376-dev-db-operator`,
  DbRelayPostgresSessionDocumentName: 'soma-376-dev-db-postgres-tunnel',
  DbRelayClickHouseSessionDocumentName: 'soma-376-dev-db-clickhouse-tunnel',
} });
const kubeconfig = () => ({
  contexts: [{ name: 'pulsemetry-dev-ssm', context: { cluster: clusterArn, user: 'pulsemetry-dev-operator' } }],
  clusters: [{ name: clusterArn, cluster: { server: 'https://127.0.0.1:8443', 'tls-server-name': 'example.ap-northeast-2.eks.amazonaws.com', 'certificate-authority-data': 'DATA+OMITTED' } }],
  users: [{ name: 'pulsemetry-dev-operator', user: { exec: {
    command: 'aws', args: ['--region', 'ap-northeast-2', 'eks', 'get-token', '--cluster-name', 'soma-376-dev-eks', '--output', 'json'],
    env: [{ name: 'AWS_PROFILE', value: 'eks-operator' }],
  } } }],
});
const readyPod = (): any => ({
  metadata: { name: 'clickhouse-0', namespace: 'pulsemetry-dev',
    labels: { 'app.kubernetes.io/name': 'clickhouse', 'app.kubernetes.io/instance': 'clickhouse' },
    ownerReferences: [{ kind: 'StatefulSet', name: 'clickhouse', controller: true }] },
  status: { phase: 'Running', podIP: '10.1.0.25', conditions: [{ type: 'Ready', status: 'True' }] },
});

// PATH의 aws/kubectl은 임시 대역뿐이다. 테스트에서 실제 AWS·Kubernetes·DB를 호출하지 않는다.
const fakeCommand = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const action = command === 'aws' ? 'aws' : args.includes('config') ? 'config' : 'pods';
fs.appendFileSync(process.env.TUNNEL_TEST_LOG, JSON.stringify({command, args, profile: process.env.AWS_PROFILE,
  region: process.env.AWS_REGION, defaultProfile: process.env.AWS_DEFAULT_PROFILE,
  hasCredential: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_ROLE_ARN', 'AWS_WEB_IDENTITY_TOKEN_FILE'].some(name => name in process.env)}) + '\\n');
const signal = process.env['TUNNEL_TEST_SIGNAL_' + action];
if (signal) { process.kill(process.pid, signal); setTimeout(() => {}, 1000); }
else {
  if (command === 'kubectl') process.stdout.write(fs.readFileSync(process.env['TUNNEL_TEST_' + action.toUpperCase()], 'utf8'));
  process.exit(Number(process.env['TUNNEL_TEST_EXIT_' + action] || 0));
}
`;

interface RunOptions {
  database?: 'postgres' | 'clickhouse';
  args?: string[];
  extra?: string[];
  document?: any;
  rawOutputs?: string;
  config?: any;
  rawConfig?: string;
  pods?: any;
  rawPods?: string;
  env?: Record<string, string>;
  omitAws?: boolean;
}

describe('dev DB 로컬 SSM 터널', () => {
  const temps: string[] = [];
  afterEach(() => { for (const temp of temps.splice(0)) rmSync(temp, { recursive: true, force: true }); });

  function run(options: RunOptions = {}) {
    const temp = mkdtempSync(join(tmpdir(), 'dev-db-tunnel-test-'));
    temps.push(temp);
    const outputs = join(temp, 'outputs.json'), configFile = join(temp, 'kubeconfig.json'), podsFile = join(temp, 'pods.json'), log = join(temp, 'calls.jsonl');
    writeFileSync(outputs, options.rawOutputs ?? JSON.stringify(options.document ?? defaults()));
    writeFileSync(configFile, options.rawConfig ?? JSON.stringify(options.config ?? kubeconfig()));
    writeFileSync(podsFile, options.rawPods ?? JSON.stringify(options.pods ?? { items: [readyPod()] }));
    for (const command of options.omitAws ? ['kubectl'] : ['aws', 'kubectl']) writeFileSync(join(temp, command), fakeCommand, { mode: 0o755 });
    const database = options.database ?? 'postgres';
    const args = options.args ?? [database, '--outputs', outputs, '--profile', 'db-operator',
      ...(database === 'clickhouse' ? ['--kubeconfig', configFile, '--eks-profile', 'eks-operator'] : []), ...(options.extra ?? [])];
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 10000, env: {
      ...process.env, PATH: temp, AWS_PROFILE: 'parent-profile', AWS_DEFAULT_PROFILE: 'parent-default',
      AWS_ACCESS_KEY_ID: 'fake-key', AWS_SECRET_ACCESS_KEY: 'fake-secret', AWS_SESSION_TOKEN: 'fake-token',
      AWS_ROLE_ARN: 'fake-role', AWS_WEB_IDENTITY_TOKEN_FILE: 'fake-file',
      TUNNEL_TEST_LOG: log, TUNNEL_TEST_CONFIG: configFile, TUNNEL_TEST_PODS: podsFile, ...options.env,
    } });
    const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
    return { result, calls, configFile };
  }

  test('PostgreSQL은 Pod 조회 없이 고정 Session 문서와 로컬 포트로 연결한다', () => {
    const { result, calls } = run();
    expect(result.status).toBe(0);
    expect(calls).toEqual([{ command: 'aws', args: [
      '--profile', 'db-operator', '--region', 'ap-northeast-2', 'ssm', 'start-session',
      '--target', 'i-0123456789abcdef0', '--document-name', 'soma-376-dev-db-postgres-tunnel',
      '--parameters', '{"localPortNumber":["15432"]}',
    ], profile: 'db-operator', region: 'ap-northeast-2', hasCredential: false }]);
    expect(result.stderr).toContain('localhost:15432');
  });

  test('ClickHouse는 명시한 kubeconfig·EKS 프로필로 현재 Pod IP를 얻어 DB 프로필로 전달한다', () => {
    const { result, calls, configFile } = run({ database: 'clickhouse' });
    expect(result.status).toBe(0);
    expect(calls.map(call => call.command)).toEqual(['kubectl', 'kubectl', 'aws']);
    expect(calls[0].args).toEqual(['--kubeconfig', configFile, 'config', 'view', '--minify', '--output', 'json']);
    expect(calls[1].args).toEqual(['--kubeconfig', configFile, '--request-timeout=15s', '--namespace', 'pulsemetry-dev', 'get', 'pods',
      '--selector', 'app.kubernetes.io/name=clickhouse,app.kubernetes.io/instance=clickhouse', '--output', 'json']);
    expect(calls.map(call => call.profile)).toEqual(['eks-operator', 'eks-operator', 'db-operator']);
    expect(calls.every(call => !call.hasCredential && !call.defaultProfile)).toBe(true);
    expect(calls[2].args).toContain('soma-376-dev-db-clickhouse-tunnel');
    expect(JSON.parse(calls[2].args.at(-1))).toEqual({ localPortNumber: ['18123'], host: ['10.1.0.25'] });
    expect(JSON.stringify(calls)).not.toContain('portNumber');
  });

  test('describe-stacks output과 사용자 지정 로컬 포트를 지원한다', () => {
    const document = { Stacks: [{ StackName: 'DevDataStack', Outputs: Object.entries(defaults().DevDataStack).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })) }] };
    const { result, calls } = run({ document, extra: ['--local-port', '65535'] });
    expect(result.status).toBe(0);
    expect(JSON.parse(calls[0].args.at(-1))).toEqual({ localPortNumber: ['65535'] });
  });

  test('도움말은 외부 명령 없이 두 터미널 사용 전제를 설명한다', () => {
    const { result, calls } = run({ args: ['--help'] });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('별도 터미널');
    expect(calls).toEqual([]);
  });

  test.each([
    [], ['other'], ['postgres'], ['postgres', '--outputs', 'x'],
    ['postgres', '--outputs', 'x', '--profile'],
    ['clickhouse', '--outputs', 'x', '--profile', 'db'],
    ['clickhouse', '--outputs', 'x', '--profile', 'db', '--kubeconfig', 'x'],
  ].map(args => ({ args })))('필수 입력 누락을 외부 명령 전에 거부한다: $args', ({ args }) => {
    const { result, calls } = run({ args });
    expect(result.status).toBe(1);
    expect(calls).toEqual([]);
  });

  test.each(['0', '-1', '65536', '1.5', '015432', 'abc', '15432\n'])('잘못된 로컬 포트를 거부한다: %s', port => {
    const { result, calls } = run({ extra: ['--local-port', port] });
    expect(result.status).toBe(1);
    expect(calls).toEqual([]);
  });

  test.each([
    ['--host', '10.1.0.1'], ['--portNumber', '9000'], ['--region', 'us-east-1'],
    ['--profile', 'other'], ['--kubeconfig', 'x'], ['--eks-profile', 'other'],
  ].map(extra => ({ extra })))('목적지 변경·중복·불필요한 옵션을 거부한다: $extra', ({ extra }) => {
    const { result, calls } = run({ extra });
    expect(result.status).toBe(1);
    expect(calls).toEqual([]);
  });

  test.each(['{', 'null', '[]', '{"DevDataStack":null}', '{"Stacks":{}}', '{"Stacks":[{"Outputs":{}}]}',
    '{"DevDataStack":{"DbRelayInstanceId":"i-0123456789abcdef0","DbRelayInstanceId":"i-0123456789abcdef1"}}'])('잘못된 output JSON을 거부한다: %s', rawOutputs => {
    const { result, calls } = run({ rawOutputs });
    expect(result.status).toBe(1);
    expect(calls).toEqual([]);
  });

  test.each([
    ['DbRelayInstanceId', undefined], ['DbRelayInstanceId', 'i-wrong'], ['DbOperatorRoleArn', 'arn:aws:iam::123456789012:role/prod'],
    ['DbRelayPostgresSessionDocumentName', 'AWS-StartPortForwardingSessionToRemoteHost'],
    ['DbRelayClickHouseSessionDocumentName', '${Token[TOKEN.1]}'],
  ])('배포 output의 필수 값과 목적지 경계를 확인한다: %s', (key, value) => {
    const document: any = defaults();
    document.DevDataStack[key] = value;
    const { result, calls } = run({ document });
    expect(result.status).toBe(1);
    expect(calls).toEqual([]);
  });

  test('같은 output 키의 충돌을 거부한다', () => {
    const { result, calls } = run({ document: { ...defaults(), WrongStack: { DbRelayInstanceId: 'i-0123456789abcdef1' } } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('충돌');
    expect(calls).toEqual([]);
  });

  test('kubeconfig에 프로필이 없으면 자식 환경의 --eks-profile을 사용한다', () => {
    const config = kubeconfig();
    config.users[0].user.exec.env = [];
    const { result, calls } = run({ database: 'clickhouse', config });
    expect(result.status).toBe(0);
    expect(calls[1].profile).toBe('eks-operator');
  });

  test('kubeconfig의 일치하는 --profile 인자는 허용한다', () => {
    const config = kubeconfig();
    config.users[0].user.exec.args.push('--profile=eks-operator');
    expect(run({ database: 'clickhouse', config }).result.status).toBe(0);
  });

  test.each(['env', 'arg', 'argEquals', 'credential', 'role', 'cluster', 'account', 'region', 'tls'])('kubeconfig의 프로필·대상·인증 충돌을 Pod 조회 전에 거부한다: %s', kind => {
    const config: any = kubeconfig();
    const exec = config.users[0].user.exec;
    if (kind === 'env') exec.env[0].value = 'other';
    if (kind === 'arg') exec.args.push('--profile', 'other');
    if (kind === 'argEquals') exec.args.push('--profile=other');
    if (kind === 'credential') exec.env.push({ name: 'AWS_ACCESS_KEY_ID', value: 'should-not-be-printed' });
    if (kind === 'role') exec.args.push('--role-arn', 'another-role');
    if (kind === 'cluster') exec.args[exec.args.indexOf('--cluster-name') + 1] = 'prod';
    if (kind === 'account') config.contexts[0].context.cluster = clusterArn.replace(account, '999999999999');
    if (kind === 'region') exec.args[1] = 'us-east-1';
    if (kind === 'tls') config.clusters[0].cluster['insecure-skip-tls-verify'] = true;
    const { result, calls } = run({ database: 'clickhouse', config });
    expect(result.status).toBe(1);
    expect(calls).toHaveLength(1);
    expect(result.stderr).not.toContain('should-not-be-printed');
  });

  test.each(['missing', 'notReady', 'pending', 'deleting', 'owner', 'nonController', 'twoControllers', 'label', 'namespace', 'multiple'])('준비되지 않았거나 잘못 선택된 Pod를 SSM 전에 거부한다: %s', kind => {
    const pod = readyPod();
    if (kind === 'notReady') pod.status.conditions[0].status = 'False';
    if (kind === 'pending') pod.status.phase = 'Pending';
    if (kind === 'deleting') pod.metadata.deletionTimestamp = '2026-10-23T00:00:00Z';
    if (kind === 'owner') pod.metadata.ownerReferences[0].name = 'other';
    if (kind === 'nonController') pod.metadata.ownerReferences[0].controller = false;
    if (kind === 'twoControllers') pod.metadata.ownerReferences.push({ kind: 'Deployment', name: 'other', controller: true });
    if (kind === 'label') pod.metadata.labels['app.kubernetes.io/instance'] = 'other';
    if (kind === 'namespace') pod.metadata.namespace = 'production';
    const items = kind === 'missing' ? [] : kind === 'multiple' ? [pod, readyPod()] : [pod];
    const { result, calls } = run({ database: 'clickhouse', pods: { items } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('정확히 하나');
    expect(calls.map(call => call.command)).toEqual(['kubectl', 'kubectl']);
  });

  test('종료 중인 구 Pod는 제외하고 준비된 현재 Pod만 선택한다', () => {
    const old = readyPod();
    old.metadata.deletionTimestamp = '2026-10-23T00:00:00Z';
    const { result, calls } = run({ database: 'clickhouse', pods: { items: [old, readyPod()] } });
    expect(result.status).toBe(0);
    expect(JSON.parse(calls[2].args.at(-1)).host).toEqual(['10.1.0.25']);
  });

  test.each([undefined, '10.2.0.1', '127.0.0.1', '169.254.169.254', '10.1.256.1', '10.1.01.2', '::1', 'clickhouse.pulsemetry-dev', '10.1.0.2\n'])('dev VPC 외부·잘못된 Pod IP를 거부한다: %s', podIP => {
    const pod = readyPod();
    pod.status.podIP = podIP;
    const { result, calls } = run({ database: 'clickhouse', pods: { items: [pod] } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('IPv4');
    expect(calls).toHaveLength(2);
  });

  test.each(['config', 'pods'])('kubectl %s의 잘못된 JSON과 실패 코드를 전달하고 SSM을 열지 않는다', action => {
    const malformed = run({ database: 'clickhouse', ...(action === 'config' ? { rawConfig: '{' } : { rawPods: '{' }) });
    expect(malformed.result.status).toBe(1);
    expect(malformed.calls.some(call => call.command === 'aws')).toBe(false);
    const failed = run({ database: 'clickhouse', env: { [`TUNNEL_TEST_EXIT_${action}`]: '42' } });
    expect(failed.result.status).toBe(42);
    expect(failed.calls.some(call => call.command === 'aws')).toBe(false);
  });

  test('AWS CLI 실패 코드를 그대로 전달한다', () => {
    expect(run({ env: { TUNNEL_TEST_EXIT_aws: '43' } }).result.status).toBe(43);
  });

  test.each(['aws', 'config', 'pods'])('자식의 SIGTERM을 종료 코드 143으로 전달한다: %s', action => {
    expect(run({ database: action === 'aws' ? 'postgres' : 'clickhouse', env: { [`TUNNEL_TEST_SIGNAL_${action}`]: 'SIGTERM' } }).result.status).toBe(143);
  });

  test('AWS CLI가 없으면 명확한 오류로 종료한다', () => {
    const { result } = run({ omitAws: true });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('설치와 PATH');
  });
});
