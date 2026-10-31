#!/usr/bin/env -S node --import tsx
// perf 환경 삭제 뒤 잔존 자원 확인. 조회 결과 JSON만 읽고 AWS를 호출하지 않는다. 잔존이 있으면 종료 코드 3이다. (PLAN §10)
import { parseOptions, readBytes, required, run } from '../lib/perf/cli';
import { parseInputJson, PerfInputError } from '../lib/perf/deploy-inputs';
import { residualReport } from '../lib/perf/inventory';

const USAGE = 'npx tsx scripts/perf-inventory.ts --environment-id <perf-…> --tagged <get-resources.json> [--stacks <describe-stacks.json> …]';

export function main(argv: readonly string[]): boolean {
  const options = parseOptions(argv, ['--environment-id', '--tagged', '--stacks', '--cleanup-mode'], ['--stacks'], USAGE);
  const mode = options['--cleanup-mode']?.[0] ?? 'legacy';
  if (!['legacy', 'owned-24h'].includes(mode)) throw new PerfInputError('--cleanup-mode는 legacy 또는 owned-24h다');
  const report = residualReport(required(options, '--environment-id'),
    parseInputJson(readBytes(required(options, '--tagged')), 'tagged'),
    (options['--stacks'] ?? []).map(path => parseInputJson(readBytes(path), path)), mode === 'owned-24h');
  console.log(JSON.stringify(report, null, 2));
  if (!report.complete) process.exitCode = 3;
  return report.complete;
}

if (require.main === module) run(() => { main(process.argv.slice(2)); });
