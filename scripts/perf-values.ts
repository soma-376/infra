#!/usr/bin/env -S node --import tsx
// perf Helm values 생성기. AWS·Secret을 읽지 않고 운영자가 저장한 output·조회 JSON만 쓴다. (ADR-0050)
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { dump } from 'js-yaml';
import { parseOptions, readBytes, required, run } from '../lib/perf/cli';
import { Schemas } from '../lib/perf/contract/schema-subset';
import {
  PERF_CONTRACT_SCHEMAS, collectPerfOutputs, loadPerfRequest, parseInputJson, parseInputYaml, parsePerfMskBootstrap, parsePerfMskNodes,
  parsePerfRuntimeInput,
} from '../lib/perf/deploy-inputs';
import { parsePerfStrimziMetadata } from '../lib/perf/strimzi';
import { loadPerfProfile } from '../lib/perf/profile';
import { GENERATED_HEADER, generatePerfFoundationValues, generatePerfValues } from '../lib/perf/values';

const USAGE = 'npx tsx scripts/perf-values.ts --request <environment.request.json> --outputs <cdk-outputs.json|describe-stacks.json> [--outputs …] '
  + '[--phase foundation | --phase full --runtime-values <perf-runtime.yaml> (--msk-bootstrap <get-bootstrap-brokers.json> --msk-nodes <list-nodes.json> | --strimzi-secrets <metadata.json>)] --output-dir <dir>';

export function main(argv: readonly string[]): string[] {
  const options = parseOptions(argv, ['--request', '--outputs', '--runtime-values', '--msk-bootstrap', '--msk-nodes', '--strimzi-secrets', '--output-dir', '--phase'], ['--outputs'], USAGE);
  const phase = options['--phase']?.[0] ?? 'full';
  if (!['full', 'foundation'].includes(phase)) throw new Error('--phase는 full 또는 foundation이다');
  const root = resolve(__dirname, '..');
  const schemas = new Schemas(PERF_CONTRACT_SCHEMAS);
  const { request } = loadPerfRequest(schemas, readBytes(required(options, '--request')));
  const infra = request.infra as { profile: string };
  const profile = loadPerfProfile(infra.profile, root);
  const outputs = collectPerfOutputs((options['--outputs'] ?? []).map(path => parseInputJson(readBytes(path), path)));
  if (!outputs.values.EksClusterName) throw new Error('--outputs가 필요하다');
  let values: Record<string, Record<string, unknown>>;
  if (phase === 'foundation') {
    if (['--runtime-values', '--msk-bootstrap', '--msk-nodes', '--strimzi-secrets'].some(key => options[key])) {
      throw new Error('foundation 단계에는 runtime·broker·Secret metadata를 공급하지 않는다');
    }
    values = generatePerfFoundationValues({ outputs, profile, request });
  } else {
    const bootstrapServers = options['--msk-bootstrap'] ? parsePerfMskBootstrap(parseInputJson(readBytes(required(options, '--msk-bootstrap')), 'msk-bootstrap')) : undefined;
    const mskBrokers = options['--msk-nodes'] ? parsePerfMskNodes(parseInputJson(readBytes(required(options, '--msk-nodes')), 'msk-nodes'), bootstrapServers ?? '') : undefined;
    const strimziMetadata = options['--strimzi-secrets'] ? parsePerfStrimziMetadata(parseInputJson(readBytes(required(options, '--strimzi-secrets')), 'strimzi-secrets')) : undefined;
    const runtime = parsePerfRuntimeInput(parseInputYaml(readBytes(required(options, '--runtime-values')).toString('utf8'), 'runtime-values'));
    values = generatePerfValues({ outputs, profile, request, runtime, bootstrapServers, mskBrokers, strimziMetadata });
  }
  const directory = resolve(required(options, '--output-dir'));
  if (phase === 'foundation' && existsSync(directory) && readdirSync(directory).length !== 0) {
    throw new Error('foundation 출력은 빈 디렉터리만 사용한다. 이전 앱 values와 섞지 않는다');
  }
  mkdirSync(directory, { recursive: true });
  for (const [name, value] of Object.entries(values)) {
    writeFileSync(resolve(directory, name), GENERATED_HEADER + dump(value, { noRefs: true, lineWidth: -1 }), { mode: 0o600 });
  }
  console.log(`${Object.keys(values).length}개 perf values 파일 생성: ${directory}`);
  return Object.keys(values);
}

if (require.main === module) run(() => { main(process.argv.slice(2)); });
