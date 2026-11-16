#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdir, readFile, writeFile, appendFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dump, loadAll } from 'js-yaml';
import { runAws, startSsmTunnel, requestMetadataHttps, parseMetadataResponse, METADATA_ACCEPT } from './dev-generated-values-inputs.mjs';
import { STRIMZI_CA, STRIMZI_BOOTSTRAP, STRIMZI_NAMESPACE, strimziUser, parseStrimziSecrets } from './strimzi-values.mjs';

const REGION = 'ap-northeast-2';
const CLUSTER = 'soma-376-dev-eks';
const OPERATOR = 'soma-376-dev-eks-operator';
const SESSION_DOCUMENT = 'soma-376-dev-eks-api-tunnel';
const SA = 'telemetry-kafka-offsets';
const fail = message => { throw new Error(`Kafka offsets: ${message}`); };
const check = (condition, message) => { if (!condition) fail(message); };

// 사용자 입력은 shell 문자열에 연결하지 않고 JSON values로 전달한다.
export function offsetInputs(env) {
  const mode = env.KAFKA_OFFSETS_MODE || 'plan';
  const partition = env.KAFKA_OFFSETS_PARTITION || '';
  const toOffset = env.KAFKA_OFFSETS_TO_OFFSET || '';
  const toDatetime = env.KAFKA_OFFSETS_TO_DATETIME || '';
  check(['plan', 'execute'].includes(mode), 'mode는 plan 또는 execute여야 한다');
  if (toDatetime) {
    check(!partition && !toOffset, '시간과 partition/offset을 함께 지정할 수 없다');
    check(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(Z|[+-]\d{2}:\d{2})$/.test(toDatetime) &&
      Number.isFinite(Date.parse(toDatetime)), '시간은 timezone을 포함한 ISO 형식이어야 한다');
    return { enabled: true, mode, toDatetime };
  }
  check(/^[0-5]$/.test(partition) && /^(0|[1-9]\d*)$/.test(toOffset) && Number.isSafeInteger(Number(toOffset)),
    'partition 0~5와 0 이상의 정확한 정수 offset이 필요하다');
  return { enabled: true, mode, partition: Number(partition), toOffset: Number(toOffset) };
}

function workflow(env) {
  check(env.GITHUB_REPOSITORY === 'soma-376/infra' && env.GITHUB_REF === 'refs/heads/develop' &&
    env.GITHUB_EVENT_NAME === 'workflow_dispatch', 'develop 수동 workflow에서만 실행한다');
  check(/^\d{12}$/.test(env.AWS_ACCOUNT_ID || ''), 'AWS_ACCOUNT_ID가 필요하다');
  check(env.RUNNER_TEMP && env.GITHUB_OUTPUT, 'runner 임시 경로가 필요하다');
  return join(env.RUNNER_TEMP, 'dev-kafka-offsets');
}

function validateTarget(target, account) {
  check(target.account === account && target.KafkaProvider === 'strimzi' && target.KafkaStage === 'main' &&
    target.KafkaTopicName === 'pulsemetry-dev-telemetry-ingress-main' &&
    target.KafkaConsumerGroupName === 'pulsemetry-dev-telemetry-ingest-main' &&
    target.EksClusterName === CLUSTER && target.EksRegion === REGION &&
    target.EksOperatorRoleArn === `arn:aws:iam::${account}:role/${OPERATOR}` &&
    target.EksRelaySessionDocumentName === SESSION_DOCUMENT && /^i-[a-f0-9]{17}$/.test(target.EksRelayInstanceId || '') &&
    /^https:\/\/[a-zA-Z0-9.-]+\.ap-northeast-2\.eks\.amazonaws\.com$/.test(target.EksClusterEndpoint || ''),
  '현재 dev main output이 필요하다');
  return target;
}

export async function prepare(env, { aws = runAws } = {}) {
  offsetInputs(env);
  const directory = workflow(env);
  const response = await aws(['cloudformation', 'describe-stacks', '--stack-name', 'DevEksStack'], { env });
  const stack = response.Stacks?.[0];
  check(response.Stacks?.length === 1 && stack.StackName === 'DevEksStack' &&
    stack.StackId?.startsWith(`arn:aws:cloudformation:${REGION}:${env.AWS_ACCOUNT_ID}:stack/DevEksStack/`) &&
    ['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'IMPORT_COMPLETE'].includes(stack.StackStatus), 'DevEksStack이 안정 상태여야 한다');
  const keys = ['EksClusterName', 'EksRegion', 'EksClusterEndpoint', 'EksOperatorRoleArn', 'EksRelayInstanceId',
    'EksRelaySessionDocumentName', 'KafkaProvider', 'KafkaStage', 'KafkaTopicName', 'KafkaConsumerGroupName'];
  const target = validateTarget({ ...Object.fromEntries((stack.Outputs || [])
    .filter(x => keys.includes(x.OutputKey)).map(x => [x.OutputKey, x.OutputValue])), account: env.AWS_ACCOUNT_ID }, env.AWS_ACCOUNT_ID);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, 'target.json'), JSON.stringify(target), { mode: 0o600 });
  await appendFile(env.GITHUB_OUTPUT, `operator_role_arn=${target.EksOperatorRoleArn}\n`);
}

// CLI 예외의 stderr·인자는 인증정보를 포함할 수 있어 외부로 전달하지 않는다.
function command(file, args, { env, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { env, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => error ? reject(new Error(`Kafka offsets: ${file === 'aws' ? 'AWS' : 'CLI'} 실행 실패`)) : resolve(stdout));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export function executionResources(rendered, mode) {
  const documents = loadAll(rendered).filter(Boolean);
  const accounts = documents.filter(x => x.kind === 'ServiceAccount' && x.metadata?.name === SA);
  const jobs = documents.filter(x => x.kind === 'Job');
  check(accounts.length === 1 && jobs.length === 1, 'offset ServiceAccount와 Job이 하나씩 필요하다');
  const job = jobs[0];
  check(job.metadata.namespace === STRIMZI_NAMESPACE && job.spec.template.spec.serviceAccountName === SA &&
    job.spec.template.metadata.labels['app.kubernetes.io/name'] === 'telemetry-kafka-admin', 'Job 실행 대상이 다르다');
  delete job.metadata.name;
  job.metadata.generateName = `telemetry-offsets-${mode}-`;
  return { account: accounts[0], job };
}

export async function waitForJob(kubectl, name, { now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const deadline = now() + 660_000;
  while (now() < deadline) {
    const job = JSON.parse(await kubectl(['get', 'job', name, '-o', 'json']));
    const conditions = job.status?.conditions || [];
    if (conditions.some(x => ['Failed', 'FailureTarget'].includes(x.type) && x.status === 'True')) fail('Job이 실패했다');
    if (conditions.some(x => x.type === 'Complete' && x.status === 'True')) return;
    await sleep(2000);
  }
  fail('Job 완료 대기 시간이 초과됐다. 재실행 전 대상 Job과 offset을 확인한다');
}

export async function run(env, deps = {}) {
  const offsets = offsetInputs(env);
  const directory = workflow(env);
  const aws = deps.aws || runAws, exec = deps.command || command;
  let tunnel, jobName, failure;
  const kubectlEnv = { ...env, KUBECONFIG: join(directory, 'kubeconfig') };
  const kubectl = (args, input) => exec(env.KUBECTL_BIN || 'kubectl', ['--namespace', STRIMZI_NAMESPACE, ...args], { env: kubectlEnv, input });
  try {
    const target = validateTarget(JSON.parse(await readFile(join(directory, 'target.json'), 'utf8')), env.AWS_ACCOUNT_ID);
    const identity = await aws(['sts', 'get-caller-identity'], { env });
    check(identity.Account === target.account && identity.Arn?.startsWith(`arn:aws:sts::${target.account}:assumed-role/${OPERATOR}/`), 'EKS 운영자 역할이 필요하다');
    const cluster = (await aws(['eks', 'describe-cluster', '--name', CLUSTER], { env })).cluster;
    check(cluster?.name === CLUSTER && cluster.status === 'ACTIVE' && cluster.endpoint === target.EksClusterEndpoint &&
      cluster.resourcesVpcConfig?.endpointPrivateAccess === true && cluster.resourcesVpcConfig.endpointPublicAccess === false,
    'private EKS 정보가 다르다');
    const ca = Buffer.from(cluster.certificateAuthority?.data || '', 'base64').toString('utf8');
    new X509Certificate(ca);
    const hostname = new URL(cluster.endpoint).hostname;
    tunnel = await (deps.startTunnel || startSsmTunnel)({ instanceId: target.EksRelayInstanceId, documentName: SESSION_DOCUMENT, env });
    await writeFile(kubectlEnv.KUBECONFIG, dump({ apiVersion: 'v1', kind: 'Config',
      clusters: [{ name: CLUSTER, cluster: { server: `https://127.0.0.1:${tunnel.port}`, 'tls-server-name': hostname, 'certificate-authority-data': cluster.certificateAuthority.data } }],
      contexts: [{ name: CLUSTER, context: { cluster: CLUSTER, user: OPERATOR } }], 'current-context': CLUSTER,
      users: [{ name: OPERATOR, user: { exec: { apiVersion: 'client.authentication.k8s.io/v1beta1', command: 'aws', interactiveMode: 'Never',
        args: ['--region', REGION, 'eks', 'get-token', '--cluster-name', CLUSTER, '--output', 'json'] } } }],
    }), { mode: 0o600 });
    const token = (await aws(['eks', 'get-token', '--cluster-name', CLUSTER], { env })).status?.token;
    check(typeof token === 'string' && token.startsWith('k8s-aws-v1.'), 'EKS 인증 응답이 필요하다');
    const items = [];
    for (const name of [STRIMZI_CA, ...['gateway', 'ingest', 'topic-admin', 'offset-admin'].map(role => strimziUser(role, 'main'))]) {
      const response = await (deps.requestMetadata || requestMetadataHttps)({ port: tunnel.port, hostname, ca, token,
        path: `/api/v1/namespaces/${STRIMZI_NAMESPACE}/secrets/${name}`, accept: METADATA_ACCEPT });
      items.push(parseMetadataResponse(response, name));
    }
    const tls = parseStrimziSecrets(JSON.stringify({ items }), 'main')['offset-admin'];
    const values = { provider: 'strimzi', region: REGION, bootstrapServers: STRIMZI_BOOTSTRAP, stage: 'main',
      topic: target.KafkaTopicName, consumerGroup: target.KafkaConsumerGroupName, topicInit: { enabled: false }, tls, offsets };
    const valuesFile = join(directory, 'values.json');
    await writeFile(valuesFile, JSON.stringify(values), { mode: 0o600 });
    const rendered = await exec(env.HELM_BIN || 'helm', ['template', 'telemetry-kafka-offsets', 'helm/dev/workloads/telemetry-kafka-admin',
      '--namespace', STRIMZI_NAMESPACE, '--kube-version', '1.36.0', '-f', valuesFile], { env });
    const resources = executionResources(rendered, offsets.mode);
    const existing = await kubectl(['get', 'serviceaccount', SA, '--ignore-not-found', '-o', 'name']);
    if (!existing.trim()) await kubectl(['create', '-f', '-'], JSON.stringify(resources.account));
    const created = JSON.parse(await kubectl(['create', '-f', '-', '-o', 'json'], JSON.stringify(resources.job)));
    jobName = created.metadata?.name;
    check(typeof jobName === 'string' && jobName.startsWith(resources.job.metadata.generateName) && /^[a-z0-9-]+$/.test(jobName), '생성된 Job 이름이 필요하다');
    (deps.log || console.log)(`Job: ${STRIMZI_NAMESPACE}/${jobName} (${offsets.mode})`);
    await waitForJob(kubectl, jobName, deps);
    (deps.log || console.log)('Kafka offset Job 완료');
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      if (jobName) (deps.log || console.log)(await kubectl(['logs', `job/${jobName}`, '--all-containers=true', '--prefix=true']));
    } catch (error) {
      if (!failure) throw error;
      (deps.log || console.log)('Job 로그 조회 실패. 원래 실행 오류를 유지한다.');
    } finally {
      try { await tunnel?.close(); }
      finally { await rm(directory, { recursive: true, force: true }); }
    }
  }
}

export async function main(args, env = process.env) {
  if (args.length !== 1) fail('validate|prepare|run 중 하나가 필요하다');
  if (args[0] === 'validate') { offsetInputs(env); workflow(env); }
  else if (args[0] === 'prepare') await prepare(env);
  else if (args[0] === 'run') await run(env);
  else fail('알 수 없는 명령');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error.message?.startsWith('Kafka offsets:') ? error.message : 'Kafka offsets: 실행 실패. AWS/EKS 접근과 대상 Job을 확인한다.');
    process.exitCode = 1;
  });
}
