import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { load, loadAll, dump, JSON_SCHEMA } from 'js-yaml';

const root = resolve(__dirname, '../..');
const catalog = JSON.parse(readFileSync(join(root, 'helm/dev/gitops/catalog.json'), 'utf8')).applications;
const cli = join(root, 'scripts/dev-argocd-handoff.mjs');
const cmpImage = `registry.example.test/strimzi-cmp@sha256:${'e'.repeat(64)}`;
const input = {
  schemaVersion: 1, mode: 'handoff', infraRevision: 'a'.repeat(40), handoffRevision: 'b'.repeat(40),
  inventory: catalog.map((entry: any) => ({ id: entry.id, namespace: entry.namespace,
    releaseName: entry.id === 'cert-manager' ? 'cert-manager' : `actual-${entry.id}`,
    ...(entry.id === 'cert-manager' ? { installation: 'new' } : {}),
  })),
};
const invoke = (args: string[], options: any = {}) => spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options });

(process.env.HELM_BIN ? describe : describe.skip)('동일 fixture 렌더에서 수동 인계 산출물 생성', () => {
  let temporary: string;
  let rendered: string;
  let current: string;
  let inputPath: string;
  let output: string;
  beforeAll(() => {
    temporary = mkdtempSync(join(tmpdir(), 'argocd-handoff-'));
    rendered = join(temporary, 'rendered'); mkdirSync(rendered);
    const generated = join(temporary, 'generated'); mkdirSync(generated);
    writeFileSync(join(rendered, 'input.json'), JSON.stringify(input));
    const driver = `
      import {generateValues,parseRuntimeValues} from ${JSON.stringify(pathToFileURL(join(root, 'scripts/eks-values.mjs')).href)};
      import {readFileSync,writeFileSync} from 'node:fs'; import {join} from 'node:path';
      const root=${JSON.stringify(root)};
      const outputs=JSON.parse(readFileSync(join(root,'test/fixtures/argocd-render-outputs.json'),'utf8'));
      const runtime=parseRuntimeValues(readFileSync(join(root,'test/fixtures/eks-runtime.yaml'),'utf8'));runtime.ingestMode='kafka';
      const apps=['enrollment-api','telemetry-ingest','telemetry-gateway','dashboard-api'];
      const refs=Object.fromEntries(['enrollment','ingest','gateway','dashboard'].map((key,i)=>[key,'111111111111.dkr.ecr.ap-northeast-2.amazonaws.com/soma-376/'+apps[i]+'@sha256:'+'abcd'[i].repeat(64)]));
      const metadata={items:['soma-376-dev-telemetry-cluster-ca-cert',...['gateway','ingest','topic-admin','offset-admin'].map(role=>'pulsemetry-'+role+'-main')].map((name,i)=>({metadata:{name,namespace:'pulsemetry-dev',uid:'fixture-'+i,resourceVersion:'123'}}))};
      for(const[file,value]of Object.entries(generateValues(outputs,refs,runtime,undefined,undefined,undefined,JSON.stringify(metadata))))writeFileSync(join(process.argv[1],file),JSON.stringify(value));
    `;
    const fixture = invoke(['--input-type=module', '-e', driver, generated]);
    expect({ status: fixture.status, stderr: fixture.stderr }).toEqual({ status: 0, stderr: '' });
    expect(readdirSync(generated)).toHaveLength(13);
    for (const entry of catalog) {
      const inventory = input.inventory.find((item: any) => item.id === entry.id)!;
      const result = entry.renderer === 'strimzi-cmp'
        ? invoke(['helm/dev/platform/argocd/cmp/bin/render-strimzi.mjs'], { env: { ...process.env, ARGOCD_ENV_RELEASE_NAME: inventory.releaseName, PULSEMETRY_CMP_NODE_MODULES: join(root, 'node_modules') } })
        : spawnSync(process.env.HELM_BIN!, ['template', inventory.releaseName, entry.chart, '-n', entry.namespace, '--kube-version', '1.36.0', '--include-crds', '--skip-tests',
          ...[...entry.staticValues, ...(entry.generatedFile ? [join(generated, entry.generatedFile)] : [])].flatMap(file => ['-f', file])],
        { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
      expect({ id: entry.id, status: result.status, stderr: result.stderr }).toEqual({ id: entry.id, status: 0, stderr: '' });
      writeFileSync(join(rendered, `${entry.id}.yaml`), result.stdout);
    }
  }, 90_000);
  beforeEach(() => {
    current = mkdtempSync(join(temporary, 'case-'));
    cpSync(rendered, join(current, 'renders'), { recursive: true });
    inputPath = join(current, 'input.json'); writeFileSync(inputPath, JSON.stringify(input));
    output = join(current, 'output');
  });
  afterAll(() => { if (temporary) rmSync(temporary, { recursive: true, force: true }); });
  const run = () => invoke([cli, '--input', inputPath, '--rendered-manifests', join(current, 'renders'), '--cmp-image', cmpImage, '--output-dir', output]);
  const changeManifest = (id: string, change: (docs: any[]) => void) => {
    const file = join(current, 'renders', `${id}.yaml`);
    const docs = loadAll(readFileSync(file, 'utf8'), { schema: JSON_SCHEMA }).filter(Boolean);
    change(docs);
    writeFileSync(file, docs.map(doc => dump(doc, { noRefs: true })).join('---\n'));
  };

  test('18개 수동 Application·활성 관리 설정을 만들고 운영 수락은 pending이다', () => {
    const result = run();
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    expect(readdirSync(output).sort()).toEqual(['applications', 'argocd-values.yaml', 'handoff-report.json', 'management-values.yaml']);
    expect(readdirSync(join(output, 'applications'))).toHaveLength(18);
    const report = JSON.parse(readFileSync(join(output, 'handoff-report.json'), 'utf8'));
    expect(report).toMatchObject({ applicationCount: 18, generatedFileCount: 13, revisions: { infra: input.infraRevision, handoff: input.handoffRevision }, operationalAcceptance: { status: 'pending' } });
    expect(report.operationalAcceptance.checks.every((entry: any) => entry.status === 'pending')).toBe(true);
    expect(Object.keys(report.renderedSha256).sort()).toEqual(catalog.map((entry: any) => entry.id).sort());
    expect(report.manualStages.flatMap((stage: any) => stage.ids).sort()).toEqual(catalog.map((entry: any) => entry.id).sort());
    const overlay: any = load(readFileSync(join(output, 'argocd-values.yaml'), 'utf8'));
    const management: any = load(readFileSync(join(output, 'management-values.yaml'), 'utf8'));
    expect(overlay.configs.cm['cluster.inClusterEnabled']).toBe('true');
    expect(management.reconciliationEnabled).toBe(true);
    const renderedManagement = spawnSync(process.env.HELM_BIN!, ['template', 'argocd-management', 'helm/dev/platform/argocd/management', '-n', 'argocd', '-f', join(output, 'management-values.yaml')], { cwd: root, encoding: 'utf8' });
    expect(renderedManagement.status).toBe(0);
    const cluster: any = loadAll(renderedManagement.stdout).find((doc: any) => doc?.kind === 'Secret');
    expect(cluster.stringData).toMatchObject({ config: '{}', server: 'https://kubernetes.default.svc' });
    expect(cluster.stringData.namespaces.split(',')).toContain('cert-manager');
    for (const entry of catalog) {
      const path = join(output, 'applications', `${entry.id}.yaml`);
      const app: any = load(readFileSync(path, 'utf8'));
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(app.metadata.annotations['argocd.argoproj.io/skip-reconcile']).toBeUndefined();
      expect(app.metadata.annotations['pulsemetry.io/handoff-status']).toBe('pending');
      expect(app.metadata.finalizers).toBeUndefined();
      expect(app.spec.syncPolicy.automated).toEqual({ enabled: false, prune: false, selfHeal: false, allowEmpty: false });
      if (['lbc', 'cert-manager', 'observability'].includes(entry.id)) {
        expect(app.spec.syncPolicy.syncOptions).toContain('RespectIgnoreDifferences=true');
        expect(app.spec.ignoreDifferences.every((diff: any) => diff.name && !diff.namespace && !diff.managedFieldsManagers && !diff.jsonPointers)).toBe(true);
        for (const diff of app.spec.ignoreDifferences) expect(diff.jqPathExpressions).toEqual(['.webhooks[]?.clientConfig.caBundle', ...(entry.id === 'observability' ? ['.webhooks[]?.failurePolicy'] : [])]);
      } else expect(app.spec.ignoreDifferences).toBeUndefined();
    }
    expect(readFileSync(join(output, 'handoff-report.json'), 'utf8')).not.toContain(current);
  });

  test('기존 디렉터리·symlink 출력을 덮어쓰지 않는다', () => {
    expect(run().status).toBe(0);
    const original = readFileSync(join(output, 'handoff-report.json'), 'utf8');
    expect(run().status).toBe(1);
    expect(readFileSync(join(output, 'handoff-report.json'), 'utf8')).toBe(original);
    const link = join(current, 'link'); symlinkSync(output, link); output = link;
    expect(run().status).toBe(1);
  });

  test.each(['revision', 'inventory', 'missing', 'extra', 'symlink', 'empty'])('렌더 %s 불일치는 출력 전에 실패한다', mutation => {
    const dir = join(current, 'renders');
    if (['revision', 'inventory'].includes(mutation)) {
      const recorded = structuredClone(input);
      if (mutation === 'revision') recorded.handoffRevision = 'c'.repeat(40);
      else recorded.inventory[0].releaseName = 'wrong-release';
      writeFileSync(join(dir, 'input.json'), JSON.stringify(recorded));
    } else if (mutation === 'extra') writeFileSync(join(dir, 'unexpected.yaml'), '{}');
    else if (mutation === 'missing') rmSync(join(dir, 'base.yaml'));
    else if (mutation === 'empty') writeFileSync(join(dir, 'base.yaml'), '');
    else { rmSync(join(dir, 'base.yaml')); symlinkSync(join(rendered, 'base.yaml'), join(dir, 'base.yaml')); }
    expect(run().status).toBe(1);
    expect(readdirSync(current)).not.toContain('output');
  });

  test.each(['secret', 'namespace', 'duplicate', 'certificate', 'ca-reference'])('%s 렌더 오류를 거부한다', mutation => {
    changeManifest('lbc', docs => {
      if (mutation === 'secret') docs.push({ apiVersion: 'v1', kind: 'Secret', metadata: { name: 'forbidden', namespace: 'kube-system' }, stringData: { token: 'fixture-plaintext' } });
      if (mutation === 'namespace') docs.push({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'forbidden', namespace: 'production' } });
      if (mutation === 'duplicate') docs.push(JSON.parse(JSON.stringify(docs[0])));
      if (mutation === 'certificate') docs.splice(docs.findIndex((doc: any) => doc.kind === 'Certificate' && doc.metadata.name.endsWith('-serving-cert')), 1);
      if (mutation === 'ca-reference') docs.find((doc: any) => doc.kind === 'MutatingWebhookConfiguration').metadata.annotations['cert-manager.io/inject-ca-from'] = 'other/missing';
    });
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain('fixture-plaintext');
    expect(readdirSync(current)).not.toContain('output');
  });

  test('H 생성기로 V/B와 root 자동화 경로를 열 수 없다', () => {
    writeFileSync(inputPath, JSON.stringify({ ...input, mode: 'gitops', valuesRevision: 'c'.repeat(40), bundleManifestSha256: 'd'.repeat(64) }));
    expect(run().status).toBe(1);
  });

  test.each(['yaml', 'input', 'recorded'])('%s 구문 오류에 잘못 넣은 원문을 진단으로 출력하지 않는다', source => {
    if (source === 'yaml') writeFileSync(join(current, 'renders', 'lbc.yaml'), 'kind: Secret\nstringData:\n  token: fixture-private-value\n  token: duplicate\n');
    else writeFileSync(source === 'input' ? inputPath : join(current, 'renders', 'input.json'), '{"token":"fixture-private-value",');
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('구문 오류');
    expect(result.stderr).not.toContain('fixture-private-value');
    expect(result.stdout).toBe('');
  });
});
