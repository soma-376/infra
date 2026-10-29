import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { buildDevApp, TEST_ENV } from '../helpers';

const {
  REGION, REPOSITORY, STACKS, sha256, canonical, inventory, validateAssembly, assertTemplate, assertAutomaticRetirement, context, createPipeline,
} = require('../../scripts/dev-cdk-pipeline.cjs');

type Json = Record<string, any>;
type CommandResult = { status: number; stdout?: string; stderr?: string; error?: Error };
type Invocation = { executable: string; args: string[]; options: Json };

const root = path.resolve(__dirname, '../..');
const sha = 'a'.repeat(40);
const otherSha = 'b'.repeat(40);
const cdEvents = ['push', 'workflow_dispatch'] as const;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const read = (file: string): Json => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file: string, value: unknown): void => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const ok = (value: unknown): CommandResult => ({ status: 0, stdout: JSON.stringify(value), stderr: '' });

let fixtures: string;
let assemblyFixture: string;
let templates: Record<string, Json>;
let retiredAssemblyFixture: string;
let retiredTemplates: Record<string, Json>;
let workspace: string;

beforeAll(() => {
  fixtures = fs.mkdtempSync(path.join(tmpdir(), 'dev-cdk-pipeline-fixture-'));
  assemblyFixture = path.join(fixtures, 'assembly');
  const built = buildDevApp({
    [`availability-zones:account=${TEST_ENV.account}:region=${TEST_ENV.region}`]:
      ['ap-northeast-2a', 'ap-northeast-2b', 'ap-northeast-2c', 'ap-northeast-2d'],
  });
  // 손으로 만든 manifest가 아니라 실제 dev 합성 결과로 검증한다.
  fs.cpSync(built.app.synth().directory, assemblyFixture, { recursive: true });
  templates = Object.fromEntries(STACKS.map((name: string) =>
    [name, read(path.join(assemblyFixture, `${name}.template.json`))]));
  retiredAssemblyFixture = path.join(fixtures, 'retired-assembly');
  const retired = buildDevApp({ devKafkaProvider: 'strimzi', devMskRetirementStage: 'network-removed',
    [`availability-zones:account=${TEST_ENV.account}:region=${TEST_ENV.region}`]:
      ['ap-northeast-2a', 'ap-northeast-2b', 'ap-northeast-2c', 'ap-northeast-2d'],
  });
  fs.cpSync(retired.app.synth().directory, retiredAssemblyFixture, { recursive: true });
  retiredTemplates = Object.fromEntries(STACKS.map((name: string) =>
    [name, read(path.join(retiredAssemblyFixture, `${name}.template.json`))]));
});

beforeEach(() => { workspace = fs.mkdtempSync(path.join(tmpdir(), 'dev-cdk-pipeline-test-')); });
afterEach(() => { jest.restoreAllMocks(); fs.rmSync(workspace, { recursive: true, force: true }); });
afterAll(() => { fs.rmSync(fixtures, { recursive: true, force: true }); });

function copyAssembly(): string {
  const destination = path.join(workspace, 'assembly');
  fs.cpSync(assemblyFixture, destination, { recursive: true });
  return destination;
}

function editManifest(directory: string, change: (manifest: Json) => void): void {
  const file = path.join(directory, 'manifest.json'), value = read(file);
  change(value); write(file, value);
}

function editAsset(directory: string, change: (asset: Json, assets: Json) => void): void {
  const file = path.join(directory, 'DevDataStack.assets.json'), value = read(file);
  change(Object.values(value.files)[0] as Json, value); write(file, value);
}

function makeHarness(event = 'push') {
  const directory = path.join(workspace, 'run');
  const env: NodeJS.ProcessEnv = {
    GITHUB_REPOSITORY: REPOSITORY, GITHUB_SHA: sha, GITHUB_RUN_ID: '12345', GITHUB_RUN_ATTEMPT: '1',
    GITHUB_EVENT_NAME: event, GITHUB_REF: 'refs/heads/develop', AWS_ACCOUNT_ID: TEST_ENV.account,
    GITHUB_OUTPUT: path.join(workspace, 'outputs'), GITHUB_STEP_SUMMARY: path.join(workspace, 'summary'),
  };
  const state = {
    head: sha, remote: sha, account: TEST_ENV.account, identityRole: undefined as string | undefined, legacy: false, legacyDenied: false,
    templateError: false, describeError: false, synthError: false, diffError: false, deployError: false,
    diffOutput: 'There were no differences\n',
    assemblyFixture,
    templates: clone(templates),
    stacks: Object.fromEntries(STACKS.map((name: string) => [name, {
      StackName: name,
      StackId: `arn:aws:cloudformation:${REGION}:${TEST_ENV.account}:stack/${name}/fixture-id`,
      StackStatus: 'UPDATE_COMPLETE', CreationTime: '2026-10-01T00:00:00Z',
      LastUpdatedTime: '2026-10-20T00:00:00Z', Tags: [{ Key: 'Env', Value: 'dev' }],
    }])) as Record<string, Json>,
  };
  const calls: Invocation[] = [];
  let activeOperation = 'plan';
  let intercept: ((call: Invocation) => CommandResult | undefined) | undefined;
  const runner = (executable: string, args: string[], options: Json): CommandResult => {
    const call = { executable, args: [...args], options };
    calls.push(call);
    const replacement = intercept?.(call);
    if (replacement) return replacement;
    if (executable === 'git') {
      if (args[0] === 'rev-parse') return { status: 0, stdout: `${state.head}\n` };
      if (args[0] === 'ls-remote') return { status: 0, stdout: `${state.remote}\trefs/heads/develop\n` };
    }
    if (executable === 'aws') {
      if (args[0] === 'sts' && args[1] === 'get-caller-identity') return ok({ Account: state.account,
        Arn: `arn:aws:sts::${state.account}:assumed-role/soma-376-infra-dev-${state.identityRole ?? (activeOperation === 'deploy' ? 'deploy' : 'diff')}/fixture`,
      });
      if (args[0] === 'ec2' && args[1] === 'describe-availability-zones') {
        return ok({ AvailabilityZones: ['a', 'b', 'c', 'd'].map(suffix => ({ ZoneName: `${REGION}${suffix}` })) });
      }
      const name = args[args.indexOf('--stack-name') + 1];
      if (args[0] === 'cloudformation' && args[1] === 'describe-stacks') {
        if (name === 'DevApplicationStack') {
          if (state.legacyDenied) return { status: 255, stderr: 'An error occurred (AccessDenied) when calling the DescribeStacks operation' };
          return state.legacy ? ok({ Stacks: [{ StackName: name }] }) : {
            status: 255, stderr: 'An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id DevApplicationStack does not exist',
          };
        }
        if (state.describeError) return { status: 255, stderr: 'Could not connect to endpoint URL' };
        return ok({ Stacks: [clone(state.stacks[name])] });
      }
      if (args[0] === 'cloudformation' && args[1] === 'get-template') {
        if (state.templateError) return { status: 255, stderr: 'An error occurred (AccessDenied)' };
        return ok({ TemplateBody: clone(state.templates[name]) });
      }
    }
    if (executable === process.execPath && args[0] === path.join(root, 'node_modules/aws-cdk/bin/cdk')) {
      if (args[1] === 'synth') {
        if (state.synthError) return { status: 1, stderr: 'Synthesis failed' };
        fs.cpSync(state.assemblyFixture, args[args.indexOf('--output') + 1], { recursive: true });
        return { status: 0, stdout: 'Successfully synthesized\n' };
      }
      if (args[1] === 'diff') return state.diffError ? { status: 1, stderr: 'Access denied' } : { status: 0, stdout: state.diffOutput };
      if (args[1] === 'deploy') {
        if (state.deployError) {
          state.stacks.DevNetworkStack.StackStatus = 'UPDATE_COMPLETE';
          state.stacks.DevDataStack.StackStatus = 'UPDATE_ROLLBACK_COMPLETE';
          return { status: 1, stdout: 'DevNetworkStack succeeded\n', stderr: 'DevDataStack deployment failed\n' };
        }
        return { status: 0, stdout: 'no changes\n' };
      }
    }
    throw new Error(`테스트가 허용하지 않은 외부 호출: ${executable} ${args.join(' ')}`);
  };
  const pipeline = () => createPipeline({ root, directory, env, runner });
  const run = (operation: string) => { activeOperation = operation; return pipeline().execute(operation); };
  const approve = () => {
    env.PLAN_ARTIFACT_ID = '987'; env.DOWNLOADED_ARTIFACT_ID = '987';
    env.PLAN_SHA256 = sha256(fs.readFileSync(path.join(directory, 'plan.json')));
  };
  const plan = () => { run('plan'); approve(); return read(path.join(directory, 'plan.json')); };
  return { directory, env, state, calls, runner, run, approve, plan,
    intercept: (handler: typeof intercept) => { intercept = handler; } };
}

describe('dev Cloud Assembly 실행 경계', () => {
  test('실제 네 dev 스택과 file/zip asset을 의존 순서로 허용한다', () => {
    const order = validateAssembly(copyAssembly(), TEST_ENV.account);
    expect([...order].sort()).toEqual([...STACKS].sort());
    expect(order.indexOf('DevNetworkStack')).toBeLessThan(order.indexOf('DevDataStack'));
    expect(order.indexOf('DevDataStack')).toBeLessThan(order.indexOf('DevEksStack'));
  });

  test.each([
    ['계정', (m: Json) => { m.artifacts.DevDataStack.environment = `aws://222222222222/${REGION}`; }, /계정·리전/],
    ['리전', (m: Json) => { m.artifacts.DevDataStack.environment = `aws://${TEST_ENV.account}/us-east-1`; }, /계정·리전/],
    ['실제 스택 이름', (m: Json) => { m.artifacts.DevDataStack.properties.stackName = 'DataStack'; }, /물리 이름/],
    ['prod 혼입', (m: Json) => { m.artifacts.DataStack = clone(m.artifacts.DevDataStack); }, /스택 목록/],
    ['cicd 혼입', (m: Json) => { m.artifacts.DeployStack = clone(m.artifacts.DevDataStack); }, /스택 목록/],
    ['dev 누락', (m: Json) => { delete m.artifacts.DevEdgeStack; }, /스택 목록/],
    ['deploy 역할', (m: Json) => { m.artifacts.DevDataStack.properties.assumeRoleArn = 'arn:aws:iam::111111111111:role/admin'; }, /deploy 역할/],
    ['CFN 실행 역할', (m: Json) => { m.artifacts.DevDataStack.properties.cloudFormationExecutionRoleArn = 'arn:aws:iam::111111111111:role/other'; }, /CFN 실행 역할/],
    ['lookup 역할', (m: Json) => { m.artifacts.DevDataStack.properties.lookupRole.arn = 'arn:aws:iam::111111111111:role/other'; }, /lookup 역할/],
    ['역할 옵션', (m: Json) => { m.artifacts.DevDataStack.properties.assumeRoleAdditionalOptions = { PolicyArns: [] }; }, /추가 옵션/],
    ['추가 context', (m: Json) => { m.missing = [{ key: 'unreviewed-lookup' }]; }, /context lookup/],
    ['추가 artifact', (m: Json) => { m.artifacts.Extra = { type: 'cdk:cloud-assembly', properties: { directoryName: 'outside' } }; }, /지원하지 않는 artifact/],
    ['legacy 실행형 asset metadata', (m: Json) => { m.artifacts.DevDataStack.metadata = { '/DevDataStack/Asset': [{ type: 'aws:cdk:asset', data: { path: 'unexpected', packaging: 'zip', sourceHash: 'x' } }] }; }, /legacy.*asset|asset.*metadata/],
    ['dependency 순환', (m: Json) => { m.artifacts.DevNetworkStack.dependencies.push('DevEksStack'); }, /dependency 순환/],
  ] as Array<[string, (value: Json) => void, RegExp]>)('%s 변경은 배포 입력으로 허용하지 않는다', (_name, change, message) => {
    const directory = copyAssembly(); editManifest(directory, change);
    expect(() => validateAssembly(directory, TEST_ENV.account)).toThrow(message);
  });

  test.each([
    ['다른 bucket', (asset: Json) => { Object.values<Json>(asset.destinations)[0].bucketName = 'unapproved-bucket'; }, /asset bucket/],
    ['다른 게시 역할', (asset: Json) => { Object.values<Json>(asset.destinations)[0].assumeRoleArn = 'arn:aws:iam::111111111111:role/admin'; }, /asset 게시 역할/],
    ['다른 object key', (asset: Json) => { Object.values<Json>(asset.destinations)[0].objectKey = 'arbitrary.json'; }, /object key/],
    ['실행형 source', (asset: Json) => { asset.source.executable = ['sh', '-c', 'unexpected']; }, /asset source/],
    ['절대 경로', (asset: Json) => { asset.source.path = '/etc/passwd'; }, /상대 경로/],
    ['상위 경로', (asset: Json) => { asset.source.path = '../outside'; }, /상대 경로/],
    ['Docker asset', (_asset: Json, assets: Json) => { assets.dockerImages = { unreviewed: {} }; }, /Docker/],
  ] as Array<[string, (asset: Json, assets: Json) => void, RegExp]>)('%s asset을 거부한다', (_name, change, message) => {
    const directory = copyAssembly(); editAsset(directory, change);
    expect(() => validateAssembly(directory, TEST_ENV.account)).toThrow(message);
  });

  test('Assembly 내부와 root의 symlink를 거부한다', () => {
    const directory = copyAssembly();
    fs.symlinkSync(path.join(root, 'package.json'), path.join(directory, 'linked.json'));
    expect(() => validateAssembly(directory, TEST_ENV.account)).toThrow(/symlink/);
    fs.unlinkSync(path.join(directory, 'linked.json'));
    const link = path.join(workspace, 'assembly-link'); fs.symlinkSync(directory, link);
    expect(() => validateAssembly(link, TEST_ENV.account)).toThrow(/root symlink/);
  });

  test('zip asset 내용 변경도 원본 해시로 탐지한다', () => {
    const directory = copyAssembly();
    const assets = read(path.join(directory, 'DevDataStack.assets.json'));
    const zip = Object.values<Json>(assets.files).find(asset => asset.source.packaging === 'zip');
    expect(zip).toBeDefined();
    fs.writeFileSync(path.join(directory, zip!.source.path, 'injected.js'), 'module.exports = 1;');
    expect(() => validateAssembly(directory, TEST_ENV.account)).toThrow(/asset source hash/);
  });

  test.each([
    ['AWS::CloudFormation::Stack', /nested/], ['AWS::ECS::Cluster', /legacy/],
    ['AWS::AutoScaling::AutoScalingGroup', /legacy/], ['AWS::ServiceDiscovery::PrivateDnsNamespace', /legacy/],
  ])('%s를 자동 갱신에 포함하지 않는다', (type, message) => {
    expect(() => assertTemplate({ Resources: { Old: { Type: type } } })).toThrow(message);
  });

  test('Application 삭제 뒤 남은 Network/Edge legacy 리소스와 output도 거부한다', () => {
    expect(() => assertTemplate({ Resources: { DevAppHostSgABC: { Type: 'AWS::EC2::SecurityGroup' } } })).toThrow(/legacy/);
    expect(() => assertTemplate({ Resources: {}, Outputs: { AlbDnsName: { Value: 'old' } } })).toThrow(/legacy/);
  });
});

describe('plan부터 승인 후 배포까지', () => {
  test.each(cdEvents)('%s는 조회와 local template diff로 plan을 만들고 승인한 Assembly로 no-op 배포한다', event => {
    const h = makeHarness(event), plan = h.plan();
    expect(plan.sourceSha).toBe(sha);
    expect(plan.event).toBe(event);
    expect(plan.ref).toBe('refs/heads/develop');
    expect(plan.runAttempt).toBe('1');
    expect(plan.baseline).toHaveLength(4);
    const synthCalls = h.calls.filter(call => call.args[1] === 'synth');
    expect(synthCalls).toHaveLength(1);
    expect(synthCalls[0].args).toContain('--no-lookups');
    expect(synthCalls[0].options.cwd).not.toBe(root);
    expect(h.calls.filter(call => call.args[1] === 'diff')).toHaveLength(4);
    for (const call of h.calls.filter(call => call.args[1] === 'diff')) {
      expect(call.args).toContain('--template'); expect(call.args).toContain('--exclusively');
      expect(call.args).toContain('template'); expect(call.args).not.toContain('--fail');
    }
    expect(h.calls.filter(call => call.executable === 'aws').every(call =>
      ['get-caller-identity', 'describe-stacks', 'get-template', 'describe-availability-zones'].includes(call.args[1]))).toBe(true);
    expect(h.calls.some(call => call.args[1] === 'deploy')).toBe(false);
    expect(fs.readFileSync(h.env.GITHUB_OUTPUT!, 'utf8')).toContain(`plan_sha256=${h.env.PLAN_SHA256}`);
    h.run('verify'); h.run('deploy');
    const deployments = h.calls.filter(call => call.args[1] === 'deploy');
    expect(deployments).toHaveLength(1);
    expect(deployments[0].args.slice(2, 6)).toEqual(plan.order);
    expect(deployments[0].args).toEqual(expect.arrayContaining(['--app', path.join(h.directory, 'payload/assembly'), '--concurrency', '1', '--require-approval', 'never', '--ci']));
    expect(deployments[0].args).not.toContain('--force');
    expect(deployments[0].options.cwd).not.toBe(root);
    expect(h.calls.filter(call => call.args[1] === 'synth')).toHaveLength(1);
    expect(h.calls.filter(call => call.executable === 'git' && call.args[0] === 'ls-remote')).toHaveLength(4);
    expect(read(path.join(h.directory, 'result-deploy.json'))).toMatchObject({ status: 'succeeded', sourceSha: sha });
  });

  test.each(cdEvents)('%s 시작 전에 develop이 바뀌면 AWS 조회·합성 없이 plan을 거부한다', event => {
    const h = makeHarness(event); h.state.remote = otherSha;
    expect(() => h.run('plan')).toThrow(/최신 develop/);
    expect(h.calls.every(call => call.executable === 'git')).toBe(true);
    expect(fs.existsSync(path.join(h.directory, 'plan.json'))).toBe(false);
    expect(read(path.join(h.directory, 'result-plan.json')).status).toBe('failed');
  });

  test('같은 디렉터리에서 과거 plan을 덮어쓰지 않는다', () => {
    const h = makeHarness(); h.plan();
    expect(() => h.run('plan')).toThrow(/빈 디렉터리/);
  });

  test('비공개 저장소 인증은 ls-remote의 임시 Git 환경만 사용하고 토큰을 산출물에 남기지 않는다', () => {
    const h = makeHarness();
    const token = 'fixture-private-repository-token';
    const encoded = Buffer.from(`x-access-token:${token}`).toString('base64');
    h.env.GH_TOKEN = token;
    h.plan(); h.run('deploy');

    const remoteCalls = h.calls.filter(call => call.executable === 'git' && call.args[0] === 'ls-remote');
    expect(remoteCalls).toHaveLength(4);
    for (const call of remoteCalls) {
      expect(call.options.env).toMatchObject({
        GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
        GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${encoded}`,
      });
    }
    for (const call of h.calls) {
      expect(JSON.stringify(call.args)).not.toContain(token);
      expect(JSON.stringify(call.args)).not.toContain(encoded);
      if (!remoteCalls.includes(call)) {
        expect(call.options.env.GIT_CONFIG_COUNT).toBeUndefined();
        expect(call.options.env.GIT_CONFIG_KEY_0).toBeUndefined();
        expect(call.options.env.GIT_CONFIG_VALUE_0).toBeUndefined();
      }
    }
    expect(h.env.GIT_CONFIG_COUNT).toBeUndefined();
    expect(h.env.GIT_CONFIG_VALUE_0).toBeUndefined();
    const assertNoToken = (directory: string): void => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) assertNoToken(file);
        else {
          const content = fs.readFileSync(file, 'utf8');
          expect(content).not.toContain(token);
          expect(content).not.toContain(encoded);
        }
      }
    };
    // payload, 실행 로그, 결과 JSON, GitHub output과 summary를 모두 포함한다.
    assertNoToken(workspace);
  });

  test('CDK diff stderr도 plan 원문과 HTML escape한 승인 summary에 보존한다', () => {
    const h = makeHarness();
    h.intercept(call => call.executable === process.execPath && call.args[1] === 'diff'
      ? { status: 0, stdout: 'diff stdout marker\n', stderr: 'diff stderr <marker> & details\n' }
      : undefined);
    h.plan();
    const diff = fs.readFileSync(path.join(h.directory, 'payload/diff.txt'), 'utf8');
    expect(diff).toContain('diff stdout marker\n');
    expect(diff).toContain('diff stderr <marker> & details\n');
    const summary = fs.readFileSync(h.env.GITHUB_STEP_SUMMARY!, 'utf8');
    expect(summary).toContain('diff stdout marker');
    expect(summary).toContain('diff stderr &lt;marker&gt; &amp; details');
    expect(summary).not.toContain('diff stderr <marker>');
  });

  test.each(cdEvents.flatMap(event => ([
    ['checkout SHA', (h: ReturnType<typeof makeHarness>) => { h.state.head = otherSha; }, /checkout SHA/],
    ['최신 develop SHA', (h: ReturnType<typeof makeHarness>) => { h.state.remote = otherSha; }, /최신 develop/],
    ['AWS 계정', (h: ReturnType<typeof makeHarness>) => { h.state.account = '222222222222'; }, /AWS 실행 계정/],
    ['AWS 실행 역할', (h: ReturnType<typeof makeHarness>) => { h.state.identityRole = 'unexpected'; }, /AWS 실행 역할/],
    ['baseline template', (h: ReturnType<typeof makeHarness>) => { h.state.templates.DevDataStack.Description = 'changed after approval'; }, /baseline 변경/],
    ['스택 교체', (h: ReturnType<typeof makeHarness>) => { h.state.stacks.DevDataStack.StackId += '-recreated'; }, /baseline 변경/],
    ['갱신 시각', (h: ReturnType<typeof makeHarness>) => { h.state.stacks.DevDataStack.LastUpdatedTime = '2026-10-21T00:00:00Z'; }, /baseline 변경/],
    ['스택 metadata', (h: ReturnType<typeof makeHarness>) => { h.state.stacks.DevDataStack.Tags.push({ Key: 'Other', Value: 'new' }); }, /baseline 변경/],
    ['스택 진행 중', (h: ReturnType<typeof makeHarness>) => { h.state.stacks.DevDataStack.StackStatus = 'UPDATE_IN_PROGRESS'; }, /정상 완료 상태/],
  ] as Array<[string, (h: ReturnType<typeof makeHarness>) => void, RegExp]>)
    .map(([name, change, message]) => [event, name, change, message] as const)))('%s 승인 후 %s 변경은 쓰기 전에 차단한다', (event, _name, change, message) => {
    const h = makeHarness(event); h.plan(); change(h);
    expect(() => h.run('deploy')).toThrow(message);
    expect(h.calls.some(call => call.args[1] === 'deploy')).toBe(false);
    expect(read(path.join(h.directory, 'result-deploy.json')).status).toBe('failed');
  });

  test.each([
    ['artifact ID 누락', (h: ReturnType<typeof makeHarness>) => { delete h.env.PLAN_ARTIFACT_ID; }, /artifact ID/],
    ['다른 artifact ID', (h: ReturnType<typeof makeHarness>) => { h.env.DOWNLOADED_ARTIFACT_ID = '988'; }, /artifact ID/],
    ['다른 run', (h: ReturnType<typeof makeHarness>) => { h.env.GITHUB_RUN_ID = '12346'; }, /runId/],
    ['deploy만 재실행한 attempt', (h: ReturnType<typeof makeHarness>) => { h.env.GITHUB_RUN_ATTEMPT = '2'; }, /runAttempt/],
    ['다른 SHA의 artifact', (h: ReturnType<typeof makeHarness>) => { h.env.GITHUB_SHA = otherSha; }, /sourceSha/],
    ['다른 계정의 artifact', (h: ReturnType<typeof makeHarness>) => { h.env.AWS_ACCOUNT_ID = '222222222222'; }, /account/],
    ['다른 이벤트의 artifact', (h: ReturnType<typeof makeHarness>) => { h.env.GITHUB_EVENT_NAME = 'workflow_dispatch'; }, /plan event/],
    ['plan.json 변조', (h: ReturnType<typeof makeHarness>) => { fs.appendFileSync(path.join(h.directory, 'plan.json'), ' '); }, /plan hash/],
    ['누락 파일', (h: ReturnType<typeof makeHarness>) => { fs.unlinkSync(path.join(h.directory, 'payload/diff.txt')); }, /inventory/],
    ['추가 파일', (h: ReturnType<typeof makeHarness>) => { fs.writeFileSync(path.join(h.directory, 'payload/unreviewed'), 'new'); }, /inventory/],
    ['변조 파일', (h: ReturnType<typeof makeHarness>) => { fs.appendFileSync(path.join(h.directory, 'payload/diff.txt'), 'new'); }, /inventory/],
  ] as Array<[string, (h: ReturnType<typeof makeHarness>) => void, RegExp]>)('%s를 승인한 입력으로 재사용하지 않는다', (_name, change, message) => {
    const h = makeHarness(); h.plan(); change(h);
    const before = h.calls.length;
    expect(() => h.run('verify')).toThrow(message);
    expect(h.calls).toHaveLength(before);
  });

  test('PR 실행은 plan만 만들 수 있고 PR artifact를 deploy에 재사용하지 못한다', () => {
    const h = makeHarness(); h.env.GITHUB_EVENT_NAME = 'pull_request'; h.env.GITHUB_REF = 'refs/pull/51/merge';
    h.plan();
    expect(h.calls.some(call => call.executable === 'git' && call.args[0] === 'ls-remote')).toBe(false);
    expect(() => h.run('deploy')).toThrow(/PR artifact/);
  });

  test('PR artifact는 실행 이벤트를 수동 CD로 바꿔도 승격하지 못한다', () => {
    const h = makeHarness('pull_request'); h.env.GITHUB_REF = 'refs/pull/71/merge';
    h.plan();
    h.env.GITHUB_EVENT_NAME = 'workflow_dispatch'; h.env.GITHUB_REF = 'refs/heads/develop';
    const before = h.calls.length;
    expect(() => h.run('verify')).toThrow(/plan event/);
    expect(h.calls).toHaveLength(before);
  });

  test.each([
    ['event', 'push'], ['ref', 'refs/heads/main'],
  ])('수동 CD도 다른 %s에 묶인 plan을 허용하지 않는다', (key, value) => {
    const h = makeHarness('workflow_dispatch'), plan = h.plan();
    plan[key] = value; write(path.join(h.directory, 'plan.json'), plan);
    h.approve();
    const before = h.calls.length;
    expect(() => h.run('verify')).toThrow(`plan ${key}`);
    expect(h.calls).toHaveLength(before);
  });

  test.each([
    ['main push', { GITHUB_REF: 'refs/heads/main' }, /CD branch/],
    ['main 수동 실행', { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main' }, /CD branch/],
    ['feature 수동 실행', { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/feature/test' }, /CD branch/],
    ['tag 수동 실행', { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/tags/develop' }, /CD branch/],
    ['다른 저장소', { GITHUB_REPOSITORY: 'other/infra' }, /식별자/],
    ['임의 이벤트', { GITHUB_EVENT_NAME: 'repository_dispatch' }, /이벤트/],
  ])('%s의 실행 식별자를 거부한다', (_name, changed, message) => {
    const h = makeHarness();
    expect(() => context({ ...h.env, ...changed })).toThrow(message);
  });

  test.each([
    ['legacy 스택', 'legacy', /철거 필요/], ['legacy 조회 권한 없음', 'legacyDenied', /aws 실행 실패/],
    ['템플릿 조회 권한 없음', 'templateError', /aws 실행 실패/], ['스택 조회 네트워크 오류', 'describeError', /aws 실행 실패/],
    ['합성 오류', 'synthError', /실행 실패/], ['diff 오류 exit 1', 'diffError', /실행 실패/],
  ])('%s는 plan 실패이며 변경 있음으로 삼키지 않는다', (_name, key, message) => {
    const h = makeHarness(); (h.state as Json)[key] = true;
    expect(() => h.run('plan')).toThrow(message);
    expect(fs.existsSync(path.join(h.directory, 'plan.json'))).toBe(false);
    expect(read(path.join(h.directory, 'result-plan.json')).status).toBe('failed');
    expect(h.calls.some(call => call.args[1] === 'deploy')).toBe(false);
  });

  test('baseline을 읽는 도중의 stack 변경을 탐지한다', () => {
    const h = makeHarness();
    let descriptions = 0;
    h.intercept(call => {
      if (call.executable === 'aws' && call.args[1] === 'describe-stacks' && call.args.includes('DevDataStack') && ++descriptions === 2) {
        h.state.stacks.DevDataStack.LastUpdatedTime = '2026-10-21T00:00:00Z';
      }
      return undefined;
    });
    expect(() => h.run('plan')).toThrow(/baseline 수집 중 stack 변경/);
  });

  test.each(cdEvents)('%s 배포 직전 두 번째 HEAD 확인에서 바뀐 develop도 차단한다', event => {
    const h = makeHarness(event); h.plan(); let reads = 0;
    h.intercept(call => {
      if (call.executable === 'git' && call.args[0] === 'ls-remote' && ++reads === 2) return { status: 0, stdout: `${otherSha}\trefs/heads/develop\n` };
      return undefined;
    });
    expect(() => h.run('deploy')).toThrow(/최신 develop/);
    expect(h.calls.some(call => call.args[1] === 'deploy')).toBe(false);
  });

  test('부분 배포 실패를 재시도하지 않고 스택별 결과와 로그를 보존한다', () => {
    const h = makeHarness(); h.plan(); h.state.deployError = true;
    expect(() => h.run('deploy')).toThrow(/실행 실패/);
    expect(h.calls.filter(call => call.args[1] === 'deploy')).toHaveLength(1);
    const result = read(path.join(h.directory, 'result-deploy.json'));
    expect(result.status).toBe('failed');
    expect(result.stacks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'DevNetworkStack', status: 'UPDATE_COMPLETE' }),
      expect.objectContaining({ name: 'DevDataStack', status: 'UPDATE_ROLLBACK_COMPLETE' }),
    ]));
    expect(fs.readFileSync(path.join(h.directory, 'logs/deploy.log'), 'utf8')).toContain('DevDataStack deployment failed');
  });

  test('deploy exit 0이어도 최종 rollback 상태는 성공으로 보고하지 않는다', () => {
    const h = makeHarness(); h.plan();
    h.intercept(call => {
      if (call.executable === process.execPath && call.args[1] === 'deploy') h.state.stacks.DevDataStack.StackStatus = 'UPDATE_ROLLBACK_COMPLETE';
      return undefined;
    });
    expect(() => h.run('deploy')).toThrow(/배포 후 stack 상태/);
    expect(read(path.join(h.directory, 'result-deploy.json')).status).toBe('failed');
  });

  test('baseline metadata의 원문 Parameters와 Outputs를 plan에 복제하지 않는다', () => {
    const h = makeHarness();
    h.state.stacks.DevDataStack.Parameters = [{ ParameterKey: 'SomeParameter', ParameterValue: 'not-for-artifact' }];
    h.state.stacks.DevDataStack.Outputs = [{ OutputKey: 'SomeOutput', OutputValue: 'also-not-for-artifact' }];
    h.plan();
    const planText = fs.readFileSync(path.join(h.directory, 'plan.json'), 'utf8');
    expect(planText).not.toContain('not-for-artifact');
    expect(planText).toContain('metadataHash');
  });
});


describe('MSK 최초 제거 차단과 철거 후 자동 배포 복구', () => {
  function stage(value: string) {
    const file = path.join(root, 'config/dev/deployment.json');
    const nodeFs = require('node:fs'), original = nodeFs.readFileSync;
    const profile = JSON.parse(original(file, 'utf8'));
    profile.context.devMskRetirementStage = value;
    const text = JSON.stringify(profile);
    jest.spyOn(nodeFs, 'readFileSync').mockImplementation((...args: any[]) => {
      if (args[0] === file) return args[1] ? text : Buffer.from(text);
      return original(...args);
    });
  }
  function retiredHarness() {
    stage('network-removed');
    const h = makeHarness();
    h.state.templates = clone(retiredTemplates);
    h.state.assemblyFixture = retiredAssemblyFixture;
    return h;
  }
  test.each(['plan', 'verify', 'deploy'])('cluster-removed %s는 AWS 호출 전에 차단한다', operation => {
    stage('cluster-removed'); const h = makeHarness();
    expect(() => h.run(operation)).toThrow('EKS 단독');
    expect(h.calls).toHaveLength(0);
  });
  test('network-removed라도 실제 MSK가 남아 있으면 최초 plan을 거부한다', () => {
    stage('network-removed'); const h = makeHarness();
    expect(() => h.run('plan')).toThrow('MSK 리소스');
    expect(h.calls.some(call => call.args[1] === 'synth')).toBe(false);
  });
  test.each([
    ['cluster', 'AWS::MSK::Cluster', {}], ['configuration', 'AWS::MSK::Configuration', {}],
    ['SG', 'AWS::EC2::SecurityGroup', { GroupDescription: 'dev MSK brokers' }],
    ['subnet', 'AWS::EC2::Subnet', { CidrBlock: '10.1.33.0/24' }],
  ])('논리 ID가 달라도 잔존 %s를 자동 제거하지 않는다', (_kind, type, properties) => {
    const baseline = clone(retiredTemplates);
    baseline.DevNetworkStack.Resources.Renamed = { Type: type, Properties: properties };
    expect(() => assertAutomaticRetirement({ context: { devMskRetirementStage: 'network-removed' } }, baseline)).toThrow('MSK 리소스');
  });
  test('완전히 철거한 안정 AWS baseline은 plan·인증 전 verify·deploy를 허용한다', () => {
    const h = retiredHarness(); h.plan();
    const before = h.calls.length;
    h.run('verify'); expect(h.calls).toHaveLength(before);
    h.run('deploy');
    expect(h.calls.filter(call => call.args[1] === 'deploy')).toHaveLength(1);
    expect(h.calls.filter(call => call.args[1] === 'get-template')).toHaveLength(12);
  });
  test('plan 뒤 MSK가 다시 나타나면 실제 AWS 재검사에서 deploy를 거부한다', () => {
    const h = retiredHarness(); h.plan();
    h.state.templates.DevEksStack.Resources.Reappeared = { Type: 'AWS::MSK::Cluster' };
    expect(() => h.run('deploy')).toThrow('MSK 리소스');
    expect(h.calls.some(call => call.args[1] === 'deploy')).toBe(false);
  });
  test('verify도 승인 artifact의 MSK baseline 잔존을 검사한다', () => {
    const h = retiredHarness(), plan = h.plan();
    const file = path.join(h.directory, 'payload/baseline/DevNetworkStack.json');
    const baseline = read(file);
    baseline.Resources.DevMskSgFixture = { Type: 'AWS::EC2::SecurityGroup' };
    write(file, baseline);
    plan.baseline.find((item: Json) => item.name === 'DevNetworkStack').templateHash = sha256(canonical(baseline));
    plan.files = inventory(path.join(h.directory, 'payload')); write(path.join(h.directory, 'plan.json'), plan); h.approve();
    const before = h.calls.length;
    expect(() => h.run('verify')).toThrow('MSK 리소스');
    expect(h.calls).toHaveLength(before);
  });
  test('철거 후에도 비정상 stack 상태나 조회 실패는 제거 완료로 간주하지 않는다', () => {
    const h = retiredHarness(); h.state.stacks.DevNetworkStack.StackStatus = 'DELETE_IN_PROGRESS';
    expect(() => h.run('plan')).toThrow('정상 완료 상태');
    h.state.stacks.DevNetworkStack.StackStatus = 'UPDATE_COMPLETE'; h.state.templateError = true;
    expect(() => h.run('plan')).toThrow('aws 실행 실패');
  });
});
