import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const enabled = Boolean(process.env.HELM_BIN && process.env.PROMTOOL_BIN);
const suite = enabled ? describe : describe.skip;

suite('관측 Helm 스택', () => {
  test('실제 렌더와 PromQL·누락·보존·private 노출 경계를 검증한다', () => {
    const result = spawnSync(process.execPath, [resolve(__dirname, '../../scripts/observability-validate.mjs')], {
      encoding: 'utf8', env: process.env, timeout: 120_000,
    });
    expect(result.error).toBeUndefined();
    expect({status:result.status,stdout:result.stdout,stderr:result.stderr}).toEqual({
      status:0,stdout:expect.stringContaining('실패 경계 통과'),stderr:'',
    });
  });
});
