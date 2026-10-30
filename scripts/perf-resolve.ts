#!/usr/bin/env -S node --import tsx
// environment.resolved.json 생산자. readiness smoke 증거와 실제 상태를 받아 한 번 만든다.
// request·provisional·resolved의 checkBundle 코드가 하나라도 있으면 쓰지 않는다. 기존 파일을 덮어쓰지 않는다. (ADR-0050)
import { resolve } from 'node:path';
import { parseOptions, readBytes, required, run, writeNew } from '../lib/perf/cli';
import { Schemas } from '../lib/perf/contract/schema-subset';
import { PERF_CONTRACT_SCHEMAS, PerfInputError, collectPerfOutputs, isObject, loadPerfRequest, parseInputJson, sha256 } from '../lib/perf/deploy-inputs';
import { parsePerfStrimziMetadata } from '../lib/perf/strimzi';
import { loadPerfProfile } from '../lib/perf/profile';
import { buildResolved, checkResolved, kubeItems, parseReadiness } from '../lib/perf/results';

const USAGE = 'npx tsx scripts/perf-resolve.ts --request <request.json> --provisional <provisional.json> --stacks <describe-stacks.json> [--stacks …] '
  + '--kubernetes <kubectl-get.json> [--kubernetes …] (--msk-nodes <list-nodes.json> | --strimzi-secrets <metadata.json>) --readiness <readiness.json> [--created-at <UTC>] --out <resolved.json>';

export function main(argv: readonly string[], now = () => new Date()): string {
  const options = parseOptions(argv, ['--request', '--provisional', '--stacks', '--kubernetes', '--msk-nodes', '--strimzi-secrets', '--readiness', '--created-at', '--out'],
    ['--stacks', '--kubernetes'], USAGE);
  const schemas = new Schemas(PERF_CONTRACT_SCHEMAS);
  const requestBytes = readBytes(required(options, '--request'));
  const { request, sha256: requestSha256 } = loadPerfRequest(schemas, requestBytes);
  const provisionalBytes = readBytes(required(options, '--provisional'));
  const provisional = parseInputJson(provisionalBytes, 'provisional');
  if (!isObject(provisional)) throw new PerfInputError('provisional: JSON object가 필요하다');
  const profile = loadPerfProfile((request.infra as { profile: string }).profile, resolve(__dirname, '..'));
  const resolved = buildResolved({
    request, requestSha256, provisional, provisionalSha256: sha256(provisionalBytes), profile,
    outputs: collectPerfOutputs((options['--stacks'] ?? []).map(path => parseInputJson(readBytes(path), path))),
    kubernetes: kubeItems((options['--kubernetes'] ?? []).map(path => parseInputJson(readBytes(path), path))),
    mskNodes: options['--msk-nodes'] ? parseInputJson(readBytes(required(options, '--msk-nodes')), 'msk-nodes') : undefined,
    strimziMetadata: options['--strimzi-secrets'] ? parsePerfStrimziMetadata(parseInputJson(readBytes(required(options, '--strimzi-secrets')), 'strimzi-secrets')) : undefined,
    readiness: parseReadiness(parseInputJson(readBytes(required(options, '--readiness')), 'readiness')),
    createdAt: options['--created-at']?.[0] ?? now().toISOString().replace(/\.[0-9]{3}Z$/, 'Z'),
  });
  const text = JSON.stringify(resolved, null, 2) + '\n';
  const codes = checkResolved(schemas, { request: requestBytes, provisional: provisionalBytes, resolved: Buffer.from(text) });
  if (codes.length) throw new PerfInputError(`resolved 검사 실패: ${codes.join(', ')}`);
  const out = required(options, '--out');
  writeNew(out, text);
  console.log(`${resolved.status}: ${out}`);
  if (resolved.status !== 'ready') {
    for (const error of resolved.errors as { code: string; message: string }[]) console.error(`${error.code}: ${error.message}`);
    process.exitCode = 3;
  }
  return String(resolved.status);
}

if (require.main === module) run(() => { main(process.argv.slice(2)); });
