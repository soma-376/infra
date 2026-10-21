#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { load, loadAll, dump } from 'js-yaml';
import { generateValues, parseRuntimeValues } from './eks-values.mjs';

// 공개 package의 고정 checksum과 실제 render를 검증한다. AWS 접속은 없다.
const root = resolve(import.meta.dirname, '..');
const helm = process.env.HELM_BIN ?? 'helm';
const kubeconform = process.env.KUBECONFORM_BIN ?? 'kubeconform';
const schema = process.env.KUBERNETES_SCHEMA_DIR;
const packagesArg = process.argv.indexOf('--packages-dir');
if (packagesArg < 0 || !process.argv[packagesArg + 1]) throw new Error('--packages-dir <versions.json의 고정 tgz 디렉터리>가 필요하다');
const packages = resolve(process.argv[packagesArg + 1]);
const check = (condition, label) => { if (!condition) throw new Error(label); };
const run = (binary, args, input) => {
  const result = spawnSync(binary, args, { cwd: root, encoding: 'utf8', input });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || String(result.error));
  return result.stdout;
};
const temp = mkdtempSync(join(tmpdir(), 'eks-runtime-check-'));
try {
  const versions = JSON.parse(readFileSync(join(root, 'helm/dev/runtime/versions.json'), 'utf8'));
  const source = JSON.parse(readFileSync(join(root, 'test/scripts/fixtures/eks-outputs.json'), 'utf8'));
  const digest = 'sha256:' + 'a'.repeat(64);
  const images = Object.fromEntries(['enrollment-api', 'telemetry-ingest', 'dashboard-api', 'telemetry-gateway']
    .map(app => [{ 'enrollment-api': 'enrollment', 'telemetry-ingest': 'ingest', 'dashboard-api': 'dashboard', 'telemetry-gateway': 'gateway' }[app], `registry.example.test/soma-376/${app}@${digest}`]));
  const bootstrap = readFileSync(join(root, 'test/scripts/fixtures/msk-bootstrap.json'), 'utf8');
  const nodes = readFileSync(join(root, 'test/scripts/fixtures/msk-nodes.json'), 'utf8');
  const values = generateValues(source, images, parseRuntimeValues(readFileSync(join(root, 'test/fixtures/eks-runtime.yaml'), 'utf8')), bootstrap, nodes);
  for (const [file, value] of Object.entries(values)) writeFileSync(join(temp, file), dump(value, { noRefs: true }));
  const render = (name, chart, namespace, files) => {
    const args = [name, chart, '--namespace', namespace, '--kube-version', '1.36.0', ...files.flatMap(file => ['-f', file])];
    run(helm, ['lint', chart, '--namespace', namespace, '--strict', '--kube-version', '1.36.0', ...files.flatMap(file => ['-f', file])]);
    return run(helm, ['template', ...args]);
  };
  const kubeArgs = ['-strict', '-summary', '-kubernetes-version', '1.36.0', '-schema-location', join(root, 'helm/dev/runtime/schemas/{{.ResourceKind}}_{{.Group}}_{{.ResourceAPIVersion}}.json'), '-schema-location', schema ? join(resolve(schema), '{{.ResourceKind}}{{.KindSuffix}}.json') : 'default'];
  const runtimeText = render('runtime-config', 'helm/dev/runtime/chart', 'pulsemetry-dev', [join(temp, 'runtime.yaml')]);
  console.log('runtime-config ' + run(kubeconform, kubeArgs, runtimeText).trim());
  const spcs = loadAll(runtimeText).filter(Boolean);
  check(spcs.length === 8, 'SPC는 configtree 3개·사용자 JWT 2개·telemetry JWT 3개여야 한다');
  for (const spc of spcs) { check(!spc.spec.secretObjects, 'Kubernetes Secret sync는 금지한다'); check(spc.spec.parameters.usePodIdentity === 'true', 'SPC는 Pod Identity를 사용한다'); }
  for (const spc of spcs.filter(item => ['enrollment-api-runtime', 'telemetry-ingest-runtime'].includes(item.metadata.name))) {
    const objects = load(spc.spec.parameters.objects);
    check(spc.spec.parameters.usePodIdentity === 'true', 'SPC는 Pod Identity를 사용한다');
    check(!spc.spec.secretObjects, 'Kubernetes Secret sync는 금지한다');
    check(objects.length === (spc.metadata.name.startsWith('enrollment') ? 3 : 2), 'Secret 소비자 수가 다르다');
    check(objects[0].filePermission === '0400', '원본 JSON은 root 전용이다');
    check(objects[0].jmesPath.every(field => field.filePermission === '0444'), '추출 field는 UID 10001이 읽는다');
    check(objects[1].objectAlias === 'PULSEMETRY_TOKEN_HASH_SECRET' && !objects[1].jmesPath, 'HMAC은 전체 SecretString이다');
  }
  const dashboard = spcs.find(item => item.metadata.name === 'dashboard-api-runtime');
  const dashboardObjects = load(dashboard.spec.parameters.objects);
  check(dashboardObjects.length === 4, 'dashboard는 네 전용 DB 계정만 받는다');
  check(dashboardObjects.every(item => item.filePermission === '0400' && item.jmesPath.length === 2 && item.jmesPath.every(field => field.filePermission === '0444')), 'dashboard credential 권한이 다르다');
  for (const app of ['enrollment-api', 'dashboard-api']) {
    const objects = load(spcs.find(item => item.metadata.name === `${app}-jwt`).spec.parameters.objects);
    check(objects.length === (app === 'enrollment-api' ? 2 : 1), 'JWT 원본 소비자 경계가 다르다');
    check(objects.every(item => item.objectVersion && !item.objectVersionLabel), 'JWT는 VersionId만 지정한다');
    const publicObject = objects.at(-1);
    check(publicObject.filePermission === '0400' && publicObject.jmesPath.every(item => item.filePermission === '0444'), 'JWT JSON/PEM 권한이 다르다');
    check(publicObject.jmesPath.every((item, index) => item.path === JSON.stringify(values['runtime.yaml'].userAuth.publicKeys[index].kid)), 'kid의 JMESPath quoted identifier를 보존한다');
  }
  // telemetry JWT: 개인키는 enrollment SPC에만 있고 모든 원본은 고정 VersionId·quoted kid 경로를 쓴다. (ADR-0036)
  const telemetry = values['runtime.yaml'].telemetryJwt;
  for (const app of ['enrollment-api', 'telemetry-gateway', 'telemetry-ingest']) {
    const spc = spcs.find(item => item.metadata.name === `${app}-telemetry-jwt`);
    check(Boolean(spc), `${app}-telemetry-jwt SPC가 필요하다`);
    const objects = load(spc.spec.parameters.objects);
    check(objects.length === (app === 'enrollment-api' ? 2 : 1), 'telemetry JWT 원본 소비자 경계가 다르다');
    check(objects.every(item => item.objectVersion && !item.objectVersionLabel), 'telemetry JWT는 VersionId만 지정한다');
    check(objects.some(item => item.objectAlias === 'private.pem') === (app === 'enrollment-api'), '개인키는 enrollment만 받는다');
    const publicObject = objects.at(-1);
    check(publicObject.objectName === values['runtime.yaml'].secrets.telemetryJwtPublicKeysArn && publicObject.objectVersion === telemetry.publicVersionId, '공개키 원본·버전이 다르다');
    check(publicObject.filePermission === '0400' && publicObject.jmesPath.every(item => item.filePermission === '0444'), 'telemetry JWT JSON/PEM 권한이 다르다');
    check(publicObject.jmesPath.every((item, index) => item.path === JSON.stringify(telemetry.publicKeys[index].kid)), 'telemetry kid의 quoted identifier를 보존한다');
  }
  check(spcs.filter(item => JSON.stringify(item).includes(values['runtime.yaml'].secrets.telemetryJwtPrivateKeyArn)).map(item => item.metadata.name).join() === 'enrollment-api-telemetry-jwt', 'telemetry 개인키 원본은 enrollment SPC에만 있다');
  check(!spcs.some(item => item.metadata.name.startsWith('dashboard-api') && JSON.stringify(item).includes('telemetry-jwt')), 'dashboard에는 telemetry JWT를 공급하지 않는다');
  // 생성된 Gateway·ingest·관리 Job values를 실제 chart로 렌더링하고 strict schema를 통과해야 한다.
  for (const [release, chart, files] of [
    ['telemetry-gateway', 'helm/dev/workloads/spring-app', [join(root, 'helm/dev/workloads/telemetry-gateway.yaml'), join(temp, 'telemetry-gateway.yaml')]],
    ['telemetry-ingest', 'helm/dev/workloads/spring-app', [join(root, 'helm/dev/workloads/telemetry-ingest.yaml'), join(temp, 'telemetry-ingest.yaml')]],
    ['enrollment-api', 'helm/dev/workloads/spring-app', [join(root, 'helm/dev/workloads/enrollment-api.yaml'), join(temp, 'enrollment-api.yaml')]],
    ['telemetry-kafka-admin', 'helm/dev/workloads/telemetry-kafka-admin', [join(temp, 'telemetry-kafka-admin.yaml')]],
  ]) {
    const text = render(release, chart, 'pulsemetry-dev', files);
    if (['telemetry-gateway', 'telemetry-ingest'].includes(release)) {
      const docs = loadAll(text).filter(Boolean);
      const metrics = docs.find(item => item.kind === 'Service' && item.metadata.name === `${release}-metrics`);
      check(metrics?.spec.type === 'ClusterIP' && metrics.spec.ports.length === 1 && metrics.spec.ports[0].port === 9404, '생성된 metrics는 내부 9404 하나만 노출한다');
      const env = docs.find(item => item.kind === 'Deployment').spec.template.spec.containers[0].env;
      check(env.filter(item => item.name === 'MANAGEMENT_SERVER_PORT').length === 1 && env.find(item => item.name === 'MANAGEMENT_SERVER_PORT').value === '9404', 'management 포트는 중복 없이 9404여야 한다');
      check(env.find(item => item.name === 'PULSEMETRY_OBSERVABILITY_ENVIRONMENT').value === 'dev', '환경 tag가 필요하다');
    }
    const standard = loadAll(text).filter(item => item && item.kind !== 'TargetGroupBinding').map(item => dump(item)).join('---\n');
    console.log(`${release} ` + run(kubeconform, kubeArgs, standard).trim());
  }
  // 비활성 bootstrap과 별도로 같은 CDK output에서 선택한 OIDC 원본만 활성화한다.
  const oidcInput = parseRuntimeValues(readFileSync(join(root, 'test/fixtures/eks-runtime.yaml'), 'utf8'));
  oidcInput.userAuth.allowedRedirectUris = ['https://dashboard.example.test/auth/callback'];
  oidcInput.oidc = {
    enabled: true, callbackBaseUrl: 'https://auth.example.test',
    failureRedirectUri: oidcInput.userAuth.allowedRedirectUris[0],
    clients: [{ key: 'cognito-b', versionId: 'b'.repeat(32) }, { key: 'cognito-a', versionId: 'a'.repeat(32) }],
  };
  const account = values['runtime.yaml'].secrets.dbArn.split(':')[4];
  const oidcSource = { ...source, OidcFixtureDataStack: { OidcClientSecretArns: JSON.stringify(Object.fromEntries(
    ['cognito-a', 'cognito-b', 'unused'].map(key => [key, `arn:aws:secretsmanager:ap-northeast-2:${account}:secret:soma-376/dev/oidc/clients/${key}-abc123`]),
  )) } };
  const oidcValues = generateValues(oidcSource, images, oidcInput, bootstrap, nodes);
  const oidcRuntimeFile = join(temp, 'oidc-runtime.yaml'), oidcAppFile = join(temp, 'oidc-enrollment.yaml');
  writeFileSync(oidcRuntimeFile, dump(oidcValues['runtime.yaml'], { noRefs: true }));
  writeFileSync(oidcAppFile, dump(oidcValues['enrollment-api.yaml'], { noRefs: true }));
  const oidcRuntimeText = render('oidc-runtime', 'helm/dev/runtime/chart', 'pulsemetry-dev', [oidcRuntimeFile]);
  console.log('OIDC runtime-config ' + run(kubeconform, kubeArgs, oidcRuntimeText).trim());
  const oidcSpcs = loadAll(oidcRuntimeText).filter(Boolean);
  const oidcObjects = load(oidcSpcs.find(item => item.metadata.name === 'enrollment-api-runtime').spec.parameters.objects).slice(3);
  check(oidcObjects.length === 2, 'OIDC는 선택한 client Secret 두 개만 소비한다');
  for (const [index, object] of oidcObjects.entries()) {
    const client = oidcValues['runtime.yaml'].oidc.clients[index];
    check(object.objectName === client.secretArn && object.objectVersion === client.versionId && object.objectAlias === client.alias, 'OIDC 원본·버전·alias가 생성 입력과 같아야 한다');
    check(object.filePermission === '0444' && !object.jmesPath && !object.objectVersionLabel, 'OIDC는 고정 버전 전체 문자열을 UID10001 파일로 전달한다');
  }
  check(oidcSpcs.filter(item => item.metadata.name !== 'enrollment-api-runtime').every(item => !JSON.stringify(item).includes('/oidc/clients/')), '다른 앱에는 OIDC 원본을 공급하지 않는다');
  const oidcAppText = render('enrollment-api', 'helm/dev/workloads/spring-app', 'pulsemetry-dev', [join(root, 'helm/dev/workloads/enrollment-api.yaml'), oidcAppFile]);
  const oidcDeployment = loadAll(oidcAppText).find(item => item?.kind === 'Deployment');
  check(Boolean(oidcDeployment.spec.template.metadata.annotations['pulsemetry.io/oidc-revision']), 'OIDC 원본 변경이 Pod 교체를 유발해야 한다');
  const oidcEnvironment = Object.fromEntries(oidcDeployment.spec.template.spec.containers[0].env.map(item => [item.name, item.value]));
  const oidcMap = JSON.parse(oidcEnvironment.SPRING_APPLICATION_JSON).pulsemetry.oidc['client-secrets'];
  for (const client of oidcValues['enrollment-api.yaml'].oidc.clients) {
    check(oidcMap[`[${client.key}]`] === '${' + client.alias + '}', 'OIDC 비밀 맵은 원문 대신 정확한 key와 placeholder만 담는다');
    check(oidcValues['enrollment-api.yaml'].runtime.requiredFiles.includes(client.alias), 'OIDC 파일을 init 필수 검사에 포함해야 한다');
  }
  const releaseData = [
    ['csiDriver', 'secrets-store-csi-driver', 'secrets-store-csi-driver', 'kube-system', ['csi-driver-values.yaml']],
    ['ascp', 'secrets-provider-aws', 'secrets-store-csi-driver-provider-aws', 'kube-system', ['ascp-values.yaml']],
    ['fluentBit', 'fluent-bit', 'fluent-bit', 'pulsemetry-dev-logs', ['fluent-bit-values.yaml']],
  ];
  for (const [key, release, chartName, namespace, files] of releaseData) {
    const archive = join(packages, basename(versions[key].url));
    check(createHash('sha256').update(readFileSync(archive)).digest('hex') === versions[key].sha256, key + ' package checksum이 다르다');
    const chartDir = join(temp, key); mkdirSync(chartDir);
    run('tar', ['-xzf', archive, '-C', chartDir]);
    const chart = join(chartDir, chartName);
    const yamlFiles = files.map(file => join(root, 'helm/dev/runtime', file));
    if (key === 'fluentBit') yamlFiles.push(join(temp, 'fluent-bit.yaml'));
    if (key === 'ascp') yamlFiles.push(join(temp, 'ascp.yaml'));
    const text = render(release, chart, namespace, yamlFiles);
    console.log(release + ' ' + run(kubeconform, kubeArgs, text).trim());
    const resources = loadAll(text).filter(Boolean);
    if (key === 'csiDriver') {
      const driver = resources.find(resource => resource.kind === 'CSIDriver');
      check(driver.spec.requiresRepublish === false, '자동 rotation은 금지한다');
      check(driver.spec.tokenRequests.map(request => request.audience).sort().join(',') === 'pods.eks.amazonaws.com,sts.amazonaws.com', 'Pod Identity audience가 필요하다');
      check(driver.spec.serviceAccountTokenInSecrets === true, 'Kubernetes 1.36 token forwarding이 필요하다');
      check(!resources.some(resource => resource.kind === 'ClusterRole' && resource.rules?.some(rule => rule.resources?.includes('secrets'))), 'Secret sync 권한을 추가하지 않는다');
    }
    if (key === 'ascp') {
      check(resources.filter(resource => resource.kind === 'DaemonSet').length === 1, 'ASCP는 driver를 다시 설치하지 않는다');
      const args = resources.find(resource => resource.kind === 'DaemonSet').spec.template.spec.containers[0].args;
      check(args.includes('--driver-writes-secrets=true'), '고정 driver의 atomic writer를 사용한다');
    }
    if (key === 'fluentBit') {
      const ds = resources.find(resource => resource.kind === 'DaemonSet');
      check(ds.spec.template.spec.serviceAccountName === 'fluent-bit', 'Fluent Bit Pod Identity SA가 다르다');
      const config = resources.find(resource => resource.kind === 'ConfigMap').data['fluent-bit.conf'];
      check(config.includes('Path /var/log/containers/*_pulsemetry-dev_*.log') && config.includes("Regex $kubernetes['namespace_name'] ^(pulsemetry-dev|pulsemetry-observability|pulsemetry-dev-logs)$"), 'app namespace 이중 filter가 필요하다');
      check(config.includes('auto_create_group Off'), 'CDK 로그 그룹 소유권을 유지한다');
      check(config.includes('DB /var/fluent-bit/state/tail.db') && config.includes('storage.type filesystem'), 'offset과 미전송 로그를 node-local 디스크에 남긴다');
      check(!/\blog_key\b/.test(config) && config.includes('Keep_Log On'), '원문과 Kubernetes metadata를 함께 보내야 한다');
      check(config.includes('Match application.*') && config.includes('Match observability.*'), '앱과 관측 스택 로그를 각각 전달한다');
      check(config.includes('storage.total_limit_size 512M') && config.includes('storage.total_limit_size 128M'), '재시도 buffer에 크기 상한이 필요하다');
      check(ds.spec.template.spec.tolerations.some(item => item.key === 'workload' && item.value === 'observability'), '관측 노드도 수집한다');
      check(ds.spec.template.spec.volumes.some(item => item.hostPath?.path === '/var/log/fluent-bit-state'), 'DB와 buffer를 Pod 재시작 후에도 보존한다');
      check(!config.includes('Name systemd') && !config.includes('Name es'), '다른 로그 전송을 포함하지 않는다');
    }
  }
  console.log('PASS: package SHA256·Helm lint/render·1.36 strict schema·SPC(telemetry JWT 포함)/CSI/ASCP/Fluent Bit·Gateway/관리 Job 경계');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
