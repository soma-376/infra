// 검토 결과는 새 private branch에만 보관한다. 배포 main과 CAS 상태는 변경하지 않는다.
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GitStore } from './git-store.mjs';
import { assert, json, parse, sha256, SHA } from './contract.mjs';
import { GENERATED } from './release.mjs';
import { operationIdentity } from './operations.mjs';

export async function preserveReview(directory, env = process.env, { openStore = GitStore.open } = {}) {
  const owner = operationIdentity(env);
  const root = await realpath(resolve(directory));
  const read = async path => {
    const absolute = join(root, path), stat = await lstat(absolute), actual = await realpath(absolute);
    const rel = relative(root, actual);
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size < 2 * 1024 * 1024 &&
      rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'), '검토 파일 경계 오류');
    return readFile(absolute, 'utf8');
  };
  const review = parse(await read('config-review.json'), '설정 검토');
  assert(review.sourceCommit === env.GITHUB_SHA && SHA.test(review.expectedHead), '검토 source/HEAD 불일치');
  const branch = `review/infra-config-${owner.workflowRunId}-${owner.workflowRunAttempt}`;
  const store = await openStore({ env });
  try {
    assert(await store.refresh() === review.expectedHead, '검토 중 main HEAD가 달라졌다');
    assert((await store.git(['ls-remote', 'origin', `refs/heads/${branch}`])) === '', '이미 존재하는 검토 branch는 덮어쓰지 않는다');
    const content = new Map([['dev/operations/config-review.json', json(review)]]);
    const names = await readdir(join(root, 'dev/generated'));
    assert(names.sort().join(',') === [...GENERATED].sort().join(','), '검토 파일 집합 오류');
    for (const name of GENERATED) {
      const path = `dev/generated/${name}`, text = await read(path);
      assert(sha256(text) === review.hashes[path], '검토 파일 hash 불일치');
      content.set(`dev/operations/generated/${name}`, text);
    }
    await store.git(['checkout', '--detach', review.expectedHead]);
    for (const [path, text] of content) {
      await mkdir(dirname(join(store.directory, path)), { recursive: true, mode: 0o700 });
      await writeFile(join(store.directory, path), text, { mode: 0o600 });
    }
    await store.git(['add', '--', ...content.keys()]);
    await store.git(['commit', '-m', '[PROJ-311] preserve private configuration review']);
    const commit = await store.git(['rev-parse', 'HEAD']);
    // 빈 이전 ref를 요구하므로 같은 이름의 검토 branch를 덮어쓰지 않는다.
    await store.git(['push', '--porcelain', `--force-with-lease=refs/heads/${branch}:`, 'origin', `${commit}:refs/heads/${branch}`]);
    console.log(`Private configuration review: ${branch} @ ${commit}`);
    return { branch, commit };
  } finally { await store.close(); }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  assert(process.argv.length === 3, '검토 디렉터리 하나가 필요하다');
  preserveReview(process.argv[2]).catch(() => { console.error('private 검토 보관 실패'); process.exitCode = 1; });
}
