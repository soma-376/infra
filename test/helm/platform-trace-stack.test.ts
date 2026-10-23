import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const enabled = Boolean(process.env.HELM_BIN);
const suite = enabled ? describe : describe.skip;

suite('Loki·Tempo·플랫폼 Collector Helm wrapper (ADR-0039)', () => {
  test('렌더 리소스·고정 digest·PVC 보존·자원 예산·실패 입력을 검증한다', () => {
    const result = spawnSync(process.execPath, [resolve(__dirname, '../../scripts/observability-platform-trace-validate.mjs')], {
      encoding: 'utf8', env: process.env, timeout: 180_000,
    });
    expect(result.error).toBeUndefined();
    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
      status: 0, stdout: expect.stringContaining('자원 예산 통과'), stderr: '',
    });
  });
});
