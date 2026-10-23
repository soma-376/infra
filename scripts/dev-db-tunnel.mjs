#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { constants } from 'node:os';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load, JSON_SCHEMA } from 'js-yaml';

const REGION = 'ap-northeast-2';
const CLUSTER_NAME = 'soma-376-dev-eks';
const DOCUMENTS = {
  postgres: 'soma-376-dev-db-postgres-tunnel',
  clickhouse: 'soma-376-dev-db-clickhouse-tunnel',
};
const OUTPUT_KEYS = [
  'DbRelayInstanceId', 'DbOperatorRoleArn', 'DbRelayPostgresSessionDocumentName',
  'DbRelayClickHouseSessionDocumentName',
];
// 명시한 프로필 대신 상위 셸의 임시 credential/provider가 선택되지 않도록 자식 환경에서만 제거한다.
const CREDENTIAL_ENV = [
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_SECURITY_TOKEN',
  'AWS_ROLE_ARN', 'AWS_ROLE_SESSION_NAME', 'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', 'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN', 'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
];
const HELP = `사용법:
  node scripts/dev-db-tunnel.mjs postgres --outputs <outputs.json> --profile <DB 프로필> [--local-port 15432]
  node scripts/dev-db-tunnel.mjs clickhouse --outputs <outputs.json> --profile <DB 프로필> --kubeconfig <파일> --eks-profile <EKS 프로필> [--local-port 18123]

로컬 AWS CLI v2·Session Manager plugin이 필요하다. ClickHouse는 별도 터미널의 EKS API 터널과 kubectl이 필요하다.
이 터미널은 DB 터널 유지에 사용한다. 다른 터미널이나 DB 클라이언트에서 localhost의 선택한 포트로 접속한다.
Pod가 교체되면 다시 실행한다. Secret·DB 인증 정보는 읽지 않는다.`;

function parseArgs(argv) {
  const [database, ...rest] = argv;
  if (!Object.hasOwn(DOCUMENTS, database ?? '')) throw new Error('postgres 또는 clickhouse를 선택해야 한다');
  const options = {};
  const allowed = new Set(['--outputs', '--profile', '--local-port', '--kubeconfig', '--eks-profile']);
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i], value = rest[i + 1];
    if (!allowed.has(flag)) throw new Error('지원하지 않는 옵션이다. --help로 사용법을 확인한다');
    if (Object.hasOwn(options, flag)) throw new Error(`${flag}: 중복 옵션은 허용하지 않는다`);
    if (!value || value.startsWith('--') || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${flag}: 값이 필요하다`);
    options[flag] = value;
  }
  for (const key of ['--outputs', '--profile', ...(database === 'clickhouse' ? ['--kubeconfig', '--eks-profile'] : [])]) {
    if (!options[key]?.trim()) throw new Error(`${key}: 필수 옵션이다`);
  }
  if (database === 'postgres' && (options['--kubeconfig'] || options['--eks-profile'])) {
    throw new Error('PostgreSQL에는 --kubeconfig·--eks-profile을 사용하지 않는다');
  }
  const port = options['--local-port'] ?? (database === 'postgres' ? '15432' : '18123');
  if (!/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535) throw new Error('--local-port: 1~65535 정수가 필요하다');
  return { database, options, port };
}

function parseJson(text, label) {
  try {
    const value = JSON.parse(text);
    load(text, { schema: JSON_SCHEMA }); // JSON.parse가 덮어쓰는 중복 키도 거부한다.
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new Error(`${label}: 중복 키 없는 JSON object가 필요하다`); }
}

function readOutputs(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); }
  catch { throw new Error('--outputs: 파일을 읽을 수 없다'); }
  const document = parseJson(text, '--outputs');
  const outputs = {};
  const add = (key, value) => {
    if (!OUTPUT_KEYS.includes(key)) return;
    if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${key}: 배포 output 문자열이 필요하다`);
    if (Object.hasOwn(outputs, key) && outputs[key] !== value) throw new Error(`${key}: output 값이 충돌한다`);
    outputs[key] = value;
  };
  if (Object.hasOwn(document, 'Stacks')) {
    if (!Array.isArray(document.Stacks)) throw new Error('--outputs: describe-stacks의 Stacks 배열이 필요하다');
    for (const stack of document.Stacks) {
      if (!stack || (stack.Outputs !== undefined && !Array.isArray(stack.Outputs))) throw new Error('--outputs: Outputs 배열이 필요하다');
      for (const item of stack.Outputs ?? []) {
        if (!item || typeof item.OutputKey !== 'string') throw new Error('--outputs: OutputKey가 필요하다');
        add(item.OutputKey, item.OutputValue);
      }
    }
  } else {
    for (const values of Object.values(document)) {
      if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('--outputs: CDK --outputs-file 형식이 필요하다');
      for (const [key, value] of Object.entries(values)) add(key, value);
    }
  }
  for (const key of OUTPUT_KEYS) if (!outputs[key]) throw new Error(`${key}: 배포 output이 없다`);
  if (!/^i-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(outputs.DbRelayInstanceId)) throw new Error('DbRelayInstanceId: EC2 instance ID가 필요하다');
  const role = /^arn:aws:iam::([0-9]{12}):role\/soma-376-dev-db-operator$/.exec(outputs.DbOperatorRoleArn);
  if (!role) throw new Error('DbOperatorRoleArn: dev DB operator role ARN이 필요하다');
  if (outputs.DbRelayPostgresSessionDocumentName !== DOCUMENTS.postgres || outputs.DbRelayClickHouseSessionDocumentName !== DOCUMENTS.clickhouse) {
    throw new Error('DB Session 문서는 CDK 소유의 dev DB 전용 문서여야 한다');
  }
  return { ...outputs, account: role[1] };
}

function profileEnv(profile) {
  const env = { ...process.env };
  for (const name of [...CREDENTIAL_ENV, 'AWS_DEFAULT_PROFILE']) delete env[name];
  return { ...env, AWS_PROFILE: profile, AWS_REGION: REGION, AWS_DEFAULT_REGION: REGION, AWS_PAGER: '' };
}

class ChildFailure extends Error {
  constructor(command, code, signal) {
    super(`${command}: ${signal ? `${signal}로 종료됐다` : `종료 코드 ${code}`}`);
    this.exitCode = signal ? 128 + (constants.signals[signal] ?? 1) : code;
  }
}

function runChild(command, args, env, capture = false) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { env, stdio: ['inherit', capture ? 'pipe' : 'inherit', 'inherit'] });
    let stdout = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', chunk => { stdout += chunk; });
    // 터미널 SIGINT와 외부 SIGTERM 모두 현재 자식에게 전달한다. 셸은 사용하지 않는다.
    const onInterrupt = () => child.kill('SIGINT');
    const onTerminate = () => child.kill('SIGTERM');
    const cleanup = () => {
      process.off('SIGINT', onInterrupt);
      process.off('SIGTERM', onTerminate);
    };
    process.on('SIGINT', onInterrupt);
    process.on('SIGTERM', onTerminate);
    child.once('error', () => { cleanup(); reject(new Error(`${command}: 실행할 수 없다. 설치와 PATH를 확인한다`)); });
    child.once('close', (code, signal) => {
      cleanup();
      if (code !== 0 || signal) reject(new ChildFailure(command, code ?? 1, signal));
      else accept(stdout);
    });
  });
}

function checkKubeconfig(config, account, profile) {
  if (![config.contexts, config.clusters, config.users].every(items => Array.isArray(items) && items.length === 1)) {
    throw new Error('kubeconfig: 선택한 context·cluster·user가 하나씩 필요하다');
  }
  const context = config.contexts?.[0]?.context;
  const cluster = config.clusters?.find(item => item.name === context?.cluster);
  const user = config.users?.find(item => item.name === context?.user)?.user;
  const expected = `arn:aws:eks:${REGION}:${account}:cluster/${CLUSTER_NAME}`;
  if (context?.cluster !== expected || cluster?.name !== expected) throw new Error('kubeconfig: DB output과 같은 계정의 dev EKS cluster여야 한다');
  if (cluster.cluster?.['insecure-skip-tls-verify']) throw new Error('kubeconfig: TLS 검증을 비활성화할 수 없다');
  const exec = user?.exec;
  if (!exec || basename(exec.command ?? '') !== 'aws' || !Array.isArray(exec.args) || !exec.args.every(arg => typeof arg === 'string') ||
      user.token || user['client-key-data'] || user['client-key'] || user['auth-provider']) {
    throw new Error('kubeconfig: AWS CLI exec 인증이 필요하다');
  }
  const args = exec.args;
  const optionValues = flag => args.flatMap((arg, i) => arg === flag ? [args[i + 1]] : arg.startsWith(`${flag}=`) ? [arg.slice(flag.length + 1)] : []);
  const names = optionValues('--cluster-name');
  if (!args.includes('eks') || !args.includes('get-token') || names.length !== 1 || names[0] !== CLUSTER_NAME ||
      optionValues('--cluster-id').length || optionValues('--role-arn').length) {
    throw new Error('kubeconfig: dev EKS get-token과 명시한 프로필만 사용해야 한다');
  }
  const execEnv = exec.env ?? [];
  if (!Array.isArray(execEnv)) throw new Error('kubeconfig: exec.env 배열이 필요하다');
  if (execEnv.some(item => !item || typeof item.name !== 'string' || typeof item.value !== 'string' || CREDENTIAL_ENV.includes(item.name))) {
    throw new Error('kubeconfig: exec.env에 credential/provider를 직접 지정할 수 없다');
  }
  const profiles = [...optionValues('--profile'), ...execEnv.filter(item => ['AWS_PROFILE', 'AWS_DEFAULT_PROFILE'].includes(item.name)).map(item => item.value)];
  if (profiles.some(value => value !== profile)) throw new Error('kubeconfig: exec의 AWS 프로필이 --eks-profile과 다르다');
  const regions = [...optionValues('--region'), ...execEnv.filter(item => ['AWS_REGION', 'AWS_DEFAULT_REGION'].includes(item.name)).map(item => item.value)];
  if (regions.some(value => value !== REGION)) throw new Error('kubeconfig: exec의 AWS 리전이 ap-northeast-2와 다르다');
}

function clickHouseIp(document) {
  if (!Array.isArray(document.items)) throw new Error('kubectl: Pod 목록 items 배열이 필요하다');
  const candidates = document.items.filter(pod => pod?.metadata && !pod.metadata.deletionTimestamp &&
    pod.metadata.namespace === 'pulsemetry-dev' && pod.metadata.labels?.['app.kubernetes.io/name'] === 'clickhouse' &&
    pod.metadata.labels?.['app.kubernetes.io/instance'] === 'clickhouse' &&
    pod.status?.phase === 'Running' && Array.isArray(pod.status.conditions) && pod.status.conditions.some(condition => condition?.type === 'Ready' && condition.status === 'True') &&
    Array.isArray(pod.metadata.ownerReferences) && pod.metadata.ownerReferences.filter(owner => owner?.controller === true).length === 1 &&
    pod.metadata.ownerReferences.some(owner => owner?.controller === true && owner.kind === 'StatefulSet' && owner.name === 'clickhouse'));
  if (candidates.length !== 1) throw new Error('ClickHouse: 삭제 중이 아닌 Running·Ready StatefulSet/clickhouse Pod가 정확히 하나 필요하다');
  const ip = candidates[0].status.podIP;
  if (typeof ip !== 'string' || isIP(ip) !== 4 || !ip.startsWith('10.1.')) throw new Error('ClickHouse: Pod IP는 유효한 10.1.0.0/16 IPv4여야 한다');
  return ip;
}

async function main() {
  if (process.argv.length === 3 && ['--help', '-h'].includes(process.argv[2])) { console.log(HELP); return; }
  const { database, options, port } = parseArgs(process.argv.slice(2));
  const outputs = readOutputs(options['--outputs']);
  const parameters = { localPortNumber: [port] };
  if (database === 'clickhouse') {
    const kubeconfig = resolve(options['--kubeconfig']);
    const env = profileEnv(options['--eks-profile']);
    const prefix = ['--kubeconfig', kubeconfig];
    const config = await runChild('kubectl', [...prefix, 'config', 'view', '--minify', '--output', 'json'], env, true);
    checkKubeconfig(parseJson(config, 'kubeconfig'), outputs.account, options['--eks-profile']);
    const pods = await runChild('kubectl', [...prefix, '--request-timeout=15s', '--namespace', 'pulsemetry-dev', 'get', 'pods',
      '--selector', 'app.kubernetes.io/name=clickhouse,app.kubernetes.io/instance=clickhouse', '--output', 'json'], env, true);
    parameters.host = [clickHouseIp(parseJson(pods, 'kubectl'))];
  }
  console.error(`${database} 터널 시작: localhost:${port}. 이 터미널을 유지하고 다른 터미널/DB 클라이언트에서 접속한다.`);
  await runChild('aws', ['--profile', options['--profile'], '--region', REGION, 'ssm', 'start-session',
    '--target', outputs.DbRelayInstanceId, '--document-name', DOCUMENTS[database], '--parameters', JSON.stringify(parameters)], profileEnv(options['--profile']));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`dev-db-tunnel: ${error.message}`); process.exitCode = error instanceof ChildFailure ? error.exitCode : 1; });
}
