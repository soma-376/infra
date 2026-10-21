#!/usr/bin/env node
// 공식 배포 archive 바이트를 검증한다. Helm dependency update로 고정값을 바꾸지 않는다.
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(await readFile(resolve(root, 'helm/observability/dependencies.lock.json'), 'utf8'));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--archive')) throw new Error('usage: observability-prepare.mjs [--archive FILE]');
let archive;
if (args.length) archive = await readFile(resolve(args[1]));
else {
  const response = await fetch(lock.chart.url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`chart download HTTP ${response.status}`);
  archive = Buffer.from(await response.arrayBuffer());
}
const digest = createHash('sha256').update(archive).digest('hex');
if (digest !== lock.chart.sha256) throw new Error(`chart checksum mismatch: ${digest}`);
const destination = resolve(root, 'helm/observability/pulsemetry-observability/charts', `${lock.chart.name}-${lock.chart.version}.tgz`);
await mkdir(dirname(destination), { recursive: true });
await writeFile(destination, archive);
console.log(`고정 chart ${lock.chart.version} SHA-256 검증 완료`);
