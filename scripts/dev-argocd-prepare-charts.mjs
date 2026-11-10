#!/usr/bin/env node
// Argo의 Git checkout만으로 렌더하도록 원본 archive와 풀어 둔 chart를 대조한다.
// --check는 네트워크·쓰기 없이 검사한다. 갱신은 검토한 lock과 --write --archive 입력으로만 한다.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8'));

export function chartTargets(root = defaultRoot) {
  const lbc = json(join(root, 'helm/dev/platform/lbc/SOURCE.json')).chart;
  const runtime = json(join(root, 'helm/dev/runtime/versions.json'));
  const monitoring = json(join(root, 'helm/observability/dependencies.lock.json'));
  return [
    { ...lbc, archive: `helm/dev/platform/lbc/vendor/${lbc.name}-${lbc.version}.tgz`, expanded: 'helm/dev/platform/lbc/chart' },
    ...Object.entries({ csiDriver: 'secrets-store-csi-driver', ascp: 'secrets-store-csi-driver-provider-aws', fluentBit: 'fluent-bit' }).map(([key, name]) => ({
      ...runtime[key], name, archive: `helm/dev/runtime/vendor/${name}-${runtime[key].version}.tgz`, expanded: `helm/dev/runtime/vendor/${name}-${runtime[key].version}`,
    })),
    ...[{ ...monitoring.chart, wrapper: 'pulsemetry-observability' }, ...Object.entries(monitoring.charts).map(([wrapper, chart]) => ({ ...chart, wrapper }))]
      .map(chart => ({ ...chart, archive: `helm/observability/${chart.wrapper}/charts/${chart.name}-${chart.version}.tgz` })),
  ];
}

function command(args) {
  const result = spawnSync('tar', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`tar 실패: ${result.stderr.trim()}`);
  return result.stdout;
}

function files(directory, prefix = '') {
  const found = new Map();
  for (const name of readdirSync(directory).sort()) {
    const relative = prefix ? `${prefix}/${name}` : name;
    const path = join(directory, name), stat = lstatSync(path);
    if (stat.isDirectory()) for (const entry of files(path, relative)) found.set(...entry);
    else if (stat.isFile()) found.set(relative, digest(readFileSync(path)));
    else throw new Error(`일반 파일·디렉터리 외의 chart 항목: ${relative}`);
  }
  return found;
}

export function prepareCharts({ root = defaultRoot, write = false, supplied = [] } = {}) {
  const targets = chartTargets(root), sources = new Map(supplied.map(path => { const bytes = readFileSync(path); return [digest(bytes), bytes]; }));
  for (const sha of sources.keys()) if (!targets.some(target => target.sha256 === sha)) throw new Error('lock에 없는 공급 archive');
  for (const target of targets) {
    const archivePath = join(root, target.archive);
    const bytes = sources.get(target.sha256) ?? (existsSync(archivePath) ? readFileSync(archivePath) : null);
    if (!bytes) throw new Error(`고정 archive가 없다: ${target.archive}`);
    if (digest(bytes) !== target.sha256) throw new Error(`chart checksum 불일치: ${target.archive}`);
    if (write) { mkdirSync(dirname(archivePath), { recursive: true }); writeFileSync(archivePath, bytes); }
    if (!target.expanded) continue;
    const temp = mkdtempSync(join(tmpdir(), 'argocd-chart-'));
    try {
      const source = join(temp, 'source.tgz'); writeFileSync(source, bytes);
      const entries = command(['-tzf', source]).trim().split('\n');
      if (!entries.length || entries.some(entry => !entry.startsWith(`${target.name}/`) || entry.split('/').includes('..'))) throw new Error(`chart archive 경로 오류: ${target.name}`);
      command(['-xzf', source, '-C', temp]);
      const original = join(temp, target.name), destination = join(root, target.expanded);
      // checksum으로 고정한 원본에 링크나 특수 파일이 생겨도 게시하지 않는다.
      const expected = files(original);
      if (write) { rmSync(destination, { recursive: true, force: true }); mkdirSync(dirname(destination), { recursive: true }); cpSync(original, destination, { recursive: true }); }
      if (!existsSync(destination)) throw new Error(`풀어 둔 chart가 없다: ${target.expanded}`);
      if (JSON.stringify([...files(destination)]) !== JSON.stringify([...expected])) throw new Error(`원본과 풀어 둔 chart 불일치: ${target.expanded}`);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  }
  return targets.map(({ archive, expanded, sha256 }) => ({ archive, ...(expanded ? { expanded } : {}), sha256 }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), supplied = []; let write = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--write') write = true;
      else if (args[i] === '--check') { /* 기본 동작 */ }
      else if (args[i] === '--archive' && args[i + 1]) supplied.push(resolve(args[++i]));
      else throw new Error('usage: dev-argocd-prepare-charts.mjs [--check | --write] [--archive FILE]...');
    }
    if (!write && supplied.length) throw new Error('--archive는 --write와 함께 사용한다');
    const checked = prepareCharts({ write, supplied });
    console.log(`Argo 고정 chart ${checked.length}개 검증 완료`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
