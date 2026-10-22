import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(__dirname, '../..');
const script = resolve(root, 'scripts/observability-metric-filter-check.mjs');
const samplesFile = resolve(root, 'helm/observability/tests/fluent-bit/metric-filter-samples.jsonl');
const dir = mkdtempSync(join(tmpdir(), 'metric-filter-check-'));
let runs = 0;

// 실제 AWS 대신 PATH의 가짜 aws가 TestMetricFilter 응답 형식을 돌려준다. 따옴표 term의 부분 문자열 일치만 흉내 낸다.
writeFileSync(join(dir, 'fake-aws.js'), `
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('aws-cli/fake'); process.exit(0); }
const term = args[args.indexOf('--filter-pattern') + 1].replace(/^"|"$/g, '');
const messages = args.slice(args.indexOf('--log-event-messages') + 1);
const base = Number(process.env.FAKE_AWS_BASE ?? 0);
const all = messages.map((message, index) => ({ eventNumber: index + base, eventMessage: message, extractedValues: {} }));
let matches = all.filter(match => match.eventMessage.includes(term));
if (process.env.FAKE_AWS_MODE === 'all') matches = all;
if (process.env.FAKE_AWS_MODE === 'unknown') matches = matches.map(match => ({ ...match, eventMessage: match.eventMessage + ' ' }));
console.log(JSON.stringify({ matches }));
`);
writeFileSync(join(dir, 'aws'), `#!/bin/sh\nexec "${process.execPath}" "${join(dir, 'fake-aws.js')}" "$@"\n`);
chmodSync(join(dir, 'aws'), 0o755);

function run(env: Record<string, string>, extra: string[] = []) {
  const output = join(dir, `result-${runs++}.json`);
  const result = spawnSync(process.execPath, [script, '--aws', '--region', 'ap-northeast-2', '--output', output, ...extra], {
    encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ...env },
  });
  return { ...result, output };
}

afterAll(() => rmSync(dir, { recursive: true, force: true }));

test.each([0, 1])('AWS eventNumber가 %i부터 세도 eventMessage로 샘플을 찾아 통과하고 원본 번호를 남긴다', base => {
  const result = run({ FAKE_AWS_BASE: String(base) });
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
  expect(result.stdout).toContain('PASS: 5개 실패 event filter');
  const evidence = JSON.parse(readFileSync(result.output, 'utf8'));
  expect(evidence.engine).toBe('CloudWatch TestMetricFilter');
  // commit-failed는 다섯째 샘플이다.
  expect(evidence.results.telemetry_commit_failed).toEqual({
    pattern: '"event=telemetry_commit_failed"', matchedSamples: ['commit-failed'], awsEventNumbers: [4 + base],
  });
  expect(evidence.results.telemetry_gateway_rejected.matchedSamples).toEqual(['gateway-rejected', 'gateway-rejected-split']);
});

test('음성 샘플까지 일치하면 실패한다', () => {
  const result = run({ FAKE_AWS_MODE: 'all' });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('일치 샘플');
});

test('응답 eventMessage가 샘플과 다르면 번호로 짐작하지 않고 실패한다', () => {
  const result = run({ FAKE_AWS_MODE: 'unknown' });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('응답 eventMessage가 샘플에 없다');
});

test('같은 message 샘플이 둘이면 실패한다', () => {
  const lines = readFileSync(samplesFile, 'utf8').split('\n').filter(Boolean);
  const duplicated = join(dir, 'duplicated.jsonl');
  writeFileSync(duplicated, [...lines, JSON.stringify({ ...JSON.parse(lines[0]), name: 'duplicate' })].join('\n') + '\n');
  const result = run({}, ['--samples', duplicated]);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('샘플 message는 서로 달라야 한다');
});
