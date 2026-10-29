import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const { load, loadAll } = require('js-yaml');
const root = resolve(__dirname, '../..');
const suite = process.env.HELM_BIN ? describe : describe.skip;
const vendor = 'helm/dev/platform/strimzi/vendor/strimzi-kafka-operator-1.3.0.tgz';
const helm = (args: string[]) => spawnSync(process.env.HELM_BIN!, args, { cwd: root, encoding: 'utf8' });

suite('Strimzi 고정 버전·CRD·노드·권한 계약', () => {
  let temp: string;
  beforeAll(() => { temp = mkdtempSync(join(tmpdir(), 'strimzi-helm-')); });
  afterAll(() => rmSync(temp, { recursive: true, force: true }));
  const render = () => {
    const result = helm(['template', 'telemetry-kafka', 'helm/dev/kafka', '-n', 'pulsemetry-dev', '--kube-version', '1.36.0', '--set', 'availabilityZone=ap-northeast-2a']);
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    return loadAll(result.stdout).filter(Boolean);
  };
  test('공식 archive checksum·ARM64 이미지와 운영자 감시 namespace를 고정한다', () => {
    const source = JSON.parse(readFileSync(join(root, 'helm/dev/platform/strimzi/SOURCE.json'), 'utf8'));
    expect(createHash('sha256').update(readFileSync(join(root, vendor))).digest('hex')).toBe(source.chart.sha256);
    expect(source.images.kafka.platforms).toContainEqual({ architecture: 'arm64', os: 'linux' });
    const result = helm(['template', 'strimzi', vendor, '-n', 'strimzi-system', '--kube-version', '1.36.0', '-f', 'helm/dev/platform/strimzi/values.yaml', '--post-renderer', './scripts/strimzi-operator-post-render.mjs']);
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    const deployment = loadAll(result.stdout).find((doc: any) => doc?.kind === 'Deployment');
    const container = deployment.spec.template.spec.containers[0];
    expect(container.image).toBe(`quay.io/strimzi/operator@${source.images.operator.digest}`);
    expect(container.env.find((item: any) => item.name === 'STRIMZI_NAMESPACE').value).toBe('pulsemetry-dev');
    expect(container.env.find((item: any) => item.name === 'STRIMZI_PKCS12_KEYSTORE_GENERATION').value).toBe('true');
    const rejected = spawnSync(process.execPath, ['scripts/strimzi-operator-post-render.mjs'], { cwd: root, input: result.stdout, encoding: 'utf8' });
    expect(rejected.status).not.toBe(0);
  });
  test('복제·리소스·스토리지·single AZ 배치와 stage별 최소 ACL을 보존한다', () => {
    const docs = render(); const pool = docs.find((x: any) => x.kind === 'KafkaNodePool');
    expect(pool.spec).toMatchObject({ replicas: 3, roles: ['controller', 'broker'], resources: { requests: { cpu: '1', memory: '4Gi' }, limits: { memory: '6Gi' } }, jvmOptions: { '-Xms': '2g', '-Xmx': '2g' } });
    expect(pool.spec.storage.volumes[0]).toMatchObject({ size: '100Gi', class: 'pulsemetry-kafka-gp3', deleteClaim: false, kraftMetadata: 'shared' });
    expect(pool.spec.template.pod.affinity.podAntiAffinity.requiredDuringSchedulingIgnoredDuringExecution[0].topologyKey).toBe('kubernetes.io/hostname');
    const kafka = docs.find((x: any) => x.kind === 'Kafka');
    expect(kafka.spec.kafka.listeners).toHaveLength(1);
    expect(kafka.spec.kafka.listeners[0]).toMatchObject({ port: 9093, tls: true, type: 'internal', authentication: { type: 'tls' } });
    expect(kafka.spec.kafka.config).toMatchObject({ 'message.max.bytes': 13631488, 'replica.fetch.max.bytes': 13631488, 'auto.create.topics.enable': false, 'min.insync.replicas': 2 });
    expect(kafka.spec.kafka.template.podDisruptionBudget.maxUnavailable).toBe(1);
    expect(docs.filter((x: any) => x.kind === 'KafkaTopic')).toHaveLength(2);
    for (const topic of docs.filter((x: any) => x.kind === 'KafkaTopic')) expect(topic.spec).toMatchObject({ partitions: 6, replicas: 3, config: { 'retention.ms': 259200000, 'max.message.bytes': 13631488, 'min.insync.replicas': 2 } });
    for (const user of docs.filter((x: any) => x.kind === 'KafkaUser')) {
      expect(user.spec.authentication).toEqual({ type: 'tls', validityDays: 365, renewalDays: 30 });
      const stage = user.metadata.name.endsWith('main') ? 'main' : 'validation';
      const role = user.metadata.name.slice('pulsemetry-'.length, -stage.length - 1);
      const operations: Record<string, Record<string, string[]>> = {
        gateway: { topic: ['Describe', 'Write'], cluster: ['IdempotentWrite'] },
        ingest: { topic: ['Describe', 'Read'], group: ['Describe', 'Read'] },
        'topic-admin': { topic: ['Describe', 'DescribeConfigs'] },
        'offset-admin': { topic: ['Describe', 'Read'], group: ['Describe', 'Read', 'Alter'] },
      };
      expect(operations[role]).toBeDefined();
      expect(user.spec.authorization.acls.map((acl: any) => acl.resource.type)).toEqual(Object.keys(operations[role]));
      for (const acl of user.spec.authorization.acls) {
        if (acl.resource.type === 'topic') expect(acl.resource).toEqual({ type: 'topic', name: `pulsemetry-dev-telemetry-ingress-${stage}`, patternType: 'literal' });
        if (acl.resource.type === 'group') expect(acl.resource).toEqual({ type: 'group', name: `pulsemetry-dev-telemetry-ingest-${stage}`, patternType: 'literal' });
        if (acl.resource.type === 'cluster') expect(acl.resource).toEqual({ type: 'cluster' });
        expect(acl.operations).toEqual(operations[role][acl.resource.type]);
      }
    }
  });
  test('전용 Kafka nodepool·SG·암호화 Retain storage가 기존 풀과 분리된다', () => {
    const result = helm(['template', 'platform', 'helm/dev/platform/base', '--kube-version', '1.36.0', '--set', 'nodeRoleName=fixture-node,subnetIds[0]=subnet-0123456789abcdef0,subnetIds[1]=subnet-0123456789abcdef1,appNodeSecurityGroupId=sg-0123456789abcdef0,clickhouseNodeSecurityGroupId=sg-0123456789abcdef1,observabilityNodeSecurityGroupId=sg-0123456789abcdef2,clickhouseAvailabilityZone=ap-northeast-2a,kafka.enabled=true,kafka.securityGroupId=sg-0123456789abcdef3,kafka.availabilityZone=ap-northeast-2a']);
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    const docs = loadAll(result.stdout).filter(Boolean);
    const pool = docs.find((x: any) => x.kind === 'NodePool' && x.metadata.name === 'pulsemetry-dev-kafka');
    expect(pool.spec.limits.cpu).toBe('8');
    expect(pool.spec.template.spec.requirements).toEqual(expect.arrayContaining([{ key: 'node.kubernetes.io/instance-type', operator: 'In', values: ['m7g.large'] }, { key: 'karpenter.sh/capacity-type', operator: 'In', values: ['on-demand'] }]));
    expect(docs.find((x: any) => x.kind === 'StorageClass' && x.metadata.name === 'pulsemetry-kafka-gp3')).toMatchObject({ provisioner: 'ebs.csi.eks.amazonaws.com', parameters: { encrypted: 'true', type: 'gp3' }, reclaimPolicy: 'Retain', volumeBindingMode: 'WaitForFirstConsumer', allowVolumeExpansion: true });
    // 전용 풀을 추가해도 노드 로그·지표 수집기가 taint 때문에 빠지지 않아야 한다.
    const collectors = {
      'fluent-bit': load(readFileSync(join(root, 'helm/dev/runtime/fluent-bit-values.yaml'), 'utf8')),
      'node-exporter': load(readFileSync(join(root, 'helm/observability/pulsemetry-observability/values.yaml'), 'utf8'))['monitoring']['prometheus-node-exporter'],
    };
    for (const [name, collector] of Object.entries(collectors)) {
      expect(collector.nodeSelector).toEqual({ 'kubernetes.io/os': 'linux', 'kubernetes.io/arch': 'arm64' });
      for (const nodePool of docs.filter((doc: any) => doc.kind === 'NodePool')) {
        for (const taint of nodePool.spec.template.spec.taints ?? []) {
          const tolerated = collector.tolerations.some((t: any) =>
            (!t.effect || t.effect === taint.effect) &&
            (t.operator === 'Exists' ? !t.key || t.key === taint.key : t.key === taint.key && t.value === taint.value));
          expect({ collector: name, nodePool: nodePool.metadata.name, tolerated }).toEqual({ collector: name, nodePool: nodePool.metadata.name, tolerated: true });
        }
      }
    }
  });
  (process.env.KUBECONFORM_BIN ? test : test.skip)('공식 1.3.0 CRD schema로 Kafka·NodePool·Topic·User를 검증한다', () => {
    const extracted = spawnSync('tar', ['-xzf', join(root, vendor), '-C', temp], { encoding: 'utf8' });
    expect(extracted.status).toBe(0);
    const directory = join(temp, 'strimzi-kafka-operator/crds');
    const crds = readdirSync(directory).map(file => load(readFileSync(join(directory, file), 'utf8')));
    for (const [index, doc] of render().entries()) {
      if (doc.apiVersion !== 'kafka.strimzi.io/v1') continue;
      const schema = crds.find(crd => crd.spec.names.kind === doc.kind).spec.versions.find((version: any) => version.name === 'v1').schema.openAPIV3Schema;
      const schemaPath = join(temp, `${doc.kind}.json`), resourcePath = join(temp, `${index}.json`);
      writeFileSync(schemaPath, JSON.stringify(schema)); writeFileSync(resourcePath, JSON.stringify(doc));
      const check = spawnSync(process.env.KUBECONFORM_BIN!, ['-strict', '-summary', '-schema-location', schemaPath, resourcePath], { encoding: 'utf8' });
      expect({ status: check.status, stdout: check.stdout, stderr: check.stderr }).toEqual({ status: 0, stdout: expect.stringContaining('Valid: 1'), stderr: '' });
    }
  });
});
