#!/usr/bin/env -S node --import tsx
// 관측 원본을 읽는 로컬 실행 gate다. AWS 조회·요청 전송·삭제를 수행하지 않는다.
import { resolve } from 'node:path';
import { checkPerfExecution, loadPerfBudget, PerfExecutionObservation } from '../lib/perf/budget';
import { loadPerfProfile } from '../lib/perf/profile';
import { parseInputJson, PerfInputError } from '../lib/perf/deploy-inputs';
import { parseOptions, readBytes, required, run } from '../lib/perf/cli';

export function main(argv: readonly string[]): void {
  const options = parseOptions(argv, ['--environment-id', '--observation']);
  const root = resolve(__dirname, '..');
  const profile = loadPerfProfile('profiles/perf/strimzi-fixed-v1.json', root);
  const budget = loadPerfBudget(root, profile, 1);
  const observation = parseInputJson(readBytes(required(options, '--observation')), 'execution observation') as unknown as PerfExecutionObservation;
  try { checkPerfExecution(budget, required(options, '--environment-id'), observation); }
  catch (error) { throw new PerfInputError(error instanceof Error ? error.message : 'perf 실행 gate 실패'); }
  console.log(JSON.stringify({ status: 'PASS', environment_id: observation.environment_id, policy_sha256: budget.sha256, source_sha256: observation.source_sha256, actual_billing_verified: false }));
}
if (require.main === module) run(() => main(process.argv.slice(2)));
