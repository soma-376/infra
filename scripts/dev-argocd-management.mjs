#!/usr/bin/env node
// 비밀 없는 관리 입력만 생성한다. Git·Kubernetes·AWS에 쓰지 않는다.
import { readFileSync, mkdirSync, writeFileSync, lstatSync, readdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAll, dump, JSON_SCHEMA } from 'js-yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = join(root, 'helm/dev/platform/argocd');
export const managedNamespaces = ['kube-system', 'cert-manager', 'pulsemetry-dev', 'pulsemetry-dev-logs', 'pulsemetry-observability', 'strimzi-system'];
const namePattern = /^[a-z0-9][a-z0-9.:-]{0,251}[a-z0-9]$/;
const imagePattern = /^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/;
const valuesReaderSecrets = [
  'soma-376-dev-telemetry-cluster-ca-cert', 'pulsemetry-gateway-main', 'pulsemetry-ingest-main',
  'pulsemetry-topic-admin-main', 'pulsemetry-offset-admin-main',
];
const sameFields = (actual, expected) => actual !== null && typeof actual === 'object' && !Array.isArray(actual) &&
  Object.keys(actual).length === Object.keys(expected).length && Object.entries(expected).every(([key, value]) => actual[key] === value);
const sameSet = (actual, expected) => Array.isArray(actual) && actual.length === expected.length &&
  new Set(actual).size === expected.length && expected.every(value => actual.includes(value));

function isValuesReaderBinding(binding, resources) {
  // base/templates/values-reader-rbac.yaml의 PROJ-279 Group만 유지한다. 일반 Group 예외는 아니다.
  if (binding.kind !== 'RoleBinding' || binding.metadata?.name !== 'generated-values-reader' || binding.metadata?.namespace !== 'pulsemetry-dev' ||
      !sameFields(binding.roleRef, { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: 'generated-values-reader' }) ||
      !Array.isArray(binding.subjects) || binding.subjects.length !== 1 ||
      !sameFields(binding.subjects[0], { apiGroup: 'rbac.authorization.k8s.io', kind: 'Group', name: 'pulsemetry:dev:generated-values-reader' })) return false;
  const role = resources.find(resource => resource?.apiVersion === 'rbac.authorization.k8s.io/v1' && resource.kind === 'Role' &&
    resource.metadata?.namespace === 'pulsemetry-dev' && resource.metadata?.name === 'generated-values-reader');
  if (!Array.isArray(role?.rules) || role.rules.length !== 1) return false;
  const rule = role.rules[0];
  return rule !== null && typeof rule === 'object' && Object.keys(rule).length === 4 &&
    sameSet(rule.apiGroups, ['']) && sameSet(rule.resources, ['secrets']) && sameSet(rule.verbs, ['get']) &&
    sameSet(rule.resourceNames, valuesReaderSecrets);
}

// 고정 관측 chart는 비인증 scrape 설정도 Secret으로 렌더한다. Strimzi의 빈 목록만 허용한다.
// TLS·앱·Git 인증 Secret과 이전 MSK scrape 설정으로 예외를 확대하지 않는다.
export function validateManagedSecret(resource) {
  const invalid = () => new Error('관리 Secret은 고정 Strimzi 관측의 빈 scrape 설정 하나만 허용한다');
  if (resource?.apiVersion !== 'v1' || resource.kind !== 'Secret' ||
      resource.metadata?.namespace !== 'pulsemetry-observability' ||
      resource.metadata?.name !== 'pulsemetry-monitoring-prometheus-scrape-confg' ||
      (resource.type !== undefined && resource.type !== 'Opaque') ||
      Object.hasOwn(resource, 'stringData') ||
      Object.keys(resource).some(key => !['apiVersion', 'kind', 'metadata', 'type', 'data'].includes(key)) ||
      !resource.data || typeof resource.data !== 'object' || Array.isArray(resource.data) ||
      Object.keys(resource.data).length !== 1 || !Object.hasOwn(resource.data, 'additional-scrape-configs.yaml')) throw invalid();
  const encoded = resource.data['additional-scrape-configs.yaml'];
  if (typeof encoded !== 'string' || encoded.length > 1024) throw invalid();
  const bytes = Buffer.from(encoded, 'base64');
  // 비정규 base64·다른 YAML 문서·태그·주석에 임의 입력을 숨기는 것도 거부한다.
  if (bytes.toString('base64') !== encoded || !/^[\t\r\n ]*\[\][\t\r\n ]*$/.test(bytes.toString('utf8'))) throw invalid();
}

export function managementInputs({ cmpImage, resources = [], reconciliationEnabled = false }) {
  if (typeof cmpImage !== 'string' || !imagePattern.test(cmpImage)) throw new Error('게시된 ARM64 CMP image의 repository@sha256 입력이 필요하다');
  if (!Array.isArray(resources)) throw new Error('렌더된 리소스 목록이 필요하다');
  if (typeof reconciliationEnabled !== 'boolean') throw new Error('reconciliationEnabled는 boolean이어야 한다');
  const managedRbac = { clusterRoles: [], clusterRoleBindings: [], roles: {}, roleBindings: {}, hookServiceAccounts: {} };
  const names = new Set();
  const roleReferences = [];
  for (const object of resources) {
    if (object?.kind === 'Secret') validateManagedSecret(object);
    if (object?.apiVersion === 'v1' && object.kind === 'ServiceAccount' &&
        (object.metadata?.annotations?.['helm.sh/hook'] || object.metadata?.annotations?.['argocd.argoproj.io/hook'])) {
      const { name, namespace } = object.metadata;
      if (!managedNamespaces.includes(namespace) || !namePattern.test(name ?? '') || name.startsWith('argocd')) throw new Error('hook ServiceAccount가 관리 범위를 벗어났다');
      const hookNames = managedRbac.hookServiceAccounts[namespace] ??= [];
      if (hookNames.includes(name)) throw new Error('중복 hook ServiceAccount');
      hookNames.push(name);
    }
    if (object?.apiVersion !== 'rbac.authorization.k8s.io/v1') continue;
    const { kind, metadata, roleRef } = object;
    if (!['Role', 'RoleBinding', 'ClusterRole', 'ClusterRoleBinding'].includes(kind)) throw new Error('미지원 RBAC 종류');
    const name = metadata?.name;
    if (typeof name !== 'string' || !namePattern.test(name) || name.startsWith('argocd') || name.startsWith('system:')) throw new Error('관리 RBAC 이름이 허용 범위를 벗어났다');
    const namespace = metadata?.namespace ?? '';
    const namespaced = !kind.startsWith('Cluster');
    if (namespaced ? !managedNamespaces.includes(namespace) : namespace !== '') throw new Error('RBAC namespace가 관리 범위를 벗어났다');
    const key = `${kind}/${namespace}/${name}`;
    if (names.has(key)) throw new Error('중복 RBAC 리소스');
    names.add(key);
    if (kind === 'ClusterRole') managedRbac.clusterRoles.push(name);
    if (kind === 'ClusterRoleBinding') managedRbac.clusterRoleBindings.push(name);
    if (kind === 'Role') (managedRbac.roles[namespace] ??= []).push(name);
    if (kind === 'RoleBinding') (managedRbac.roleBindings[namespace] ??= []).push(name);
    if (kind.endsWith('Binding')) {
      if (roleRef?.apiGroup !== 'rbac.authorization.k8s.io' || !['Role', 'ClusterRole'].includes(roleRef?.kind) || (kind === 'ClusterRoleBinding' && roleRef.kind !== 'ClusterRole')) throw new Error('잘못된 roleRef');
      roleReferences.push(`${roleRef.kind}/${roleRef.kind === 'Role' ? namespace : ''}/${roleRef.name}`);
      if (!isValuesReaderBinding(object, resources) && (!Array.isArray(object.subjects) || object.subjects.length === 0 || object.subjects.some(subject => subject?.kind !== 'ServiceAccount' || !managedNamespaces.includes(subject.namespace ?? namespace) || !namePattern.test(subject.name ?? '') || subject.name.startsWith('argocd')))) throw new Error('RBAC subject가 관리 workload 범위를 벗어났다');
    }
  }
  if (roleReferences.some(reference => !names.has(reference))) throw new Error('같은 고정 렌더에 없는 Role을 bind할 수 없다');
  managedRbac.clusterRoles.sort();
  managedRbac.clusterRoleBindings.sort();
  for (const map of [managedRbac.roles, managedRbac.roleBindings, managedRbac.hookServiceAccounts]) for (const values of Object.values(map)) values.sort();

  const healthDirectory = join(root, 'helm/dev/gitops/health');
  const cm = {
    // 적용용 생성기만 opt-in한다. 연결 Secret도 같은 값으로 함께 활성화한다.
    'cluster.inClusterEnabled': String(reconciliationEnabled),
    'application.resourceTrackingMethod': 'annotation',
    'resource.respectRBAC': 'strict',
  };
  // 파일명은 Application 생성기와 공유하는 health 계약이다.
  for (const [kind, file] of [
    ['argoproj.io_Application', 'application.lua'],
    ['kafka.strimzi.io_Kafka', 'kafka.lua'],
    ['kafka.strimzi.io_KafkaTopic', 'kafka.lua'],
    ['kafka.strimzi.io_KafkaUser', 'kafka.lua'],
    ['cert-manager.io_Certificate', 'certificate.lua'],
    ['cert-manager.io_Issuer', 'certificate.lua'],
  ]) cm[`resource.customizations.health.${kind}`] = readFileSync(join(healthDirectory, file), 'utf8');
  const plugin = readFileSync(join(directory, 'cmp/plugin.yaml'), 'utf8');
  const argoValues = {
    createClusterRoles: false,
    createAggregateRoles: false,
    configs: { cm },
    repoServer: {
      automountServiceAccountToken: false,
      serviceAccount: { automountServiceAccountToken: false },
      volumes: [
        { name: 'strimzi-cmp-config', configMap: { name: 'argocd-strimzi-cmp' } },
        { name: 'strimzi-cmp-tmp', emptyDir: {} },
      ],
      extraContainers: [{
        name: 'strimzi-cmp', image: cmpImage,
        command: ['/var/run/argocd/argocd-cmp-server'],
        securityContext: { runAsNonRoot: true, runAsUser: 999, allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] }, seccompProfile: { type: 'RuntimeDefault' } },
        resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { memory: '512Mi' } },
        volumeMounts: [
          { name: 'var-files', mountPath: '/var/run/argocd', readOnly: true },
          { name: 'plugins', mountPath: '/home/argocd/cmp-server/plugins' },
          { name: 'strimzi-cmp-config', mountPath: '/home/argocd/cmp-server/config/plugin.yaml', subPath: 'plugin.yaml', readOnly: true },
          { name: 'strimzi-cmp-tmp', mountPath: '/tmp' },
        ],
      }],
    },
    extraObjects: [{ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'argocd-strimzi-cmp', namespace: 'argocd' }, data: { 'plugin.yaml': plugin } }],
  };
  return { argoValues, managementValues: { reconciliationEnabled, managedRbac } };
}

export function run(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--cmp-image', '--rendered-manifests', '--output-dir'].includes(argv[i]) || !argv[i + 1] || args[argv[i]]) throw new Error('usage: --cmp-image repository@sha256:... --rendered-manifests FILE --output-dir EMPTY_DIRECTORY');
    args[argv[i]] = argv[i + 1];
  }
  if (Object.keys(args).length !== 3) throw new Error('세 입력이 모두 필요하다');
  const rendered = readFileSync(resolve(args['--rendered-manifests']), 'utf8');
  let resources;
  try { resources = loadAll(rendered, { schema: JSON_SCHEMA }).filter(Boolean); }
  catch { throw new Error('관리 렌더 YAML 구문 오류'); }
  const result = managementInputs({ cmpImage: args['--cmp-image'], resources });
  const output = resolve(args['--output-dir']);
  mkdirSync(output, { recursive: true, mode: 0o700 });
  if (lstatSync(output).isSymbolicLink() || readdirSync(output).length) throw new Error('출력은 비어 있는 실제 디렉터리여야 한다');
  for (const [file, values] of [['argocd-values.yaml', result.argoValues], ['management-values.yaml', result.managementValues]]) {
    writeFileSync(join(output, file), dump(values, { noRefs: true, lineWidth: -1 }), { flag: 'wx', mode: 0o600 });
  }
  // manifest·Secret data·개인 경로를 출력하지 않는다.
  console.log('Argo 관리 values 2개 생성 완료; Git/클러스터 적용 없음; 인계 검증은 별도');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { run(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
