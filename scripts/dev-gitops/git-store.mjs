// 공통 CAS는 main의 일반 fast-forward만 사용한다. lease·force·시간 기반 탈취는 없다.
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SHA, assert, parse, json } from './contract.mjs';
import { GENERATED } from './release.mjs';
import { CATALOG } from '../dev-argocd-applications.mjs';

const REPOSITORY = 'https://github.com/soma-376/infra-generated-values.git';
const exactPaths = new Set([...GENERATED.map(name => `dev/generated/${name}`), ...CATALOG.applications.map(entry => `dev/applications/${entry.id}.yaml`),
  ...['bundle.json', 'infra-commit.txt', 'desired.yaml', 'delivery-state.json', 'activation.json', 'root.yaml'].map(name => `dev/${name}`)]);
const allowedPath = { test: path => exactPaths.has(path) || /^dev\/evidence\/[a-f0-9]{32}\.json$/.test(path) };
export class GitStore {
  constructor(directory, { env = process.env } = {}) {
    this.directory = directory;
    // 사용자 gitconfig의 외부 credential helper·hook·url rewrite는 게시기에 공급하지 않는다.
    this.env = { PATH: env.PATH, HOME: directory, LANG: 'C.UTF-8', GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null',
      GIT_CONFIG_KEY_1: 'protocol.file.allow', GIT_CONFIG_VALUE_1: 'never',
      GIT_AUTHOR_NAME: 'Pulsemetry delivery', GIT_AUTHOR_EMAIL: 'delivery@soma-376.invalid',
      GIT_COMMITTER_NAME: 'Pulsemetry delivery', GIT_COMMITTER_EMAIL: 'delivery@soma-376.invalid' };
    if (env.VALUES_GH_TOKEN) {
      this.env.GIT_CONFIG_COUNT = '3';
      this.env.GIT_CONFIG_KEY_2 = 'http.https://github.com/.extraheader';
      this.env.GIT_CONFIG_VALUE_2 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${env.VALUES_GH_TOKEN}`).toString('base64')}`;
    }
  }
  git(args, input, extraEnv = {}) {
    return new Promise((resolve, reject) => {
      const child = execFile('git', args, { cwd: this.directory, env: { ...this.env, ...extraEnv }, encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024, timeout: 60_000 }, (error, stdout) => {
        if (error) reject(new Error('Git 작업 실패: 인증값과 원문은 출력하지 않는다'));
        else resolve(stdout.trimEnd());
      });
      if (input !== undefined) child.stdin.end(input); else child.stdin.end();
    });
  }
  static async open({ env = process.env } = {}) {
    assert(env.VALUES_GH_TOKEN, '전용 private publisher 인증이 필요하다');
    const directory = await mkdtemp(join(tmpdir(), 'pulsemetry-delivery-'));
    const store = new GitStore(directory, { env });
    try {
      await store.git(['init', '--quiet']);
      await store.git(['remote', 'add', 'origin', REPOSITORY]);
      await store.refresh();
      return store;
    } catch (error) { await store.close(); throw error; }
  }
  async refresh() {
    await this.git(['fetch', '--no-tags', 'origin', 'refs/heads/main:refs/remotes/origin/main']);
    const head = await this.git(['rev-parse', 'refs/remotes/origin/main']);
    assert(SHA.test(head), 'private HEAD 조회 오류');
    assert(await this.git(['rev-parse', '--is-shallow-repository']) === 'false', '실패 이력은 전체 Git 이력이 필요하다');
    return head;
  }
  async read(revision, path) {
    assert(SHA.test(revision) && allowedPath.test(path), 'Git 읽기 경로 오류');
    // git()의 trimEnd가 manifest 원본 B를 바꾸지 않도록 blob은 별도로 읽는다.
    return new Promise((resolve, reject) => {
      execFile('git', ['cat-file', 'blob', `${revision}:${path}`], { cwd: this.directory, env: this.env, encoding: 'utf8',
        timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => error ? reject(new Error('Git 입력 파일을 읽을 수 없다')) : resolve(stdout));
    });
  }
  async files(revision) {
    assert(SHA.test(revision), 'Git revision 오류');
    const listing = await this.git(['ls-tree', '-r', '-z', revision, '--', 'dev/']);
    const files = new Map();
    for (const line of listing.split('\0').filter(Boolean)) {
      const match = /^(\d+) blob ([a-f0-9]{40})\t(.+)$/.exec(line);
      assert(match && match[1] === '100644' && allowedPath.test(match[3]), 'private dev 파일 허용목록 또는 mode 위반');
      files.set(match[3], await this.read(revision, match[3]));
    }
    return files;
  }
  async state(revision) { return parse(await this.read(revision, 'dev/delivery-state.json'), '공통 상태'); }
  async failures(revision) {
    assert(SHA.test(revision), '실패 이력 revision 오류');
    const commits = (await this.git(['log', '--format=%H', revision, '--', 'dev/delivery-state.json'])).split('\n').filter(Boolean);
    const records = new Map();
    for (const commit of commits) {
      const state = await this.state(commit);
      for (const record of [...(state.failedReleases ?? []), ...(state.failedRelease ? [state.failedRelease] : [])]) {
        const key = `${record.bundleManifestSha256}/${record.imageVectorSha256}`, previous = records.get(key);
        if (!previous || Date.parse(record.failureRecordedAt) > Date.parse(previous.failureRecordedAt)) records.set(key, record);
      }
    }
    return [...records.values()];
  }
  async cas(expected, changes, message) {
    assert(SHA.test(expected) && changes instanceof Map && changes.size > 0, 'CAS 입력 오류');
    assert(await this.refresh() === expected, 'CAS 경쟁: 예상 main HEAD가 바뀌었다');
    const index = join(this.directory, 'delivery-index');
    const env = { GIT_INDEX_FILE: index };
    await this.git(['read-tree', expected], undefined, env);
    for (const [path, content] of changes) {
      assert(allowedPath.test(path) && typeof content === 'string', '게시 경로 또는 내용 오류');
      const blob = await this.git(['hash-object', '-w', '--stdin'], content);
      await this.git(['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], undefined, env);
    }
    const tree = await this.git(['write-tree'], undefined, env);
    const commit = await this.git(['commit-tree', tree, '-p', expected, '-m', message]);
    assert(SHA.test(commit), '게시 commit 생성 오류');
    try { await this.git(['push', '--porcelain', 'origin', `${commit}:refs/heads/main`]); }
    catch {
      // 성공 응답이 유실돼도 동일 commit이 remote 이력에 있으면 중복 게시하지 않는다.
      const actual = await this.refresh();
      try { await this.git(['merge-base', '--is-ancestor', commit, actual]); }
      catch { throw new Error('CAS 게시 실패 또는 응답 불명: 소유권 재확인이 필요하다'); }
    }
    return commit;
  }
  async writeState(expected, state, message) { return this.cas(expected, new Map([['dev/delivery-state.json', json(state)]]), message); }
  async close() { await rm(this.directory, { recursive: true, force: true }); }
}
