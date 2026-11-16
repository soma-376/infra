// Git 선택만 원자적으로 게시한다. rollout 잠금·상태·자동 복구는 만들지 않는다.
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, SHA, sha256 } from './contract.mjs';
import { SIMPLE_PATHS, desiredFiles, readSimpleRelease, validateApplications } from './simple-release.mjs';

export class PublicationConflict extends Error {}
export class SimpleGitStore {
  constructor(directory, { env = process.env, local = false } = {}) {
    this.directory = directory;
    this.env = { PATH: env.PATH, HOME: directory, LANG: 'C.UTF-8', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null',
      GIT_CONFIG_KEY_1: 'protocol.file.allow', GIT_CONFIG_VALUE_1: local ? 'always' : 'never',
      GIT_AUTHOR_NAME: 'Pulsemetry delivery', GIT_AUTHOR_EMAIL: 'delivery@soma-376.invalid',
      GIT_COMMITTER_NAME: 'Pulsemetry delivery', GIT_COMMITTER_EMAIL: 'delivery@soma-376.invalid' };
    if (env.VALUES_GH_TOKEN) Object.assign(this.env, { GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_2: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_2: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${env.VALUES_GH_TOKEN}`).toString('base64')}` });
  }
  git(args, input, extraEnv = {}) {
    return new Promise((resolve, reject) => {
      const child = execFile('git', args, { cwd: this.directory, env: { ...this.env, ...extraEnv }, encoding: 'utf8', timeout: 60_000,
        maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => error ? reject(new Error('Git 게시 작업 실패')) : resolve(stdout));
      child.stdin.end(input);
    });
  }
  static async open({ env = process.env, remote = 'https://github.com/soma-376/infra-generated-values.git', local = false } = {}) {
    assert(local || (env.VALUES_GH_TOKEN && remote === 'https://github.com/soma-376/infra-generated-values.git'), '전용 publisher 인증이 필요하다');
    const store = new SimpleGitStore(await mkdtemp(join(tmpdir(), 'simple-publication-')), { env, local });
    try { await store.git(['init', '--quiet']); await store.git(['remote','add','origin',remote]); await store.refresh(); return store; }
    catch (error) { await store.close(); throw error; }
  }
  async refresh() {
    await this.git(['fetch','--no-tags','origin','refs/heads/main:refs/remotes/origin/main']);
    const head = (await this.git(['rev-parse','refs/remotes/origin/main'])).trim();
    assert(SHA.test(head), 'private main HEAD 오류'); return head;
  }
  async files(revision) {
    assert(SHA.test(revision), 'Git revision 오류');
    const files = new Map();
    for (const line of (await this.git(['ls-tree','-r','-z',revision])).split('\0').filter(Boolean)) {
      const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(line);
      assert(match && (SIMPLE_PATHS.has(match[3]) || ['README.md','AGENTS.md'].includes(match[3])), 'private 파일 허용목록 오류');
      assert(match[1] === '100644', 'private 실행 파일 금지');
      const text = await this.git(['cat-file','blob',`${revision}:${match[3]}`]);
      assert(Buffer.byteLength(text) <= 2 * 1024 * 1024, 'private 파일 크기 오류'); files.set(match[3],text);
    }
    return files;
  }
  async commit(parent, changes, message) {
    assert(SHA.test(parent) && changes instanceof Map && changes.size > 0, '게시 commit 입력 오류');
    const env = { GIT_INDEX_FILE: join(this.directory, 'publication-index') };
    await this.git(['read-tree',parent], undefined, env);
    for (const [path, text] of changes) {
      assert(SIMPLE_PATHS.has(path) && typeof text === 'string', '게시 경로 오류');
      const blob = (await this.git(['hash-object','-w','--stdin'],text)).trim();
      await this.git(['update-index','--add','--cacheinfo',`100644,${blob},${path}`],undefined,env);
    }
    const tree = (await this.git(['write-tree'],undefined,env)).trim();
    return (await this.git(['commit-tree',tree,'-p',parent,'-m',message])).trim();
  }
  async push(expected, commit) {
    if (await this.refresh() !== expected) throw new PublicationConflict('게시 중 main HEAD 변경');
    // 정상 push의 advertised old SHA까지 검사해 원격 rewind도 덮어쓰지 않는다.
    const hooks=join(this.directory,'publication-hooks');
    await mkdir(hooks,{recursive:true,mode:0o700});
    await writeFile(join(hooks,'pre-push'),`#!/usr/bin/env node\nconst fs=require('node:fs');\nconst rows=fs.readFileSync(0,'utf8').trim().split('\\n').map(x=>x.split(/\\s+/));\nif(rows.length!==1||rows[0][1]!==${JSON.stringify(commit)}||rows[0][2]!=='refs/heads/main'||rows[0][3]!==${JSON.stringify(expected)})process.exit(1);\n`,{mode:0o700});
    try { await this.git(['-c',`core.hooksPath=${hooks}`,'push','--porcelain','origin',`${commit}:refs/heads/main`]); }
    catch {
      const head = await this.refresh();
      try { await this.git(['merge-base','--is-ancestor',commit,head]); return; }
      catch { if (head !== expected) throw new PublicationConflict('게시 경합'); throw new Error('Git 게시 실패'); }
    }
  }
  async close() { await rm(this.directory,{recursive:true,force:true}); }
}
export async function selectedRelease(store, head) {
  const currentFiles = await store.files(head), current = readSimpleRelease(currentFiles);
  const selectedFiles = await store.files(current.selection.valuesCommit), selected = readSimpleRelease(new Map([...selectedFiles,['dev/desired.yaml',currentFiles.get('dev/desired.yaml')]]));
  for (const path of ['dev/bundle.json','dev/producer.json','dev/infra-commit.txt',...current.generated.keys()]) {
    assert(currentFiles.get(path) === selectedFiles.get(path), '선택 V 밖의 snapshot 변경');
  }
  return { ...selected, applications: validateApplications(currentFiles,current.selection), files:currentFiles };
}
export async function publishPrepared({store,expectedHead,snapshot,applications,infraCommit,root,verify=async()=>{}}) {
  if (await store.refresh() !== expectedHead) throw new PublicationConflict('게시 HEAD 불일치');
  const files = await store.files(expectedHead);
  const B = sha256(snapshot.get('dev/bundle.json'));
  const rootText=root?(typeof root==='string'?root:`${JSON.stringify(root,null,2)}\n`):undefined;
  const same = [...snapshot].every(([path,text]) => files.get(path) === text);
  if (same && files.has('dev/desired.yaml')) {
    const current = readSimpleRelease(files);
    const desired = desiredFiles(applications,{...current.selection,infraCommit,bundleManifestSha256:B});
    if ([...desired].every(([path,text]) => files.get(path) === text) && (rootText===undefined || files.get('dev/root.yaml')===rootText)) {
      await verify();
      if(await store.refresh()!==expectedHead)throw new PublicationConflict('검토 중 main HEAD 변경');
      return {result:'noop',...current.selection};
    }
  }
  const V = await store.commit(expectedHead,snapshot,'[PROJ-334] chore: generated snapshot 갱신');
  const selection = {infraCommit,valuesCommit:V,bundleManifestSha256:B};
  const changes = desiredFiles(applications,selection);
  if (rootText!==undefined) changes.set('dev/root.yaml',rootText);
  const P = await store.commit(V,changes,'[PROJ-334] chore: Argo Application 참조 갱신');
  await verify(); await store.push(expectedHead,P);
  return {result:'published',...selection,desiredCommit:P};
}
export async function publishWithRetry({store,prepare,verify=async()=>{},attempts=3}) {
  for (let attempt=0;attempt<attempts;attempt++) {
    const head = await store.refresh(), current = await selectedRelease(store,head);
    const prepared = await prepare(current);
    try { return await publishPrepared({store,expectedHead:head,applications:current.applications,...prepared,verify:async()=>{await prepared.verify?.();await verify(current,prepared);}}); }
    catch(error) { if (!(error instanceof PublicationConflict) || attempt===attempts-1) throw error; }
    finally {await prepared.close?.();}
  }
}
