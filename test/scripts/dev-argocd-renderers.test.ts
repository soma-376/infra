import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, cpSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const { load, loadAll } = require('js-yaml');
const root = resolve(__dirname, '../..');
const cmp = 'helm/dev/platform/argocd/cmp';
const wrapper = join(root, cmp, 'bin/render-strimzi.mjs');
const script = join(root, 'scripts/dev-argocd-prepare-charts.mjs');
const invoke = (binary: string, args: string[], options = {}) => spawnSync(binary, args, {
  cwd: root, encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024, ...options,
});
const documents = (text: string) => loadAll(text).filter(Boolean).sort((a: any, b: any) =>
  `${a.apiVersion}/${a.kind}/${a.metadata?.namespace}/${a.metadata?.name}`.localeCompare(`${b.apiVersion}/${b.kind}/${b.metadata?.namespace}/${b.metadata?.name}`));
const runCmp = (options = {}) => invoke(process.execPath, [wrapper], {
  env: { ...process.env, ARGOCD_ENV_RELEASE_NAME: 'strimzi', PULSEMETRY_CMP_NODE_MODULES: join(root, 'node_modules') }, ...options,
});

describe('Argo 오프라인 chart·CMP 의존성', () => {
  test('고정 archive 9개와 풀어 둔 chart의 파일 집합·내용을 대조한다', () => {
    const result = invoke(process.execPath, [script, '--check']);
    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({ status: 0, stdout: 'Argo 고정 chart 9개 검증 완료\n', stderr: '' });
  });

  test.each(['archive', 'expanded', 'extra'])('%s 변경을 검출하고 source를 보정하지 않는다', mutation => {
    const driver = `
      import { prepareCharts, chartTargets } from ${JSON.stringify(pathToFileURL(script).href)};
      import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
      import { join, dirname } from 'node:path'; import { tmpdir } from 'node:os';
      const source = ${JSON.stringify(root)}, dest = mkdtempSync(join(tmpdir(), 'chart-tamper-'));
      try {
        for (const path of ['helm/dev/platform/lbc/SOURCE.json', 'helm/dev/platform/cert-manager/SOURCE.json', 'helm/dev/runtime/versions.json', 'helm/observability/dependencies.lock.json']) {
          mkdirSync(dirname(join(dest, path)), {recursive:true}); cpSync(join(source,path),join(dest,path));
        }
        for (const target of chartTargets(source)) for (const path of [target.archive, target.expanded].filter(Boolean)) {
          mkdirSync(dirname(join(dest,path)),{recursive:true}); cpSync(join(source,path),join(dest,path),{recursive:true});
        }
        const path = ${JSON.stringify(mutation)} === 'archive' ? chartTargets(dest)[0].archive :
          'helm/dev/platform/lbc/chart/' + (${JSON.stringify(mutation)} === 'extra' ? 'unexpected.yaml' : 'values.yaml');
        writeFileSync(join(dest,path),'changed');
        try { prepareCharts({root:dest}); process.exitCode=2; } catch (error) { console.log(error.message); }
        if (readFileSync(join(dest,path),'utf8') !== 'changed') process.exitCode=3;
      } finally {rmSync(dest,{recursive:true,force:true});}
    `;
    const result = invoke(process.execPath, ['--input-type=module', '-e', driver]);
    expect(result.status).toBe(0); expect(result.stdout).toMatch(/불일치/);
  });

  test('CMP만의 lock·base digest·비밀을 전달하지 않는 plugin 경계를 고정한다', () => {
    const lock = JSON.parse(readFileSync(join(root, cmp, 'package-lock.json'), 'utf8'));
    expect(lock.packages['node_modules/js-yaml'].version).toBe('5.2.3');
    expect(Object.keys(lock.packages).sort()).toEqual(['', 'node_modules/argparse', 'node_modules/js-yaml']);
    const pins = JSON.parse(readFileSync(join(root, cmp, 'toolchain.json'), 'utf8'));
    const dockerfile = readFileSync(join(root, cmp, 'Dockerfile'), 'utf8');
    expect(dockerfile).toContain(`FROM ${pins.node.image}`);
    expect(dockerfile).toContain('USER 999:999');
    expect(dockerfile).toContain('--ignore-scripts');
    expect(pins.helm.version).toBe('3.22.0');
    expect(pins.node.arm64Manifest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(load(readFileSync(join(root, cmp, 'plugin.yaml'), 'utf8'))).toMatchObject({
      metadata: { name: 'pulsemetry-strimzi' },
      spec: { version: 'v1', provideGitCreds: false, preserveFileMode: false, generate: { command: ['node', '/opt/pulsemetry/bin/render-strimzi.mjs'] } },
    });
  });
});

const renderSuite = process.env.HELM_BIN ? describe : describe.skip;
renderSuite('고정 Helm3 Strimzi CMP', () => {
  test('기존 post-render 결과와 같고 CRD·감시 namespace를 보존한다', () => {
    const upstream = invoke(process.env.HELM_BIN!, ['template', 'strimzi', 'helm/dev/platform/strimzi/vendor/strimzi-kafka-operator-1.3.0.tgz',
      '-n', 'strimzi-system', '--kube-version', '1.36.0', '--include-crds', '--skip-tests', '-f', 'helm/dev/platform/strimzi/values.yaml']);
    expect(upstream.status).toBe(0);
    const expected = invoke(process.execPath, ['scripts/strimzi-operator-post-render.mjs', 'dev'], { input: upstream.stdout });
    const result = runCmp();
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    expect(documents(result.stdout)).toEqual(documents(expected.stdout));
    const docs = documents(result.stdout);
    expect(docs.some((doc: any) => doc.kind === 'CustomResourceDefinition')).toBe(true);
    const deployment = docs.find((doc: any) => doc.kind === 'Deployment');
    expect(deployment.metadata.namespace).toBe('strimzi-system');
    expect(deployment.spec.template.spec.containers[0].env.find((entry: any) => entry.name === 'STRIMZI_NAMESPACE').value).toBe('pulsemetry-dev');
  });

  test.each(['checksum', 'watch', 'script', 'version', 'empty', 'partial'])('%s 실패에서 부분 YAML을 stdout에 내보내지 않는다', mutation => {
    const temp = mkdtempSync(join(tmpdir(), 'cmp-failure-'));
    try {
      mkdirSync(join(temp, 'helm/dev/platform'), { recursive: true }); mkdirSync(join(temp, 'scripts'));
      cpSync(join(root, 'helm/dev/platform/strimzi'), join(temp, 'helm/dev/platform/strimzi'), { recursive: true });
      cpSync(join(root, 'scripts/strimzi-operator-post-render.mjs'), join(temp, 'scripts/strimzi-operator-post-render.mjs'));
      let helm = process.env.HELM_BIN!;
      if (mutation === 'checksum') writeFileSync(join(temp, 'helm/dev/platform/strimzi/vendor/strimzi-kafka-operator-1.3.0.tgz'), 'changed');
      if (mutation === 'watch') {
        const values = join(temp, 'helm/dev/platform/strimzi/values.yaml');
        writeFileSync(values, readFileSync(values, 'utf8').replace('pulsemetry-dev', 'unexpected-namespace'));
      }
      if (mutation === 'script') writeFileSync(join(temp, 'scripts/strimzi-operator-post-render.mjs'), 'process.stdout.write("partial yaml"); process.exit(1);');
      if (['version', 'empty', 'partial'].includes(mutation)) {
        helm = join(temp, 'helm-fixture');
        writeFileSync(helm, mutation === 'version' ? '#!/bin/sh\nprintf v4.2.1\n' :
          '#!/bin/sh\nif [ "$1" = version ]; then printf v3.22.0; exit 0; fi\n' + (mutation === 'partial' ? 'printf partial; exit 1\n' : 'exit 0\n'), { mode: 0o700 });
      }
      const result = runCmp({ cwd: temp, env: { ...process.env, HELM_BIN: helm, ARGOCD_ENV_RELEASE_NAME: 'strimzi', PULSEMETRY_CMP_NODE_MODULES: join(root, 'node_modules') } });
      expect(result.status).not.toBe(0); expect(result.stdout).toBe(''); expect(result.stderr).not.toBe('');
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
});

const paritySuite = process.env.HELM_BIN && process.env.ARGOCD_NATIVE_HELM_BIN ? describe : describe.skip;
paritySuite('Argo native Helm4와 기존 Helm3 렌더 비교', () => {
  let generated: string;
  const targets: Array<[string, string, string, string[]]> = [
    ['cert-manager', 'helm/dev/platform/cert-manager/chart', 'cert-manager', ['-f', 'helm/dev/platform/cert-manager/values.yaml']],
    ['secrets-store-csi-driver', 'helm/dev/runtime/vendor/secrets-store-csi-driver-1.6.1', 'kube-system', ['-f', 'helm/dev/runtime/csi-driver-values.yaml']],
    ['secrets-provider-aws', 'helm/dev/runtime/vendor/secrets-store-csi-driver-provider-aws-3.1.4', 'kube-system', ['-f', 'helm/dev/runtime/ascp-values.yaml']],
    ['fluent-bit', 'helm/dev/runtime/vendor/fluent-bit-0.58.3', 'pulsemetry-dev-logs', ['-f', 'helm/dev/runtime/fluent-bit-values.yaml', '-f', 'helm/dev/runtime/fluent-bit-loki-values.yaml']],
    ...['loki', 'tempo', 'otel-platform'].map(name => [name, `helm/observability/${name}`, 'pulsemetry-observability', []] as [string, string, string, string[]]),
    ['telemetry-kafka', 'helm/dev/kafka', 'pulsemetry-dev', ['--set', 'availabilityZone=ap-northeast-2a,stage=main']],
  ];
  const render = (binary: string, target: typeof targets[number]) => {
    const [release, chart, namespace, args] = target;
    const result = invoke(binary, ['template', release, chart, '-n', namespace, '--kube-version', '1.36.0', '--include-crds', '--skip-tests', ...args]);
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    return documents(result.stdout);
  };
  beforeAll(() => {
    expect(invoke(process.env.HELM_BIN!, ['version', '--short']).stdout).toMatch(/^v3\.22\.0(?:\+|\s)/);
    expect(invoke(process.env.ARGOCD_NATIVE_HELM_BIN!, ['version', '--short']).stdout).toMatch(/^v4\.2\.1(?:\+|\s)/);
    generated = mkdtempSync(join(tmpdir(), 'argocd-parity-'));
    const driver = `
      import {generateValues, parseRuntimeValues} from ${JSON.stringify(pathToFileURL(join(root, 'scripts/eks-values.mjs')).href)};
      import {readFileSync,writeFileSync} from 'node:fs'; import {join} from 'node:path';
      const root=${JSON.stringify(root)};
      const outputs=JSON.parse(readFileSync(join(root,'test/fixtures/argocd-render-outputs.json'),'utf8'));
      const runtime=parseRuntimeValues(readFileSync(join(root,'test/fixtures/eks-runtime.yaml'),'utf8'));runtime.ingestMode='kafka';
      const apps=['enrollment-api','telemetry-ingest','telemetry-gateway','dashboard-api'];
      const refs=Object.fromEntries(['enrollment','ingest','gateway','dashboard'].map((key,i)=>[key,'111111111111.dkr.ecr.ap-northeast-2.amazonaws.com/soma-376/'+apps[i]+'@sha256:'+'abcd'[i].repeat(64)]));
      const metadata={items:['soma-376-dev-telemetry-cluster-ca-cert',...['gateway','ingest','topic-admin','offset-admin'].map(role=>'pulsemetry-'+role+'-main')].map((name,i)=>({metadata:{name,namespace:'pulsemetry-dev',uid:'fixture-'+i,resourceVersion:'123'}}))};
      const values=generateValues(outputs,refs,runtime,undefined,undefined,undefined,JSON.stringify(metadata));
      for(const[file,value]of Object.entries(values))writeFileSync(join(process.argv[1],file),JSON.stringify(value));
    `;
    const fixture = invoke(process.execPath, ['--input-type=module', '-e', driver, generated]);
    expect({status:fixture.status,stderr:fixture.stderr}).toEqual({status:0,stderr:''});
  });
  afterAll(() => { if (generated) rmSync(generated, {recursive:true,force:true}); });
  test.each(targets)('%s의 고정 fixture는 두 렌더러가 동일하다', (release, chart, namespace, args) => {
    expect(render(process.env.ARGOCD_NATIVE_HELM_BIN!, [release, chart, namespace, args])).toEqual(render(process.env.HELM_BIN!, [release, chart, namespace, args]));
  });
  test('합성 generated 13개 소비 경로가 LBC 인증서 선언까지 동일하다', () => {
    const native: Array<[string,string,string,string,string[]]> = [
      ['base.yaml','pulsemetry-dev-platform','helm/dev/platform/base','kube-system',[]],
      ['runtime.yaml','runtime-config','helm/dev/runtime/chart','pulsemetry-dev',[]],
      ...['enrollment-api','telemetry-ingest','telemetry-gateway','dashboard-api'].map(app=>[`${app}.yaml`,app,'helm/dev/workloads/spring-app','pulsemetry-dev',[`helm/dev/workloads/${app}.yaml`]] as [string,string,string,string,string[]]),
      ['telemetry-kafka-admin.yaml','telemetry-kafka-admin','helm/dev/workloads/telemetry-kafka-admin','pulsemetry-dev',[]],
      ['clickhouse.yaml','clickhouse','helm/dev/workloads/clickhouse','pulsemetry-dev',[]],
      ['fluent-bit.yaml','fluent-bit','helm/dev/runtime/vendor/fluent-bit-0.58.3','pulsemetry-dev-logs',['helm/dev/runtime/fluent-bit-values.yaml','helm/dev/runtime/fluent-bit-loki-values.yaml']],
      ['ascp.yaml','secrets-provider-aws','helm/dev/runtime/vendor/secrets-store-csi-driver-provider-aws-3.1.4','kube-system',['helm/dev/runtime/ascp-values.yaml']],
      ['observability.yaml','observability','helm/observability/pulsemetry-observability','pulsemetry-observability',[]],
      ['kafka-strimzi.yaml','telemetry-kafka','helm/dev/kafka','pulsemetry-dev',[]],
      ['lbc.yaml','aws-load-balancer-controller','helm/dev/platform/lbc/chart','kube-system',['helm/dev/platform/lbc/values.yaml']],
    ];
    expect(native).toHaveLength(13);
    for(const [file,release,chart,namespace,staticValues] of native) {
      const target: typeof targets[number] = [release,chart,namespace,[...staticValues,join(generated,file)].flatMap(path=>['-f',path])];
      const oldDocs = render(process.env.HELM_BIN!,target), argoDocs = render(process.env.ARGOCD_NATIVE_HELM_BIN!,target);
      expect({file,docs:argoDocs}).toEqual({file,docs:oldDocs});
      if(file === 'lbc.yaml') expect(argoDocs.some((doc:any)=>doc.kind==='Secret')).toBe(false);
    }
  });
  test('LBC 인증서 선언은 반복 렌더가 같고 관측 hook 계약을 보존한다', () => {
    const lbc: typeof targets[number] = ['aws-load-balancer-controller', 'helm/dev/platform/lbc/chart', 'kube-system', [
      '-f', 'helm/dev/platform/lbc/values.yaml', '--set', 'clusterName=fixture,region=ap-northeast-2,vpcId=vpc-0123456789abcdef0',
    ]];
    const first = render(process.env.ARGOCD_NATIVE_HELM_BIN!, lbc);
    const second = render(process.env.ARGOCD_NATIVE_HELM_BIN!, lbc);
    expect(first).toEqual(second);
    expect(first.some((doc:any)=>doc.kind==='Secret')).toBe(false);
    expect(first.filter((doc:any)=>doc.kind==='Certificate')).toHaveLength(2);
    expect(first.filter((doc:any)=>doc.kind==='Issuer')).toHaveLength(2);
    const target: typeof targets[number] = ['observability', 'helm/observability/pulsemetry-observability', 'pulsemetry-observability', ['-f', 'helm/observability/tests/generated-values.yaml']];
    const hooks = (docs: any[]) => docs.filter((doc: any) => doc.metadata.annotations?.['helm.sh/hook']);
    const firstHooks = hooks(render(process.env.ARGOCD_NATIVE_HELM_BIN!, target));
    expect(firstHooks).toEqual(hooks(render(process.env.ARGOCD_NATIVE_HELM_BIN!, target)));
    expect(firstHooks.map((doc:any)=>doc.kind).sort()).toEqual(['ClusterRole','ClusterRoleBinding','Job','Job','Role','RoleBinding','ServiceAccount']);
    const imageLock = JSON.parse(readFileSync(join(root,'helm/observability/tests/fixtures/arm64-images.json'),'utf8')).images
      .find((image:any)=>image.image==='ghcr.io/jkroepke/kube-webhook-certgen:1.7.4');
    const jobs = firstHooks.filter((doc:any)=>doc.kind==='Job');
    expect(jobs.map((job:any)=>job.metadata.name).sort()).toEqual(['pulsemetry-monitoring-admission-create','pulsemetry-monitoring-admission-patch']);
    for(const doc of firstHooks) {
      const annotations=doc.metadata.annotations;
      expect(annotations['helm.sh/hook-delete-policy']).toBe('before-hook-creation,hook-succeeded');
      expect(Number(annotations['helm.sh/hook-weight'] ?? '0')).toBe(0);
      expect(annotations['argocd.argoproj.io/hook']).toBeUndefined();
      if(doc.kind!=='Job') {
        expect(doc.metadata.name).toBe('pulsemetry-monitoring-admission');
        expect(annotations['helm.sh/hook']).toBe('pre-install,pre-upgrade,post-install,post-upgrade');
      }
    }
    // Argo 공식 Helm 호환표의 PreSync/PostSync 매핑 입력을 검증한다. 실제 반복 sync 성공 증거는 아니다.
    for(const [suffix,events,args] of [
      ['create','pre-install,pre-upgrade',['create','--host=pulsemetry-monitoring-operator,pulsemetry-monitoring-operator.pulsemetry-observability.svc','--namespace=pulsemetry-observability','--secret-name=pulsemetry-monitoring-admission']],
      ['patch','post-install,post-upgrade',['patch','--webhook-name=pulsemetry-monitoring-admission','--namespace=pulsemetry-observability','--secret-name=pulsemetry-monitoring-admission','--patch-failure-policy=']],
    ] as Array<[string,string,string[]]>) {
      const job=jobs.find((doc:any)=>doc.metadata.name.endsWith(`-${suffix}`));
      expect(job.metadata.annotations['helm.sh/hook']).toBe(events);
      expect(job.spec.ttlSecondsAfterFinished).toBe(60);
      expect(job.spec.template.spec.serviceAccountName).toBe('pulsemetry-monitoring-admission');
      expect(job.spec.template.spec.restartPolicy).toBe('OnFailure');
      expect(job.spec.template.spec.containers).toHaveLength(1);
      expect(job.spec.template.spec.containers[0]).toMatchObject({image:`${imageLock.image}@sha256:${imageLock.manifest_index_sha256}`,args});
    }
  });
});

(process.env.PULSEMETRY_CMP_IMAGE ? describe : describe.skip)('CMP 실제 컨테이너', () => {
  test('비루트·읽기 전용 root·네트워크 없이 동일 C의 renderer를 실행한다', () => {
    const result = invoke('docker', ['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--user', '999:999', '--tmpfs', '/tmp:rw,nosuid,nodev', '-v', `${root}:/work:ro`, '-w', '/work', '-e', 'ARGOCD_ENV_RELEASE_NAME=strimzi',
      '--entrypoint', 'node', process.env.PULSEMETRY_CMP_IMAGE!, '/opt/pulsemetry/bin/render-strimzi.mjs']);
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    expect(documents(result.stdout)).toEqual(documents(runCmp().stdout));
  });
});
