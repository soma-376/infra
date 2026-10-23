#!/usr/bin/env node
// 공식 배포 archive 바이트를 검증한다. Helm dependency update로 고정값을 바꾸지 않는다.
// lock의 `chart`(관측 차트의 kube-prometheus-stack)와 `charts`(Loki·Tempo·플랫폼 Collector wrapper, ADR-0039)를 모두 준비한다.
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(await readFile(resolve(root, 'helm/observability/dependencies.lock.json'), 'utf8'));
const targets = [
  { ...lock.chart, wrapper: 'pulsemetry-observability' },
  ...Object.entries(lock.charts ?? {}).map(([wrapper, chart]) => ({ ...chart, wrapper })),
];

// 네트워크 없는 검증은 `--archive FILE`을 반복해 공급한다. 어느 chart인지는 SHA256으로 고른다.
const args = process.argv.slice(2);
if (args.length % 2 !== 0 || args.some((arg, i) => i % 2 === 0 && arg !== '--archive')) {
  throw new Error('usage: observability-prepare.mjs [--archive FILE]...');
}
const supplied = new Map();
for (let i = 1; i < args.length; i += 2) {
  const bytes = await readFile(resolve(args[i]));
  supplied.set(createHash('sha256').update(bytes).digest('hex'), bytes);
}
for (const digest of supplied.keys()) {
  if (!targets.some(target => target.sha256 === digest)) throw new Error(`lock에 없는 archive다: ${digest}`);
}

for (const target of targets) {
  let archive = supplied.get(target.sha256);
  if (!archive) {
    if (supplied.size) continue;
    const response = await fetch(target.url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`${target.name} chart download HTTP ${response.status}`);
    archive = Buffer.from(await response.arrayBuffer());
  }
  const digest = createHash('sha256').update(archive).digest('hex');
  if (digest !== target.sha256) throw new Error(`${target.name} chart checksum mismatch: ${digest}`);
  const destination = resolve(root, 'helm/observability', target.wrapper, 'charts', `${target.name}-${target.version}.tgz`);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, archive);
  console.log(`고정 chart ${target.name} ${target.version} SHA-256 검증 완료 (${target.wrapper})`);
}
