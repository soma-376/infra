// 고정된 infra checkout의 생성기와 읽기 전용 입력 수집기를 연결한다. 원문·자격증명은 출력하지 않는다.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dump } from 'js-yaml';
import { APPS, SHA, assert, validateManifest } from './contract.mjs';
import { GENERATED, yaml } from './release.mjs';

const PROFILE = 'config/dev/deployment.json';
const PREFIX = '# CDK output 참조에서 생성했다. Secret 값을 넣지 않는다.\n';
const fail = () => new Error('설정 실행 입력·고정 source·생성 결과 검증 실패');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const inside = (root, path) => { const part = relative(root, path); return part && !isAbsolute(part) && part !== '..' && !part.startsWith('../'); };

function gitCommand(root, args) {
  return new Promise((accept, reject) => execFile('git', ['-C', root, ...args], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' },
  }, (error, stdout) => error ? reject(fail()) : accept(stdout)));
}

/** status의 assume-unchanged 표시와 무관하게 tracked blob의 실제 바이트도 고정 SHA와 대조한다. */
async function sourceGuard(root, sourceCommit, git) {
  assert((await git(root, ['rev-parse', '--show-toplevel'])).trim() === root, '전용 source checkout root가 필요하다');
  assert((await git(root, ['rev-parse', 'HEAD'])).trim() === sourceCommit, '설정 source HEAD 불일치');
  assert((await git(root, ['status', '--porcelain=v1', '--untracked-files=all'])).trim() === '', '설정 source checkout이 clean해야 한다');
  const tracked = new Set();
  const tree = await git(root, ['ls-tree', '-r', '-z', sourceCommit]);
  for (const entry of tree.split('\0').filter(Boolean)) {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(entry);
    assert(match && inside(root, resolve(root, match[3])), 'source tree 일반 파일 경계 오류');
    const path = join(root, match[3]);
    const stat = await lstat(path);
    assert(stat.isFile() && !stat.isSymbolicLink() && inside(root, await realpath(path)), 'source 파일 경계 오류');
    const bytes = await readFile(path);
    const hash = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    assert(hash === match[2], '고정 source blob 불일치');
    tracked.add(match[3]);
  }
  assert(tracked.has(PROFILE), '추적된 dev 배포 profile이 필요하다');
  return tracked;
}

async function sourceTools(root) {
  const [collector, generator, validation, profiles] = await Promise.all([
    import(pathToFileURL(join(root, 'scripts/dev-generated-values-inputs.mjs')).href),
    import(pathToFileURL(join(root, 'scripts/eks-values.mjs')).href),
    import(pathToFileURL(join(root, 'scripts/validate-generated-values.mjs')).href),
    import(pathToFileURL(join(root, 'lib/dev/deployment-profile.cjs')).href),
  ]);
  return { collectInputs: collector.collectGeneratedValuesInputs, generate: generator.generateValues,
    parseRuntime: generator.parseRuntimeValues, readProfile: profiles.default.readDeploymentProfile,
    validateValues: validation.validateGeneratedValues };
}

/** 실제 AWS 호출은 collectInputs adapter에만 있다. 테스트는 adapter를 주입하며 live 호출을 하지 않는다. */
export async function prepareConfigurationRuntime({ root: inputRoot, sourceCommit, accountId, runId, runAttempt,
  selectedFiles, selection, helm, chartsDirectory }, dependencies = {}) {
  let collected, temporary, closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try { await collected?.close(); } finally { if (temporary) await rm(temporary, { recursive: true, force: true }); }
  };
  try {
    assert(SHA.test(sourceCommit) && /^[0-9]{12}$/.test(accountId ?? ''), '설정 source·계정 오류');
    assert(/^[1-9][0-9]{0,19}$/.test(String(runId ?? '')) && /^[1-9][0-9]{0,5}$/.test(String(runAttempt ?? '')), '설정 실행 식별자 오류');
    const root = await realpath(resolve(inputRoot));
    const git = dependencies.git ?? gitCommand;
    const tracked = await sourceGuard(root, sourceCommit, git);
    const tools = { ...(await (dependencies.loadSourceTools ?? sourceTools)(root)), ...dependencies };
    const profile = tools.readProfile(join(root, PROFILE));
    assert(inside(root, profile.runtimeValuesPath) && tracked.has(relative(root, profile.runtimeValuesPath)), 'runtime은 같은 source의 추적 파일이어야 한다');
    const runtime = tools.parseRuntime(await readFile(profile.runtimeValuesPath, 'utf8'));
    const bundle = validateManifest(selectedFiles.get('dev/bundle.json'));
    assert(bundle.B === selection.bundleManifestSha256, '선택 V/B 불일치');
    const images = Object.fromEntries(APPS.map(app => {
      const image = yaml(selectedFiles.get(`dev/generated/${app}.yaml`)).image;
      assert(image?.repository === `${accountId}.dkr.ecr.ap-northeast-2.amazonaws.com/soma-376/${app}` &&
        image.digest === bundle.manifest.images[app].digest, '현재 선택 V의 이미지 불일치');
      return [app, { repository: image.repository, digest: image.digest, platform: 'linux/arm64' }];
    }));
    const inputImages = Object.fromEntries(Object.entries({ enrollment: 'enrollment-api', ingest: 'telemetry-ingest',
      gateway: 'telemetry-gateway', dashboard: 'dashboard-api' }).map(([key, app]) => [key, `${images[app].repository}@${images[app].digest}`]));
    const collect = () => tools.collectInputs({ accountId, runId, runAttempt });
    const generate = input => tools.generate(input.outputs, inputImages, runtime, undefined, undefined, profile, JSON.stringify(input.metadata));
    collected = await collect();
    const baselineInputs = canonical({ outputs: collected.outputs, metadata: collected.metadata });
    const values = generate(collected);
    assert(Object.keys(values).sort().join(',') === [...GENERATED].sort().join(','), 'generated 파일 집합 오류');
    temporary = await mkdtemp(join(tmpdir(), 'config-runtime-'));
    const candidate = new Map();
    for (const name of GENERATED) {
      const text = PREFIX + dump(values[name], { noRefs: true, lineWidth: -1 });
      candidate.set(`dev/generated/${name}`, text);
      await writeFile(join(temporary, name), text, { mode: 0o600, flag: 'wx' });
    }
    const hashes = Object.fromEntries([...candidate].map(([path, text]) => [path, digest(text)]));
    const selected = canonical(selection);
    const validateCandidate = async ({ sourceCommit: expectedSource, candidate: proposed, currentSelection, bundleManifest }) => {
      let fresh;
      try {
        assert(!closed && expectedSource === sourceCommit && canonical(currentSelection) === selected && bundleManifest === bundle.bytes, '설정 검증 source·선택 변경');
        assert(proposed instanceof Map && proposed.size === GENERATED.length && [...candidate].every(([path, text]) => proposed.get(path) === text), '설정 후보 바이트 변경');
        await sourceGuard(root, sourceCommit, git);
        await collected.verifyMetadata();
        fresh = await collect();
        assert(canonical({ outputs: fresh.outputs, metadata: fresh.metadata }) === baselineInputs, '설정 입력 재조회 불일치');
        const regenerated = generate(fresh);
        assert(canonical(regenerated) === canonical(values), '설정 재생성 불일치');
        const verified = await tools.validateValues({ root, directory: temporary, images, expectedValues: regenerated, helm, chartsDirectory });
        for (const name of GENERATED) {
          const path = `dev/generated/${name}`;
          assert(digest(await readFile(join(temporary, name))) === hashes[path] && verified.hashes[name] === hashes[path], '설정 검증 파일 hash 불일치');
        }
        await fresh.verifyMetadata();
        await collected.verifyMetadata();
        await sourceGuard(root, sourceCommit, git);
      } catch { throw fail(); }
      finally {
        try { await fresh?.close(); } catch { throw fail(); }
      }
    };
    await validateCandidate({ sourceCommit, candidate: new Map(candidate), currentSelection: selection, bundleManifest: bundle.bytes });
    return { candidate: new Map(candidate), validateCandidate, close };
  } catch {
    try { await close(); } catch { /* 정리 실패에도 원문을 노출하지 않는다. */ }
    throw fail();
  }
}
