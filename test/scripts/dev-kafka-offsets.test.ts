import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const script = resolve(__dirname, '../../scripts/dev-kafka-offsets.mjs');
const harness = String.raw`
import { mkdtemp, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { rootCertificates } from 'node:tls';
const modulePath = process.argv[1];
process.argv[1] = 'kafka-offset-test';
const { offsetInputs, prepare, run } = await import(modulePath);
const input = JSON.parse(await new Promise(r => { let s=''; process.stdin.on('data', c => s+=c); process.stdin.on('end', () => r(s)); }));
const directory = await mkdtemp(join(tmpdir(), 'kafka-offset-test-'));
const env = { ...process.env, RUNNER_TEMP: directory, GITHUB_OUTPUT: join(directory, 'output'),
  GITHUB_REPOSITORY: 'soma-376/infra', GITHUB_REF: 'refs/heads/develop', GITHUB_EVENT_NAME: 'workflow_dispatch',
  AWS_ACCOUNT_ID: '111111111111', KAFKA_OFFSETS_MODE: 'plan', KAFKA_OFFSETS_PARTITION: '0', KAFKA_OFFSETS_TO_OFFSET: '100', ...input.env };
const calls = [], logs = [], metadataRequests = [];
let closed = 0, kubeconfig, values, createdJob, clock=0;
const outputs = { EksClusterName: 'soma-376-dev-eks', EksRegion: 'ap-northeast-2',
  EksClusterEndpoint: 'https://fixture.ap-northeast-2.eks.amazonaws.com',
  EksOperatorRoleArn: 'arn:aws:iam::111111111111:role/soma-376-dev-eks-operator',
  EksRelayInstanceId: 'i-0123456789abcdef0', EksRelaySessionDocumentName: 'soma-376-dev-eks-api-tunnel',
  KafkaProvider: 'strimzi', KafkaStage: 'main', KafkaTopicName: 'pulsemetry-dev-telemetry-ingress-main',
  KafkaConsumerGroupName: 'pulsemetry-dev-telemetry-ingest-main', ...input.outputs };
const aws = async args => {
  calls.push(args);
  switch(args.slice(0,2).join(' ')) {
    case 'cloudformation describe-stacks': return { Stacks: [{ StackName: 'DevEksStack',
      StackId: 'arn:aws:cloudformation:ap-northeast-2:111111111111:stack/DevEksStack/fixture',
      StackStatus: 'UPDATE_COMPLETE', Outputs: Object.entries(outputs).map(([OutputKey, OutputValue])=>({OutputKey, OutputValue})) }] };
    case 'sts get-caller-identity': return { Account: env.AWS_ACCOUNT_ID,
      Arn: 'arn:aws:sts::111111111111:assumed-role/soma-376-dev-eks-operator/test' };
    case 'eks describe-cluster': return { cluster: { name: outputs.EksClusterName, status:'ACTIVE', endpoint:outputs.EksClusterEndpoint,
      resourcesVpcConfig:{endpointPrivateAccess:true, endpointPublicAccess:false},
      certificateAuthority:{data:Buffer.from(rootCertificates[0]).toString('base64')} } };
    case 'eks get-token': return {status:{token:'k8s-aws-v1.fixture'}};
    default: throw new Error('unexpected AWS call');
  }
};
const command = async (file, args, options) => {
  calls.push([file,...args]);
  if (file===env.HELM_BIN || file==='helm') {
    values=JSON.parse(await readFile(args.at(-1),'utf8'));
    const rendered=execFileSync(file,args,{encoding:'utf8'});
    return rendered;
  }
  kubeconfig=await readFile(options.env.KUBECONFIG,'utf8');
  const a=args.slice(2);
  if(a[0]==='get' && a[1]==='serviceaccount') {
    if(input.saError) throw new Error('serviceaccount access denied');
    return input.existingSa ? 'serviceaccount/telemetry-kafka-offsets\n' : '';
  }
  if(a[0]==='create') {
    const resource=JSON.parse(options.input);
    if(resource.kind==='Job') {
      createdJob=resource;
      return JSON.stringify({metadata:{name:resource.metadata.generateName+'abcde'}});
    }
    return '';
  }
  if(a[0]==='get' && a[1]==='job') {
    if(input.timeout) return '{}';
    return JSON.stringify({status:{conditions:[{type:input.failed?'Failed':'Complete',status:'True'}]}});
  }
  if(a[0]==='logs') {
    if(input.logsError) throw new Error('logs unavailable');
    return 'pulsemetry-dev-telemetry-ingress-main,0,100';
  }
  throw new Error('unexpected command');
};
let error, parsed;
try {
  parsed=offsetInputs(env);
  await prepare(env,{aws});
  await run(env,{aws, command, log:x=>logs.push(x), now:()=>clock, sleep:async ms=>{clock+=input.timeout?660001:ms},
    startTunnel:async()=>({port:18443,close:async()=>{closed++}}),
    requestMetadata:async options=>{
      metadataRequests.push({path:options.path,accept:options.accept,hostname:options.hostname,port:options.port});
      const name=options.path.split('/').at(-1);
      return {statusCode:200,headers:{'content-type':'application/json'},body:JSON.stringify({
        apiVersion:'meta.k8s.io/v1',kind:input.fullSecret?'Secret':'PartialObjectMetadata',
        metadata:{name,namespace:'pulsemetry-dev',uid:'fixture-'+name,resourceVersion:'1'},
        ...(input.fullSecret?{data:{password:'PRIVATE_MARKER'}}:{})})};
    }});
} catch(e) { error=e.message; }
let removed=false;
try { await access(join(directory,'dev-kafka-offsets')); } catch { removed=true; }
const output = await readFile(env.GITHUB_OUTPUT,'utf8').catch(()=>null);
await rm(directory,{recursive:true,force:true});
process.stdout.write(JSON.stringify({error,parsed,calls,logs,closed,removed,kubeconfig,values,createdJob,metadataRequests,output}));
`;

function execute(input: Record<string, unknown> = {}): any {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', harness, script], {
    input: JSON.stringify(input), encoding: 'utf8', env: process.env,
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  if (!result.stdout) throw new Error(result.stderr);
  return JSON.parse(result.stdout);
}

describe('수동 Kafka offset workflow 실행', () => {
  test.each([
    { KAFKA_OFFSETS_MODE: 'delete' }, { KAFKA_OFFSETS_PARTITION: '6' }, { KAFKA_OFFSETS_TO_OFFSET: '-1' },
    { KAFKA_OFFSETS_TO_OFFSET: '9007199254740993' }, { KAFKA_OFFSETS_TO_OFFSET: '' },
    { KAFKA_OFFSETS_TO_DATETIME: '2026-11-17T00:00:00.000Z' },
    { KAFKA_OFFSETS_PARTITION: '', KAFKA_OFFSETS_TO_OFFSET: '', KAFKA_OFFSETS_TO_DATETIME: 'not-a-date' },
    { GITHUB_REF: 'refs/heads/main' },
  ])('잘못된 입력은 AWS 호출 전에 거부한다: %j', env => {
    const result = execute({ env });
    expect(result.error).toBeDefined();
    expect(result.calls).toEqual([]);
  });

  test.each(['msk', 'unknown'])('다른 Kafka 공급자 %s는 실행하지 않는다', provider => {
    const result = execute({ outputs: { KafkaProvider: provider } });
    expect(result.error).toBeDefined();
    expect(result.closed).toBe(0);
    expect(result.createdJob).toBeUndefined();
  });

  test.each([
    ['plan', false, false], ['execute', true, false], ['plan', true, true], ['execute', false, true],
  ])('%s 렌더·실행 (기존 SA %s, 시간 지정 %s)', (mode, existingSa, datetime) => {
    const result = execute({ existingSa, env: { KAFKA_OFFSETS_MODE: mode, ...(datetime ? {
      KAFKA_OFFSETS_PARTITION: '', KAFKA_OFFSETS_TO_OFFSET: '', KAFKA_OFFSETS_TO_DATETIME: '2026-11-17T00:00:00.000Z',
    } : {}) } });
    expect(result.error).toBeUndefined();
    expect(result.output).toContain('operator_role_arn=arn:aws:iam::111111111111:role/soma-376-dev-eks-operator');
    expect(result.createdJob.metadata.name).toBeUndefined();
    expect(result.createdJob.metadata.generateName).toBe(`telemetry-offsets-${mode}-`);
    expect(result.createdJob.spec).toMatchObject({ backoffLimit: 0, activeDeadlineSeconds: 600, ttlSecondsAfterFinished: 86400 });
    const pod = result.createdJob.spec.template;
    expect(pod.metadata.labels['app.kubernetes.io/name']).toBe('telemetry-kafka-admin');
    expect(pod.spec.serviceAccountName).toBe('telemetry-kafka-offsets');
    expect(pod.spec.automountServiceAccountToken).toBe(false);
    expect(pod.spec.volumes.filter((x: any) => x.secret).map((x: any) => x.secret.secretName)).toEqual([
      'soma-376-dev-telemetry-cluster-ca-cert', 'pulsemetry-offset-admin-main',
    ]);
    expect(result.calls.filter((x: string[]) => x.includes('create'))).toHaveLength(existingSa ? 1 : 2);
    expect(result.metadataRequests).toHaveLength(5);
    expect(result.metadataRequests.every((x: any) => x.accept.includes('PartialObjectMetadata'))).toBe(true);
    expect(result.kubeconfig).toContain('server: https://127.0.0.1:18443');
    expect(result.kubeconfig).toContain('tls-server-name: fixture.ap-northeast-2.eks.amazonaws.com');
    expect(result.kubeconfig).toContain('certificate-authority-data:');
    expect(result.kubeconfig).not.toContain('--role-arn');
    expect(result.logs.join('\n')).toContain('pulsemetry-dev-telemetry-ingress-main,0,100');
    expect(result.closed).toBe(1);
    expect(result.removed).toBe(true);
  });

  test.each([{ failed: true }, { timeout: true }, { failed: true, logsError: true }])('실패·시간 초과에도 로그와 정리를 수행한다: %j', input => {
    const result = execute(input);
    expect(result.error).toMatch(/Job/);
    expect(result.calls.some((x: string[]) => x.includes('logs'))).toBe(true);
    expect(result.closed).toBe(1);
    expect(result.removed).toBe(true);
  });

  test.each([{ saError: true }, { fullSecret: true }])('권한·metadata 오류에 Job을 만들지 않는다: %j', input => {
    const result = execute(input);
    expect(result.error).toBeDefined();
    expect(result.createdJob).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('PRIVATE_MARKER');
    expect(result.closed).toBe(1);
    expect(result.removed).toBe(true);
  });
});
