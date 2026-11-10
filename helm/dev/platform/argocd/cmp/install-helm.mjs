// 이미지 build에만 실행한다. 공식 archive를 검증한 뒤 바이너리를 설치한다.
import { readFileSync, writeFileSync, mkdtempSync, copyFileSync, chmodSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const pins = JSON.parse(readFileSync(new URL('./toolchain.json', import.meta.url), 'utf8'));
const arch = process.env.TARGETARCH;
if (!Object.hasOwn(pins.helm.sha256, arch)) throw new Error('지원 architecture는 amd64 또는 arm64다');
const response = await fetch(`https://get.helm.sh/helm-v${pins.helm.version}-linux-${arch}.tar.gz`, { signal: AbortSignal.timeout(60000) });
if (!response.ok) throw new Error(`Helm 다운로드 HTTP ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
if (createHash('sha256').update(bytes).digest('hex') !== pins.helm.sha256[arch]) throw new Error('Helm checksum 불일치');
const temp = mkdtempSync(join(tmpdir(), 'helm-cmp-'));
try {
  writeFileSync(join(temp, 'helm.tgz'), bytes);
  const extracted = spawnSync('tar', ['-xzf', join(temp, 'helm.tgz'), '-C', temp], { encoding: 'utf8' });
  if (extracted.status !== 0) throw new Error('Helm archive 추출 실패');
  copyFileSync(join(temp, `linux-${arch}/helm`), '/usr/local/bin/helm'); chmodSync('/usr/local/bin/helm', 0o755);
} finally { rmSync(temp, { recursive: true, force: true }); }
