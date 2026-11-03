import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
const { loadAll } = require('js-yaml');
const suite = process.env.HELM_BIN ? describe : describe.skip;

suite('generated values reader RBAC', () => {
  test('dev의 CA와 main 사용자 4개 get만 허용하고 group을 연결한다', () => {
    const result = spawnSync(process.env.HELM_BIN!, [
      'template', 'pulsemetry-dev-platform', 'helm/dev/platform/base',
      '--set', 'nodeRoleName=fixture-node,subnetIds[0]=subnet-0123456789abcdef0,subnetIds[1]=subnet-0123456789abcdef1,appNodeSecurityGroupId=sg-0123456789abcdef0,clickhouseNodeSecurityGroupId=sg-0123456789abcdef1,observabilityNodeSecurityGroupId=sg-0123456789abcdef2,clickhouseAvailabilityZone=ap-northeast-2a',
    ], { cwd: resolve(__dirname, '../..'), encoding: 'utf8' });
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    const docs = loadAll(result.stdout).filter(Boolean);
    const rbac = docs.filter((doc: any) => doc.apiVersion === 'rbac.authorization.k8s.io/v1');
    expect(rbac).toHaveLength(2);
    expect(rbac.find((doc: any) => doc.kind === 'Role')).toEqual({
      apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'Role',
      metadata: { name: 'generated-values-reader', namespace: 'pulsemetry-dev' },
      rules: [{ apiGroups: [''], resources: ['secrets'], verbs: ['get'], resourceNames: [
        'soma-376-dev-telemetry-cluster-ca-cert', 'pulsemetry-gateway-main', 'pulsemetry-ingest-main',
        'pulsemetry-topic-admin-main', 'pulsemetry-offset-admin-main',
      ] }],
    });
    expect(rbac.find((doc: any) => doc.kind === 'RoleBinding')).toEqual({
      apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding',
      metadata: { name: 'generated-values-reader', namespace: 'pulsemetry-dev' },
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: 'generated-values-reader' },
      subjects: [{ apiGroup: 'rbac.authorization.k8s.io', kind: 'Group', name: 'pulsemetry:dev:generated-values-reader' }],
    });
    expect(rbac.some((doc: any) => doc.kind.startsWith('Cluster'))).toBe(false);
  });
});
