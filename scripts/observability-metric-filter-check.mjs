#!/usr/bin/env node
// 실패 event 5종의 CloudWatch metric filter가 Fluent Bit envelope 샘플과 정확히 일치하는지 확인한다.
// 기본은 로컬 부분 문자열 대조이며 CloudWatch filter engine을 대신하지 않는다.
// 배포 전 --aws로 읽기 전용 TestMetricFilter를 실행해 실제 engine 결과를 새 증거 파일에 남긴다.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const usage = 'usage: observability-metric-filter-check.mjs [--samples FILE] [--aws --region REGION --output NEW_FILE]';
const args = process.argv.slice(2);
const options = { samples: resolve(root, 'helm/observability/tests/fluent-bit/metric-filter-samples.jsonl'), aws: false };
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--aws') options.aws = true;
  else if (['--samples', '--region', '--output'].includes(args[i]) && args[i + 1]) options[args[i].slice(2)] = args[++i];
  else throw new Error(usage);
}
if (options.aws && (!options.region || !options.output)) throw new Error(usage);
if (options.output && existsSync(options.output)) throw new Error('증거 파일을 덮어쓸 수 없다. 새 --output 경로를 사용한다.');

const raw = readFileSync(options.samples, 'utf8');
const samples = raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
const events = [...new Set(samples.map(sample => sample.expectedEvent).filter(Boolean))].sort();
assert.ok(samples.some(sample => !sample.expectedEvent), '어떤 filter와도 일치하면 안 되는 음성 샘플이 필요하다');
// AWS 응답은 eventMessage로 샘플에 대응시킨다. 같은 메시지가 둘이면 어느 샘플이 일치했는지 알 수 없다.
assert.equal(new Set(samples.map(sample => sample.message)).size, samples.length, '샘플 message는 서로 달라야 한다');

// CDK의 FilterPattern.literal(`"event=<code>"`)과 같은 문자열이다. 테스트가 합성 템플릿과 대조한다.
const pattern = event => `"event=${event}"`;
const expected = event => samples.flatMap((sample, index) => sample.expectedEvent === event ? [index + 1] : []);

function localMatches(event) {
  // 따옴표 term은 원문 key=value 부분 문자열과 일치한다고 가정한다. 실제 engine 확인은 --aws다.
  return samples.flatMap((sample, index) => sample.message.includes(`event=${event}`) ? [index + 1] : []);
}

// eventNumber가 0과 1 중 어디서 시작하는지는 문서 예시(0)뿐이고 실제 응답으로 확인하지 못했다. 번호 대신 eventMessage로
// 샘플을 찾고, 원본 eventNumber는 증거 파일에 남겨 첫 실행에서 기준을 확인한다.
function awsMatches(event) {
  const result = spawnSync('aws', ['logs', 'test-metric-filter', '--region', options.region, '--output', 'json',
    '--filter-pattern', pattern(event), '--log-event-messages', ...samples.map(sample => sample.message)],
  { encoding: 'utf8', timeout: 60_000 });
  assert.equal(result.status, 0, `aws logs test-metric-filter 실패: ${result.stderr || result.error}`);
  const matches = JSON.parse(result.stdout).matches;
  const matched = matches.map(match => {
    const index = samples.findIndex(sample => sample.message === match.eventMessage);
    assert.ok(index >= 0, `${pattern(event)}: 응답 eventMessage가 샘플에 없다 (eventNumber ${match.eventNumber})`);
    return index + 1;
  });
  return { matched: matched.sort((a, b) => a - b), eventNumbers: matches.map(match => match.eventNumber).sort((a, b) => a - b) };
}

const results = {};
for (const event of events) {
  const { matched, eventNumbers } = options.aws ? awsMatches(event) : { matched: localMatches(event) };
  assert.deepEqual(matched, expected(event), `${pattern(event)}: 일치 샘플 ${matched} ≠ 기대 ${expected(event)}`);
  results[event] = { pattern: pattern(event), matchedSamples: matched.map(number => samples[number - 1].name), ...(eventNumbers && { awsEventNumbers: eventNumbers }) };
}
const engine = options.aws ? 'CloudWatch TestMetricFilter' : 'local substring (CloudWatch engine 미실행)';
if (options.output) {
  const awsVersion = options.aws ? spawnSync('aws', ['--version'], { encoding: 'utf8' }).stdout.trim() : null;
  writeFileSync(options.output, JSON.stringify({
    status: 'PASS', engine, region: options.region ?? null, awsCliVersion: awsVersion, checkedAt: new Date().toISOString(),
    samples: options.samples, samplesSha256: createHash('sha256').update(raw).digest('hex'), results,
  }, null, 2) + '\n');
}
console.log(`PASS: ${events.length}개 실패 event filter, 샘플 ${samples.length}건 (${engine})`);
