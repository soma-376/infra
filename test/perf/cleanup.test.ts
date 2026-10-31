import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

test('정리 드라이버의 소유권·기한·재진입·페이지/버전 삭제 회귀를 실행한다', () => {
  const result = spawnSync('python3', ['scripts/test-perf-cleanup.py'], { cwd: resolve(__dirname, '../..'), encoding: 'utf8' });
  expect([result.status, result.error?.message]).toEqual([0, undefined]);
  expect(result.stderr).toContain('OK');
});
