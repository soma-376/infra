// 보호된 infra 수동 workflow의 진입점이다. 입력 저장소에서는 데이터 파일만 읽고 코드를 실행하지 않는다.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { resolve, join, dirname, isAbsolute, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SHA, assert, parse, json, sha256, validateOwner, validateState } from './contract.mjs';
import { GENERATED, validateCurrent } from './release.mjs';
import { configure } from './configure.mjs';
import { prepareConfigurationRuntime } from './config-runtime.mjs';
import { GitStore } from './git-store.mjs';
import { runtimeObservers } from './runtime.mjs';

const exec = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW = 'soma-376/infra/.github/workflows/dev-gitops-operations.yml@refs/heads/develop';
export const MODES = ['review-config', 'publish-config'];

export function operationIdentity(env) {
  assert(env.GITHUB_REPOSITORY === 'soma-376/infra' && env.GITHUB_REF === 'refs/heads/develop' &&
    env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.GITHUB_WORKFLOW_REF === WORKFLOW,
  '보호된 develop 수동 workflow만 허용한다');
  assert(SHA.test(env.GITHUB_SHA) && env.GITHUB_WORKFLOW_SHA === env.GITHUB_SHA, 'workflow와 실행 source SHA가 같아야 한다');
  const owner = { repository: env.GITHUB_REPOSITORY, workflowRef: env.GITHUB_WORKFLOW_REF,
    workflowRunId: env.GITHUB_RUN_ID, workflowRunAttempt: env.GITHUB_RUN_ATTEMPT };
  validateOwner(owner);
  assert(/^[1-9]\d*$/.test(owner.workflowRunId), '실제 workflow run이 필요하다');
  return owner;
}

async function fixedJson(directory, name) {
  const root = await realpath(directory), path = join(root, name), stat = await lstat(path);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size < 2 * 1024 * 1024, '입력 데이터 파일 경계 오류');
  const rel = relative(root, await realpath(path));
  assert(rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'), '입력 경로 오류');
  return parse(await readFile(path, 'utf8'), '운영 입력');
}

export async function main(args, env = process.env, deps = {}) {
  const [mode, inputDirectory, outputDirectory] = args;
  assert(args.length === 3 && MODES.includes(mode), '사용법: operations.mjs MODE INPUT_DIRECTORY NEW_OUTPUT_DIRECTORY');
  const owner = operationIdentity(env);
  const source = (await exec('git', ['-C', ROOT, 'rev-parse', 'HEAD'])).stdout.trim();
  assert(source === env.GITHUB_SHA, '검토된 workflow source checkout이 필요하다');
  const publish = mode === 'publish-config';
  assert(!publish || env.INFRA_GITOPS_ENABLED === 'true', 'infra GitOps 게시 스위치가 비활성이다');
  const output = resolve(outputDirectory);
  await mkdir(output, { mode: 0o700 });

  const store = await (deps.openStore ?? GitStore.open)({ env });
  let runtime, observer;
  try {
    const head = await store.refresh(), state = validateState(await store.state(head));
    assert(state.state === 'idle', '다른 배포·보류 중에는 설정 준비를 시작하지 않는다');
    validateCurrent(await store.files(head), state);
    const selectedFiles = await store.files(state.currentSelection.valuesCommit);
    runtime = await (deps.prepareRuntime ?? prepareConfigurationRuntime)({ root: ROOT, sourceCommit: source,
      accountId: env.AWS_ACCOUNT_ID, runId: owner.workflowRunId, runAttempt: owner.workflowRunAttempt,
      selectedFiles, selection: state.currentSelection, helm: env.HELM_BIN });
    const hashes = Object.fromEntries([...runtime.candidate].map(([path, text]) => [path, sha256(text)]));
    if (!publish) {
      for (const [path, text] of runtime.candidate) {
        const destination = join(output, path);
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        await writeFile(destination, text, { mode: 0o600, flag: 'wx' });
      }
      await writeFile(join(output, 'config-review.json'), json({ sourceCommit: source, expectedHead: head,
        bundleManifestSha256: state.currentSelection.bundleManifestSha256, hashes }), { mode: 0o600, flag: 'wx' });
      console.log('설정 후보 생성·재조회 검증 완료; Git 게시 없음');
      return 0;
    }
    const approved = await fixedJson(inputDirectory, 'config-review.json');
    assert(approved.sourceCommit === source && approved.expectedHead === head &&
      approved.bundleManifestSha256 === state.currentSelection.bundleManifestSha256 &&
      JSON.stringify(Object.entries(approved.hashes ?? {}).sort()) === JSON.stringify(Object.entries(hashes).sort()),
    '검토한 설정 후보·기준 HEAD가 달라졌다');
    const activation = parse(await store.read(head, 'dev/activation.json'), '자동화 수락');
    observer = await (deps.openObserver ?? runtimeObservers)(activation, { env, store });
    const result = await configure({ store, sourceCommit: source, candidate: runtime.candidate, owner,
      validateCandidate: runtime.validateCandidate, observe: observer.observe });
    console.log(JSON.stringify({ result: result.result }));
    return result.result === 'blocked' ? 2 : 0;
  } finally { await observer?.close(); await runtime?.close(); await store.close(); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(() => {
    console.error('infra GitOps 작업 실패: 원문·자격증명은 출력하지 않는다'); process.exitCode = 1;
  });
}
