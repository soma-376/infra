import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

// 외부 검증 도구는 전역 설치하지 않는다. 지정한 공식 버전으로 실제 Helm/schema를 검사한다.
const enabled = Boolean(process.env.HELM_BIN && process.env.KUBECONFORM_BIN);
const suite = enabled ? describe : describe.skip;

suite('dev EKS Helm workload 경계', () => {
  test('실제 lint/render/schema와 잘못된 입력의 실패를 검사한다', () => {
    const result = spawnSync(process.execPath, [resolve(__dirname, '../../scripts/validate-helm-workloads.mjs')], {
      encoding: 'utf8', env: process.env, timeout: 120_000,
    });
    expect(result.error).toBeUndefined();
    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
      status: 0,
      stdout: expect.stringContaining('workload/runtime 경계 통과'),
      stderr: '',
    });
  });
});
