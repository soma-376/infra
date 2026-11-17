import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const { dump, loadAll } = require('js-yaml');
const root = resolve(__dirname, '../..');
const suite = process.env.HELM_BIN ? describe : describe.skip;
const pipelineResources = { requests: { cpu: '500m', memory: '2Gi' }, limits: { cpu: '2', memory: '4Gi' } };
const existingResources = { requests: { cpu: '250m', memory: '1Gi' }, limits: { cpu: '1', memory: '2Gi' } };

suite('PROJ-304 dev 파이프라인 자원과 노드 분리', () => {
  let temporary: string;
  let sequence = 0;
  beforeAll(() => { temporary = mkdtempSync(join(tmpdir(), 'dev-pipeline-resources-')); });
  afterAll(() => rmSync(temporary, { recursive: true, force: true }));

  function render(workload: string, override: Record<string, any> = {}, environment = 'dev') {
    const gateway = workload === 'telemetry-gateway';
    const perf = environment === 'perf';
    const values = {
      image: { repository: `example.invalid/soma-376/${workload}`, digest: `sha256:${'a'.repeat(64)}` },
      ...(gateway ? {
        telemetryJwt: { enabled: true, secretProviderClass: `${workload}-telemetry-jwt`, publicVersionId: 'a'.repeat(32), publicKeys: [{ kid: 'fixture-key', alias: 'fixture.pem' }] },
      } : {}),
      ...(gateway || perf ? {
        kafka: {
          enabled: true,
          security: 'mtls',
          bootstrapServers: `soma-376-${environment}-telemetry-kafka-bootstrap.pulsemetry-${environment}.svc.cluster.local:9093`,
          topic: perf ? 'pulsemetry-perf-telemetry-ingress' : 'pulsemetry-dev-telemetry-ingress-main',
          ...(gateway ? {} : { consumerGroup: 'pulsemetry-perf-telemetry-ingest' }),
          clusterCaSecretName: `soma-376-${environment}-telemetry-cluster-ca-cert`,
          userSecretName: `pulsemetry-${gateway ? 'gateway' : 'ingest'}-${perf ? 'perf' : 'main'}`,
          tlsRevision: 'b'.repeat(64),
        },
        env: { AWS_REGION: 'ap-northeast-2' },
      } : {}),
      ...(perf ? {
        service: { type: 'ClusterIP' },
        resources: { requests: { cpu: '750m', memory: '3Gi' }, limits: { cpu: null, memory: '5Gi' } },
        placement: { nodePool: gateway ? 'perf-gateway' : 'perf-pipeline', taint: gateway ? 'gateway' : 'pipeline' },
      } : {}),
      ...override,
    };
    const filename = join(temporary, `${sequence++}.yaml`);
    writeFileSync(filename, dump(values));
    return spawnSync(process.env.HELM_BIN!, [
      'template', workload, 'helm/dev/workloads/spring-app', '--namespace', `pulsemetry-${environment}`,
      '--kube-version', '1.36.0', '-f', `helm/${environment}/workloads/${workload}.yaml`, '-f', filename,
    ], { cwd: root, encoding: 'utf8' });
  }

  function deployment(workload: string, override: Record<string, any> = {}, environment = 'dev') {
    const result = render(workload, override, environment);
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    return loadAll(result.stdout).find((document: any) => document?.kind === 'Deployment');
  }

  test('apps·ClickHouse 노드 타입을 확대하고 기존 풀 예산·격리와 Kafka·관측 타입을 보존한다', () => {
    const values = {
      nodeRoleName: 'fixture-eks-node',
      subnetIds: ['subnet-0123456789abcdef0', 'subnet-1123456789abcdef0'],
      appNodeSecurityGroupId: 'sg-0123456789abcdef0',
      clickhouseNodeSecurityGroupId: 'sg-1123456789abcdef0',
      observabilityNodeSecurityGroupId: 'sg-2123456789abcdef0',
      clickhouseAvailabilityZone: 'ap-northeast-2a',
      kafka: { enabled: true, securityGroupId: 'sg-3123456789abcdef0', availabilityZone: 'ap-northeast-2a' },
    };
    const filename = join(temporary, `${sequence++}.yaml`);
    writeFileSync(filename, dump(values));
    const result = spawnSync(process.env.HELM_BIN!, [
      'template', 'platform', 'helm/dev/platform/base', '--namespace', 'kube-system',
      '--kube-version', '1.36.0', '-f', filename,
    ], { cwd: root, encoding: 'utf8' });
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    const documents = loadAll(result.stdout).filter(Boolean);
    const expectedPools = [
      ['pulsemetry-dev-apps', 't4g.large', '8', values.appNodeSecurityGroupId],
      ['pulsemetry-dev-clickhouse', 'm7g.large', '4', values.clickhouseNodeSecurityGroupId],
      ['pulsemetry-dev-kafka', 'm7g.large', '8', values.kafka.securityGroupId],
      ['pulsemetry-observability', 'm7g.large', '4', values.observabilityNodeSecurityGroupId],
    ];
    expect(documents.filter((document: any) => document.kind === 'NodePool')).toHaveLength(4);
    for (const [name, instanceType, cpuLimit, securityGroup] of expectedPools) {
      const pool = documents.find((document: any) => document.kind === 'NodePool' && document.metadata.name === name);
      const nodeClass = documents.find((document: any) => document.kind === 'NodeClass' && document.metadata.name === name);
      expect(pool.spec.limits.cpu).toBe(cpuLimit);
      expect(pool.spec.replicas).toBeUndefined();
      expect(pool.spec.template.spec.nodeClassRef).toEqual({ group: 'eks.amazonaws.com', kind: 'NodeClass', name });
      expect(pool.spec.template.spec.requirements).toEqual(expect.arrayContaining([
        { key: 'kubernetes.io/arch', operator: 'In', values: ['arm64'] },
        { key: 'karpenter.sh/capacity-type', operator: 'In', values: ['on-demand'] },
        { key: 'node.kubernetes.io/instance-type', operator: 'In', values: [instanceType] },
      ]));
      expect(pool.spec.disruption).toMatchObject({ consolidationPolicy: 'WhenEmpty', consolidateAfter: '5m' });
      expect(nodeClass.spec.securityGroupSelectorTerms).toEqual([{ id: securityGroup }]);
      expect(nodeClass.spec.subnetSelectorTerms).toEqual(values.subnetIds.map(id => ({ id })));
      expect(nodeClass.spec.role).toBe(values.nodeRoleName);
      if (name === 'pulsemetry-dev-clickhouse') {
        expect(pool.spec.template.spec.requirements).toContainEqual({ key: 'topology.kubernetes.io/zone', operator: 'In', values: ['ap-northeast-2a'] });
        expect(pool.spec.template.spec.taints).toEqual([{ key: 'workload', value: 'clickhouse', effect: 'NoSchedule' }]);
      }
    }
  });

  test.each(['telemetry-gateway', 'telemetry-ingest'])('%s는 동일 자원과 필수 hostname 분리를 적용한다', workload => {
    const resource = deployment(workload);
    const pod = resource.spec.template.spec;
    expect(pod.containers[0].resources).toEqual(pipelineResources);
    expect(resource.spec.replicas).toBe(1);
    expect(resource.spec.strategy).toEqual({ type: 'Recreate' });
    expect(pod.nodeSelector).toEqual({ 'kubernetes.io/arch': 'arm64', 'karpenter.sh/nodepool': 'pulsemetry-dev-apps' });
    expect(pod.affinity).toEqual({ podAntiAffinity: { requiredDuringSchedulingIgnoredDuringExecution: [{
      labelSelector: { matchExpressions: [{ key: 'app.kubernetes.io/name', operator: 'In', values: ['telemetry-gateway', 'telemetry-ingest'] }] },
      topologyKey: 'kubernetes.io/hostname',
    }] } });
  });

  test.each(['enrollment-api', 'dashboard-api'])('%s의 기존 자원과 배치를 유지한다', workload => {
    const resource = deployment(workload);
    expect(resource.spec.template.spec.containers[0].resources).toEqual(existingResources);
    expect(resource.spec.template.spec.affinity).toBeUndefined();
  });

  test.each(['telemetry-gateway', 'telemetry-ingest'])('%s의 임의 dev 자원 변경을 거부한다', workload => {
    for (const resources of [existingResources,
      { ...pipelineResources, limits: { cpu: '1', memory: '2Gi' } },
      { ...pipelineResources, requests: { cpu: '500m', memory: '4Gi' } },
      { ...pipelineResources, limits: { cpu: '2', memory: '4Gi', ephemeralStorage: '1Gi' } }]) {
      const result = render(workload, { resources });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('resources');
    }
  });

  test.each(['telemetry-gateway', 'telemetry-ingest'])('%s의 perf 프로필 자원과 전용 풀은 바꾸지 않는다', workload => {
    const resource = deployment(workload, {}, 'perf');
    expect(resource.spec.template.spec.containers[0].resources).toEqual({
      requests: { cpu: '750m', memory: '3Gi' }, limits: { memory: '5Gi' },
    });
    expect(resource.spec.template.spec.affinity).toBeUndefined();
    expect(resource.spec.template.spec.nodeSelector['karpenter.sh/nodepool']).toBe(workload === 'telemetry-gateway' ? 'perf-gateway' : 'perf-pipeline');
  });
});
