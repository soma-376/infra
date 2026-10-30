#!/usr/bin/env -S node --import tsx
// deployment.provisional.json 생산자. 공유 v2 schema·연결 검사를 통과해야 쓰고 기존 파일을 덮어쓰지 않는다. (ADR-0050)
import { resolve } from 'node:path';
import { parseOptions, readBytes, required, run, writeNew } from '../lib/perf/cli';
import { Schemas } from '../lib/perf/contract/schema-subset';
import { PERF_CONTRACT_SCHEMAS, PerfInputError, collectPerfOutputs, loadPerfRequest, parseInputJson } from '../lib/perf/deploy-inputs';
import { loadPerfProfile } from '../lib/perf/profile';
import { buildProvisional, checkProvisional } from '../lib/perf/results';

const USAGE = 'npx tsx scripts/perf-provisional.ts --request <environment.request.json> --stacks <describe-stacks.json> [--stacks …] '
  + '--deployment-id <slug> [--created-at <UTC>] --out <deployment.provisional.json>';

export function main(argv: readonly string[], now = () => new Date()): string {
  const options = parseOptions(argv, ['--request', '--stacks', '--deployment-id', '--created-at', '--out'], ['--stacks'], USAGE);
  const schemas = new Schemas(PERF_CONTRACT_SCHEMAS);
  const { request, sha256 } = loadPerfRequest(schemas, readBytes(required(options, '--request')));
  const profile = loadPerfProfile((request.infra as { profile: string }).profile, resolve(__dirname, '..'));
  const outputs = collectPerfOutputs((options['--stacks'] ?? []).map(path => parseInputJson(readBytes(path), path)));
  const provisional = buildProvisional({
    request, requestSha256: sha256, profile, outputs, deploymentId: required(options, '--deployment-id'),
    createdAt: options['--created-at']?.[0] ?? now().toISOString().replace(/\.[0-9]{3}Z$/, 'Z'),
  });
  const codes = checkProvisional(schemas, request, sha256, provisional);
  if (codes.length) throw new PerfInputError(`provisional 검사 실패: ${codes.join(', ')}`);
  const out = required(options, '--out');
  writeNew(out, JSON.stringify(provisional, null, 2) + '\n');
  console.log(`${provisional.status}: ${out}`);
  return String(provisional.status);
}

if (require.main === module) run(() => { main(process.argv.slice(2)); });
