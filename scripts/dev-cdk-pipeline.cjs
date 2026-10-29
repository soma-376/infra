const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const { load, JSON_SCHEMA } = require('js-yaml');

const REGION = 'ap-northeast-2';
const REPOSITORY = 'soma-376/infra';
const CD_EVENTS = new Set(['push', 'workflow_dispatch']);
const STACKS = ['DevNetworkStack', 'DevDataStack', 'DevEdgeStack', 'DevEksStack'];
const QUALIFIER = 'hnb659fds';
const VERSION_PARAMETER = `/cdk-bootstrap/${QUALIFIER}/version`;
const STABLE = new Set(['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'IMPORT_COMPLETE']);
const fail = message => { throw new Error(message); };
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(sort(value));
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])]));
  return value;
}
function document(file) { return load(fs.readFileSync(file, 'utf8'), { schema: JSON_SCHEMA }); }
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}
function equal(actual, expected, label) {
  if (!isDeepStrictEqual(actual, expected)) fail(`${label} 불일치`);
}
function keys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(`${label} 형식 오류`);
}
function relative(root, name, kind = 'file') {
  if (typeof name !== 'string' || !name || name.includes('\\') || path.isAbsolute(name) || name.split('/').some(part => !part || part === '..' || part === '.')) fail('artifact 상대 경로 오류');
  let cursor = root;
  for (const part of name.split('/')) {
    cursor = path.join(cursor, part);
    if (fs.lstatSync(cursor).isSymbolicLink()) fail('artifact symlink 금지');
  }
  const stat = fs.lstatSync(cursor);
  if (kind === 'file' ? !stat.isFile() : !stat.isDirectory()) fail('artifact 파일 종류 오류');
  return cursor;
}
function inventory(root) {
  if (fs.lstatSync(root).isSymbolicLink()) fail('artifact root symlink 금지');
  const files = [];
  function walk(directory, prefix) {
    for (const name of fs.readdirSync(directory).sort()) {
      const item = path.join(directory, name), stat = fs.lstatSync(item), rel = prefix ? `${prefix}/${name}` : name;
      if (stat.isSymbolicLink()) fail('artifact symlink 금지');
      if (stat.isDirectory()) walk(item, rel);
      else if (stat.isFile()) files.push({ path: rel, size: stat.size, sha256: sha256(fs.readFileSync(item)) });
      else fail('artifact 특수 파일 금지');
    }
  }
  walk(root, '');
  return files;
}
function role(account, kind) { return `arn:aws:iam::${account}:role/cdk-${QUALIFIER}-${kind}-role-${account}-${REGION}`; }
function normalizedArn(value) { return typeof value === 'string' ? value.replaceAll('${AWS::Partition}', 'aws') : value; }
// 최초 제거는 ENI 해제를 기다리는 수동 절차다. 제거가 끝난 baseline의 후속 자동 배포는 허용한다.
function automaticRetirementStage(profile) {
  const stage = profile?.context?.devMskRetirementStage ?? 'retain';
  if (!['retain', 'cluster-removed', 'network-removed'].includes(stage)) fail('MSK 제거 단계가 올바르지 않다');
  if (stage === 'cluster-removed') fail('MSK 제거는 자동 전체 스택 배포가 아닌 EKS 단독 → ENI 확인 → Network 단독 절차로 수행한다');
  return stage;
}
function assertAutomaticRetirement(profile, templates) {
  if (automaticRetirementStage(profile) === 'retain') return;
  if (!templates || Object.keys(templates).sort().join() !== [...STACKS].sort().join()) fail('MSK 제거 완료 확인에 네 스택 baseline이 필요하다');
  for (const template of Object.values(templates)) {
    assertTemplate(template);
    for (const [id, resource] of Object.entries(template.Resources)) {
      if (/^AWS::MSK::/.test(resource.Type) || /^DevMsk/.test(id) ||
          /\/DevMsk(?:Sg|Subnet)[^/]*\//.test(resource.Metadata?.['aws:cdk:path'] ?? '') ||
          (resource.Type === 'AWS::EC2::Subnet' && /^10\.1\.(32|33|34)\.0\/24$/.test(resource.Properties?.CidrBlock ?? '')) ||
          (resource.Type === 'AWS::EC2::SecurityGroup' && resource.Properties?.GroupDescription === 'dev MSK brokers')) {
        fail('MSK 리소스가 baseline 또는 배포 템플릿에 남아 있다. Network 단독 제거 완료 후 자동 배포한다');
      }
    }
    if (Object.keys(template.Outputs ?? {}).some(key => key.startsWith('Msk'))) fail('MSK output이 baseline 또는 배포 템플릿에 남아 있다');
  }
}
function assertTemplate(template) {
  if (!template || typeof template !== 'object' || !template.Resources || typeof template.Resources !== 'object' || Array.isArray(template.Resources)) fail('CloudFormation 템플릿 오류');
  for (const [id, resource] of Object.entries(template.Resources)) {
    if (resource.Type === 'AWS::CloudFormation::Stack') fail('nested stack은 수동 설계가 필요합니다');
    if (/^AWS::(?:ECS|AutoScaling|ServiceDiscovery)::/.test(resource.Type) ||
        /^(?:DevAlb|DevAppHostSg|DevClickhouseSg|DevCollectorSg|EksToExistingClickhouse|DevHttpListener|DevTelemetryIngestTg|DevEnrollmentApiTg|DevDashboardApiTg|DevClickhouseTg)/.test(id)) fail('legacy ECS 철거를 먼저 완료해야 합니다');
  }
  if (['AlbDnsName', 'OtlpEndpoint', 'ClickhouseDebugUrl', 'OtlpDebugEndpoint'].some(key => Object.hasOwn(template.Outputs ?? {}, key))) fail('legacy ECS output 잔존');
}

// Assembly는 실행 입력이다. 새 asset 실행 형식이나 임의 역할을 암묵적으로 허용하지 않는다.
function validateAssembly(directory, account) {
  inventory(directory);
  const manifest = document(relative(directory, 'manifest.json'));
  if (manifest.missing?.length) fail('추가 context lookup 금지');
  const artifacts = manifest.artifacts ?? {};
  equal(Object.keys(artifacts).filter(id => artifacts[id].type === 'aws:cloudformation:stack').sort(), [...STACKS].sort(), 'dev 스택 목록');
  const allowedIds = [...STACKS, ...STACKS.map(id => `${id}.assets`), 'Tree', 'aws-cdk-lib/feature-flag-report'];
  if (Object.keys(artifacts).some(id => !allowedIds.includes(id))) fail('지원하지 않는 artifact');
  const bucket = `cdk-${QUALIFIER}-assets-${account}-${REGION}`;
  const dependencies = {};
  for (const [id, artifact] of Object.entries(artifacts)) {
    const props = artifact.properties ?? {};
    if (Object.values(artifact.metadata ?? {}).some(entries => entries.some(entry => entry.type === 'aws:cdk:asset'))) fail('legacy metadata asset 금지');
    if ((artifact.dependencies ?? []).some(dep => !allowedIds.includes(dep))) fail('허용하지 않은 artifact dependency');
    if (STACKS.includes(id)) {
      equal(artifact.environment, `aws://${account}/${REGION}`, 'stack 계정·리전');
      if (props.stackName !== undefined) equal(props.stackName, id, 'stack 물리 이름');
      equal(props.templateFile, `${id}.template.json`, 'template 경로');
      equal(normalizedArn(props.assumeRoleArn), role(account, 'deploy'), 'deploy 역할');
      equal(normalizedArn(props.cloudFormationExecutionRoleArn), role(account, 'cfn-exec'), 'CFN 실행 역할');
      equal(normalizedArn(props.lookupRole?.arn), role(account, 'lookup'), 'lookup 역할');
      equal(props.bootstrapStackVersionSsmParameter, VERSION_PARAMETER, 'bootstrap parameter');
      equal(props.lookupRole?.bootstrapStackVersionSsmParameter, VERSION_PARAMETER, 'lookup bootstrap parameter');
      if (Object.keys(props).some(key => /(?:ExternalId|AdditionalOptions)$/.test(key)) ||
          Object.keys(props.lookupRole ?? {}).some(key => /(?:ExternalId|AdditionalOptions)$/.test(key))) fail('역할 추가 옵션 금지');
      if (props.parameters && Object.keys(props.parameters).length) fail('별도 stack parameter 입력 금지');
      if (artifact.type !== 'aws:cloudformation:stack') fail('stack artifact 형식 오류');
      const templateFile = relative(directory, props.templateFile);
      assertTemplate(document(templateFile));
      const templateHash = sha256(fs.readFileSync(templateFile));
      equal(props.stackTemplateAssetObjectUrl, `s3://${bucket}/${templateHash}.json`, 'template asset URL');
      dependencies[id] = (artifact.dependencies ?? []).filter(dep => STACKS.includes(dep));
    } else if (id.endsWith('.assets')) {
      equal(artifact.type, 'cdk:asset-manifest', 'asset artifact 종류');
      equal(props.file, `${id}.json`, 'asset manifest 경로');
      equal(props.bootstrapStackVersionSsmParameter, VERSION_PARAMETER, 'asset bootstrap parameter');
      const assets = document(relative(directory, props.file));
      if (Object.keys(assets.dockerImages ?? {}).length) fail('Docker asset 금지');
      for (const [hash, asset] of Object.entries(assets.files ?? {})) {
        if (!/^[a-f0-9]{64}$/.test(hash)) fail('asset hash 형식 오류');
        keys(asset.source, ['path', 'packaging'], 'asset source');
        const packaging = asset.source.packaging;
        if (!['file', 'zip'].includes(packaging)) fail('asset packaging 오류');
        const source = relative(directory, asset.source.path, packaging === 'zip' ? 'directory' : 'file');
        const actualHash = packaging === 'file' ? sha256(fs.readFileSync(source)) : require('aws-cdk-lib/core').FileSystem.fingerprint(source);
        equal(hash, actualHash, 'asset source hash');
        const destinations = Object.values(asset.destinations ?? {});
        if (destinations.length !== 1) fail('asset destination 수 오류');
        const destination = destinations[0];
        keys(destination, ['bucketName', 'objectKey', 'region', 'assumeRoleArn'], 'asset destination');
        equal(destination.bucketName, bucket, 'asset bucket');
        equal(destination.region, REGION, 'asset 리전');
        equal(normalizedArn(destination.assumeRoleArn), role(account, 'file-publishing'), 'asset 게시 역할');
        equal(destination.objectKey, `${hash}.${packaging === 'zip' ? 'zip' : 'json'}`, 'asset object key');
      }
      const stack = id.slice(0, -7), templateHash = sha256(fs.readFileSync(relative(directory, `${stack}.template.json`)));
      equal(assets.files?.[templateHash]?.source, { path: `${stack}.template.json`, packaging: 'file' }, 'template asset 등록');
    } else if (id === 'Tree') {
      equal(artifact.type, 'cdk:tree', 'tree artifact 종류');
      relative(directory, props.file);
    } else if (id === 'aws-cdk-lib/feature-flag-report') equal(artifact.type, 'cdk:feature-flag-report', 'feature flag artifact 종류');
    else fail('지원하지 않는 artifact 종류');
  }
  for (const stack of STACKS) if (!artifacts[`${stack}.assets`]) fail('asset manifest 누락');
  const ordered = [], visiting = new Set();
  function visit(stack) {
    if (ordered.includes(stack)) return;
    if (visiting.has(stack)) fail('stack dependency 순환');
    visiting.add(stack);
    for (const dependency of dependencies[stack]) visit(dependency);
    visiting.delete(stack); ordered.push(stack);
  }
  STACKS.forEach(visit);
  return ordered;
}

function context(env) {
  const value = { repository: env.GITHUB_REPOSITORY, sourceSha: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT, account: env.AWS_ACCOUNT_ID, region: REGION, event: env.GITHUB_EVENT_NAME, ref: env.GITHUB_REF };
  if (value.repository !== REPOSITORY || !/^[a-f0-9]{40}$/.test(value.sourceSha ?? '') ||
      !/^[1-9]\d*$/.test(value.runId ?? '') || !/^[1-9]\d*$/.test(value.runAttempt ?? '') || !/^\d{12}$/.test(value.account ?? '')) fail('GitHub 실행 식별자·계정 오류');
  if (CD_EVENTS.has(value.event)) equal(value.ref, 'refs/heads/develop', 'CD branch');
  else if (value.event === 'pull_request') {
    if (!/^refs\/pull\/[1-9]\d*\/merge$/.test(value.ref ?? '')) fail('PR merge ref 오류');
  } else fail('허용하지 않은 GitHub 이벤트');
  return value;
}

function defaultRunner(command, args, options = {}) {
  return spawnSync(command, args, { cwd: options.cwd, env: options.env, encoding: 'utf8', timeout: options.timeout ?? 120_000, maxBuffer: 32 * 1024 * 1024 });
}
function stackRecord(raw, name, account) {
  if (raw.StackName !== name || !new RegExp(`^arn:aws:cloudformation:${REGION}:${account}:stack/${name}/[^/]+$`).test(raw.StackId ?? '')) fail('baseline stack 식별자 오류');
  if (!STABLE.has(raw.StackStatus)) fail(`${name}: 정상 완료 상태가 아닙니다`);
  if (!raw.CreationTime) fail('baseline 생성 시각 누락');
  return { name, id: raw.StackId, status: raw.StackStatus, createdAt: raw.CreationTime, updatedAt: raw.LastUpdatedTime ?? null,
    // Parameter/Output 원문은 artifact에 복제하지 않고 변경 감지용 해시만 남긴다.
    metadataHash: sha256(canonical({ parameters: raw.Parameters ?? [], outputs: raw.Outputs ?? [], tags: raw.Tags ?? [],
      roleArn: raw.RoleARN ?? null, terminationProtection: raw.EnableTerminationProtection ?? false })) };
}

function createPipeline({ root, directory, env = process.env, runner = defaultRunner }) {
  root = path.resolve(root); directory = path.resolve(directory);
  const payload = path.join(directory, 'payload'), assembly = path.join(payload, 'assembly'), logs = path.join(directory, 'logs');
  const childEnv = { ...env, AWS_REGION: REGION, AWS_DEFAULT_REGION: REGION, CDK_DEFAULT_REGION: REGION,
    CDK_DEFAULT_ACCOUNT: env.AWS_ACCOUNT_ID, AWS_EC2_METADATA_DISABLED: 'true', AWS_PAGER: '', CDK_DISABLE_VERSION_CHECK: 'true' };
  const result = { operation: null, status: 'failed', stacks: [] };
  const retirementProfile = () => document(path.join(root, 'config/dev/deployment.json'));
  function checkRetirementFiles(base, filename) {
    const templates = Object.fromEntries(STACKS.map(name => [name, document(relative(base, filename(name)))]));
    assertAutomaticRetirement(retirementProfile(), templates);
    return templates;
  }
  function command(executable, args, options = {}) {
    const response = runner(executable, args, { cwd: root, env: childEnv, ...options });
    if (options.log) {
      fs.mkdirSync(logs, { recursive: true });
      fs.writeFileSync(path.join(logs, options.log), `${response.stdout ?? ''}${response.stderr ?? ''}`, { mode: 0o600 });
    }
    if (response.error || response.status !== 0) {
      const error = new Error(`${path.basename(executable)} 실행 실패${options.log ? ` (${options.log})` : ''}`);
      error.response = response;
      throw error;
    }
    return options.combined ? `${response.stdout ?? ''}${response.stderr ?? ''}` : response.stdout ?? '';
  }
  function aws(service, operation, args = []) {
    try {
      return JSON.parse(command('aws', [service, operation, ...args, '--region', REGION, '--output', 'json', '--no-cli-pager']));
    } catch (error) {
      // 응답 본문(Parameters/Outputs)은 복사하지 않고 조회 실패 진단만 보존한다.
      fs.mkdirSync(logs, { recursive: true });
      fs.appendFileSync(path.join(logs, `aws-${service}-${operation}.log`), `${error.response?.stderr ?? error.message}\n`, { mode: 0o600 });
      throw error;
    }
  }
  function checkIdentity(expected, kind) {
    const identity = aws('sts', 'get-caller-identity');
    equal(identity.Account, expected.account, 'AWS 실행 계정');
    if (!new RegExp(`^arn:aws:sts::${expected.account}:assumed-role/soma-376-infra-dev-${kind}/[^/]+$`).test(identity.Arn ?? '')) fail('AWS 실행 역할 불일치');
  }
  function checkSource(expected) {
    equal(command('git', ['rev-parse', 'HEAD']).trim(), expected.sourceSha, 'checkout SHA');
    if (CD_EVENTS.has(expected.event)) {
      // 비공개 저장소도 조회한다. 토큰은 인자·Git 설정 파일·로그에 쓰지 않는다.
      const gitEnv = { ...childEnv, GIT_TERMINAL_PROMPT: '0' };
      if (env.GH_TOKEN) Object.assign(gitEnv, {
        GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
        GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${env.GH_TOKEN}`).toString('base64')}`,
      });
      const lines = command('git', ['ls-remote', '--exit-code', `https://github.com/${REPOSITORY}.git`, 'refs/heads/develop'], { env: gitEnv }).trim().split('\n');
      if (lines.length !== 1) fail('develop ref 조회 오류');
      equal(lines[0].split(/\s+/), [expected.sourceSha, 'refs/heads/develop'], '최신 develop SHA');
    }
  }
  function checkLegacy() {
    try {
      const value = aws('cloudformation', 'describe-stacks', ['--stack-name', 'DevApplicationStack']);
      if (value.Stacks?.length) fail('legacy DevApplicationStack 철거 필요');
      fail('legacy stack 조회 응답 오류');
    } catch (error) {
      const stderr = error.response?.stderr ?? '';
      // 존재하지 않음만 인정한다. AccessDenied·네트워크 실패는 절대 부재로 간주하지 않는다.
      if (!/\(ValidationError\)/.test(stderr) || !/Stack with id DevApplicationStack does not exist/.test(stderr)) throw error;
    }
  }
  function describe(name, expected) {
    const value = aws('cloudformation', 'describe-stacks', ['--stack-name', name]);
    if (value.Stacks?.length !== 1) fail('baseline stack 조회 응답 오류');
    return stackRecord(value.Stacks[0], name, expected.account);
  }
  function captureBaseline(expected, write = false) {
    checkLegacy();
    const before = Object.fromEntries(STACKS.map(name => [name, describe(name, expected)]));
    const baseline = [], templates = {};
    for (const name of STACKS) {
      const response = aws('cloudformation', 'get-template', ['--stack-name', name, '--template-stage', 'Original']);
      const template = typeof response.TemplateBody === 'string' ? load(response.TemplateBody, { schema: JSON_SCHEMA }) : response.TemplateBody;
      assertTemplate(template);
      templates[name] = template;
      if (write) writeJson(path.join(payload, 'baseline', `${name}.json`), template);
      baseline.push({ ...before[name], templateHash: sha256(canonical(template)) });
    }
    for (const name of STACKS) equal(describe(name, expected), before[name], 'baseline 수집 중 stack 변경');
    assertAutomaticRetirement(retirementProfile(), templates);
    return baseline;
  }
  function inputs() {
    return Object.fromEntries(['package-lock.json', 'config/dev/deployment.json'].map(file => [file, sha256(fs.readFileSync(path.join(root, file)))]));
  }
  const cdkVersion = () => JSON.parse(fs.readFileSync(path.join(root, 'node_modules/aws-cdk/package.json'), 'utf8')).version;
  function cdk(args, log, cwd = root) {
    return command(process.execPath, [path.join(root, 'node_modules/aws-cdk/bin/cdk'), ...args, '--no-notices', '--no-lookups'], { cwd, log, combined: true, timeout: 3_300_000 });
  }
  function preparePlan(expected) {
    if (fs.existsSync(payload) || fs.existsSync(path.join(directory, 'plan.json'))) fail('plan은 빈 디렉터리에서 생성해야 합니다');
    checkSource(expected); checkIdentity(expected, 'diff');
    const baseline = captureBaseline(expected, true);
    result.stacks = baseline.map(stack => ({ name: stack.name, id: stack.id, status: stack.status, diff: 'pending' }));
    const azResponse = aws('ec2', 'describe-availability-zones', ['--filters', 'Name=state,Values=available', 'Name=zone-type,Values=availability-zone']);
    const zones = azResponse.AvailabilityZones?.map(zone => zone.ZoneName).sort();
    if (!zones || zones.length < 2 || zones.some(zone => !/^ap-northeast-2[a-z]$/.test(zone)) || new Set(zones).size !== zones.length) fail('AZ 조회 응답 오류');
    // 새로운 빈 작업 폴더에서 실행해 개인 cdk.context.json·cdk.json·plugin을 읽지 않는다.
    const synthesis = path.join(directory, 'synthesis');
    fs.mkdirSync(synthesis);
    const config = document(path.join(root, 'cdk.json'));
    writeJson(path.join(synthesis, 'cdk.json'), { context: { ...config.context,
      [`availability-zones:account=${expected.account}:region=${REGION}`]: zones } });
    const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
    const appCommand = `node --import ${quote(path.join(root, 'node_modules/tsx/dist/loader.mjs'))} ${quote(path.join(root, 'bin/infra.ts'))}`;
    cdk(['synth', ...STACKS, '--app', appCommand, '-c', 'env=dev', '-c', `devDeploymentProfile=${path.join(root, 'config/dev/deployment.json')}`, '--output', assembly], 'synth.log', synthesis);
    const order = validateAssembly(assembly, expected.account);
    checkRetirementFiles(assembly, name => `${name}.template.json`);
    const diff = [];
    for (const name of order) {
      diff.push(cdk(['diff', name, '--app', assembly, '--exclusively', '--template', path.join(payload, 'baseline', `${name}.json`), '--method', 'template'], `diff-${name}.log`, synthesis));
      result.stacks.find(stack => stack.name === name).diff = 'completed';
      fs.writeFileSync(path.join(payload, 'diff.txt'), diff.join('\n'), { mode: 0o600 });
    }
    fs.writeFileSync(path.join(payload, 'diff.txt'), diff.join('\n'), { mode: 0o600 });
    equal(captureBaseline(expected), baseline, 'plan 생성 중 baseline 변경');
    checkSource(expected);
    const plan = { schemaVersion: 1, ...expected, cdkVersion: cdkVersion(), inputs: inputs(), order, baseline, files: inventory(payload) };
    writeJson(path.join(directory, 'plan.json'), plan);
    const hash = sha256(fs.readFileSync(path.join(directory, 'plan.json')));
    if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `plan_sha256=${hash}\n`);
    if (env.GITHUB_STEP_SUMMARY) {
      fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `## dev CloudFormation plan\n\nSHA: \`${expected.sourceSha}\`\n\nPlan SHA256: \`${hash}\`\n\n승인 대상은 고정된 합성 템플릿입니다.\n\n`);
      // 긴 diff는 artifact에 온전히 남기고 Summary는 GitHub 용량 안에서 HTML escape한다.
      const escaped = diff.join('\n').slice(0, 500_000).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
      fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `<pre>${escaped}</pre>\n\n전체 diff는 plan artifact의 payload/diff.txt를 확인합니다.\n`);
    }
    return plan;
  }
  function verifyPlan(expected) {
    if (!CD_EVENTS.has(expected.event)) fail('PR artifact 배포 금지');
    if (!/^[1-9]\d*$/.test(env.PLAN_ARTIFACT_ID ?? '')) fail('plan artifact ID 누락');
    equal(env.DOWNLOADED_ARTIFACT_ID, env.PLAN_ARTIFACT_ID, '다운로드 artifact ID');
    if (!/^[a-f0-9]{64}$/.test(env.PLAN_SHA256 ?? '')) fail('plan hash 누락');
    const file = relative(directory, 'plan.json');
    equal(sha256(fs.readFileSync(file)), env.PLAN_SHA256, 'plan hash');
    const plan = document(file);
    equal(plan.schemaVersion, 1, 'plan schema');
    for (const [key, value] of Object.entries(expected)) equal(plan[key], value, `plan ${key}`);
    equal(plan.cdkVersion, cdkVersion(), 'CDK CLI 버전');
    equal(plan.inputs, inputs(), '배포 입력');
    equal(inventory(payload), plan.files, 'artifact 파일 inventory');
    equal(validateAssembly(assembly, expected.account), plan.order, '배포 순서');
    checkRetirementFiles(assembly, name => `${name}.template.json`);
    // verify는 AWS 인증 전이다. 승인 artifact의 baseline을 검사하고 deploy에서 실제 AWS를 다시 검사한다.
    const baselineTemplates = checkRetirementFiles(path.join(payload, 'baseline'), name => `${name}.json`);
    if (!Array.isArray(plan.baseline) || plan.baseline.length !== STACKS.length) fail('plan baseline 목록 오류');
    for (const name of STACKS) {
      const records = plan.baseline.filter(stack => stack.name === name);
      if (records.length !== 1 || !STABLE.has(records[0].status)) fail('plan baseline 안정 상태 오류');
      equal(sha256(canonical(baselineTemplates[name])), records[0].templateHash, 'plan baseline template hash');
    }
    return plan;
  }
  function collectResult(expected) {
    result.stacks = [];
    for (const name of STACKS) {
      try {
        const stack = aws('cloudformation', 'describe-stacks', ['--stack-name', name]).Stacks?.[0];
        result.stacks.push({ name, id: stack?.StackId, status: stack?.StackStatus, reason: stack?.StackStatusReason });
      } catch { result.stacks.push({ name, status: '조회 실패' }); }
    }
    result.account = expected.account;
  }
  function deploy(expected) {
    const plan = verifyPlan(expected);
    checkSource(expected); checkIdentity(expected, 'deploy');
    equal(captureBaseline(expected), plan.baseline, '승인 후 baseline 변경');
    checkSource(expected);
    // SDK/plugin/project 설정을 다시 읽지 않도록 소스와 분리된 빈 cwd를 쓴다.
    const execution = path.join(directory, 'execution'); fs.mkdirSync(execution, { recursive: true });
    try {
      cdk(['deploy', ...plan.order, '--app', assembly, '--exclusively', '--concurrency', '1', '--require-approval', 'never', '--ci'], 'deploy.log', execution);
    } finally { collectResult(expected); }
    if (result.stacks.some(stack => !STABLE.has(stack.status))) fail('배포 후 stack 상태 확인 실패');
  }
  function execute(operation) {
    fs.mkdirSync(directory, { recursive: true });
    result.operation = operation;
    try {
      automaticRetirementStage(retirementProfile());
      const expected = context(env);
      result.sourceSha = expected.sourceSha;
      if (operation === 'plan') preparePlan(expected);
      else if (operation === 'verify') verifyPlan(expected);
      else if (operation === 'deploy') deploy(expected);
      else fail('지원하지 않는 명령');
      result.status = 'succeeded';
      return result;
    } catch (error) {
      result.error = error.message;
      throw error;
    } finally {
      writeJson(path.join(directory, `result-${operation}.json`), result);
      if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `\n${operation}: **${result.status}**\n`);
    }
  }
  return { execute, preparePlan, verifyPlan, captureBaseline };
}

module.exports = { REGION, REPOSITORY, STACKS, sha256, canonical, inventory, validateAssembly, assertTemplate, assertAutomaticRetirement, stackRecord, context, createPipeline };
