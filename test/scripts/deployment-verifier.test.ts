import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

test('검증기는 실제 schema 변동·fresh offset·Pod UID·자격 누락을 보수적으로 판정한다', () => {
  const result = spawnSync('python3', ['-m', 'unittest', 'discover', '-v', '-p', 'test_*.py'], {
    cwd: resolve(__dirname, '../../scripts/deployment-verifier'), encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, timeout: 20_000,
  });
  expect(result.error).toBeUndefined();
  expect({ status: result.status, output: result.stderr }).toEqual({ status: 0, output: expect.stringContaining('OK') });
});
