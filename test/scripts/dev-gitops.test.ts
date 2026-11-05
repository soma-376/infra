import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(__dirname, '../..');

test('공통 CAS·원본 계약·관측·초기화의 실제 로컬 Git 회귀', () => {
  const directory = join(root, 'test/dev-gitops');
  const files = readdirSync(directory).filter(name => name.endsWith('.test.mjs')).map(name => join(directory, name));
  const result = spawnSync(process.execPath, ['--test', ...files], { cwd: root, encoding: 'utf8', timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
  expect(result.status).toBe(0);
}, 190_000);
