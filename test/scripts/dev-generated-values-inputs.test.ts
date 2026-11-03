import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const script = resolve(__dirname, '../../scripts/dev-generated-values-inputs.mjs');
// 실제 AWS·터널·Kubernetes를 호출하지 않는다. 자격증명 대역은 자식 프로세스 밖으로 반환하지 않는다.
const harness = String.raw`
import { rootCertificates } from 'node:tls';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
const { collectGeneratedValuesInputs, requestMetadataHttps, METADATA_ACCEPT } = await import(process.argv[1]);
const input = JSON.parse(readFileSync(0, 'utf8'));
const accountId = '111111111111';
const roleName = 'soma-376-dev-eks-values-reader';
const identity = 'arn:aws:sts::' + accountId + ':assumed-role/' + roleName + '/values-sync-123-2';
const clusterName = 'soma-376-dev-eks';
const endpoint = 'https://fixture.ap-northeast-2.eks.amazonaws.com';
const ca = rootCertificates[0];
const privateMarker = 'DO_NOT_LEAK_PRIVATE_RESPONSE';
const calls = [], requests = [], tunnels = [];
let closed = 0, count = 0;
const outputs = {
  KafkaProvider: 'strimzi', KafkaStage: 'main', ArchivePrefix: 'eks',
  EksClusterName: clusterName, EksRegion: 'ap-northeast-2', EksClusterEndpoint: endpoint,
  EksValuesReaderRoleArn: 'arn:aws:iam::' + accountId + ':role/' + roleName,
  EksRelaySessionDocumentName: 'soma-376-dev-eks-api-tunnel', EksRelayInstanceId: 'i-0123456789abcdef0',
  ...input.outputs,
};
const assumedCredentials = { AccessKeyId: 'test-key', SecretAccessKey: privateMarker, SessionToken: privateMarker,
  Expiration: input.expiredCredentials ? '2000-01-01T00:00:00Z' : '2999-01-01T00:00:00Z' };
const aws = async (args, { env }) => {
  calls.push({ args, reader: env?.AWS_ACCESS_KEY_ID === 'test-key',
    noParentProfile: !env?.AWS_PROFILE && !env?.AWS_DEFAULT_PROFILE,
    explicitReaderToken: env?.AWS_SESSION_TOKEN === privateMarker });
  const operation = args.slice(0, 2).join(' ');
  if (input.awsError === operation) throw new Error(privateMarker);
  if (operation === 'cloudformation describe-stacks') {
    const name = args[3];
    const stack = { StackName: input.wrongStack ? 'DevApplicationStack' : name,
      StackId: 'arn:aws:cloudformation:ap-northeast-2:' + (input.wrongAccount ? '222222222222' : accountId) + ':stack/' + name + '/fixture-id',
      StackStatus: input.stackStatus || 'UPDATE_COMPLETE', Outputs: Object.entries(name === 'DevEksStack' ? outputs : {}).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })) };
    if (input.duplicateOutput && name === 'DevEksStack') stack.Outputs.push(stack.Outputs[0]);
    return { Stacks: [stack] };
  }
  if (operation === 'sts assume-role') return { AssumedRoleUser: { Arn: input.wrongAssumedRole ? identity + '-wrong' : identity }, Credentials: assumedCredentials };
  if (operation === 'sts get-caller-identity') return { Account: accountId, Arn: input.wrongIdentity ? identity + '-wrong' : identity };
  if (operation === 'eks describe-cluster') return { cluster: {
    name: clusterName, arn: 'arn:aws:eks:ap-northeast-2:' + accountId + ':cluster/' + clusterName,
    status: 'ACTIVE', endpoint: input.clusterEndpoint || endpoint,
    certificateAuthority: { data: input.badCa ? Buffer.from('not a certificate').toString('base64') : Buffer.from(ca).toString('base64') },
    resourcesVpcConfig: { endpointPrivateAccess: true, endpointPublicAccess: Boolean(input.publicApi) },
  } };
  if (operation === 'eks get-token') return { status: {
    token: input.badToken ? privateMarker : 'k8s-aws-v1.test-token',
    expirationTimestamp: input.expiredToken ? '2000-01-01T00:00:00Z' : '2999-01-01T00:00:00Z',
  } };
  throw new Error(privateMarker);
};
const startTunnel = async ({ instanceId, documentName, env }) => {
  if (input.tunnelError) throw new Error(privateMarker);
  tunnels.push({ instanceId, documentName, reader: env.AWS_ACCESS_KEY_ID === 'test-key' });
  return { port: 18443, close: async () => { closed++; } };
};
const requestMetadata = async options => {
  count++;
  requests.push({ hostname: options.hostname, port: options.port, path: options.path,
    accept: options.accept, caMatches: options.ca === ca, tokenMatches: options.token === 'k8s-aws-v1.test-token' });
  if (input.requestError) throw new Error(privateMarker);
  const name = options.path.split('/').at(-1);
  const metadata = { name: input.wrongName ? 'wrong-name' : name,
    namespace: input.wrongNamespace ? 'another-namespace' : 'pulsemetry-dev',
    uid: 'fixture-' + name, resourceVersion: input.changedMetadata && count > 5 ? '2' : '1',
    annotations: { ignored: privateMarker }, labels: { ignored: privateMarker } };
  if (input.missingRevision) delete metadata.resourceVersion;
  if (input.badUid) metadata.uid = '../wrong';
  const document = { apiVersion: input.wrongVersion ? 'v1' : 'meta.k8s.io/v1',
    kind: input.fullSecret ? 'Secret' : 'PartialObjectMetadata', metadata };
  if (input.fullSecret || input.extraData) document.data = { 'tls.key': privateMarker };
  let body = JSON.stringify(document);
  if (input.duplicateKey) body = body.replace('"kind":', '"kind":"PartialObjectMetadata","kind":');
  return { statusCode: input.statusCode || 200,
    headers: { 'content-type': input.contentType || 'application/json' }, body };
};
try {
  if (input.transport) {
    let captured, timeout;
    const fake = (options, callback) => {
      captured = { ...options, headers: { ...options.headers, Authorization: options.headers.Authorization === 'Bearer fixture-token' } };
      const req = new EventEmitter();
      req.setTimeout = value => { timeout = value; };
      req.destroy = () => req.emit('error', new Error(privateMarker));
      req.end = () => {
        const response = new EventEmitter();
        response.statusCode = 200; response.headers = { 'content-type': 'application/json' };
        callback(response); response.emit('data', Buffer.from('{}')); response.emit('end');
      };
      return req;
    };
    const response = await requestMetadataHttps({ hostname: 'fixture.ap-northeast-2.eks.amazonaws.com',
      port: 18443, ca: 'fixture-ca', token: 'fixture-token', path: '/api/v1/namespaces/pulsemetry-dev/secrets/fixture', accept: METADATA_ACCEPT }, fake);
    console.log(JSON.stringify({ captured, timeout, response }));
  } else {
    const collected = await collectGeneratedValuesInputs({ accountId: input.accountId || accountId, runId: '123', runAttempt: '2', aws, startTunnel, requestMetadata });
    const result = { outputs: collected.outputs, metadata: collected.metadata };
    if (input.recheck) await collected.verifyMetadata();
    await collected.close(); await collected.close();
    console.log(JSON.stringify({ ok: true, result, calls, requests, tunnels, closed }));
  }
} catch (error) { console.log(JSON.stringify({ ok: false, error: error.message, calls, requests, tunnels, closed })); }
`;

function run(input: any = {}) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', harness, script], {
    input: JSON.stringify(input), encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, AWS_PROFILE: 'inherited-profile', AWS_DEFAULT_PROFILE: 'inherited-default' },
  });
  expect({ code: result.status, error: result.stderr }).toEqual({ code: 0, error: '' });
  expect(result.stdout).not.toContain('DO_NOT_LEAK_PRIVATE_RESPONSE');
  return JSON.parse(result.stdout);
}

describe('generated values 입력 수집', () => {
  test('네 안정 스택·전용 reader·고정 터널로 metadata 네 필드만 수집하고 재대조한다', () => {
    const result = run({ recheck: true });
    expect(result.ok).toBe(true);
    expect(Object.keys(result.result.outputs)).toEqual(['DevNetworkStack', 'DevDataStack', 'DevEdgeStack', 'DevEksStack']);
    expect(result.result.metadata.items).toHaveLength(5);
    for (const item of result.result.metadata.items) {
      expect(Object.keys(item)).toEqual(['metadata']);
      expect(Object.keys(item.metadata)).toEqual(['name', 'namespace', 'uid', 'resourceVersion']);
    }
    expect(result.calls.slice(0, 4).every((call: any) => !call.reader)).toBe(true);
    expect(result.calls[4].args).toEqual(['sts', 'assume-role', '--role-arn',
      'arn:aws:iam::111111111111:role/soma-376-dev-eks-values-reader',
      '--role-session-name', 'values-sync-123-2', '--duration-seconds', '3600']);
    expect(result.calls.slice(5).every((call: any) => call.reader && call.noParentProfile && call.explicitReaderToken)).toBe(true);
    expect(result.tunnels).toEqual([{ instanceId: 'i-0123456789abcdef0', documentName: 'soma-376-dev-eks-api-tunnel', reader: true }]);
    expect(result.requests).toHaveLength(10);
    for (const item of result.requests) expect(item).toMatchObject({ hostname: 'fixture.ap-northeast-2.eks.amazonaws.com',
      port: 18443, accept: 'application/json;as=PartialObjectMetadata;g=meta.k8s.io;v=v1', caMatches: true, tokenMatches: true });
    expect(result.requests.slice(0, 5).map((item: any) => item.path)).toEqual([
      'soma-376-dev-telemetry-cluster-ca-cert', 'pulsemetry-gateway-main', 'pulsemetry-ingest-main',
      'pulsemetry-topic-admin-main', 'pulsemetry-offset-admin-main',
    ].map(name => `/api/v1/namespaces/pulsemetry-dev/secrets/${name}`));
    expect(result.closed).toBe(1);
  });

  test.each([
    { accountId: 'bad-account' }, { wrongStack: true }, { wrongAccount: true }, { stackStatus: 'UPDATE_IN_PROGRESS' },
    { duplicateOutput: true }, { outputs: { KafkaProvider: 'msk' } }, { outputs: { KafkaStage: 'validation' } },
    { outputs: { EksValuesReaderRoleArn: 'arn:aws:iam::111111111111:role/soma-376-dev-eks-operator' } },
    { outputs: { EksRelaySessionDocumentName: 'AWS-StartPortForwardingSessionToRemoteHost' } },
    { outputs: { EksClusterEndpoint: 'https://external.example.test' } },
    { wrongAssumedRole: true }, { wrongIdentity: true }, { expiredCredentials: true },
    { clusterEndpoint: 'https://changed.ap-northeast-2.eks.amazonaws.com' }, { publicApi: true }, { badCa: true },
  ])('잘못된 배포·역할·TLS 입력은 터널과 metadata 조회 전에 거부한다: %j', input => {
    const result = run(input);
    expect(result.ok).toBe(false);
    expect(result.requests).toEqual([]);
    expect(result.tunnels).toEqual([]);
  });

  test.each([
    { statusCode: 406 }, { statusCode: 403 }, { statusCode: 302 }, { contentType: 'text/plain' },
    { fullSecret: true }, { extraData: true }, { wrongVersion: true }, { duplicateKey: true },
    { wrongNamespace: true }, { wrongName: true }, { missingRevision: true }, { badUid: true },
    { requestError: true }, { badToken: true }, { expiredToken: true }, { awsError: 'eks get-token' },
  ])('metadata-only·인증 실패 시 fallback 없이 종료하고 터널을 정리한다: %j', input => {
    const result = run(input);
    expect(result.ok).toBe(false);
    expect(result.closed).toBe(1);
    expect(result.requests.length).toBeLessThanOrEqual(5);
  });

  test('게시 직전 metadata 변경은 실패하고 자신의 터널을 닫는다', () => {
    const result = run({ changedMetadata: true, recheck: true });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('metadata 변경');
    expect(result.closed).toBe(1);
    expect(result.requests).toHaveLength(10);
  });

  test.each([{ awsError: 'sts assume-role' }, { tunnelError: true }])('하위 도구 예외에 든 원문을 출력하지 않는다: %j', input => {
    const result = run(input);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^generated values 입력:/);
  });

  test('HTTPS transport는 원래 EKS hostname·CA를 검증하고 개별 metadata만 요청한다', () => {
    const result = run({ transport: true });
    expect(result.captured).toEqual({ hostname: '127.0.0.1', port: 18443,
      servername: 'fixture.ap-northeast-2.eks.amazonaws.com', ca: 'fixture-ca', rejectUnauthorized: true,
      agent: false, method: 'GET', path: '/api/v1/namespaces/pulsemetry-dev/secrets/fixture',
      headers: { Accept: 'application/json;as=PartialObjectMetadata;g=meta.k8s.io;v=v1', Authorization: true,
        Host: 'fixture.ap-northeast-2.eks.amazonaws.com' } });
    expect(result.timeout).toBe(10_000);
  });
});
