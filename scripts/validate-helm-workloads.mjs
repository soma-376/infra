import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const root = resolve(import.meta.dirname, '..');
const helm = process.env.HELM_BIN ?? 'helm';
const kubeconform = process.env.KUBECONFORM_BIN ?? 'kubeconform';
const temporary = mkdtempSync(resolve(tmpdir(), 'pulsemetry-helm-'));
const digest = `sha256:${'a'.repeat(64)}`;
let fixtureId = 0;
let negativeCases = 0;
let renderedResources = 0;

function run(binary, args, options = {}) {
  const result = spawnSync(binary, args, { cwd: root, encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  return result;
}

function checked(binary, args) {
  const result = run(binary, args);
  assert.equal(result.status, 0, `${binary} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function fixture(values) {
  const filename = resolve(temporary, `values-${fixtureId++}.json`);
  writeFileSync(filename, JSON.stringify(values));
  return filename;
}

function chartArgs(release, chart, values, namespace = 'pulsemetry-dev') {
  return [release, chart, '--namespace', namespace, '--kube-version', '1.36.0', '-f', fixture(values)];
}

function render(release, chart, values) {
  const args = chartArgs(release, chart, values);
  checked(helm, ['lint', chart, '--strict', ...args.slice(2)]);
  const text = checked(helm, ['template', ...args]);
  const documents = yaml.loadAll(text).filter(Boolean);
  renderedResources += documents.length;
  for (const document of documents) {
    assert.equal(document.metadata.namespace, 'pulsemetry-dev');
    assert.notEqual(document.kind, 'Ingress');
    if (document.kind === 'Service') assert.notEqual(document.spec.type, 'LoadBalancer');
    assert.notEqual(document.kind, 'Secret');
  }
  return documents;
}

function rejects(release, chart, values, namespace) {
  const result = run(helm, ['template', ...chartArgs(release, chart, values, namespace)]);
  assert.notEqual(result.status, 0, `잘못된 입력을 허용했다: ${JSON.stringify(values)}`);
  negativeCases++;
}

function find(documents, kind, name) {
  const result = documents.find(document => document.kind === kind && document.metadata.name === name);
  assert.ok(result, `${kind}/${name} 누락`);
  return result;
}

function binding(stage, suffix) {
  return {
    stage,
    targetGroupARN: `arn:aws:elasticloadbalancing:ap-northeast-2:000000000000:targetgroup/soma-376-dev-eks-${suffix}/${'a'.repeat(16)}`,
    confirmExclusiveOwnership: true,
  };
}

function appValues(workload) {
  const defaults = yaml.load(readFileSync(resolve(root, `helm/dev/workloads/${workload}.yaml`), 'utf8'));
  return {
    ...defaults,
    image: { repository: `example.invalid/soma-376/${workload}`, digest },
    vpcId: 'vpc-0123456789abcdef0',
    targetGroupBindings: [binding('validation', `${workload}-v`), binding('canary', `${workload}-c`)],
  };
}

function checkBindings(documents, workload, targetType) {
  const bindings = documents.filter(document => document.kind === 'TargetGroupBinding');
  assert.equal(bindings.length, 2);
  assert.notEqual(bindings[0].spec.targetGroupARN, bindings[1].spec.targetGroupARN);
  for (const item of bindings) {
    assert.equal(item.apiVersion, 'elbv2.k8s.aws/v1beta1');
    assert.equal(item.spec.targetType, targetType);
    assert.equal(item.spec.vpcID, 'vpc-0123456789abcdef0');
    assert.deepEqual(item.spec.serviceRef, { name: workload, port: 'http' });
    assert.equal(item.spec.networking, undefined);
    assert.equal(item.spec.controllerClass, undefined);
    if (targetType === 'instance') {
      assert.deepEqual(item.spec.nodeSelector.matchLabels, {
        'kubernetes.io/arch': 'arm64', 'karpenter.sh/nodepool': 'pulsemetry-dev-apps',
      });
    } else assert.equal(item.spec.nodeSelector, undefined);
  }
}

function checkApp(documents, workload) {
  const deployment = find(documents, 'Deployment', workload);
  const pod = deployment.spec.template.spec;
  const container = pod.containers[0];
  const service = find(documents, 'Service', workload);
  const port = workload === 'telemetry-ingest' ? 4316 : 8080;
  assert.equal(deployment.spec.replicas, 1);
  assert.deepEqual(deployment.spec.strategy, { type: 'Recreate' });
  assert.deepEqual(deployment.spec.selector.matchLabels, deployment.spec.template.metadata.labels);
  assert.deepEqual(service.spec.selector, deployment.spec.selector.matchLabels);
  assert.equal(service.spec.type, 'NodePort');
  assert.deepEqual(service.spec.ports, [{ name: 'http', port, targetPort: 'http',
    nodePort: workload === 'telemetry-ingest' ? 30416 : 30080, protocol: 'TCP' }]);
  assert.deepEqual(container.ports, [{ name: 'http', containerPort: port, protocol: 'TCP' }]);
  assert.deepEqual(pod.nodeSelector, {
    'kubernetes.io/arch': 'arm64', 'karpenter.sh/nodepool': 'pulsemetry-dev-apps',
  });
  assert.equal(container.image, `example.invalid/soma-376/${workload}@${digest}`);
  assert.deepEqual(container.resources.requests, { cpu: '250m', memory: '1Gi' });
  assert.deepEqual(container.resources.limits, { cpu: '1', memory: '2Gi' });
  assert.deepEqual(container.readinessProbe.httpGet, { path: '/api/v1/healthz', port: 'http' });
  assert.equal(container.readinessProbe.timeoutSeconds, 6);
  assert.deepEqual(container.livenessProbe.tcpSocket, { port: 'http' });
  assert.equal(container.livenessProbe.httpGet, undefined);
  assert.equal(container.startupProbe.periodSeconds * container.startupProbe.failureThreshold,
    workload === 'telemetry-ingest' ? 240 : 60);
  assert.equal(pod.serviceAccountName, workload);
  assert.equal(find(documents, 'ServiceAccount', workload).automountServiceAccountToken, false);
  assert.deepEqual(pod.securityContext, {
    runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, fsGroup: 10001,
  });
  checkBindings(documents, workload, 'instance');
}

function checkRuntime(documents, workload, files) {
  const pod = find(documents, 'Deployment', workload).spec.template.spec;
  const container = pod.containers[0];
  assert.deepEqual(pod.volumes, [{ name: 'secrets-store', csi: {
    driver: 'secrets-store.csi.k8s.io', readOnly: true,
    volumeAttributes: { secretProviderClass: `${workload}-runtime` },
  } }]);
  const mounts = [{ name: 'secrets-store', mountPath: '/mnt/secrets-store', readOnly: true }];
  assert.deepEqual(container.volumeMounts, mounts);
  const init = pod.initContainers[0];
  assert.deepEqual(init.volumeMounts, mounts);
  assert.equal(init.image, container.image);
  assert.deepEqual(init.command, ['/bin/sh', '-ec']);
  for (const flag of ['-f', '-r', '-s']) assert.ok(init.args[0].includes(`test ${flag}`));
  for (const file of files) assert.ok(init.args[0].includes(file));
  assert.ok(!/\b(cat|echo|printenv)\b/.test(init.args[0]));
  assert.equal(container.env.filter(value => value.name === 'SPRING_CONFIG_IMPORT').length, 1);
  assert.equal(container.env.find(value => value.name === 'SPRING_CONFIG_IMPORT').value,
    'configtree:/mnt/secrets-store/');
  for (const file of files) assert.equal(container.env.find(value => value.name === file), undefined);
}

function checkClickhouse(documents) {
  const statefulset = find(documents, 'StatefulSet', 'clickhouse');
  const pod = statefulset.spec.template.spec;
  const container = pod.containers[0];
  assert.equal(statefulset.spec.replicas, 1);
  assert.equal(statefulset.spec.serviceName, 'clickhouse-headless');
  assert.deepEqual(statefulset.spec.persistentVolumeClaimRetentionPolicy,
    { whenDeleted: 'Retain', whenScaled: 'Retain' });
  assert.deepEqual(statefulset.spec.selector.matchLabels, statefulset.spec.template.metadata.labels);
  for (const name of ['clickhouse', 'clickhouse-headless']) {
    const service = find(documents, 'Service', name);
    assert.deepEqual(service.spec.selector, statefulset.spec.selector.matchLabels);
    assert.equal(service.spec.type, 'ClusterIP');
    assert.deepEqual(service.spec.ports.map(value => value.port), [8123, 9000]);
  }
  assert.equal(find(documents, 'Service', 'clickhouse-headless').spec.clusterIP, 'None');
  assert.equal(container.image, 'clickhouse/clickhouse-server:24.8-alpine');
  assert.deepEqual(Object.fromEntries(container.env.map(value => [value.name, value.value])), {
    CLICKHOUSE_DB: 'default', CLICKHOUSE_USER: 'default', CLICKHOUSE_PASSWORD: '',
    CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT: '1',
  });
  assert.deepEqual(pod.nodeSelector, {
    'kubernetes.io/arch': 'arm64', 'karpenter.sh/nodepool': 'pulsemetry-dev-clickhouse',
    'topology.kubernetes.io/zone': 'ap-northeast-2a',
  });
  assert.deepEqual(pod.tolerations,
    [{ key: 'workload', operator: 'Equal', value: 'clickhouse', effect: 'NoSchedule' }]);
  const claim = statefulset.spec.volumeClaimTemplates[0];
  assert.equal(claim.metadata.name, 'data');
  assert.equal(claim.spec.storageClassName, 'pulsemetry-dev-gp3');
  assert.equal(claim.spec.resources.requests.storage, '50Gi');
  assert.deepEqual(claim.spec.accessModes, ['ReadWriteOnce']);
  assert.deepEqual(container.volumeMounts, [{ name: 'data', mountPath: '/var/lib/clickhouse' }]);
  checkBindings(documents, 'clickhouse', 'ip');
}

function checkSchema(documents) {
  const filename = resolve(temporary, 'standard.yaml');
  writeFileSync(filename, documents.filter(value => value.kind !== 'TargetGroupBinding')
    .map(value => yaml.dump(value)).join('---\n'));
  const args = ['-strict', '-summary', '-kubernetes-version', '1.36.0'];
  if (process.env.KUBERNETES_SCHEMA_LOCATION) args.push('-schema-location', process.env.KUBERNETES_SCHEMA_LOCATION);
  checked(kubeconform, [...args, filename]);
  const bindingDocs = documents.filter(value => value.kind === 'TargetGroupBinding');
  if (bindingDocs.length) {
    const schemaLocation = process.env.TGB_SCHEMA_LOCATION ?? resolve(root,
      'helm/dev/platform/lbc/schemas/{{.ResourceKind}}_{{.Group}}_{{.ResourceAPIVersion}}.json');
    const bindings = resolve(temporary, 'targetgroupbindings.yaml');
    writeFileSync(bindings, bindingDocs.map(value => yaml.dump(value)).join('---\n'));
    checked(kubeconform, ['-strict', '-summary', '-schema-location', schemaLocation, bindings]);
  }
}

function checkPlatform() {
  const chart = 'helm/dev/platform/base';
  const values = {
    nodeRoleName: 'fixture-eks-node',
    subnetIds: ['subnet-0123456789abcdef0', 'subnet-1123456789abcdef0'],
    appNodeSecurityGroupId: 'sg-0123456789abcdef0',
    clickhouseNodeSecurityGroupId: 'sg-1123456789abcdef0',
    clickhouseAvailabilityZone: 'ap-northeast-2a',
  };
  const args = chartArgs('pulsemetry-dev-platform', chart, values);
  checked(helm, ['lint', chart, '--strict', ...args.slice(2)]);
  const documents = yaml.loadAll(checked(helm, ['template', ...args])).filter(Boolean);
  assert.equal(documents.length, 6);
  const namespace = find(documents, 'Namespace', 'pulsemetry-dev');
  assert.equal(namespace.metadata.annotations['helm.sh/resource-policy'], 'keep');
  const storage = find(documents, 'StorageClass', 'pulsemetry-dev-gp3');
  assert.equal(storage.provisioner, 'ebs.csi.eks.amazonaws.com');
  assert.equal(storage.volumeBindingMode, 'WaitForFirstConsumer');
  assert.equal(storage.reclaimPolicy, 'Retain');
  assert.deepEqual(storage.parameters, { type: 'gp3', encrypted: 'true' });
  assert.equal(storage.allowVolumeExpansion, true);
  assert.equal(storage.metadata.annotations['helm.sh/resource-policy'], 'keep');
  assert.deepEqual(storage.allowedTopologies[0].matchLabelExpressions, [
    { key: 'eks.amazonaws.com/compute-type', values: ['auto'] },
    { key: 'topology.kubernetes.io/zone', values: ['ap-northeast-2a'] },
  ]);
  for (const pool of ['apps', 'clickhouse']) {
    const name = `pulsemetry-dev-${pool}`;
    const nodeClass = find(documents, 'NodeClass', name);
    assert.equal(nodeClass.apiVersion, 'eks.amazonaws.com/v1');
    assert.equal(nodeClass.spec.role, values.nodeRoleName);
    assert.deepEqual(nodeClass.spec.subnetSelectorTerms, values.subnetIds.map(id => ({ id })));
    assert.deepEqual(nodeClass.spec.securityGroupSelectorTerms, [{ id: pool === 'apps'
      ? values.appNodeSecurityGroupId : values.clickhouseNodeSecurityGroupId }]);
    assert.deepEqual(nodeClass.spec.advancedNetworking, { associatePublicIPAddress: true });
    const nodePool = find(documents, 'NodePool', name);
    assert.equal(nodePool.apiVersion, 'karpenter.sh/v1');
    assert.deepEqual(nodePool.spec.template.metadata.labels, { 'pulsemetry.io/workload': pool });
    assert.deepEqual(nodePool.spec.template.spec.nodeClassRef, { group: 'eks.amazonaws.com', kind: 'NodeClass', name });
    const requirements = nodePool.spec.template.spec.requirements;
    assert.deepEqual(requirements.slice(0, 3), [
      { key: 'kubernetes.io/arch', operator: 'In', values: ['arm64'] },
      { key: 'karpenter.sh/capacity-type', operator: 'In', values: ['on-demand'] },
      { key: 'node.kubernetes.io/instance-type', operator: 'In', values: ['t4g.medium'] },
    ]);
    assert.equal(requirements.some(requirement => requirement.key === 'kubernetes.io/os'), false);
    if (pool === 'clickhouse') {
      assert.deepEqual(nodePool.spec.template.spec.taints,
        [{ key: 'workload', value: 'clickhouse', effect: 'NoSchedule' }]);
      assert.deepEqual(requirements[3], { key: 'topology.kubernetes.io/zone', operator: 'In', values: ['ap-northeast-2a'] });
    } else assert.equal(nodePool.spec.template.spec.taints, undefined);
    assert.equal(nodePool.spec.limits.cpu, pool === 'apps' ? '8' : '4');
  }
  // AWS가 배포하는 NodeClass/Auto Mode NodePool CRD는 live 설치 전 구조만 검사한다.
  checkSchema([namespace, storage]);
  return documents.length;
}

try {
  assert.match(checked(helm, ['version', '--short']), /^v3\.22\.0\+/);
  assert.match(checked(kubeconform, ['-v']), /^v0\.8\.0/);
  const chart = 'helm/dev/workloads/spring-app';
  const allDocuments = [];
  for (const workload of ['telemetry-ingest', 'enrollment-api']) {
    const values = appValues(workload);
    const base = render(workload, chart, values);
    checkApp(base, workload);
    assert.equal(find(base, 'Deployment', workload).spec.template.spec.volumes, undefined);
    const files = ['PULSEMETRY_DB_USERNAME', 'PULSEMETRY_DB_PASSWORD', 'PULSEMETRY_TOKEN_HASH_SECRET'];
    if (workload === 'enrollment-api') files.push('PULSEMETRY_ADMIN_API_TOKEN');
    const runtime = { enabled: true, secretProviderClass: `${workload}-runtime`, requiredFiles: files };
    const mounted = render(workload, chart, { ...values, runtime });
    checkApp(mounted, workload);
    checkRuntime(mounted, workload, files);
    allDocuments.push(...base, ...mounted);
    rejects(workload, chart, { ...values, image: { ...values.image, digest: '' } });
    rejects(workload, chart, { ...values, image: { ...values.image, digest: 'latest' } });
    rejects(workload, chart, { ...values, image: { ...values.image, repository: 'example.invalid/app:latest' } });
    rejects(workload, chart, { ...values, replicaCount: 2 });
    rejects(workload, chart, { ...values, resources: { limits: { memory: '512Mi' } } });
    rejects(workload, chart, { ...values, env: { PULSEMETRY_DB_PASSWORD: 'fixture-only' } });
    rejects(workload, chart, { ...values, env: { PULSEMETRY_ADMIN_API_TOKEN: 'fixture-only' } });
    rejects(workload, chart, { ...values, env: { SPRING_CONFIG_IMPORT: 'optional:configtree:/other/' } });
    rejects(workload, chart, { ...values, env: { SERVER_PORT: '4318' } });
    rejects(workload, chart, { ...values, runtime: { ...runtime, secretProviderClass: '' } });
    rejects(workload, chart, { ...values, runtime: { ...runtime, requiredFiles: files.slice(1) } });
    rejects(workload, chart, { ...values, runtime: { ...runtime, requiredFiles: [...files, files[0]] } });
    rejects(workload, chart, { ...values, targetGroupBindings: [binding('validation', 'v'), binding('validation', 'c')] });
    rejects(workload, chart, { ...values, targetGroupBindings: [binding('validation', 'same'), binding('canary', 'same')] });
    rejects(workload, chart, { ...values, targetGroupBindings: [{ ...binding('validation', 'v'), confirmExclusiveOwnership: false }] });
    rejects(workload, chart, { ...values, targetGroupBindings: [{ ...binding('validation', 'v'),
      targetGroupARN: 'arn:aws:elasticloadbalancing:ap-northeast-2:000000000000:targetgroup/ecs-ingest/aaaaaaaaaaaaaaaa' }] });
    rejects(workload, chart, { ...values, vpcId: '' });
    rejects(workload, chart, values, 'default');
    rejects(workload, chart, { ...values, nodePort: 30000 });
    if (workload === 'telemetry-ingest') {
      rejects(workload, chart, { ...values, env: { PULSEMETRY_INGEST_PORT: '4318' } });
      rejects(workload, chart, { ...values, runtime: { ...runtime, requiredFiles: [...files, 'PULSEMETRY_ADMIN_API_TOKEN'] } });
    }
  }
  const clickhouseChart = 'helm/dev/workloads/clickhouse';
  const clickhouseValues = {
    availabilityZone: 'ap-northeast-2a', vpcId: 'vpc-0123456789abcdef0',
    targetGroupBindings: [binding('validation', 'clickhouse-v'), binding('canary', 'clickhouse-c')],
  };
  const clickhouse = render('clickhouse', clickhouseChart, clickhouseValues);
  checkClickhouse(clickhouse);
  allDocuments.push(...clickhouse);
  rejects('clickhouse', clickhouseChart, { ...clickhouseValues, availabilityZone: '' });
  rejects('clickhouse', clickhouseChart, { ...clickhouseValues, availabilityZone: 'us-east-1a' });
  rejects('clickhouse', clickhouseChart, { ...clickhouseValues, storage: { className: 'gp2' } });
  rejects('clickhouse', clickhouseChart, { ...clickhouseValues, storage: { size: '20Gi' } });
  rejects('clickhouse', clickhouseChart, { ...clickhouseValues, replicaCount: 2 });
  rejects('clickhouse', clickhouseChart, { ...clickhouseValues, image: 'clickhouse/clickhouse-server:latest' });
  rejects('clickhouse', clickhouseChart, { ...clickhouseValues, targetGroupBindings: [binding('validation', 'same'), binding('canary', 'same')] });
  rejects('clickhouse', clickhouseChart, { ...clickhouseValues, vpcId: '' });
  rejects('clickhouse', clickhouseChart, clickhouseValues, 'default');
  checkSchema(allDocuments);
  const platformResources = checkPlatform();
  console.log(`Helm 3.22.0 / kubeconform 0.8.0: ${renderedResources}개 workload resource, ${platformResources}개 platform resource, ${negativeCases}개 실패 입력, workload/runtime 경계 통과 (AWS NodeClass/NodePool 구조 검사)`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
