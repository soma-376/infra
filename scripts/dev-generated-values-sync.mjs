#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, lstatSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dump } from 'js-yaml';
import pipeline from './dev-cdk-pipeline.cjs';
import profiles from '../lib/dev/deployment-profile.cjs';
import { generateValues, parseRuntimeValues } from './eks-values.mjs';
import { validateBackendImageInputs } from './backend-image-inputs.mjs';
import { collectGeneratedValuesInputs } from './dev-generated-values-inputs.mjs';
import { GENERATED_FILES, validateGeneratedValues } from './validate-generated-values.mjs';
import { githubClient, verifyPublicationEvidence } from './generated-values-github.mjs';

const TARGET = 'soma-376/infra-generated-values';
const MARKERS = ['bundle.json', 'desired.yaml', 'applications', 'delivery-state.json'];
const ALLOWED = ['dev/infra-commit.txt', ...GENERATED_FILES.map(name => `dev/generated/${name}`)];
const assertSha = value => { if (!/^[a-f0-9]{40}$/.test(value ?? '')) throw new Error('commit SHA 형식 오류'); };

// Git 자격은 자식 환경에만 넣고 clone URL·인자·설정 파일에 남기지 않는다.
export function createValuesPublisher({ directory, token, remote = `https://github.com/${TARGET}.git`, runner = spawnSync }) {
  const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_COUNT: token ? '3' : '2', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'core.hooksPath', GIT_CONFIG_VALUE_1: '/dev/null' };
  if (token) Object.assign(gitEnv, { GIT_CONFIG_KEY_2: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_2: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}` });
  function git(args, cwd = directory, allowFailure = false) {
    const result = runner('git', args, { cwd, env: gitEnv, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
    if (allowFailure) return result;
    if (result.error || result.status !== 0) throw new Error(`사본 Git ${args[0]} 실패`);
    return result.stdout;
  }
  git(['clone', '--quiet', '--no-checkout', '--depth=1', '--branch', 'main', '--', remote, directory], path.dirname(directory));
  const startHead = git(['rev-parse', 'HEAD']).trim(); assertSha(startHead);
  git(['checkout', '--quiet', '--detach', startHead]);
  function checkTree() {
    for (const marker of MARKERS) for (const prefix of ['', 'dev/']) {
      if (lstatSync(path.join(directory, prefix, marker), { throwIfNoEntry: false })) throw new Error('GitOps 인계 표식 발견: 사본 writer 종료 필요');
    }
    for (const folder of ['dev', 'dev/generated']) {
      const file = path.join(directory, folder);
      const stat = lstatSync(file, { throwIfNoEntry: false });
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error('사본 디렉터리 형식 오류');
    }
    const tree = git(['ls-tree', '-r', '--name-only', startHead]).trim().split('\n');
    if (tree.some(name => !['README.md', 'AGENTS.md', ...ALLOWED].includes(name))) throw new Error('기존 사본 파일 허용목록 오류');
    const snapshot = tree.filter(name => ALLOWED.includes(name));
    if (snapshot.length !== 0 && snapshot.length !== ALLOWED.length) throw new Error('기존 사본이 부분 묶음입니다');
    for (const name of ['README.md', 'AGENTS.md', ...ALLOWED]) {
      const file = path.join(directory, name);
      const stat = lstatSync(file, { throwIfNoEntry: false });
      if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error('사본 파일 형식 오류');
    }
  }
  function remoteHead() {
    const lines = git(['ls-remote', '--exit-code', 'origin', 'refs/heads/main']).trim().split('\n');
    if (lines.length !== 1) throw new Error('private main HEAD 조회 오류');
    const [sha, ref] = lines[0].split(/\s+/); assertSha(sha);
    if (ref !== 'refs/heads/main') throw new Error('private main ref 오류');
    return sha;
  }
  checkTree();
  return {
    startHead,
    async publish({ generatedDirectory, infraSha, runId, runAttempt, backend, verify }) {
      assertSha(infraSha); validateBackendImageInputs(backend);
      if (!/^[1-9]\d*$/.test(runId) || !/^[1-9]\d*$/.test(runAttempt)) throw new Error('게시 실행 식별자 오류');
      mkdirSync(path.join(directory, 'dev/generated'), { recursive: true });
      for (const name of GENERATED_FILES) {
        const source = path.join(generatedDirectory, name);
        if (!lstatSync(source).isFile() || lstatSync(source).isSymbolicLink()) throw new Error('생성 사본 파일 형식 오류');
        writeFileSync(path.join(directory, 'dev/generated', name), readFileSync(source), { mode: 0o600 });
      }
      writeFileSync(path.join(directory, 'dev/infra-commit.txt'), `${infraSha}\n`, { mode: 0o600 });
      git(['add', '--', ...ALLOWED]);
      const changed = git(['diff', '--cached', '--name-only', '-z']).split('\0').filter(Boolean);
      if (changed.some(name => !ALLOWED.includes(name))) throw new Error('사본 변경 파일 허용목록 오류');
      await verify();
      checkTree();
      if (remoteHead() !== startHead) throw new Error('private main HEAD 경쟁: 새 실행 필요');
      if (!changed.length) return { status: 'noop', commit: startHead };
      const title = `auto(dev): values 동기화 by infra@${infraSha.slice(0, 12)} (run ${runId}/${runAttempt})`;
      const message = `${title}\n\ninfra: ${infraSha}\nbackend: ${backend.sourceSha}\nbackend run: ${backend.runId}/${backend.runAttempt}\n`;
      git(['-c', 'user.name=pulsemetry-values[bot]', '-c', 'user.email=pulsemetry-values[bot]@users.noreply.github.com',
        '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', message]);
      const commit = git(['rev-parse', 'HEAD']).trim(); assertSha(commit);
      // 원격이 handshake 전에 되감긴 경우도 차단한다. 이후 경쟁은 Git receive-pack의 old SHA 비교가 막는다.
      // 저장소의 임의 hook은 계속 비활성화하고 이 프로세스가 만든 단일 검증 hook만 실행한다.
      const hooks = path.join(directory, '.git', 'values-sync-hooks'); mkdirSync(hooks, { mode: 0o700 });
      writeFileSync(path.join(hooks, 'pre-push'), `#!/usr/bin/env node\nconst fs = require('node:fs');\n` +
        `const rows = fs.readFileSync(0, 'utf8').trim().split('\\n').map(x => x.split(/\\s+/));\n` +
        `if (rows.length !== 1 || rows[0][1] !== ${JSON.stringify(commit)} || rows[0][2] !== 'refs/heads/main' || rows[0][3] !== ${JSON.stringify(startHead)}) process.exit(1);\n`, { mode: 0o700 });
      // force/rebase 없이 하나의 ref만 게시한다. 응답 유실은 원격의 정확한 commit 일치로만 복구한다.
      const pushed = git(['-c', `core.hooksPath=${hooks}`, 'push', '--porcelain', 'origin', 'HEAD:refs/heads/main'], directory, true);
      if (remoteHead() !== commit) throw new Error(pushed.status === 0 ? '게시 후 private HEAD 변경' : '사본 push 실패 또는 HEAD 경쟁');
      return { status: 'published', commit };
    },
  };
}

export async function syncGeneratedValues({ root, directory, env = process.env }) {
  const expected = pipeline.context(env);
  const pipelineRun = pipeline.createPipeline({ root, directory, env, validateImages: validateBackendImageInputs });
  const { plan, receipt } = pipelineRun.verifyPublication(expected);
  const github = githubClient(env.GH_TOKEN);
  const verifyEvidence = () => verifyPublicationEvidence({ receipt, receiptArtifactId: env.RECEIPT_ARTIFACT_ID, github });
  await verifyEvidence();
  pipelineRun.checkPublicationBaseline(expected, receipt);
  const targetGithub = githubClient(env.VALUES_GH_TOKEN);
  const repo = await targetGithub(`/repos/${TARGET}`);
  if (repo.full_name !== TARGET || repo.private !== true || repo.default_branch !== 'main') throw new Error('사본 private 저장소 경계 오류');
  const temporary = mkdtempSync(path.join(tmpdir(), 'dev-values-sync-'));
  let collected;
  try {
    const publisher = createValuesPublisher({ directory: path.join(temporary, 'copy'), token: env.VALUES_GH_TOKEN });
    collected = await collectGeneratedValuesInputs({ accountId: expected.account, runId: expected.runId, runAttempt: expected.runAttempt });
    const profile = profiles.readDeploymentProfile(path.join(root, 'config/dev/deployment.json'));
    const images = Object.fromEntries(Object.entries(plan.generatedValues.backend.images).map(([app, value]) =>
      [app, { ...value, repository: `${expected.account}.dkr.ecr.ap-northeast-2.amazonaws.com/soma-376/${app}` }]));
    const image = app => `${images[app].repository}@${images[app].digest}`;
    const values = generateValues(collected.outputs, { enrollment: image('enrollment-api'), ingest: image('telemetry-ingest'),
      gateway: image('telemetry-gateway'), dashboard: image('dashboard-api') },
    parseRuntimeValues(readFileSync(profile.runtimeValuesPath, 'utf8')), undefined, undefined, profile, JSON.stringify(collected.metadata));
    const generatedDirectory = path.join(temporary, 'generated'); mkdirSync(generatedDirectory);
    for (const [name, value] of Object.entries(values)) writeFileSync(path.join(generatedDirectory, name),
      '# CDK output 참조에서 생성했다. Secret 값을 넣지 않는다.\n' + dump(value, { noRefs: true, lineWidth: -1 }), { mode: 0o600 });
    await validateGeneratedValues({ root, directory: generatedDirectory, images, expectedValues: values });
    const result = await publisher.publish({ generatedDirectory, infraSha: expected.sourceSha, runId: expected.runId,
      runAttempt: expected.runAttempt, backend: plan.generatedValues.backend, verify: async () => {
        await verifyEvidence();
        pipelineRun.checkPublicationBaseline(expected, receipt);
        await collected.verifyMetadata();
      } });
    return { ...result, sourceSha: expected.sourceSha, runId: expected.runId,
      deploymentAttempt: receipt.runAttempt, publisherAttempt: expected.runAttempt };
  } finally {
    try { await collected?.close(); } finally { rmSync(temporary, { recursive: true, force: true }); }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [flag, directory, ...extra] = process.argv.slice(2);
  if (flag !== '--directory' || !directory || extra.length) { console.error('사용법: dev-generated-values-sync.mjs --directory <path>'); process.exitCode = 1; }
  else {
    let result = { status: 'failed' };
    try { result = await syncGeneratedValues({ root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), directory }); }
    catch { console.error('generated values 게시 실패: 원본 승인·배포 증거, 조회 권한과 private HEAD를 확인한다'); process.exitCode = 1; }
    finally {
      writeFileSync(path.join(directory, 'result-publish.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
      if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY,
        `\nGenerated values: **${result.status}**${result.commit ? ` (commit \`${result.commit}\`)` : ''}\n`, { flag: 'a' });
    }
  }
}
