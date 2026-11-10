import { execFile, spawn } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { request } from 'node:https';
import { createConnection, createServer } from 'node:net';
import { load, JSON_SCHEMA } from 'js-yaml';
import { collectOutputs } from './eks-values.mjs';
import { parseStrimziSecrets, STRIMZI_CA, STRIMZI_NAMESPACE, strimziUser } from './strimzi-values.mjs';

const REGION = 'ap-northeast-2';
const CLUSTER = 'soma-376-dev-eks';
const READER_ROLE = 'soma-376-dev-eks-values-reader';
const SESSION_DOCUMENT = 'soma-376-dev-eks-api-tunnel';
const STACKS = ['DevNetworkStack', 'DevDataStack', 'DevEdgeStack', 'DevEksStack'];
const STABLE = new Set(['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'IMPORT_COMPLETE']);
const NAMES = [STRIMZI_CA, ...['gateway', 'ingest', 'topic-admin', 'offset-admin'].map(role => strimziUser(role, 'main'))];
export const METADATA_ACCEPT = 'application/json;as=PartialObjectMetadata;g=meta.k8s.io;v=v1';
const failure = label => new Error(`generated values 입력: ${label}`);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function parseJson(text, label) {
  try {
    const value = JSON.parse(text);
    load(text, { schema: JSON_SCHEMA });
    if (!object(value)) throw new Error();
    return value;
  } catch { throw failure(`${label} 응답 형식 오류`); }
}

// CLI stderr·예외 객체에는 조회 원문 또는 자격증명이 있을 수 있어 고정 메시지만 반환한다.
export function runAws(args, { env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    execFile('aws', ['--region', REGION, '--output', 'json', '--no-cli-pager', ...args], {
      env: { ...env, AWS_PAGER: '', AWS_EC2_METADATA_DISABLED: 'true' },
      encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout) => {
      if (error) return reject(failure('AWS 조회 실패'));
      try { resolve(parseJson(stdout, 'AWS')); }
      catch { reject(failure('AWS 응답 형식 오류')); }
    });
  });
}

function readerEnvironment(credentials) {
  if (!object(credentials) || !['AccessKeyId', 'SecretAccessKey', 'SessionToken'].every(key =>
    typeof credentials[key] === 'string' && credentials[key] && !/[\r\n\u0000]/.test(credentials[key])) ||
    !(Date.parse(credentials.Expiration) > Date.now() + 60_000)) throw failure('reader 임시 자격증명 오류');
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^AWS_(PROFILE|DEFAULT_PROFILE|ROLE_ARN|ROLE_SESSION_NAME|WEB_IDENTITY_TOKEN_FILE|SECURITY_TOKEN|CONTAINER_|ENDPOINT_URL)/.test(key)) delete env[key];
  }
  return { ...env, AWS_CONFIG_FILE: '/dev/null', AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
    AWS_ACCESS_KEY_ID: credentials.AccessKeyId, AWS_SECRET_ACCESS_KEY: credentials.SecretAccessKey,
    AWS_SESSION_TOKEN: credentials.SessionToken, AWS_REGION: REGION, AWS_DEFAULT_REGION: REGION,
    AWS_PAGER: '', AWS_EC2_METADATA_DISABLED: 'true' };
}

async function localPort() {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', () => reject(failure('로컬 터널 포트 확보 실패')));
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(failure('로컬 터널 포트 확보 실패')) : resolve(port));
    });
  });
}

/** 자신이 생성한 AWS CLI·Session Manager plugin 프로세스만 종료한다. */
export async function startSsmTunnel({ instanceId, documentName, env }) {
  const port = await localPort();
  const child = spawn('aws', ['--region', REGION, '--no-cli-pager', 'ssm', 'start-session',
    '--target', instanceId, '--document-name', documentName,
    '--parameters', JSON.stringify({ localPortNumber: [String(port)] }),
  ], { env, stdio: 'ignore', detached: process.platform !== 'win32' });
  let ended = false, closing;
  const endedPromise = new Promise(resolve => {
    child.once('error', () => { ended = true; resolve(); });
    child.once('exit', () => { ended = true; resolve(); });
  });
  const kill = signal => {
    if (!child.pid) return;
    try {
      if (process.platform === 'win32') child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch { /* 이미 종료된 자신의 프로세스 그룹만 무시한다. */ }
  };
  const onExit = () => kill('SIGTERM');
  const onTerm = () => { close().finally(() => process.exit(143)); };
  const onInt = () => { close().finally(() => process.exit(130)); };
  process.once('exit', onExit);
  process.once('SIGTERM', onTerm);
  process.once('SIGINT', onInt);
  function close() {
    if (closing) return closing;
    closing = (async () => {
      kill('SIGTERM');
      let timeout;
      await Promise.race([endedPromise, new Promise(resolve => {
        timeout = setTimeout(() => { kill('SIGKILL'); resolve(); }, 2_000);
      })]);
      clearTimeout(timeout);
      // CLI가 먼저 끝난 경우에도 남은 plugin은 같은 그룹에서 정리한다.
      kill('SIGKILL');
      process.removeListener('exit', onExit);
      process.removeListener('SIGTERM', onTerm);
      process.removeListener('SIGINT', onInt);
    })();
    return closing;
  }
  try {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (ended) throw failure('SSM 터널 시작 실패');
      const connected = await new Promise(resolve => {
        const socket = createConnection({ host: '127.0.0.1', port });
        let finished = false;
        const finish = value => { if (finished) return; finished = true; socket.destroy(); resolve(value); };
        socket.once('connect', () => finish(true));
        socket.once('error', () => finish(false));
        socket.setTimeout(250, () => finish(false));
      });
      if (connected && !ended) return { port, close };
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw failure('SSM 터널 준비 시간 초과');
  } catch {
    await close();
    throw failure('SSM 터널 준비 실패');
  }
}

/** servername과 CA 검증을 보존한 개별 Secret metadata-only GET. redirect·전체 응답 fallback은 없다. */
export function requestMetadataHttps({ port, hostname, ca, token, path, accept }, requestImpl = request) {
  return new Promise((resolve, reject) => {
    const req = requestImpl({
      hostname: '127.0.0.1', port, servername: hostname, ca, rejectUnauthorized: true,
      agent: false, method: 'GET', path,
      headers: { Accept: accept, Authorization: `Bearer ${token}`, Host: hostname },
    }, response => {
      let size = 0;
      const chunks = [];
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 1024 * 1024) { req.destroy(); reject(failure('metadata 응답 크기 초과')); }
        else chunks.push(chunk);
      });
      response.once('error', () => reject(failure('metadata 수신 실패')));
      response.once('end', () => resolve({ statusCode: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.setTimeout(10_000, () => req.destroy());
    req.once('error', () => reject(failure('metadata TLS 요청 실패')));
    req.end();
  });
}

export function parseMetadataResponse(response, expectedName) {
  if (response?.statusCode !== 200 || !/^application\/json(?:\s*;|$)/i.test(response.headers?.['content-type'] ?? '') ||
    typeof response.body !== 'string' || Buffer.byteLength(response.body) > 1024 * 1024) throw failure('metadata-only 응답 필요');
  const value = parseJson(response.body, 'metadata');
  if (Object.keys(value).sort().join() !== 'apiVersion,kind,metadata' || value.kind !== 'PartialObjectMetadata' ||
    value.apiVersion !== 'meta.k8s.io/v1' || !object(value.metadata) || value.metadata.name !== expectedName ||
    value.metadata.namespace !== STRIMZI_NAMESPACE) throw failure('metadata-only 객체 불일치');
  const { name, namespace, uid, resourceVersion } = value.metadata;
  return { metadata: { name, namespace, uid, resourceVersion } };
}

function stackOutputs(response, name, accountId) {
  const stack = response?.Stacks?.[0];
  if (!Array.isArray(response?.Stacks) || response.Stacks.length !== 1 || response.NextToken || !object(stack) ||
    stack.StackName !== name || !new RegExp(`^arn:aws:cloudformation:${REGION}:${accountId}:stack/${name}/[A-Za-z0-9-]+$`).test(stack.StackId ?? '') ||
    !STABLE.has(stack.StackStatus) || !Array.isArray(stack.Outputs)) throw failure('배포 스택의 식별자·안정 상태 오류');
  const outputs = {};
  for (const entry of stack.Outputs) {
    if (!object(entry) || !/^[A-Za-z][A-Za-z0-9]*$/.test(entry.OutputKey ?? '') ||
      typeof entry.OutputValue !== 'string' || !entry.OutputValue || /[\r\n\u0000]/.test(entry.OutputValue) ||
      Object.hasOwn(outputs, entry.OutputKey)) throw failure('CloudFormation output 형식 오류');
    outputs[entry.OutputKey] = entry.OutputValue;
  }
  return outputs;
}

/** 조회 원문·임시 credential·kubeconfig를 파일이나 로그로 남기지 않는다. */
export async function collectGeneratedValuesInputs({
  accountId, runId, runAttempt, aws = runAws, startTunnel = startSsmTunnel, requestMetadata = requestMetadataHttps,
}) {
  if (!/^[0-9]{12}$/.test(accountId ?? '') || !/^[1-9][0-9]{0,19}$/.test(String(runId ?? '')) ||
    !/^[1-9][0-9]{0,5}$/.test(String(runAttempt ?? ''))) throw failure('계정·실행 식별자 오류');
  let tunnel, readerEnv, closed = false;
  const safeAws = async (args, env) => {
    try { return await aws(args, { env }); }
    catch { throw failure('AWS 조회 실패'); }
  };
  const close = async () => {
    if (closed) return;
    closed = true;
    try { await tunnel?.close(); }
    finally {
      if (readerEnv) for (const key of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN']) delete readerEnv[key];
    }
  };
  try {
    const outputs = {};
    for (const name of STACKS) outputs[name] = stackOutputs(await safeAws(['cloudformation', 'describe-stacks', '--stack-name', name]), name, accountId);
    const flattened = collectOutputs(outputs);
    const expectedRole = `arn:aws:iam::${accountId}:role/${READER_ROLE}`;
    if (flattened.KafkaProvider !== 'strimzi' || flattened.KafkaStage !== 'main' || flattened.ArchivePrefix !== 'eks' ||
      flattened.EksClusterName !== CLUSTER || flattened.EksRegion !== REGION || flattened.EksValuesReaderRoleArn !== expectedRole ||
      flattened.EksRelaySessionDocumentName !== SESSION_DOCUMENT || !/^i-[a-f0-9]{17}$/.test(flattened.EksRelayInstanceId ?? '') ||
      !/^https:\/\/[a-zA-Z0-9.-]+\.ap-northeast-2\.eks\.amazonaws\.com$/.test(flattened.EksClusterEndpoint ?? '')) throw failure('dev main 조회 계약 불일치');

    const sessionName = `values-sync-${runId}-${runAttempt}`;
    const assumed = await safeAws(['sts', 'assume-role', '--role-arn', expectedRole, '--role-session-name', sessionName, '--duration-seconds', '3600']);
    const expectedIdentity = `arn:aws:sts::${accountId}:assumed-role/${READER_ROLE}/${sessionName}`;
    if (assumed?.AssumedRoleUser?.Arn !== expectedIdentity) throw failure('reader AssumeRole 식별자 불일치');
    readerEnv = readerEnvironment(assumed.Credentials);
    const identity = await safeAws(['sts', 'get-caller-identity'], readerEnv);
    if (identity?.Account !== accountId || identity.Arn !== expectedIdentity) throw failure('reader 호출자 불일치');
    const cluster = (await safeAws(['eks', 'describe-cluster', '--name', CLUSTER], readerEnv))?.cluster;
    if (!object(cluster) || cluster.name !== CLUSTER || cluster.arn !== `arn:aws:eks:${REGION}:${accountId}:cluster/${CLUSTER}` ||
      cluster.status !== 'ACTIVE' || cluster.endpoint !== flattened.EksClusterEndpoint ||
      cluster.resourcesVpcConfig?.endpointPrivateAccess !== true || cluster.resourcesVpcConfig?.endpointPublicAccess !== false ||
      typeof cluster.certificateAuthority?.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(cluster.certificateAuthority.data) ||
      cluster.certificateAuthority.data.length > 128 * 1024) throw failure('EKS endpoint·CA·private 설정 불일치');
    const ca = Buffer.from(cluster.certificateAuthority.data, 'base64').toString('utf8');
    try { new X509Certificate(ca); } catch { throw failure('EKS CA 형식 오류'); }
    const hostname = new URL(cluster.endpoint).hostname;
    try {
      tunnel = await startTunnel({ instanceId: flattened.EksRelayInstanceId, documentName: SESSION_DOCUMENT, env: readerEnv });
    } catch { throw failure('SSM 터널 준비 실패'); }
    if (!Number.isInteger(tunnel?.port) || tunnel.port < 1 || tunnel.port > 65535 || typeof tunnel.close !== 'function') throw failure('SSM 터널 계약 오류');

    const fetchMetadata = async () => {
      if (closed) throw failure('이미 종료된 수집기');
      const tokenResult = await safeAws(['eks', 'get-token', '--cluster-name', CLUSTER], readerEnv);
      if (!/^k8s-aws-v1\.[A-Za-z0-9_-]+$/.test(tokenResult?.status?.token ?? '') ||
        !(Date.parse(tokenResult.status.expirationTimestamp) > Date.now() + 30_000)) throw failure('EKS 인증 응답 오류');
      const items = [];
      for (const name of NAMES) {
        let response;
        try {
          response = await requestMetadata({ port: tunnel.port, hostname, ca, token: tokenResult.status.token,
            path: `/api/v1/namespaces/${STRIMZI_NAMESPACE}/secrets/${name}`, accept: METADATA_ACCEPT });
        } catch { throw failure('metadata TLS 요청 실패'); }
        items.push(parseMetadataResponse(response, name));
      }
      const metadata = { items };
      parseStrimziSecrets(JSON.stringify(metadata), 'main');
      return metadata;
    };
    const metadata = await fetchMetadata();
    const originalMetadata = JSON.stringify(metadata);
    const verifyMetadata = async () => {
      try {
        if (JSON.stringify(await fetchMetadata()) !== originalMetadata) throw failure('게시 전 metadata 변경');
      } catch (error) {
        await close();
        throw error;
      }
    };
    return { outputs, metadata, verifyMetadata, close };
  } catch (error) {
    await close();
    if (error?.message?.startsWith('generated values 입력:') || error?.message?.startsWith('strimzi-secrets:')) throw error;
    throw failure('수집 실패');
  }
}
