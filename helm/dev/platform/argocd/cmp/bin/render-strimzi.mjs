// stdout는 검증을 모두 통과한 최종 YAML에만 사용한다. git checkout에는 쓰지 않는다.
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
const imageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let temp;
try {
  const release = process.env.ARGOCD_ENV_RELEASE_NAME;
  if (!release || release.length > 53 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(release)) throw new Error('검증한 RELEASE_NAME이 필요하다');
  const root = process.cwd(), source = JSON.parse(readFileSync(join(root, 'helm/dev/platform/strimzi/SOURCE.json'), 'utf8'));
  const archive = join(root, `helm/dev/platform/strimzi/vendor/strimzi-kafka-operator-${source.chart.version}.tgz`);
  if (createHash('sha256').update(readFileSync(archive)).digest('hex') !== source.chart.sha256) throw new Error('Strimzi archive checksum 불일치');
  const helm = process.env.HELM_BIN || 'helm';
  const run = (binary, args, input) => {
    const result = spawnSync(binary, args, { cwd: root, input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60000 });
    if (result.error || result.status !== 0) throw new Error(`렌더 명령 실패: ${result.error?.message ?? result.stderr.trim()}`);
    if (!result.stdout.trim()) throw new Error('렌더 결과가 비어 있다');
    return result.stdout;
  };
  if (!/^v3\.22\.0(?:\+|\s|$)/.test(run(helm, ['version', '--short']).trim())) throw new Error('CMP는 Helm 3.22.0이 필요하다');
  const rendered = run(helm, ['template', release, archive, '--namespace', 'strimzi-system', '--kube-version', '1.36.0', '--include-crds', '--skip-tests', '-f', join(root, 'helm/dev/platform/strimzi/values.yaml')]);
  temp = mkdtempSync(join(tmpdir(), 'strimzi-post-render-'));
  // ESM은 NODE_PATH를 사용하지 않는다. 같은 C의 script만 복사하고 image의 고정 의존성을 연결한다.
  const script = join(temp, 'strimzi-operator-post-render.mjs');
  writeFileSync(script, readFileSync(join(root, 'scripts/strimzi-operator-post-render.mjs')));
  symlinkSync(process.env.PULSEMETRY_CMP_NODE_MODULES || join(imageRoot, 'node_modules'), join(temp, 'node_modules'), 'dir');
  const finalYaml = run(process.execPath, [script, 'dev'], rendered);
  process.stdout.write(finalYaml);
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { if (temp) rmSync(temp, { recursive: true, force: true }); }
