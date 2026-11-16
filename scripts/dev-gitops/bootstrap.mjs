// 이미 수동 인계한 Application을 같은 코드·이미지로 root에 연결한다. 클러스터에는 쓰지 않는다.
import { mkdir, lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { isDeepStrictEqual, promisify } from 'node:util';
import { dirname, join, posix, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CATALOG, INFRA_REPOSITORY, VALUES_REPOSITORY } from '../dev-argocd-applications.mjs';
import { SHA, assert, json, parse, sha256, validateManifest } from './contract.mjs';
import { GENERATED } from './release.mjs';
import { makeSnapshot, validateGenerated } from './simple-release.mjs';
import { publishPrepared, SimpleGitStore } from './publication.mjs';
import { verifySourceBundle } from './source-proof.mjs';

const ownKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).every(key => keys.includes(key));
const stringMap = value => value === undefined || ownKeys(value, Object.keys(value)) && Object.values(value).every(item => typeof item === 'string');
const equal = isDeepStrictEqual;
const releaseName = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/;
const CURRENT_FIELDS = ['apiVersion', 'kind', 'metadata', 'spec'];
const exec = promisify(execFile);

export function bootstrapRoot() {
  return { apiVersion: 'argoproj.io/v1alpha1', kind: 'Application',
    metadata: { name: 'pulsemetry-dev-root', namespace: 'argocd' },
    spec: { project: 'pulsemetry-dev-root',
      source: { repoURL: VALUES_REPOSITORY, targetRevision: 'main', path: 'dev/applications', directory: { recurse: false } },
      destination: { server: 'https://kubernetes.default.svc', namespace: 'argocd' },
      syncPolicy: { automated: { enabled: true, selfHeal: true, prune: false, allowEmpty: false },
        retry: { limit: 0 }, syncOptions: ['FailOnSharedResource=true'] } } };
}

function currentApplication(value, entry) {
  assert(ownKeys(value, CURRENT_FIELDS) && value.apiVersion === 'argoproj.io/v1alpha1' && value.kind === 'Application', '현재 Application 선언만 입력한다');
  assert(ownKeys(value.metadata, ['name', 'namespace', 'annotations', 'labels']) &&
    value.metadata.name === entry.name && value.metadata.namespace === 'argocd' &&
    stringMap(value.metadata.annotations) && stringMap(value.metadata.labels), 'Application metadata 경계 오류');
  const app = structuredClone(value), spec = app.spec;
  assert(spec && spec.project === entry.project &&
    equal(spec.destination, { server: 'https://kubernetes.default.svc', namespace: entry.namespace }) &&
    spec.source === undefined && Array.isArray(spec.sources) && spec.sources.length === (entry.generatedFile ? 2 : 1), '현재 Application 대상·source 경계 오류');
  const source = spec.sources[0];
  assert(source.repoURL === INFRA_REPOSITORY && source.path === entry.chart && SHA.test(source.targetRevision), '현재 infra source 경계 오류');
  let name;
  if (entry.renderer === 'strimzi-cmp') {
    assert(source.helm === undefined && source.plugin?.name === 'pulsemetry-strimzi-v1' &&
      source.plugin.env?.length === 1 && source.plugin.env[0].name === 'RELEASE_NAME', '현재 Strimzi CMP 경계 오류');
    name = source.plugin.env[0].value;
  } else {
    assert(source.plugin === undefined && source.helm, '현재 Helm source 경계 오류');
    name = source.helm.releaseName;
    const expected = [...entry.staticValues.map(file => posix.relative(entry.chart, file)),
      ...(entry.generatedFile ? [`$values/dev/generated/${entry.generatedFile}`] : [])];
    assert(equal(source.helm.valueFiles, expected) && source.helm.ignoreMissingValueFiles === false, '현재 values 파일 순서가 catalog와 다르다');
  }
  assert(typeof name === 'string' && name.length <= 53 && releaseName.test(name) &&
    (entry.id !== 'cert-manager' || name === 'cert-manager'), '현재 releaseName 오류');
  if (entry.generatedFile) {
    const values = spec.sources[1];
    assert(ownKeys(values, ['repoURL', 'targetRevision', 'ref']) && values.repoURL === VALUES_REPOSITORY &&
      values.ref === 'values' && SHA.test(values.targetRevision), '현재 values source 경계 오류');
  }
  assert(spec.syncPolicy && !spec.syncPolicy.automated?.prune && !spec.syncPolicy.automated?.allowEmpty &&
    !spec.syncPolicy.syncOptions?.some(option => /^(Force|Replace|ApplyOutOfSyncOnly)=true$/.test(option)), '현재 동기화 정책 경계 오류');
  app.metadata.annotations ??= {};
  delete app.metadata.annotations['argocd.argoproj.io/skip-reconcile'];
  delete app.metadata.annotations['pulsemetry.io/handoff-status'];
  app.spec.syncPolicy.automated = { enabled: true, selfHeal: true, prune: false, allowEmpty: false };
  app.spec.syncPolicy.retry = { limit: 0 };
  return { app, release: `${entry.namespace}/${name}` };
}

export function prepareBootstrap(input, candidateBytes, producer, generated) {
  assert(ownKeys(input, ['schemaVersion', 'expectedHead', 'applications']) && input.schemaVersion === 1 &&
    SHA.test(input.expectedHead) && Array.isArray(input.applications) && input.applications.length === CATALOG.applications.length,
  '초기 연결에는 예상 HEAD와 현재 Application 18개가 필요하다');
  const bundle = validateManifest(candidateBytes, producer);
  validateGenerated(generated, bundle);
  const byName = new Map(input.applications.map(app => [app.metadata?.name, app]));
  assert(byName.size === CATALOG.applications.length, 'Application 이름 중복');
  const applications = new Map(), revisions = new Set(), releases = new Set(), sourceRevisions = new Map();
  for (const entry of CATALOG.applications) {
    const { app, release } = currentApplication(byName.get(entry.name), entry);
    assert(!releases.has(release), 'namespace/release가 중복된다');
    releases.add(release); revisions.add(app.spec.sources[0].targetRevision);
    applications.set(`dev/applications/${entry.id}.yaml`, json(app));
    if (entry.generatedFile) sourceRevisions.set(`dev/generated/${entry.generatedFile}`, app.spec.sources[1].targetRevision);
  }
  const kafka = CATALOG.applications.find(entry => entry.id === 'kafka');
  sourceRevisions.set('dev/generated/telemetry-kafka-admin.yaml', sourceRevisions.get(`dev/generated/${kafka.generatedFile}`));
  assert(revisions.size === 1, '초기 연결은 현재 공통 infra SHA를 보존한다');
  const infraCommit = [...revisions][0];
  return { expectedHead: input.expectedHead, infraCommit, bundle, producer,
    applications, sourceRevisions, generated, snapshot: makeSnapshot(generated, candidateBytes, producer, infraCommit), root: bootstrapRoot() };
}

export async function verifyBootstrapSources(prepared, readBlob) {
  for (const [path, revision] of prepared.sourceRevisions) {
    assert(SHA.test(revision) && await readBlob(revision, path) === prepared.generated.get(path),
      '현재 Application이 참조한 generated 바이트와 다르다');
  }
}

async function sourceReader(directory) {
  const root = resolve(directory);
  const git = async args => (await exec('git', ['-C', root, ...args], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' },
  })).stdout;
  const origin = (await git(['remote', 'get-url', 'origin'])).trim();
  assert([VALUES_REPOSITORY, VALUES_REPOSITORY.replace(/\.git$/, '')].includes(origin), '원본 private values checkout이 필요하다');
  return (revision, path) => git(['cat-file', 'blob', `${revision}:${path}`]);
}

export async function publishBootstrap({ prepared, store, verify }) {
  assert(await store.refresh() === prepared.expectedHead, '초기 연결 예상 private HEAD가 변경됐다');
  const existing = await store.files(prepared.expectedHead);
  assert(![...existing.keys()].some(path => ['dev/desired.yaml', 'dev/delivery-state.json', 'dev/activation.json', 'dev/root.yaml'].includes(path) ||
    path.startsWith('dev/applications/') || path.startsWith('dev/evidence/')), '기존 배포 선언은 초기 연결로 덮어쓰지 않는다');
  return publishPrepared({ store, expectedHead: prepared.expectedHead, snapshot: prepared.snapshot,
    applications: prepared.applications, infraCommit: prepared.infraCommit, root: prepared.root, verify });
}

async function readPlainFile(path) {
  const stat = await lstat(path);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 4 * 1024 * 1024, '일반 입력 파일만 허용한다');
  return readFile(path, 'utf8');
}

async function writeFiles(directory, files) {
  for (const [path, content] of files) {
    const destination = join(directory, path);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, content, { mode: 0o600, flag: 'wx' });
  }
}

export async function main(args, env = process.env, dependencies = {}) {
  assert([12, 13].includes(args.length) && args[0] === '--input' && args[2] === '--candidate' &&
    args[4] === '--provenance' && args[6] === '--generated-dir' && args[8] === '--values-repository' && args[10] === '--output-dir' &&
    (args.length === 12 || args[12] === '--publish'),
  '사용법: bootstrap.mjs --input JSON --candidate JSON --provenance JSON --generated-dir DIR --values-repository DIR --output-dir NEW_DIR [--publish]');
  const input = parse(await readPlainFile(args[1]), '현재 Application 입력');
  const candidate = await readPlainFile(args[3]);
  const producer = parse(await readPlainFile(args[5]), '원본 생산 증거');
  const generatedDirectory = resolve(args[7]), stat = await lstat(generatedDirectory);
  assert(stat.isDirectory() && !stat.isSymbolicLink() && equal((await readdir(generatedDirectory)).sort(), [...GENERATED].sort()), '정확한 generated 파일 13개가 필요하다');
  const generated = new Map(await Promise.all(GENERATED.map(async name => [`dev/generated/${name}`, await readPlainFile(join(generatedDirectory, name))])));
  const prepared = prepareBootstrap(input, candidate, producer, generated);
  const readBlob = dependencies.readBlob ?? await sourceReader(args[9]);
  await verifyBootstrapSources(prepared, readBlob);
  const output = resolve(args[11]);
  await mkdir(output, { mode: 0o700 });
  await writeFiles(join(output, 'snapshot'), prepared.snapshot);
  await writeFiles(join(output, 'templates'), prepared.applications);
  await writeFile(join(output, 'root.yaml'), json(prepared.root), { mode: 0o600, flag: 'wx' });
  const review = { schemaVersion: 1, mode: 'review', expectedHead: prepared.expectedHead,
    infraCommit: prepared.infraCommit, bundleManifestSha256: prepared.bundle.B, applicationCount: prepared.applications.size,
    generatedHashes: Object.fromEntries([...generated].map(([name, bytes]) => [name, sha256(bytes)])),
    valuesCommit: null, desiredCommit: null,
    note: 'templates는 현재 참조를 보존한 검토 입력이며 그대로 적용하지 않는다. 게시 결과가 최종 참조를 정한다.' };
  await writeFile(join(output, 'bootstrap-review.json'), json(review), { mode: 0o600, flag: 'wx' });
  if (args.length === 12) { console.log('root 초기 연결 검토 자료를 생성했다. Git 게시·클러스터 적용 없음.'); return 0; }
  assert(env.BOOTSTRAP_ENABLED === 'true', '초기 연결 게시를 명시적으로 활성화해야 한다');
  const verify = async () => {
    await verifyBootstrapSources(prepared, readBlob);
    return (dependencies.verifySource ?? verifySourceBundle)(prepared.bundle, producer, { env, requireLatest: false });
  };
  await verify();
  const store = await (dependencies.openStore ?? SimpleGitStore.open)({ env });
  try {
    const result = await publishBootstrap({ prepared, store, verify });
    await writeFiles(join(output, 'published'), await store.files(result.desiredCommit));
    await writeFile(join(output, 'bootstrap-result.json'), json({ ...result, clusterApplied: false }), { mode: 0o600, flag: 'wx' });
    console.log('초기 Git 선언 게시 완료. root는 기존 EKS 운영자 경로에서 별도로 적용한다.');
    return 0;
  } finally { await store.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(() => {
    console.error('초기 root 연결 준비·게시 실패. 원본 입력과 private HEAD를 확인한다.'); process.exitCode = 1;
  });
}
