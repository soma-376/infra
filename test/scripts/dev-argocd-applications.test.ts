import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(__dirname, '../..');
const catalog = JSON.parse(readFileSync(join(root, 'helm/dev/gitops/catalog.json'), 'utf8')).applications;
const moduleUrl = pathToFileURL(join(root, 'scripts/dev-argocd-applications.mjs')).href;
const input = (mode = 'handoff') => ({
  schemaVersion: 1, mode, infraRevision: 'a'.repeat(40),
  ...(mode === 'handoff' ? { handoffRevision: 'b'.repeat(40) } : { valuesRevision: 'c'.repeat(40), bundleManifestSha256: 'd'.repeat(64) }),
  inventory: catalog.map((entry: any) => ({ id: entry.id, releaseName: `existing-${entry.id}`, namespace: entry.namespace })),
});
const generate = (value: any) => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { readFileSync } from 'node:fs';
    import { generateApplications } from ${JSON.stringify(moduleUrl)};
    try { console.log(JSON.stringify(generateApplications(JSON.parse(readFileSync(0, 'utf8'))))); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  `], { cwd: root, input: JSON.stringify(value), encoding: 'utf8' });
  return { status: result.status, error: result.stderr, review: result.status === 0 ? JSON.parse(result.stdout) : undefined };
};

describe('dev Application 정의의 인계 경계', () => {
  test('17개 실제 release를 보존하고 관리 Job·Argo 자체를 카탈로그에 넣지 않는다', () => {
    const fixture = input();
    fixture.inventory[0].releaseName = 'actual-platform-release';
    const { status, error, review } = generate(fixture);
    expect({ status, error }).toEqual({ status: 0, error: '' });
    expect(review.definitions).toHaveLength(17);
    expect(catalog.map((entry: any) => entry.id)).not.toContain('telemetry-kafka-admin');
    expect(catalog.map((entry: any) => entry.id)).not.toContain('argocd');
    for (const definition of review.definitions) {
      const actual = fixture.inventory.find((item: any) => item.id === definition.id)!;
      expect(definition.application.spec.destination.namespace).toBe(actual.namespace);
      const source = definition.application.spec.sources[0];
      if (definition.id === 'strimzi-operator') expect(source.plugin).toEqual({ name: 'pulsemetry-strimzi-v1', env: [{ name: 'RELEASE_NAME', value: actual.releaseName }] });
      else expect(source.helm.releaseName).toBe(actual.releaseName);
    }
  });

  test('H는 검토용 하위 정의만 만들고 정상 V/B·root 선택으로 꾸미지 않는다', () => {
    const { review } = generate(input());
    expect(review.revisions).toEqual({ infra: 'a'.repeat(40), handoff: 'b'.repeat(40) });
    expect(review.rootTemplate).toBeNull();
    expect(review.definitions.find((entry: any) => entry.id === 'enrollment-api').application.spec.sources[1].targetRevision).toBe('b'.repeat(40));
  });

  test('V의 root도 중지된 template이며 모든 child source는 고정 SHA다', () => {
    const { review } = generate(input('gitops'));
    expect(review.rootTemplate.spec.source).toEqual({
      repoURL: 'https://github.com/soma-376/infra-generated-values.git', targetRevision: 'main', path: 'dev/applications', directory: { recurse: false },
    });
    expect(review.rootTemplate.spec.project).toBe('pulsemetry-dev-root');
    for (const definition of review.definitions) {
      expect(definition.application.spec.sources[0].targetRevision).toBe('a'.repeat(40));
      for (const source of definition.application.spec.sources) expect(source.targetRevision).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  test('정적 values 다음 generated values를 읽고 static 전용 source에는 private ref를 붙이지 않는다', () => {
    const { review } = generate(input('gitops'));
    const app = (id: string) => review.definitions.find((entry: any) => entry.id === id).application;
    expect(app('enrollment-api').spec.sources).toEqual([
      { repoURL: 'https://github.com/soma-376/infra.git', targetRevision: 'a'.repeat(40), path: 'helm/dev/workloads/spring-app',
        helm: { releaseName: 'existing-enrollment-api', kubeVersion: '1.36.0', valueFiles: ['../enrollment-api.yaml', '$values/dev/generated/enrollment-api.yaml'], ignoreMissingValueFiles: false, skipCrds: false, skipTests: true } },
      { repoURL: 'https://github.com/soma-376/infra-generated-values.git', targetRevision: 'c'.repeat(40), ref: 'values' },
    ]);
    for (const id of ['csi', 'strimzi-operator', 'loki', 'tempo', 'otel-platform']) expect(app(id).spec.sources).toHaveLength(1);
    const fluent = app('fluent-bit').spec.sources[0].helm.valueFiles;
    expect(fluent).toEqual(['../../fluent-bit-values.yaml', '../../fluent-bit-loki-values.yaml', '$values/dev/generated/fluent-bit.yaml']);
    expect(app('strimzi-operator').spec.sources[0].helm).toBeUndefined();
  });

  test('LBC를 격리하고 모든 인계·자동화·삭제를 차단한 상태로만 출력한다', () => {
    const { review } = generate(input('gitops'));
    expect(review.readiness).toMatchObject({ status: 'blocked', deployable: false, deployableApplicationCount: 0 });
    expect(review.definitions.find((entry: any) => entry.id === 'lbc')).toMatchObject({ state: 'quarantined', deployable: false, blockReason: expect.stringContaining('TLS Secret') });
    for (const app of [...review.definitions.map((entry: any) => entry.application), review.rootTemplate]) {
      expect(app.metadata.annotations['argocd.argoproj.io/skip-reconcile']).toBe('true');
      expect(app.metadata.annotations['pulsemetry.io/handoff-status']).toBe('blocked');
      expect(app.metadata.finalizers).toBeUndefined();
      expect(app.spec.syncPolicy.automated).toEqual({ enabled: false, prune: false, selfHeal: false, allowEmpty: false });
      expect(app.spec.syncPolicy.syncOptions).toContain('FailOnSharedResource=true');
    }
  });

  test('필수 기반과 앱 순서를 카탈로그 wave에 보존한다', () => {
    const waves = Object.fromEntries(catalog.map((entry: any) => [entry.id, entry.wave]));
    for (const [before, after] of [['base', 'csi'], ['csi', 'ascp'], ['ascp', 'runtime'], ['strimzi-operator', 'kafka'], ['kafka', 'enrollment-api'], ['runtime', 'enrollment-api'], ['enrollment-api', 'telemetry-ingest'], ['telemetry-ingest', 'telemetry-gateway'], ['telemetry-gateway', 'dashboard-api']]) {
      expect(waves[before]).toBeLessThan(waves[after]);
    }
  });

  test('CRD 소유 Application만 server-side apply를 쓰고 Helm 테스트 리소스를 관리하지 않는다', () => {
    const { review } = generate(input());
    for (const definition of review.definitions) {
      const app = definition.application;
      expect(app.spec.syncPolicy.syncOptions.includes('ServerSideApply=true')).toBe(['lbc', 'csi', 'strimzi-operator', 'observability'].includes(definition.id));
      expect(app.spec.syncPolicy.syncOptions).not.toContain('Replace=true');
      expect(app.spec.syncPolicy.syncOptions).not.toContain('Force=true');
      const native = app.spec.sources[0].helm;
      if (native) expect(native.skipTests).toBe(true);
    }
  });

  test.each([
    ['가변 C', (v: any) => { v.infraRevision = 'develop'; }],
    ['짧은 H', (v: any) => { v.handoffRevision = 'abcd123'; }],
    ['H와 V 혼합', (v: any) => { v.valuesRevision = 'c'.repeat(40); }],
    ['H와 B 혼합', (v: any) => { v.bundleManifestSha256 = 'd'.repeat(64); }],
    ['부분 inventory', (v: any) => { v.inventory.pop(); }],
    ['중복 id', (v: any) => { v.inventory[1] = { ...v.inventory[0] }; }],
    ['미허용 id', (v: any) => { v.inventory[0].id = 'telemetry-kafka-admin'; }],
    ['다른 namespace', (v: any) => { v.inventory[0].namespace = 'pulsemetry-perf'; }],
    ['빈 release', (v: any) => { v.inventory[0].releaseName = ''; }],
    ['중복 release', (v: any) => { v.inventory[1].releaseName = v.inventory[0].releaseName; }],
    ['활성화 우회 입력', (v: any) => { v.activate = true; }],
    ['inventory override', (v: any) => { v.inventory[0].targetRevision = 'main'; }],
  ])('%s를 거부한다', (_name, mutate) => {
    const fixture = input();
    (mutate as (value: any) => void)(fixture);
    expect(generate(fixture)).toMatchObject({ status: 1, review: undefined });
  });

  test.each(['main', 'A'.repeat(40), 'a'.repeat(39)])('gitops V=%s를 거부한다', revision => {
    const fixture: any = input('gitops'); fixture.valuesRevision = revision;
    expect(generate(fixture).status).toBe(1);
  });

  test('gitops에 B가 없거나 H를 함께 주면 거부한다', () => {
    const fixture: any = input('gitops'); delete fixture.bundleManifestSha256;
    expect(generate(fixture).status).toBe(1);
    fixture.bundleManifestSha256 = 'd'.repeat(64); fixture.handoffRevision = 'b'.repeat(40);
    expect(generate(fixture).status).toBe(1);
  });

  test('CLI는 새 로컬 디렉터리의 review JSON만 만들고 기존 파일을 덮어쓰지 않는다', () => {
    const temporary = mkdtempSync(join(tmpdir(), 'argocd-definition-'));
    try {
      const fixture = join(temporary, 'input.json'); writeFileSync(fixture, JSON.stringify(input()));
      const directory = join(temporary, 'review');
      const args = [join(root, 'scripts/dev-argocd-applications.mjs'), '--input', fixture, '--output-dir', directory];
      const run = () => spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' });
      expect(run().status).toBe(0);
      const report = JSON.parse(readFileSync(join(directory, 'application-review.json'), 'utf8'));
      expect(report.kind).toBeUndefined();
      expect(report.readiness.deployableApplicationCount).toBe(0);
      expect(statSync(join(directory, 'application-review.json')).mode & 0o777).toBe(0o600);
      const original = readFileSync(join(directory, 'application-review.json'), 'utf8');
      expect(run().status).toBe(1);
      expect(readFileSync(join(directory, 'application-review.json'), 'utf8')).toBe(original);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  });
});
