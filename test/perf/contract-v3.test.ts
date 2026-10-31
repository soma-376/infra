import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { BundleBytes, checkBundle } from '../../lib/perf/contract/bundle';
import { ContractError, JsonValue, Schemas, jsonEqual } from '../../lib/perf/contract/schema-subset';

/**
 * telemetry-load-tests의 v3 계약 공유 사본(test/fixtures/perf-contract-v3)을 load-tests와 같은 결과로 검사한다.
 * 사본은 load-tests에서 `python3 tools/contract.py export-shared <이 디렉터리>`로만 갱신한다.
 */
const copy = resolve(__dirname, '../fixtures/perf-contract-v3');
const source = JSON.parse(readFileSync(join(copy, 'SOURCE.json'), 'utf8'));
interface SchemaCase { id: string; schema: string; file: string; shared: boolean; errors: [string, string][] }
interface BundleCase { id: string; dir: string; shared: boolean; codes: string[] }
const cases: { schema_cases: SchemaCase[]; bundle_cases: BundleCase[] } = JSON.parse(readFileSync(join(copy, 'fixtures/cases.json'), 'utf8'));
const schemas = new Schemas(join(copy, 'schemas'));

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

test('공유 사본은 출처 commit과 파일별 SHA-256이 SOURCE.json과 정확히 같다', () => {
  expect(source).toEqual(expect.objectContaining({
    schema_version: 3, kind: 'contract-source', repository: 'soma-376/telemetry-load-tests',
    commit: expect.stringMatching(/^[0-9a-f]{40}$/),
  }));
  const onDisk = walk(copy).map(path => relative(copy, path)).filter(path => path !== 'SOURCE.json').sort();
  expect(onDisk).toEqual(Object.keys(source.files).sort());
  for (const [path, digest] of Object.entries(source.files)) {
    expect([path, createHash('sha256').update(readFileSync(join(copy, path))).digest('hex')]).toEqual([path, digest]);
  }
});

test('공유 schema는 infra가 만들거나 읽는 다섯 개다', () => {
  expect(readdirSync(join(copy, 'schemas')).sort()).toEqual([
    'common.schema.json', 'environment-lock.schema.json', 'environment-provisional.schema.json',
    'environment-request.schema.json', 'environment-resolved.schema.json',
  ]);
});

describe('schema case가 load-tests 검사기와 같은 오류를 낸다', () => {
  test.each(cases.schema_cases.map(c => [c.id, c] as const))('%s', (_id, c) => {
    const document = JSON.parse(readFileSync(join(copy, 'fixtures', c.file), 'utf8')) as JsonValue;
    expect(schemas.validate(c.schema, document).map(e => [...e])).toEqual(c.errors);
  });
});

describe('bundle case가 load-tests 검사기와 같은 연결 코드를 낸다', () => {
  test.each(cases.bundle_cases.map(c => [c.id, c] as const))('%s', (_id, c) => {
    const files: BundleBytes = {};
    for (const name of ['request', 'provisional', 'resolved', 'lock'] as const) {
      const path = join(copy, 'fixtures', c.dir, `${name}.json`);
      if (existsSync(path)) files[name] = readFileSync(path);
    }
    expect(checkBundle(schemas, files)).toEqual(c.codes);
  });
});

test('공유 fixture는 schema마다 통과·실패 사례를 모두 갖는다', () => {
  for (const name of ['environment-request', 'environment-provisional', 'environment-resolved', 'environment-lock']) {
    const own = cases.schema_cases.filter(c => c.schema === name);
    expect([name, own.some(c => c.errors.length === 0), own.some(c => c.errors.length > 0)]).toEqual([name, true, true]);
  }
  expect(cases.bundle_cases.some(c => c.codes.length === 0)).toBe(true);
});
