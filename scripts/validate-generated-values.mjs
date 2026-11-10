import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { load, loadAll, JSON_SCHEMA } from 'js-yaml';

export const GENERATED_FILES = Object.freeze([
  'base.yaml', 'lbc.yaml', 'runtime.yaml', 'enrollment-api.yaml', 'telemetry-ingest.yaml',
  'telemetry-gateway.yaml', 'telemetry-kafka-admin.yaml', 'dashboard-api.yaml', 'clickhouse.yaml',
  'fluent-bit.yaml', 'ascp.yaml', 'observability.yaml', 'kafka-strimzi.yaml',
]);
const APPS = ['enrollment-api', 'telemetry-ingest', 'telemetry-gateway', 'dashboard-api'];
const HASH = /^[a-f0-9]{64}$/;
const fail = message => { throw new Error(`generated values 검증: ${message}`); };
const hash = data => createHash('sha256').update(data).digest('hex');
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, expected) => record(value) && isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort());

function regularFile(path, label, maxBytes = 1024 * 1024) {
  let stat;
  try { stat = lstatSync(path); } catch { fail(`${label} 파일 누락`); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !stat.size || stat.size > maxBytes) {
    fail(`${label} 일반 파일·크기 조건 오류`);
  }
  return readFileSync(path);
}

// 값·파서 예외·Helm 출력에는 private endpoint가 포함될 수 있으므로 오류에도 원문을 넣지 않는다.
export function inspectGeneratedValues({ directory, images, expectedValues }) {
  let stat;
  try { stat = lstatSync(directory); } catch { fail('생성 디렉터리 누락'); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('생성 디렉터리는 실제 디렉터리여야 한다');
  if (!isDeepStrictEqual(readdirSync(directory).sort(), [...GENERATED_FILES].sort())) fail('정확한 YAML 13개만 허용한다');
  if (!exactKeys(expectedValues, GENERATED_FILES)) fail('생성기 원본 13개가 필요하다');
  if (!exactKeys(images, APPS)) fail('정확한 앱 이미지 4개가 필요하다');
  const accounts = new Set();
  for (const app of APPS) {
    const image = images[app];
    if (!exactKeys(image, ['repository', 'digest', 'platform'])) fail(`${app} 이미지 필드 오류`);
    const repository = new RegExp(`^([0-9]{12})\\.dkr\\.ecr\\.ap-northeast-2\\.amazonaws\\.com/soma-376/${app}$`).exec(image.repository ?? '');
    if (!repository || !/^sha256:[a-f0-9]{64}$/.test(image.digest ?? '') || image.platform !== 'linux/arm64') {
      fail(`${app} 고정 ECR·digest·ARM64 오류`);
    }
    accounts.add(repository[1]);
  }
  if (accounts.size !== 1) fail('이미지 계정이 서로 다르다');
  const values = {};
  const hashes = {};
  for (const file of GENERATED_FILES) {
    const data = regularFile(join(directory, file), file);
    let value;
    try { value = load(data.toString('utf8'), { schema: JSON_SCHEMA }); } catch { fail(`${file} 단일 YAML 문서 형식 오류`); }
    if (!record(value) || !isDeepStrictEqual(value, expectedValues[file])) fail(`${file} 생성기 원본과 다르다`);
    values[file] = value;
    hashes[file] = hash(data);
  }
  for (const app of APPS) {
    const { repository, digest } = images[app];
    if (!isDeepStrictEqual(values[`${app}.yaml`].image, { repository, digest })) fail(`${app} 승인 이미지와 다르다`);
  }
  return { values, hashes };
}

function checkedHelm(helm, args, root, label) {
  const result = spawnSync(helm, args, {
    cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, HELM_DEBUG: 'false' },
  });
  if (result.error || result.status !== 0) fail(`${label} Helm 실행 실패`);
  return result.stdout;
}

function checkedArchive(path, sha256, label) {
  if (!HASH.test(sha256 ?? '') || hash(regularFile(path, label, 64 * 1024 * 1024)) !== sha256) fail(`${label} chart SHA256 불일치`);
  return path;
}

async function pinnedArchive(pin, cache, label) {
  let url;
  try { url = new URL(pin.url); } catch { fail(`${label} chart URL 오류`); }
  if (url.protocol !== 'https:' || url.username || url.password || !HASH.test(pin.sha256 ?? '')) fail(`${label} chart pin 오류`);
  const file = basename(url.pathname);
  if (!/^[a-z0-9][a-z0-9.-]+\.tgz$/.test(file)) fail(`${label} chart 파일명 오류`);
  const destination = join(cache, file);
  if (!existsSync(destination)) {
    let response;
    try { response = await fetch(url, { signal: AbortSignal.timeout(60_000) }); } catch { fail(`${label} chart 다운로드 실패`); }
    if (!response.ok) fail(`${label} chart 다운로드 실패`);
    const declaredSize = Number(response.headers.get('content-length') ?? 0);
    if (declaredSize > 64 * 1024 * 1024) fail(`${label} chart 크기 오류`);
    let data;
    try { data = Buffer.from(await response.arrayBuffer()); } catch { fail(`${label} chart 다운로드 실패`); }
    if (data.length > 64 * 1024 * 1024 || hash(data) !== pin.sha256) fail(`${label} chart SHA256 불일치`);
    writeFileSync(destination, data, { mode: 0o600, flag: 'wx' });
  }
  return checkedArchive(destination, pin.sha256, label);
}

function readJson(path, label) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { fail(`${label} pin 형식 오류`); }
}

export async function prepareGeneratedValuesCharts({ root, temporary, chartsDirectory }) {
  const cache = chartsDirectory ? resolve(chartsDirectory) : join(temporary, 'archives');
  mkdirSync(cache, { recursive: true, mode: 0o700 });
  if (lstatSync(cache).isSymbolicLink()) fail('chart cache는 실제 디렉터리여야 한다');
  const versions = readJson(join(root, 'helm/dev/runtime/versions.json'), 'runtime');
  const lock = readJson(join(root, 'helm/observability/dependencies.lock.json'), '관측');
  const ascp = await pinnedArchive(versions.ascp, cache, 'ascp');
  const fluentBit = await pinnedArchive(versions.fluentBit, cache, 'fluent-bit');
  const monitoring = await pinnedArchive(lock.chart, cache, 'observability');
  const lbcRoot = join(root, 'helm/dev/platform/lbc');
  const pins = readFileSync(join(lbcRoot, 'SHA256SUMS'), 'utf8').split('\n')
    .map(line => /^([a-f0-9]{64})  (vendor\/[a-z0-9.-]+\.tgz)$/.exec(line)).filter(Boolean);
  if (pins.length !== 1) fail('LBC vendor pin 하나가 필요하다');
  const lbc = checkedArchive(join(lbcRoot, pins[0][2]), pins[0][1], 'lbc');

  // 의존성은 임시 wrapper에만 공급한다. source checkout·lock은 Helm이 수정하지 않는다.
  const observability = join(temporary, 'observability');
  const source = join(root, 'helm/observability/pulsemetry-observability');
  cpSync(source, observability, { recursive: true, filter: path => path !== join(source, 'charts') });
  const manifest = load(readFileSync(join(observability, 'Chart.yaml'), 'utf8'), { schema: JSON_SCHEMA });
  if (manifest.dependencies?.length !== 1 || manifest.dependencies[0].name !== lock.chart.name ||
      manifest.dependencies[0].version !== lock.chart.version) fail('관측 dependency와 lock 불일치');
  mkdirSync(join(observability, 'charts'), { mode: 0o700 });
  cpSync(monitoring, join(observability, 'charts', basename(monitoring)));
  return { ascp, fluentBit, lbc, observability };
}

function renderTargets(root, directory, charts) {
  const local = path => join(root, path);
  const generated = file => join(directory, file);
  return [
    ['base.yaml', 'pulsemetry-dev-platform', local('helm/dev/platform/base'), 'kube-system', []],
    ['lbc.yaml', 'aws-load-balancer-controller', charts.lbc, 'kube-system', [local('helm/dev/platform/lbc/values.yaml')]],
    ['runtime.yaml', 'runtime-config', local('helm/dev/runtime/chart'), 'pulsemetry-dev', []],
    ...APPS.map(app => [`${app}.yaml`, app, local('helm/dev/workloads/spring-app'), 'pulsemetry-dev', [local(`helm/dev/workloads/${app}.yaml`)]]),
    ['telemetry-kafka-admin.yaml', 'telemetry-kafka-admin', local('helm/dev/workloads/telemetry-kafka-admin'), 'pulsemetry-dev', []],
    ['clickhouse.yaml', 'clickhouse', local('helm/dev/workloads/clickhouse'), 'pulsemetry-dev', []],
    ['fluent-bit.yaml', 'fluent-bit', charts.fluentBit, 'pulsemetry-dev-logs', [local('helm/dev/runtime/fluent-bit-values.yaml'), local('helm/dev/runtime/fluent-bit-loki-values.yaml')]],
    ['ascp.yaml', 'secrets-provider-aws', charts.ascp, 'kube-system', [local('helm/dev/runtime/ascp-values.yaml')]],
    ['observability.yaml', 'observability', charts.observability, 'pulsemetry-observability', []],
    ['kafka-strimzi.yaml', 'telemetry-kafka', local('helm/dev/kafka'), 'pulsemetry-dev', []],
  ].map(([file, release, chart, namespace, staticValues]) => ({
    file, release, chart, args: ['template', release, chart, '--namespace', namespace, '--kube-version', '1.36.0',
      ...[...staticValues, generated(file)].flatMap(path => ['--values', path])],
  }));
}

export async function validateGeneratedValues({ root, directory, images, expectedValues, helm = process.env.HELM_BIN ?? 'helm', chartsDirectory }) {
  const { hashes } = inspectGeneratedValues({ directory, images, expectedValues });
  const version = checkedHelm(helm, ['version', '--template', '{{.Version}}'], root, '버전');
  if (!/^v3\.22\.0(?:\+[^\s]+)?\s*$/.test(version)) fail('Helm 3.22.0이 필요하다');
  const temporary = mkdtempSync(join(tmpdir(), 'generated-values-validation-'));
  try {
    const charts = await prepareGeneratedValuesCharts({ root, temporary, chartsDirectory });
    const rendered = [];
    for (const target of renderTargets(root, directory, charts)) {
      const output = checkedHelm(helm, target.args, root, target.file);
      let resources;
      try { resources = loadAll(output, { schema: JSON_SCHEMA }).filter(Boolean); } catch { fail(`${target.file} Helm YAML 형식 오류`); }
      if (!resources.length || resources.some(item => !record(item) || !item.kind || !item.metadata?.name)) fail(`${target.file} Helm 리소스 누락`);
      if (APPS.some(app => `${app}.yaml` === target.file)) {
        const deployment = resources.filter(item => item.kind === 'Deployment' && item.metadata.name === target.release);
        const pod = deployment[0]?.spec?.template?.spec;
        const expected = `${images[target.release].repository}@${images[target.release].digest}`;
        if (deployment.length !== 1 || !pod?.containers?.length ||
            [...pod.containers, ...(pod.initContainers ?? [])].some(container => container.image !== expected) ||
            pod.nodeSelector?.['kubernetes.io/arch'] !== 'arm64') fail(`${target.file} 렌더 이미지·ARM64 불일치`);
      }
      if (target.file === 'telemetry-kafka-admin.yaml' && resources.some(item => item.kind === 'Job')) fail('사본은 Kafka 수동 Job 실행을 요청하지 않는다');
      rendered.push({ file: target.file, resources: resources.length });
    }
    const after = inspectGeneratedValues({ directory, images, expectedValues });
    if (!isDeepStrictEqual(hashes, after.hashes)) fail('렌더 중 생성 파일이 변경됐다');
    return { files: [...GENERATED_FILES], hashes, rendered };
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
