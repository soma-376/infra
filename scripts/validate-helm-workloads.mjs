import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  if (['enrollment-api', 'telemetry-ingest', 'dashboard-api', 'telemetry-gateway'].includes(release)) {
    checkBlockedCerts(documents, release);
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

const TELEMETRY_KEYS = [{ kid: 'telemetry-2026.10', alias: 'telemetry-2026-10.pem' }];
// 실제 MSK 형식이다. cluster 이름의 하이픈이 빠진다(ADR-0035).
const BOOTSTRAP = [1, 2, 3].map(n => `b-${n}.soma376devtelemetry.abc123.c2.kafka.ap-northeast-2.amazonaws.com:9098`).join(',');

function telemetryJwt(workload) {
  return {
    enabled: true, secretProviderClass: `${workload}-telemetry-jwt`, publicVersionId: '4'.repeat(32), publicKeys: TELEMETRY_KEYS,
    ...(workload === 'enrollment-api' ? { privateVersionId: '5'.repeat(32), activeKid: 'telemetry-2026.10', issueEnabled: false } : {}),
  };
}

function kafka(workload) {
  const gateway = workload === 'telemetry-gateway';
  return {
    enabled: true, bootstrapServers: BOOTSTRAP, topic: 'pulsemetry-dev-telemetry-ingress-validation',
    ...(gateway ? {} : { consumerGroup: 'pulsemetry-dev-telemetry-ingest-validation' }),
    iamRoleArn: `arn:aws:iam::000000000000:role/fixture-msk-${gateway ? 'gateway' : 'ingest'}`,
    iamSessionName: `pulsemetry-dev-telemetry-${gateway ? 'gateway' : 'ingest'}`,
  };
}

function appValues(workload) {
  const defaults = yaml.load(readFileSync(resolve(root, `helm/dev/workloads/${workload}.yaml`), 'utf8'));
  return {
    ...defaults,
    image: { repository: `example.invalid/soma-376/${workload}`, digest },
    vpcId: 'vpc-0123456789abcdef0',
    targetGroupBindings: [binding('validation', `${workload}-v`), binding('canary', `${workload}-c`)],
    // Gateway는 telemetry 공개키와 Kafka 발행 설정이 없으면 렌더링을 거부한다.
    ...(workload === 'telemetry-gateway' ? { telemetryJwt: telemetryJwt(workload), kafka: kafka(workload), env: { AWS_REGION: 'ap-northeast-2' } } : {}),
  };
}

function environment(documents, workload) {
  const container = find(documents, 'Deployment', workload).spec.template.spec.containers[0];
  const names = (container.env ?? []).map(item => item.name);
  assert.equal(new Set(names).size, names.length, `${workload} env 이름이 중복된다`);
  return Object.fromEntries((container.env ?? []).map(item => [item.name, item.value]));
}

// chart의 실제 init shell을 fixture 디렉터리에 적용해 파일 누락·빈 파일을 거부하는지 확인한다.
function checkInit(documents, workload, files) {
  const init = find(documents, 'Deployment', workload).spec.template.spec.initContainers[0].args[0];
  const directory = mkdtempSync(resolve(temporary, 'init-'));
  let command = init;
  for (const mount of ['/mnt/secrets-store', '/mnt/user-jwt/keys', '/mnt/telemetry-jwt/keys']) {
    const local = resolve(directory, mount.replaceAll('/', '_'));
    mkdirSync(local);
    command = command.replaceAll(mount, local);
    for (const file of files[mount] ?? []) writeFileSync(resolve(local, file), 'fixture-only');
  }
  const check = () => run('/bin/sh', ['-ec', command]);
  const good = check();
  assert.equal(good.status, 0, good.stderr);
  assert.equal(good.stdout + good.stderr, '');
  for (const [mount, names] of Object.entries(files)) {
    for (const file of names) {
      const path = resolve(directory, mount.replaceAll('/', '_'), file);
      writeFileSync(path, '');
      assert.notEqual(check().status, 0, `${file} 빈 파일을 허용했다`);
      rmSync(path);
      assert.notEqual(check().status, 0, `${file} 누락을 허용했다`);
      writeFileSync(path, 'fixture-only');
      negativeCases += 2;
    }
  }
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

// liveness는 TCP가 기본이다. dual·kafka ingest만 멈춘 listener를 503으로 알리는 health를 HTTP로 본다.
function checkLiveness(container, listenerHealth) {
  if (listenerHealth) {
    assert.deepEqual(container.livenessProbe.httpGet, { path: '/api/v1/healthz', port: 'http' });
    assert.equal(container.livenessProbe.tcpSocket, undefined);
    assert.equal(container.livenessProbe.timeoutSeconds, 6);
  } else {
    assert.deepEqual(container.livenessProbe.tcpSocket, { port: 'http' });
    assert.equal(container.livenessProbe.httpGet, undefined);
  }
  assert.equal(container.livenessProbe.periodSeconds * container.livenessProbe.failureThreshold, 30);
}

function checkApp(documents, workload, grace = 60) {
  const deployment = find(documents, 'Deployment', workload);
  const pod = deployment.spec.template.spec;
  const container = pod.containers[0];
  const service = find(documents, 'Service', workload);
  const port = { 'telemetry-ingest': 4316, 'enrollment-api': 8080, 'dashboard-api': 8081, 'telemetry-gateway': 8082 }[workload];
  assert.equal(pod.terminationGracePeriodSeconds, grace);
  assert.equal(deployment.spec.replicas, 1);
  assert.deepEqual(deployment.spec.strategy, { type: 'Recreate' });
  assert.deepEqual(deployment.spec.selector.matchLabels, deployment.spec.template.metadata.labels);
  assert.deepEqual(service.spec.selector, deployment.spec.selector.matchLabels);
  assert.equal(service.spec.type, 'NodePort');
  assert.deepEqual(service.spec.ports, [{ name: 'http', port, targetPort: 'http',
    nodePort: { 'telemetry-ingest': 30416, 'enrollment-api': 30080, 'dashboard-api': 30081, 'telemetry-gateway': 30082 }[workload], protocol: 'TCP' }]);
  assert.equal(service.spec.externalTrafficPolicy, 'Cluster');
  assert.deepEqual(container.ports, [{ name: 'http', containerPort: port, protocol: 'TCP' }]);
  assert.deepEqual(pod.nodeSelector, {
    'kubernetes.io/arch': 'arm64', 'karpenter.sh/nodepool': 'pulsemetry-dev-apps',
  });
  assert.equal(container.image, `example.invalid/soma-376/${workload}@${digest}`);
  assert.deepEqual(container.resources.requests, { cpu: '250m', memory: '1Gi' });
  assert.deepEqual(container.resources.limits, { cpu: '1', memory: '2Gi' });
  assert.deepEqual(container.readinessProbe.httpGet, { path: '/api/v1/healthz', port: 'http' });
  assert.equal(container.readinessProbe.timeoutSeconds, 6);
  const mode = (container.env ?? []).find(item => item.name === 'PULSEMETRY_INGEST_MODE')?.value;
  checkLiveness(container, workload === 'telemetry-ingest' && ['dual', 'kafka'].includes(mode));
  assert.equal(container.startupProbe.periodSeconds * container.startupProbe.failureThreshold,
    workload === 'telemetry-ingest' ? 240 : 60);
  assert.equal(pod.serviceAccountName, workload);
  assert.equal(find(documents, 'ServiceAccount', workload).automountServiceAccountToken, false);
  assert.deepEqual(pod.securityContext, {
    runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, fsGroup: 10001,
  });
  checkBindings(documents, workload, 'instance');
}

function checkBlockedCerts(documents, workload) {
  const contents = readFileSync(resolve(root, 'helm/dev/workloads/spring-app/files/blocked.certs'), 'utf8');
  const configMap = find(documents, 'ConfigMap', `${workload}-blocked-certs`);
  assert.deepEqual(configMap.data, { 'blocked.certs': contents });
  const deployment = find(documents, 'Deployment', workload);
  assert.equal(deployment.spec.template.metadata.annotations['pulsemetry.io/blocked-certs-revision'],
    createHash('sha256').update(contents).digest('hex'));
  const pod = deployment.spec.template.spec;
  assert.deepEqual(pod.volumes.filter(volume => volume.name === 'blocked-certs'), [{
    name: 'blocked-certs', configMap: {
      name: `${workload}-blocked-certs`, defaultMode: 0o444,
      items: [{ key: 'blocked.certs', path: 'blocked.certs' }],
    },
  }]);
  assert.deepEqual(pod.containers[0].volumeMounts.filter(mount => mount.name === 'blocked-certs'), [{
    name: 'blocked-certs', mountPath: '/opt/java/openjdk/lib/security/blocked.certs',
    subPath: 'blocked.certs', readOnly: true,
  }]);
  for (const init of pod.initContainers ?? []) {
    assert.equal(init.volumeMounts.some(mount => mount.name === 'blocked-certs'), false);
  }
}

function checkRuntime(documents, workload, files) {
  const pod = find(documents, 'Deployment', workload).spec.template.spec;
  const container = pod.containers[0];
  assert.deepEqual(pod.volumes.filter(volume => volume.name !== 'blocked-certs'), [{ name: 'secrets-store', csi: {
    driver: 'secrets-store.csi.k8s.io', readOnly: true,
    volumeAttributes: { secretProviderClass: `${workload}-runtime` },
  } }]);
  const mounts = [{ name: 'secrets-store', mountPath: '/mnt/secrets-store', readOnly: true }];
  assert.deepEqual(container.volumeMounts.filter(mount => mount.name !== 'blocked-certs'), mounts);
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
  assert.equal(documents.filter(document => document.kind === 'TargetGroupBinding').length, 0);
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
    observabilityNodeSecurityGroupId: 'sg-2123456789abcdef0',
    clickhouseAvailabilityZone: 'ap-northeast-2a',
  };
  const args = chartArgs('pulsemetry-dev-platform', chart, values);
  checked(helm, ['lint', chart, '--strict', ...args.slice(2)]);
  const documents = yaml.loadAll(checked(helm, ['template', ...args])).filter(Boolean);
  assert.equal(documents.length, 10);
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
  const observationStorage = find(documents, 'StorageClass', 'gp3-observability');
  assert.equal(observationStorage.provisioner, 'ebs.csi.eks.amazonaws.com');
  assert.equal(observationStorage.reclaimPolicy, 'Retain');
  assert.equal(observationStorage.volumeBindingMode, 'WaitForFirstConsumer');
  assert.deepEqual(observationStorage.parameters, { type: 'gp3', encrypted: 'true' });
  const observationClass = find(documents, 'NodeClass', 'pulsemetry-observability');
  assert.deepEqual(observationClass.spec.securityGroupSelectorTerms, [{ id: values.observabilityNodeSecurityGroupId }]);
  const observationPool = find(documents, 'NodePool', 'pulsemetry-observability');
  assert.deepEqual(observationPool.spec.template.spec.taints, [{ key: 'workload', value: 'observability', effect: 'NoSchedule' }]);
  assert.deepEqual(observationPool.spec.template.metadata.labels, { 'pulsemetry.io/workload': 'observability' });
  assert.deepEqual(observationPool.spec.template.spec.requirements.find(rule => rule.key === 'node.kubernetes.io/instance-type').values, ['m7g.large']);
  checkSchema([namespace, storage, observationStorage, find(documents, 'Namespace', 'pulsemetry-observability')]);
  return documents.length;
}

// 별도 ClusterIP가 management 포트만 노출한다. 기존 business Service/TGB의 port는 그대로다.
function checkObservability(chart, clickhouseChart, clickhouseValues) {
  const documents = [];
  for (const workload of ['telemetry-gateway', 'telemetry-ingest']) {
    const rendered = render(workload, chart, { ...appValues(workload), metrics: { enabled: true } });
    const service = find(rendered, 'Service', `${workload}-metrics`);
    const pod = find(rendered, 'Deployment', workload).spec.template.spec;
    assert.equal(service.spec.type, 'ClusterIP');
    assert.deepEqual(service.spec.ports, [{ name: 'metrics', port: 9404, targetPort: 'metrics', protocol: 'TCP' }]);
    assert.deepEqual(service.spec.selector, find(rendered, 'Service', workload).spec.selector);
    assert.equal(environment(rendered, workload).MANAGEMENT_SERVER_PORT, '9404');
    assert.ok(pod.containers[0].ports.some(port => port.name === 'metrics' && port.containerPort === 9404));
    assert.equal(find(rendered, 'Service', workload).spec.ports.length, 1);
    documents.push(...rendered);
  }
  rejects('enrollment-api', chart, { ...appValues('enrollment-api'), metrics: { enabled: true } });
  rejects('telemetry-gateway', chart, { ...appValues('telemetry-gateway'), metrics: { enabled: true }, env: { MANAGEMENT_SERVER_PORT: '8082' } });
  // GC/safepoint 로그는 고정 문자열 하나만 허용한다. 임의 JVM 옵션 env는 거부한다.
  for (const workload of ['telemetry-gateway', 'telemetry-ingest']) {
    const enabled = render(workload, chart, { ...appValues(workload), jvm: { gcSafepointLog: true } });
    assert.equal(environment(enabled, workload).JDK_JAVA_OPTIONS, '-Xlog:gc,safepoint:stderr:utctime,level,tags');
    assert.equal(environment(render(workload, chart, appValues(workload)), workload).JDK_JAVA_OPTIONS, undefined);
    documents.push(...enabled);
  }
  for (const name of ['JDK_JAVA_OPTIONS', 'JAVA_TOOL_OPTIONS']) rejects('telemetry-ingest', chart, { ...appValues('telemetry-ingest'), env: { [name]: '-Xmx1g' } });
  rejects('telemetry-ingest', chart, { ...appValues('telemetry-ingest'), jvm: { gcSafepointLog: true, options: '-Xmx1g' } });
  const clickhouse = render('clickhouse', clickhouseChart, { ...clickhouseValues, observability: { enabled: true } });
  const config = find(clickhouse, 'ConfigMap', 'clickhouse-observability').data['observability.xml'];
  assert.ok(config.includes('<endpoint>/metrics</endpoint><port>9363</port>'));
  assert.ok(config.includes('<level>information</level><console>1</console>'));
  assert.ok(config.includes('<log remove="remove"/><errorlog remove="remove"/>'));
  const pod = find(clickhouse, 'StatefulSet', 'clickhouse').spec.template.spec;
  assert.ok(pod.containers[0].volumeMounts.some(mount => mount.subPath === 'observability.xml' && mount.readOnly));
  const metrics = find(clickhouse, 'Service', 'clickhouse-metrics');
  assert.equal(metrics.spec.type, 'ClusterIP');
  assert.deepEqual(metrics.spec.ports, [{ name: 'metrics', port: 9363, targetPort: 'metrics', protocol: 'TCP' }]);
  documents.push(...clickhouse);
  return documents;
}

const RUNTIME_FILES = {
  'telemetry-ingest': ['PULSEMETRY_DB_USERNAME', 'PULSEMETRY_DB_PASSWORD', 'PULSEMETRY_TOKEN_HASH_SECRET'],
  'enrollment-api': ['PULSEMETRY_DB_USERNAME', 'PULSEMETRY_DB_PASSWORD', 'PULSEMETRY_TOKEN_HASH_SECRET', 'PULSEMETRY_ADMIN_API_TOKEN'],
};

function telemetryVolume(workload) {
  return { name: 'telemetry-jwt', csi: { driver: 'secrets-store.csi.k8s.io', readOnly: true,
    volumeAttributes: { secretProviderClass: `${workload}-telemetry-jwt` } } };
}
const TELEMETRY_MOUNT = { name: 'telemetry-jwt', mountPath: '/mnt/telemetry-jwt/keys', readOnly: true };
const TELEMETRY_FILES = { '[telemetry-2026.10]': '/mnt/telemetry-jwt/keys/telemetry-2026-10.pem' };

// PROJ-246: Gateway·ingest 모드·telemetry JWT 경계를 실제 render로 검사한다. (ADR-0036)
function checkTelemetry(chart) {
  const documents = [];
  // Gateway: configtree·사용자 JWT 없이 공개키 mount와 Kafka 발행 설정만 받는다.
  const gatewayValues = appValues('telemetry-gateway');
  const gateway = render('telemetry-gateway', chart, gatewayValues);
  documents.push(...gateway);
  checkApp(gateway, 'telemetry-gateway', 60);
  const gatewayPod = find(gateway, 'Deployment', 'telemetry-gateway').spec.template.spec;
  assert.deepEqual(gatewayPod.volumes.filter(volume => volume.name !== 'blocked-certs'), [telemetryVolume('telemetry-gateway')]);
  assert.deepEqual(gatewayPod.containers[0].volumeMounts.filter(mount => mount.name !== 'blocked-certs'), [TELEMETRY_MOUNT]);
  assert.deepEqual(gatewayPod.initContainers[0].volumeMounts, [TELEMETRY_MOUNT]);
  assert.ok(!gatewayPod.initContainers[0].args[0].includes('/mnt/secrets-store'));
  assert.ok(!gatewayPod.initContainers[0].args[0].includes('private.pem'));
  checkInit(gateway, 'telemetry-gateway', { '/mnt/telemetry-jwt/keys': ['telemetry-2026-10.pem'] });
  const gatewayEnv = environment(gateway, 'telemetry-gateway');
  assert.deepEqual(gatewayEnv, {
    SPRING_APPLICATION_JSON: JSON.stringify({ pulsemetry: { 'telemetry-jwt': { 'public-key-files': TELEMETRY_FILES } } }),
    PULSEMETRY_KAFKA_BOOTSTRAP_SERVERS: BOOTSTRAP, PULSEMETRY_KAFKA_SECURITY: 'iam',
    PULSEMETRY_KAFKA_TOPIC: 'pulsemetry-dev-telemetry-ingress-validation',
    PULSEMETRY_KAFKA_IAM_ROLE_ARN: 'arn:aws:iam::000000000000:role/fixture-msk-gateway',
    PULSEMETRY_KAFKA_IAM_SESSION_NAME: 'pulsemetry-dev-telemetry-gateway', AWS_REGION: 'ap-northeast-2',
  });
  const revision = find(gateway, 'Deployment', 'telemetry-gateway').spec.template.metadata.annotations['pulsemetry.io/telemetry-jwt-revision'];
  assert.match(revision, /^[a-f0-9]{64}$/);
  const rotated = render('telemetry-gateway', chart, { ...gatewayValues, telemetryJwt: { ...gatewayValues.telemetryJwt, publicVersionId: '6'.repeat(32) } });
  assert.notEqual(find(rotated, 'Deployment', 'telemetry-gateway').spec.template.metadata.annotations['pulsemetry.io/telemetry-jwt-revision'], revision);
  // bootstrap 목록은 모든 broker를 담지 않을 수 있다. 일부 주소도 그대로 env에 들어간다.
  const partial = BOOTSTRAP.split(',').slice(0, 1).join(',');
  const partialGateway = render('telemetry-gateway', chart, { ...gatewayValues, kafka: { ...gatewayValues.kafka, bootstrapServers: partial } });
  assert.equal(environment(partialGateway, 'telemetry-gateway').PULSEMETRY_KAFKA_BOOTSTRAP_SERVERS, partial);
  const gw = gatewayValues;
  for (const invalid of [
    { ...gw, runtime: { enabled: true, secretProviderClass: 'telemetry-gateway-runtime', requiredFiles: RUNTIME_FILES['telemetry-ingest'] } },
    { ...gw, jwt: { enabled: true, secretProviderClass: 'telemetry-gateway-jwt', publicVersionId: '2'.repeat(32), publicKeys: TELEMETRY_KEYS } },
    { ...gw, userAuth: { issuer: 'https://issuer.example.invalid', audience: 'pulsemetry-dev', allowedOrigins: ['https://dashboard.example.invalid'] } },
    { ...gw, telemetryJwt: { enabled: false } },
    { ...gw, kafka: { enabled: false } },
    { ...gw, telemetryJwt: { ...gw.telemetryJwt, privateVersionId: '5'.repeat(32) } },
    { ...gw, telemetryJwt: { ...gw.telemetryJwt, issueEnabled: true } },
    { ...gw, telemetryJwt: { ...gw.telemetryJwt, secretProviderClass: 'telemetry-ingest-telemetry-jwt' } },
    { ...gw, telemetryJwt: { ...gw.telemetryJwt, issuer: 'https://issuer.example.invalid' } },
    { ...gw, telemetryJwt: { ...gw.telemetryJwt, publicKeys: [{ kid: 'telemetry-2026.10', alias: 'private.pem' }] } },
    { ...gw, kafka: { ...gw.kafka, consumerGroup: 'pulsemetry-dev-telemetry-ingest-validation' } },
    { ...gw, kafka: { ...gw.kafka, iamSessionName: 'pulsemetry-dev-telemetry-ingest' } },
    { ...gw, kafka: { ...gw.kafka, bootstrapServers: 'b-1.soma376devtelemetry.abc123.c2.kafka.ap-northeast-2.amazonaws.com:9092' } },
    { ...gw, kafka: { ...gw.kafka, bootstrapServers: `${BOOTSTRAP},b-4.soma376devtelemetry.abc123.c2.kafka.ap-northeast-2.amazonaws.com:9098` } },
    { ...gw, kafka: { ...gw.kafka, topic: 'pulsemetry-dev-telemetry-ingress-other' } },
    { ...gw, kafka: { ...gw.kafka, iamRoleArn: '*' } },
    { ...gw, env: { PULSEMETRY_DB_URL: 'jdbc:postgresql://db.example.invalid:5432/controlplane' } },
    { ...gw, env: { PULSEMETRY_ARCHIVE_BUCKET: 'fixture' } },
    { ...gw, env: { PULSEMETRY_KAFKA_TOPIC: 'override' } },
    { ...gw, env: { PULSEMETRY_TELEMETRY_JWT_ISSUER: 'override' } },
    { ...gw, env: { AWS_ACCESS_KEY_ID: 'fixture-only' } },
    { ...gw, env: { AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://169.254.170.23/v1/credentials' } },
    { ...gw, service: { type: 'ClusterIP' }, targetGroupBindings: [] },
    { ...gw, nodePort: 30081 },
    { ...gw, ingestMode: 'kafka' },
    (({ nodePort, ...rest }) => rest)(gw),
    (({ kafka: _kafka, ...rest }) => rest)(gw),
  ]) rejects('telemetry-gateway', chart, invalid);

  // ingest: http는 기존 경로, dual은 HTTP+Consumer, kafka는 ClusterIP health만 둔다.
  for (const mode of ['http', 'dual', 'kafka']) {
    const values = {
      ...appValues('telemetry-ingest'), ingestMode: mode, telemetryJwt: telemetryJwt('telemetry-ingest'),
      runtime: { enabled: true, secretProviderClass: 'telemetry-ingest-runtime', requiredFiles: RUNTIME_FILES['telemetry-ingest'] },
      ...(mode === 'http' ? {} : { kafka: kafka('telemetry-ingest') }),
      ...(mode === 'kafka' ? { service: { type: 'ClusterIP' }, targetGroupBindings: [] } : {}),
    };
    const ingest = render('telemetry-ingest', chart, values);
    documents.push(...ingest);
    const grace = mode === 'http' ? 60 : 90;
    if (mode === 'kafka') {
      const service = find(ingest, 'Service', 'telemetry-ingest');
      assert.equal(service.spec.type, 'ClusterIP');
      assert.equal(service.spec.externalTrafficPolicy, undefined);
      assert.deepEqual(service.spec.ports, [{ name: 'http', port: 4316, targetPort: 'http', protocol: 'TCP' }]);
      assert.equal(ingest.filter(document => document.kind === 'TargetGroupBinding').length, 0);
      assert.equal(find(ingest, 'Deployment', 'telemetry-ingest').spec.template.spec.terminationGracePeriodSeconds, grace);
    } else checkApp(ingest, 'telemetry-ingest', grace);
    const pod = find(ingest, 'Deployment', 'telemetry-ingest').spec.template.spec;
    assert.deepEqual(pod.volumes.map(volume => volume.name), ['secrets-store', 'telemetry-jwt', 'blocked-certs']);
    assert.deepEqual(pod.volumes[1], telemetryVolume('telemetry-ingest'));
    assert.deepEqual(pod.initContainers[0].volumeMounts, pod.containers[0].volumeMounts.filter(mount => mount.name !== 'blocked-certs'));
    assert.deepEqual(pod.containers[0].volumeMounts[1], TELEMETRY_MOUNT);
    checkLiveness(pod.containers[0], mode !== 'http');
    const env = environment(ingest, 'telemetry-ingest');
    assert.equal(env.PULSEMETRY_INGEST_MODE, mode);
    // 관측 ServiceMonitor가 이 annotation을 ingest_mode target label로 옮긴다.
    assert.equal(find(ingest, 'Deployment', 'telemetry-ingest').spec.template.metadata.annotations['pulsemetry.io/ingest-mode'], mode);
    assert.deepEqual(JSON.parse(env.SPRING_APPLICATION_JSON), { pulsemetry: { 'telemetry-jwt': { 'public-key-files': TELEMETRY_FILES } } });
    const kafkaEnv = Object.keys(env).filter(name => name.startsWith('PULSEMETRY_KAFKA_')).sort();
    if (mode === 'http') assert.deepEqual(kafkaEnv, []);
    else {
      assert.deepEqual(kafkaEnv, ['PULSEMETRY_KAFKA_BOOTSTRAP_SERVERS', 'PULSEMETRY_KAFKA_CONSUMER_GROUP', 'PULSEMETRY_KAFKA_IAM_ROLE_ARN',
        'PULSEMETRY_KAFKA_IAM_SESSION_NAME', 'PULSEMETRY_KAFKA_SECURITY', 'PULSEMETRY_KAFKA_TOPIC']);
      assert.equal(env.PULSEMETRY_KAFKA_CONSUMER_GROUP, 'pulsemetry-dev-telemetry-ingest-validation');
      assert.equal(env.PULSEMETRY_KAFKA_IAM_SESSION_NAME, 'pulsemetry-dev-telemetry-ingest');
    }
    for (const name of ['PULSEMETRY_USER_AUTH_ENABLED', 'PULSEMETRY_USER_AUTH_PRIVATE_KEY_FILE']) assert.equal(env[name], undefined);
    if (mode === 'dual') {
      checkInit(ingest, 'telemetry-ingest', { '/mnt/secrets-store': RUNTIME_FILES['telemetry-ingest'], '/mnt/telemetry-jwt/keys': ['telemetry-2026-10.pem'] });
      for (const invalid of [
        { ...values, kafka: { enabled: false } },
        { ...values, kafka: (({ consumerGroup, ...rest }) => rest)(values.kafka) },
        { ...values, kafka: { ...values.kafka, iamSessionName: 'pulsemetry-dev-telemetry-gateway' } },
        { ...values, ingestMode: 'http' },
        { ...values, ingestMode: 'kafka' },
        { ...values, ingestMode: 'consumer' },
        { ...values, service: { type: 'ClusterIP' } },
        { ...values, service: { type: 'LoadBalancer' } },
        { ...values, telemetryJwt: { ...values.telemetryJwt, privateVersionId: '5'.repeat(32), activeKid: 'telemetry-2026.10' } },
        { ...values, telemetryJwt: { ...values.telemetryJwt, secretProviderClass: 'telemetry-gateway-telemetry-jwt' } },
        { ...values, env: { ...values.env, PULSEMETRY_INGEST_MODE: 'kafka' } },
        { ...values, env: { ...values.env, PULSEMETRY_KAFKA_CONSUMER_GROUP: 'other' } },
        (({ ingestMode, ...rest }) => rest)(values),
      ]) rejects('telemetry-ingest', chart, invalid);
    }
    if (mode === 'kafka') {
      rejects('telemetry-ingest', chart, { ...values, targetGroupBindings: [binding('validation', 'telemetry-ingest-v')] });
      rejects('telemetry-ingest', chart, { ...values, service: { type: 'NodePort' } });
    }
  }

  // enrollment: 사용자 JWT·OIDC 맵을 유지하고 telemetry JWT 서명 설정을 같은 SPRING_APPLICATION_JSON에 합친다.
  const enrollmentValues = {
    ...appValues('enrollment-api'),
    runtime: { enabled: true, secretProviderClass: 'enrollment-api-runtime', requiredFiles: RUNTIME_FILES['enrollment-api'] },
    userAuth: { issuer: 'https://issuer.example.invalid', audience: 'pulsemetry-dev', allowedOrigins: ['https://dashboard.example.invalid'] },
    jwt: { enabled: true, secretProviderClass: 'enrollment-api-jwt', publicVersionId: '2'.repeat(32), privateVersionId: '1'.repeat(32),
      activeKid: 'release-2026.10', publicKeys: [{ kid: 'release-2026.10', alias: 'release-2026-10.pem' }] },
    telemetryJwt: telemetryJwt('enrollment-api'),
  };
  for (const issueEnabled of [false, true]) {
    const enrollment = render('enrollment-api', chart, { ...enrollmentValues, telemetryJwt: { ...enrollmentValues.telemetryJwt, issueEnabled } });
    documents.push(...enrollment);
    checkApp(enrollment, 'enrollment-api', 60);
    const pod = find(enrollment, 'Deployment', 'enrollment-api').spec.template.spec;
    assert.deepEqual(pod.volumes.map(volume => volume.name), ['secrets-store', 'user-jwt', 'telemetry-jwt', 'blocked-certs']);
    assert.deepEqual(pod.volumes[2], telemetryVolume('enrollment-api'));
    assert.deepEqual(pod.initContainers[0].volumeMounts, pod.containers[0].volumeMounts.filter(mount => mount.name !== 'blocked-certs'));
    const env = environment(enrollment, 'enrollment-api');
    assert.deepEqual(JSON.parse(env.SPRING_APPLICATION_JSON), { pulsemetry: {
      'user-auth': { 'public-key-files': { '[release-2026.10]': '/mnt/user-jwt/keys/release-2026-10.pem' } },
      'telemetry-jwt': { 'public-key-files': TELEMETRY_FILES,
        'active-kid': 'telemetry-2026.10', 'private-key-file': '/mnt/telemetry-jwt/keys/private.pem', 'issue-enabled': issueEnabled },
    } });
    assert.equal(env.PULSEMETRY_USER_AUTH_PRIVATE_KEY_FILE, '/mnt/user-jwt/keys/private.pem');
    for (const name of Object.keys(env)) assert.ok(!name.startsWith('PULSEMETRY_KAFKA_') && name !== 'PULSEMETRY_INGEST_MODE');
    if (!issueEnabled) checkInit(enrollment, 'enrollment-api', { '/mnt/secrets-store': RUNTIME_FILES['enrollment-api'],
      '/mnt/user-jwt/keys': ['release-2026-10.pem', 'private.pem'], '/mnt/telemetry-jwt/keys': ['telemetry-2026-10.pem', 'private.pem'] });
  }
  const et = enrollmentValues.telemetryJwt;
  for (const invalid of [
    { ...enrollmentValues, telemetryJwt: (({ privateVersionId, ...rest }) => rest)(et) },
    { ...enrollmentValues, telemetryJwt: (({ issueEnabled, ...rest }) => rest)(et) },
    { ...enrollmentValues, telemetryJwt: { ...et, activeKid: 'missing' } },
    { ...enrollmentValues, telemetryJwt: { ...et, privateVersionId: 'AWSCURRENT' } },
    { ...enrollmentValues, telemetryJwt: { ...et, secretProviderClass: 'enrollment-api-jwt' } },
    { ...enrollmentValues, telemetryJwt: { ...et, audience: 'pulsemetry-dev' } },
    { ...enrollmentValues, kafka: kafka('telemetry-ingest') },
    { ...enrollmentValues, ingestMode: 'http' },
  ]) rejects('enrollment-api', chart, invalid);
  // dashboard는 telemetry 키·Kafka를 받지 않는다.
  const dashboard = appValues('dashboard-api');
  rejects('dashboard-api', chart, { ...dashboard, telemetryJwt: { ...telemetryJwt('telemetry-ingest'), secretProviderClass: 'enrollment-api-telemetry-jwt' } });
  rejects('dashboard-api', chart, { ...dashboard, kafka: kafka('telemetry-ingest') });
  return documents;
}

const KAFKA_ADMIN_VALUES = {
  bootstrapServers: BOOTSTRAP, stage: 'validation',
  topic: 'pulsemetry-dev-telemetry-ingress-validation', consumerGroup: 'pulsemetry-dev-telemetry-ingest-validation',
  topicAdmin: { roleArn: 'arn:aws:iam::000000000000:role/fixture-topic-admin', sessionName: 'pulsemetry-dev-telemetry-kafka-admin' },
  offsetAdmin: { roleArn: 'arn:aws:iam::000000000000:role/fixture-offset-admin', sessionName: 'pulsemetry-dev-telemetry-kafka-offsets' },
};

// Kafka CLI를 기록용 stub으로 바꿔 Job의 실제 shell을 실행한다. MSK·AWS에는 접속하지 않는다.
function runJobScript(job, stub) {
  const container = job.spec.template.spec.containers[0];
  const directory = mkdtempSync(resolve(temporary, 'kafka-stub-'));
  const log = resolve(directory, 'calls.log');
  writeFileSync(log, '');
  const tool = (name, body) => {
    const path = resolve(directory, name);
    writeFileSync(path, `#!/bin/sh\necho "${name} $*" >> "$STUB_LOG"\n${body}\n`, { mode: 0o755 });
  };
  tool('kafka-topics.sh', 'case "$*" in *--describe*) printf "Topic: %s\\tTopicId: x\\tPartitionCount: %s\\tReplicationFactor: %s\\tConfigs: x\\n\\tTopic: %s\\tPartition: 0\\n" "$PULSEMETRY_KAFKA_TOPIC" "$STUB_PARTITIONS" "$STUB_RF" "$PULSEMETRY_KAFKA_TOPIC";; esac');
  tool('kafka-configs.sh', 'printf "%s\\n" "$STUB_CONFIGS"');
  tool('kafka-consumer-groups.sh', 'case "$*" in *--state*) printf "%s\\n" "$STUB_STATE";; *--to-current*) printf "%s\\n" "$STUB_CURRENT";; *--reset-offsets*) printf "%s\\n" "$STUB_RESET";; esac');
  const env = { PATH: process.env.PATH, ...Object.fromEntries(container.env.map(item => [item.name, item.value])),
    KAFKA_BIN: directory, CLIENT_CONFIG: resolve(directory, 'client.properties'), STUB_LOG: log, ...stub };
  const result = run('/bin/sh', ['-ec', container.args[0]], { env });
  return { status: result.status, output: result.stdout + result.stderr, calls: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) };
}

const GOOD_CONFIGS = [
  'All configs for topic pulsemetry-dev-telemetry-ingress-validation are:',
  '  cleanup.policy=delete sensitive=false synonyms={DYNAMIC_TOPIC_CONFIG:cleanup.policy=delete}',
  '  max.message.bytes=13631488 sensitive=false synonyms={DYNAMIC_TOPIC_CONFIG:max.message.bytes=13631488, STATIC_BROKER_CONFIG:message.max.bytes=13631488}',
  '  min.insync.replicas=2 sensitive=false synonyms={DYNAMIC_TOPIC_CONFIG:min.insync.replicas=2, STATIC_BROKER_CONFIG:min.insync.replicas=2}',
  '  retention.ms=259200000 sensitive=false synonyms={DYNAMIC_TOPIC_CONFIG:retention.ms=259200000}',
  '  unclean.leader.election.enable=false sensitive=false synonyms={DYNAMIC_TOPIC_CONFIG:unclean.leader.election.enable=false}',
].join('\n');

// PROJ-246: topic 초기화와 수동 offset Job의 IAM client 설정·고정 이미지·대조 shell을 검사한다. (ADR-0035·0036)
function checkKafkaAdmin() {
  const chart = 'helm/dev/workloads/telemetry-kafka-admin';
  const documents = render('telemetry-kafka-admin', chart, KAFKA_ADMIN_VALUES);
  assert.deepEqual(documents.map(document => `${document.kind}/${document.metadata.name}`).sort(), [
    'ConfigMap/telemetry-kafka-admin-client', 'ConfigMap/telemetry-kafka-offsets-client', 'Job/telemetry-topic-init-r1',
    'ServiceAccount/telemetry-kafka-admin', 'ServiceAccount/telemetry-kafka-offsets',
  ]);
  for (const name of ['telemetry-kafka-admin', 'telemetry-kafka-offsets']) assert.equal(find(documents, 'ServiceAccount', name).automountServiceAccountToken, false);
  for (const [name, role] of [['telemetry-kafka-admin-client', KAFKA_ADMIN_VALUES.topicAdmin], ['telemetry-kafka-offsets-client', KAFKA_ADMIN_VALUES.offsetAdmin]]) {
    assert.equal(find(documents, 'ConfigMap', name).data['client.properties'], [
      'security.protocol=SASL_SSL', 'sasl.mechanism=AWS_MSK_IAM',
      `sasl.jaas.config=software.amazon.msk.auth.iam.IAMLoginModule required awsRoleArn="${role.roleArn}" awsRoleSessionName="${role.sessionName}" awsStsRegion="ap-northeast-2";`,
      'sasl.client.callback.handler.class=software.amazon.msk.auth.iam.IAMClientCallbackHandler', ''].join('\n'));
  }
  const job = find(documents, 'Job', 'telemetry-topic-init-r1');
  const pod = job.spec.template.spec;
  assert.equal(job.spec.backoffLimit, 0);
  assert.equal(pod.restartPolicy, 'Never');
  assert.equal(pod.serviceAccountName, 'telemetry-kafka-admin');
  assert.deepEqual(pod.nodeSelector, { 'kubernetes.io/arch': 'arm64', 'karpenter.sh/nodepool': 'pulsemetry-dev-apps' });
  const image = 'docker.io/apache/kafka@sha256:05b4616e0702ef2729327705d54ad6b50ea70b271c4b730fabd2320789fb7b02';
  assert.equal(pod.initContainers[0].image, image);
  assert.equal(pod.containers[0].image, image);
  const initEnv = Object.fromEntries(pod.initContainers[0].env.map(item => [item.name, item.value]));
  assert.equal(initEnv.JAR_URL, 'https://github.com/aws/aws-msk-iam-auth/releases/download/v2.3.9/aws-msk-iam-auth-2.3.9-all.jar');
  assert.equal(initEnv.JAR_SHA256, '922064f312ddc8a5f3dbe65fcef3d02ddbd588a02e3a6f0fca4b5a4dbec1ba43');
  assert.ok(pod.initContainers[0].args[0].includes('sha256sum -c -'));
  for (const container of [...pod.initContainers, ...pod.containers]) {
    assert.deepEqual(container.securityContext, { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } });
  }
  assert.deepEqual(pod.volumes.find(volume => volume.name === 'client-config'), { name: 'client-config', configMap: { name: 'telemetry-kafka-admin-client' } });
  assert.ok(!JSON.stringify(documents).match(/secretKeyRef|kind":"Secret|AWS_ACCESS_KEY_ID/));
  // topic 초기화 shell: 없을 때만 생성하고, 다르면 실패하며 다시 만들지 않는다.
  const good = runJobScript(job, { STUB_PARTITIONS: '6', STUB_RF: '3', STUB_CONFIGS: GOOD_CONFIGS });
  assert.equal(good.status, 0, good.output);
  assert.match(good.calls[0], /--create --if-not-exists --topic pulsemetry-dev-telemetry-ingress-validation --partitions 6 --replication-factor 3 --config min.insync.replicas=2 --config retention.ms=259200000 --config cleanup.policy=delete --config max.message.bytes=13631488 --config unclean.leader.election.enable=false$/);
  assert.equal(good.calls.filter(call => call.includes('--create')).length, 1);
  assert.ok(!good.calls.some(call => /--delete|--alter/.test(call)));
  for (const stub of [
    { STUB_PARTITIONS: '3', STUB_RF: '3', STUB_CONFIGS: GOOD_CONFIGS },
    { STUB_PARTITIONS: '6', STUB_RF: '2', STUB_CONFIGS: GOOD_CONFIGS },
    { STUB_PARTITIONS: '6', STUB_RF: '3', STUB_CONFIGS: GOOD_CONFIGS.replace('  min.insync.replicas=2 sensitive', '  min.insync.replicas=1 sensitive') },
    { STUB_PARTITIONS: '6', STUB_RF: '3', STUB_CONFIGS: GOOD_CONFIGS.replace('  unclean.leader.election.enable=false', '  unclean.leader.election.enable=true') },
    { STUB_PARTITIONS: '6', STUB_RF: '3', STUB_CONFIGS: GOOD_CONFIGS.replace('  max.message.bytes=13631488 sensitive', '  max.message.bytes=1048588 sensitive') },
    { STUB_PARTITIONS: '60', STUB_RF: '3', STUB_CONFIGS: GOOD_CONFIGS },
  ]) {
    const result = runJobScript(job, stub);
    assert.notEqual(result.status, 0, `불일치 topic을 통과시켰다: ${JSON.stringify(stub)}`);
    assert.match(result.output, /불일치/);
    assert.equal(result.calls.filter(call => call.includes('--create')).length, 1);
    negativeCases++;
  }
  const kafkaDocuments = [...documents];
  // offset Job: 기본 plan은 --dry-run, execute는 명시적 입력이며 group이 비어 있어야 한다.
  for (const offsets of [
    { enabled: true, mode: 'plan', toDatetime: '2026-10-21T00:00:00.000+09:00' },
    { enabled: true, mode: 'execute', partition: 2, toOffset: 1234 },
  ]) {
    const rendered = render('telemetry-kafka-admin', chart, { ...KAFKA_ADMIN_VALUES, topicInit: { enabled: false }, offsets });
    kafkaDocuments.push(...rendered);
    const offsetsJob = find(rendered, 'Job', `telemetry-offsets-${offsets.mode}-r1`);
    assert.equal(rendered.filter(document => document.kind === 'Job').length, 1);
    const offsetsPod = offsetsJob.spec.template.spec;
    assert.equal(offsetsPod.serviceAccountName, 'telemetry-kafka-offsets');
    assert.deepEqual(offsetsPod.volumes.find(volume => volume.name === 'client-config').configMap, { name: 'telemetry-kafka-offsets-client' });
    // CLI는 `--export`에서 `topic,partition,offset` CSV를 낸다. execute 뒤에는 --to-current로 committed offset을 다시 읽는다.
    const topic = 'pulsemetry-dev-telemetry-ingress-validation';
    const planned = offsets.mode === 'plan' ? [0, 1, 2, 3, 4, 5].map(p => `${topic},${p},${100 + p}`).join('\n') : `${topic},2,1234`;
    const header = 'GROUP COORDINATOR (ID) ASSIGNMENT-STRATEGY STATE #MEMBERS';
    const emptyState = `${header}\npulsemetry-dev-telemetry-ingest-validation b-1:9098 (1) range Empty 0`;
    const reset = (state, stub = {}) => runJobScript(offsetsJob, { STUB_STATE: state, STUB_RESET: planned, STUB_CURRENT: planned, ...stub });
    const empty = reset(emptyState);
    assert.equal(empty.status, 0, empty.output);
    const resetCall = empty.calls.find(call => call.includes('--reset-offsets'));
    assert.ok(resetCall.endsWith(offsets.mode === 'plan' ? '--export --dry-run' : '--export --execute'), resetCall);
    assert.ok(resetCall.includes(offsets.mode === 'plan'
      ? `--topic ${topic} --to-datetime 2026-10-21T00:00:00.000+09:00`
      : `--topic ${topic}:2 --to-offset 1234`), resetCall);
    const verifyCall = empty.calls.find(call => call.includes('--to-current'));
    assert.equal(Boolean(verifyCall), offsets.mode === 'execute');
    if (verifyCall) assert.ok(verifyCall.endsWith(`--topic ${topic}:2 --to-current --export --dry-run`), verifyCall);
    const missing = reset("Consumer group 'pulsemetry-dev-telemetry-ingest-validation' does not exist.");
    assert.equal(missing.status, 0, missing.output);
    // Kafka 3.9.2 CLI는 아래 실패를 `Error:` 출력과 종료 코드 0으로 끝낸다. Job은 실패해야 한다.
    const failures = [
      { STUB_RESET: '\nError: Executing consumer group command failed due to org.apache.kafka.common.errors.TimeoutException: timed out' },
      { STUB_RESET: "\nError: Assignments can only be reset if the group 'pulsemetry-dev-telemetry-ingest-validation' is inactive, but the current state is Stable." },
      { STUB_RESET: '' },
      { STUB_RESET: `${topic.replace('validation', 'main')},2,1234` },
    ];
    if (offsets.mode === 'execute') {
      failures.push(
        { STUB_RESET: `${topic},3,1234` },
        { STUB_CURRENT: `${topic},2,1000` },
        { STUB_CURRENT: '' },
        { STUB_CURRENT: "\nError: Assignments can only be reset if the group 'pulsemetry-dev-telemetry-ingest-validation' is inactive, but the current state is Stable." },
      );
      // 범위를 벗어난 목표는 CLI가 보정한다. 입력값이 아니라 CLI 계획과 committed offset을 대조한다.
      const clamped = reset(emptyState, { STUB_RESET: `${topic},2,1500`, STUB_CURRENT: `${topic},2,1500` });
      assert.equal(clamped.status, 0, clamped.output);
    }
    for (const stub of failures) {
      const failed = reset(emptyState, stub);
      assert.notEqual(failed.status, 0, `${JSON.stringify(stub)}\n${failed.output}`);
      negativeCases++;
    }
    for (const state of ['Stable 3', 'PreparingRebalance 1', 'CompletingRebalance 1']) {
      const active = reset(`${header}\npulsemetry-dev-telemetry-ingest-validation b-1:9098 (1) range ${state}`);
      assert.notEqual(active.status, 0);
      assert.ok(!active.calls.some(call => call.includes('--reset-offsets')), '활성 group에서 reset을 호출했다');
      negativeCases++;
    }
  }
  const values = KAFKA_ADMIN_VALUES;
  const offsetsOn = { ...values, topicInit: { enabled: false } };
  for (const invalid of [
    { ...values, image: { repository: 'docker.io/apache/kafka', digest: `sha256:${'0'.repeat(64)}` } },
    { ...values, image: { repository: 'docker.io/apache/kafka:latest', digest: 'sha256:05b4616e0702ef2729327705d54ad6b50ea70b271c4b730fabd2320789fb7b02' } },
    { ...values, iamAuthJar: { url: 'https://example.invalid/aws-msk-iam-auth.jar', sha256: '922064f312ddc8a5f3dbe65fcef3d02ddbd588a02e3a6f0fca4b5a4dbec1ba43' } },
    { ...values, iamAuthJar: { url: 'https://github.com/aws/aws-msk-iam-auth/releases/download/v2.3.9/aws-msk-iam-auth-2.3.9-all.jar', sha256: '0'.repeat(64) } },
    { ...values, stage: 'main' },
    { ...values, topic: 'pulsemetry-dev-telemetry-ingress-main' },
    { ...values, region: 'us-east-1' },
    { ...values, bootstrapServers: 'b-1.example.invalid:9092' },
    { ...values, topicAdmin: { ...values.topicAdmin, sessionName: 'pulsemetry-dev-telemetry-gateway' } },
    { ...values, offsetAdmin: { ...values.offsetAdmin, roleArn: values.topicAdmin.roleArn } },
    { ...values, topicAdmin: { ...values.topicAdmin, roleArn: '*' } },
    { ...values, offsets: { enabled: true, mode: 'plan', partition: 0, toOffset: 1 } },
    { ...values, topicInit: { enabled: false } },
    { ...offsetsOn, offsets: { enabled: true, mode: 'plan' } },
    { ...offsetsOn, offsets: { enabled: true, mode: 'execute', partition: 1 } },
    { ...offsetsOn, offsets: { enabled: true, mode: 'execute', partition: 6, toOffset: 1 } },
    { ...offsetsOn, offsets: { enabled: true, mode: 'execute', partition: 1, toOffset: -1 } },
    { ...offsetsOn, offsets: { enabled: true, mode: 'execute', partition: 1, toOffset: 1, toDatetime: '2026-10-21T00:00:00.000Z' } },
    { ...offsetsOn, offsets: { enabled: true, mode: 'execute', toDatetime: '2026-10-21 00:00:00' } },
    { ...offsetsOn, offsets: { enabled: true, mode: 'apply', toDatetime: '2026-10-21T00:00:00.000Z' } },
    { ...offsetsOn, offsets: { enabled: false, mode: 'plan', partition: 1, toOffset: 1 } },
  ]) rejects('telemetry-kafka-admin', chart, invalid);
  rejects('telemetry-kafka-admin', chart, values, 'default');
  return kafkaDocuments;
}

try {
  assert.match(checked(helm, ['version', '--short']), /^v3\.22\.0\+/);
  assert.match(checked(kubeconform, ['-v']), /^v0\.8\.0/);
  const chart = 'helm/dev/workloads/spring-app';
  const allDocuments = [];
  for (const workload of ['telemetry-ingest', 'enrollment-api', 'dashboard-api']) {
    const values = appValues(workload);
    const base = render(workload, chart, values);
    checkApp(base, workload);
    const basePod = find(base, 'Deployment', workload).spec.template.spec;
    assert.equal(basePod.volumes.length, 1);
    assert.equal(basePod.containers[0].volumeMounts.length, 1);
    assert.equal(basePod.initContainers, undefined);
    const files = ['PULSEMETRY_DB_USERNAME', 'PULSEMETRY_DB_PASSWORD', 'PULSEMETRY_TOKEN_HASH_SECRET'];
    if (workload === 'enrollment-api') files.push('PULSEMETRY_ADMIN_API_TOKEN');
    if (workload === 'dashboard-api') files.splice(0, files.length, ...['RDS', 'CLICKHOUSE'].flatMap(store => ['SOURCE', 'CACHE'].flatMap(role => ['USERNAME', 'PASSWORD'].map(field => `PULSEMETRY_DASHBOARD_${store}_${role}_${field}`))));
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
    rejects(workload, chart, { ...values, env: { PULSEMETRY_USER_AUTH_PRIVATE_KEY_FILE: '/other/key' } });
    rejects(workload, chart, { ...values, env: { SPRING_APPLICATION_JSON: '{}' } });
    rejects(workload, chart, { ...values, env: { PULSEMETRY_DASHBOARD_RDS_SOURCE_PASSWORD: 'fixture-only' } });
    rejects(workload, chart, { ...values, env: { PULSEMETRY_DASHBOARD_CLICKHOUSE_CACHE_USERNAME: 'fixture-only' } });
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
    if (workload === 'dashboard-api') {
      const { nodePort, ...withoutNodePort } = values;
      rejects(workload, chart, withoutNodePort);
      rejects(workload, chart, { ...values, nodePort: 30080 });
      rejects(workload, chart, { ...values, env: { PULSEMETRY_DASHBOARD_PORT: '8080' } });
      rejects(workload, chart, { ...values, runtime: { ...runtime, requiredFiles: [...files, 'PULSEMETRY_TOKEN_HASH_SECRET'] } });
    }
    if (workload === 'telemetry-ingest') {
      rejects(workload, chart, { ...values, env: { PULSEMETRY_INGEST_PORT: '4318' } });
      rejects(workload, chart, { ...values, runtime: { ...runtime, requiredFiles: [...files, 'PULSEMETRY_ADMIN_API_TOKEN'] } });
    }
  }
  for (const workload of ['enrollment-api', 'dashboard-api']) {
    const values = appValues(workload);
    const files = workload === 'enrollment-api'
      ? ['PULSEMETRY_DB_USERNAME', 'PULSEMETRY_DB_PASSWORD', 'PULSEMETRY_TOKEN_HASH_SECRET', 'PULSEMETRY_ADMIN_API_TOKEN']
      : ['RDS', 'CLICKHOUSE'].flatMap(store => ['SOURCE', 'CACHE'].flatMap(role => ['USERNAME', 'PASSWORD'].map(field => `PULSEMETRY_DASHBOARD_${store}_${role}_${field}`)));
    values.runtime = { enabled: true, secretProviderClass: `${workload}-runtime`, requiredFiles: files };
    values.userAuth = { issuer: 'https://issuer.example.invalid', audience: 'pulsemetry-dev', allowedOrigins: ['https://dashboard.example.invalid'] };
    values.jwt = { enabled: true, secretProviderClass: `${workload}-jwt`, publicVersionId: '2'.repeat(32), publicKeys: [{ kid: 'release-2026.10', alias: 'release-2026-10.pem' }],
      ...(workload === 'enrollment-api' ? { privateVersionId: '1'.repeat(32), activeKid: 'release-2026.10' } : {}) };
    const documents = render(workload, chart, values);
    allDocuments.push(...documents);
    const deployment = find(documents, 'Deployment', workload);
    const pod = deployment.spec.template.spec;
    const container = pod.containers[0];
    assert.equal(pod.volumes.length, 3);
    assert.deepEqual(pod.volumes[1], { name: 'user-jwt', csi: { driver: 'secrets-store.csi.k8s.io', readOnly: true, volumeAttributes: { secretProviderClass: `${workload}-jwt` } } });
    assert.deepEqual(container.volumeMounts[1], { name: 'user-jwt', mountPath: '/mnt/user-jwt/keys', readOnly: true });
    assert.deepEqual(pod.initContainers[0].volumeMounts, container.volumeMounts.filter(mount => mount.name !== 'blocked-certs'));
    assert.ok(pod.initContainers[0].args[0].includes('head -c 1'));
    assert.equal(pod.initContainers[0].args[0].includes('private.pem'), workload === 'enrollment-api');
    const json = JSON.parse(container.env.find(item => item.name === 'SPRING_APPLICATION_JSON').value);
    assert.deepEqual(json, { pulsemetry: { 'user-auth': { 'public-key-files': { '[release-2026.10]': '/mnt/user-jwt/keys/release-2026-10.pem' } } } });
    assert.equal(container.env.some(item => item.name === 'PULSEMETRY_USER_AUTH_PRIVATE_KEY_FILE'), workload === 'enrollment-api');
    assert.match(deployment.spec.template.metadata.annotations['pulsemetry.io/jwt-revision'], /^[a-f0-9]{64}$/);
    const next = render(workload, chart, { ...values, jwt: { ...values.jwt, publicVersionId: '3'.repeat(32) } });
    assert.notEqual(find(next, 'Deployment', workload).spec.template.metadata.annotations['pulsemetry.io/jwt-revision'], deployment.spec.template.metadata.annotations['pulsemetry.io/jwt-revision']);
    rejects(workload, chart, { ...values, runtime: { ...values.runtime, enabled: false } });
    rejects(workload, chart, { ...values, jwt: { ...values.jwt, publicVersionId: 'AWSCURRENT' } });
    rejects(workload, chart, { ...values, jwt: { ...values.jwt, secretProviderClass: 'other-jwt' } });
    rejects(workload, chart, { ...values, jwt: { ...values.jwt, publicKeys: [] } });
    for (const alias of ['../escape.pem', 'private.pem']) rejects(workload, chart, { ...values, jwt: { ...values.jwt, publicKeys: [{ kid: 'release-2026.10', alias }] } });
    rejects(workload, chart, { ...values, jwt: { ...values.jwt, publicKeys: [...values.jwt.publicKeys, { kid: 'another', alias: 'release-2026-10.pem' }] } });
    rejects(workload, chart, { ...values, userAuth: { ...values.userAuth, allowedOrigins: [] } });
    rejects(workload, chart, { ...values, jwt: { ...values.jwt, privateVersionId: '1'.repeat(32), activeKid: 'missing' } });
  }
  rejects('unknown', chart, { ...appValues('enrollment-api'), workload: 'unknown' });
  allDocuments.push(...checkTelemetry(chart));
  allDocuments.push(...checkKafkaAdmin());
  const clickhouseChart = 'helm/dev/workloads/clickhouse';
  const clickhouseValues = { availabilityZone: 'ap-northeast-2a' };
  const clickhouse = render('clickhouse', clickhouseChart, clickhouseValues);
  checkClickhouse(clickhouse);
  allDocuments.push(...clickhouse);
  rejects('clickhouse', clickhouseChart, { ...clickhouseValues, availabilityZone: '' });
  rejects('clickhouse', clickhouseChart, { ...clickhouseValues, availabilityZone: 'us-east-1a' });
  rejects('clickhouse', clickhouseChart, { ...clickhouseValues, storage: { className: 'gp2' } });
  rejects('clickhouse', clickhouseChart, { ...clickhouseValues, storage: { size: '20Gi' } });
  rejects('clickhouse', clickhouseChart, { ...clickhouseValues, replicaCount: 2 });
  rejects('clickhouse', clickhouseChart, { ...clickhouseValues, image: 'clickhouse/clickhouse-server:latest' });
  // 구 generated values를 조용히 무시하면 공개 TG 정리가 누락될 수 있으므로 빈 값도 거부한다.
  for (const targetGroupBindings of [[], [binding('validation', 'clickhouse-v')]]) {
    rejects('clickhouse', clickhouseChart, { ...clickhouseValues, targetGroupBindings });
  }
  for (const vpcId of ['', 'vpc-0123456789abcdef0']) {
    rejects('clickhouse', clickhouseChart, { ...clickhouseValues, vpcId });
  }
  rejects('clickhouse', clickhouseChart, clickhouseValues, 'default');
  allDocuments.push(...checkObservability(chart, clickhouseChart, clickhouseValues));
  checkSchema(allDocuments);
  const platformResources = checkPlatform();
  console.log(`Helm 3.22.0 / kubeconform 0.8.0: ${renderedResources}개 workload resource, ${platformResources}개 platform resource, ${negativeCases}개 실패 입력, workload/runtime 경계 통과 (AWS NodeClass/NodePool 구조 검사)`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
