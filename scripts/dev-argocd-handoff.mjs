#!/usr/bin/env node
// PROJ-310: 검토 자료와 분리한 수동 인계 선언이다. 외부 조회·게시·클러스터 적용은 하지 않는다.
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dump, loadAll, JSON_SCHEMA } from 'js-yaml';
import { CATALOG, generateApplications, validateApplicationInput } from './dev-argocd-applications.mjs';
import { managedNamespaces, managementInputs, validateManagedSecret } from './dev-argocd-management.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => JSON.stringify(normalize(value));
function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])]));
  return value;
}
const clusterKinds = new Set(['Namespace', 'ClusterRole', 'ClusterRoleBinding', 'CustomResourceDefinition', 'StorageClass', 'CSIDriver', 'NodeClass', 'NodePool', 'MutatingWebhookConfiguration', 'ValidatingWebhookConfiguration']);
const pendingChecks = [
  '고정 C/H checkout·generated 검증과 실제 release inventory 및 live diff 대조',
  '전용 GitHub App 읽기·쓰기 거부·토큰 갱신·키 교체',
  '게시된 ARM64 CMP digest와 실제 Argo 렌더 일치',
  'PROJ-279 writer 중지·진행 중 실행 종료 및 사본 게시 방지',
  'cert-manager 준비·LBC 인증서 전환·serving certificate와 webhook 통신',
  '관측 admission hook의 phase·RBAC·반복 sync',
  'AppProject·Kubernetes RBAC 실제 허용·거부와 기존 자원 보존',
  '관측의 빈 scrape 설정 Secret 존재 확인; 소실 시 동일 C/H로 운영자가 복구(Argo Secret create 권한 없음)',
  '목표 C/H의 Synced·Healthy·enrollment Flyway와 앱 기능',
  'Gateway ACK→Kafka consume/commit→S3/ClickHouse 및 관측 경로',
];
export const manualStages = [
  { ids: ['base'], gate: '기반 namespace·NodeClass·NodePool·기존 PVC/AZ 정합' },
  { ids: ['cert-manager'], gate: 'CRD Established·controller/webhook/cainjector Ready·startup API check 성공' },
  { ids: ['lbc', 'csi', 'strimzi-operator'], gate: '별도 LBC 인증서 전환 완료·webhook 정상·CSI/Operator Ready' },
  { ids: ['ascp', 'fluent-bit', 'kafka', 'clickhouse'], gate: 'ASCP·Kafka 현재 generation Ready·ClickHouse/PVC·로그 준비' },
  { ids: ['runtime', 'loki', 'tempo'], gate: '고정 버전 CSI 파일과 관측 수신 준비' },
  { ids: ['observability', 'otel-platform'], gate: '인증서 hook·metrics·로그·trace 확인' },
  { ids: ['enrollment-api'], gate: '목표 revision Ready·Flyway 성공·enrollment 기능' },
  { ids: ['telemetry-ingest'], gate: '목표 revision Ready·consume/commit·적재 기능' },
  { ids: ['telemetry-gateway'], gate: '목표 revision Ready·실제 ACK→Kafka→ingest 확인' },
  { ids: ['dashboard-api'], gate: '목표 revision Ready·로그인·조회 확인' },
];

function regularFile(path) {
  if (!lstatSync(path).isFile()) throw new Error('렌더 입력은 심볼릭 링크가 아닌 일반 파일이어야 한다');
  return readFileSync(path, 'utf8');
}

function parseInput(bytes) {
  try { return JSON.parse(bytes); } catch { throw new Error('인계 입력 JSON 구문 오류'); }
}

export function readRenderedManifests(input, directory) {
  validateApplicationInput(input);
  const path = resolve(directory);
  if (!lstatSync(path).isDirectory()) throw new Error('렌더 입력은 실제 디렉터리여야 한다');
  const expected = ['input.json', ...CATALOG.applications.map(entry => `${entry.id}.yaml`)].sort();
  if (canonical(readdirSync(path).sort()) !== canonical(expected)) throw new Error('동일 입력과 18개 Application별 YAML이 모두 필요하다');
  const recorded = parseInput(regularFile(join(path, 'input.json')));
  if (canonical(recorded) !== canonical(input)) throw new Error('렌더 입력의 C/H·inventory가 인계 입력과 다르다');
  const manifests = {};
  const hashes = {};
  for (const entry of CATALOG.applications) {
    const bytes = regularFile(join(path, `${entry.id}.yaml`));
    // YAML 오류의 snippet에 잘못 입력한 자격증명이 포함될 수 있으므로 원문 오류를 전파하지 않는다.
    try { manifests[entry.id] = loadAll(bytes, { schema: JSON_SCHEMA }).filter(Boolean); }
    catch { throw new Error(`${entry.id}: 렌더 YAML 구문 오류`); }
    hashes[entry.id] = sha256(bytes);
  }
  return { manifests, hashes };
}

function checkedResources(manifests) {
  if (!manifests || canonical(Object.keys(manifests).sort()) !== canonical(CATALOG.applications.map(entry => entry.id).sort())) throw new Error('18개 Application의 렌더가 필요하다');
  const owners = new Set();
  return Object.fromEntries(CATALOG.applications.map(entry => {
    const documents = manifests[entry.id];
    if (!Array.isArray(documents) || !documents.length) throw new Error(`${entry.id}: 빈 렌더는 인계할 수 없다`);
    return [entry.id, documents.map(document => {
      const item = structuredClone(document);
      if (!item || typeof item.apiVersion !== 'string' || typeof item.kind !== 'string' || typeof item.metadata?.name !== 'string') throw new Error(`${entry.id}: Kubernetes 리소스 형식 오류`);
      const cluster = clusterKinds.has(item.kind);
      const namespace = cluster ? '' : (item.metadata.namespace ?? entry.namespace);
      if (cluster && item.metadata.namespace) throw new Error(`${entry.id}: cluster 리소스에 namespace가 있다`);
      if (!cluster && !managedNamespaces.includes(namespace)) throw new Error(`${entry.id}: 관리 대상 밖 namespace`);
      if (entry.project === 'pulsemetry-dev-workloads' && (cluster || namespace !== entry.namespace)) throw new Error(`${entry.id}: workload 범위 밖 리소스`);
      if (item.kind === 'Namespace' && !managedNamespaces.includes(item.metadata.name)) throw new Error(`${entry.id}: 관리 대상 밖 Namespace`);
      if (item.metadata.annotations?.['argocd.argoproj.io/tracking-id']) throw new Error(`${entry.id}: live export 대신 고정 source를 렌더해야 한다`);
      if (!cluster) item.metadata.namespace = namespace;
      if (item.kind === 'Secret') validateManagedSecret(item);
      const group = item.apiVersion.includes('/') ? item.apiVersion.split('/')[0] : '';
      const key = `${group}/${item.kind}/${namespace}/${item.metadata.name}`;
      if (owners.has(key)) throw new Error('여러 Application이 같은 리소스를 소유하거나 렌더에 중복 리소스가 있다');
      owners.add(key);
      return item;
    })];
  }));
}

function webhookDifferences(id, resources) {
  if (!['lbc', 'cert-manager', 'observability'].includes(id)) return [];
  const hooks = resources.filter(item => ['MutatingWebhookConfiguration', 'ValidatingWebhookConfiguration'].includes(item.kind));
  if (!hooks.length) throw new Error(`${id}: webhook 렌더가 누락됐다`);
  return hooks.map(item => {
    if (id !== 'observability') {
      const annotations = item.metadata.annotations ?? {};
      const certificate = annotations['cert-manager.io/inject-ca-from'];
      const secret = annotations['cert-manager.io/inject-ca-from-secret'];
      if (id === 'lbc') {
        const cert = resources.find(resource => resource.kind === 'Certificate' && `${resource.metadata.namespace}/${resource.metadata.name}` === certificate);
        if (!cert || !resources.some(resource => resource.kind === 'Issuer' && resource.metadata.name === cert.spec?.issuerRef?.name)) throw new Error('LBC는 같은 렌더의 cert-manager Certificate·Issuer로 CA를 주입해야 한다');
        if (resources.some(resource => resource.kind === 'Secret' && resource.metadata.name === cert.spec.secretName)) throw new Error('LBC 인증서 Secret을 Argo가 중복 소유할 수 없다');
      } else if (item.metadata.name !== 'cert-manager-webhook' || secret !== 'cert-manager/cert-manager-webhook-ca') throw new Error('cert-manager webhook CA 주입 참조 오류');
    }
    return {
      group: 'admissionregistration.k8s.io', kind: item.kind, name: item.metadata.name,
      jqPathExpressions: ['.webhooks[]?.clientConfig.caBundle', ...(id === 'observability' ? ['.webhooks[]?.failurePolicy'] : [])],
    };
  });
}

export function generateHandoff(input, { cmpImage, manifests, hashes = {} }) {
  if (input?.mode !== 'handoff') throw new Error('수동 인계 생성기는 H만 받는다');
  const review = generateApplications(input);
  if (review.definitions.some(entry => entry.blockReason)) throw new Error('미해결 chart 인계 차단 조건이 있다');
  const resources = checkedResources(manifests);
  const management = managementInputs({ cmpImage, resources: Object.values(resources).flat(), reconciliationEnabled: true });
  const applications = review.definitions.map(({ id, application }) => {
    delete application.metadata.annotations['argocd.argoproj.io/skip-reconcile'];
    application.metadata.annotations['pulsemetry.io/handoff-status'] = 'pending';
    const differences = webhookDifferences(id, resources[id]);
    if (differences.length) {
      application.spec.ignoreDifferences = differences;
      application.spec.syncPolicy.syncOptions.push('RespectIgnoreDifferences=true');
    }
    return { id, application };
  });
  return {
    ...management, applications,
    report: {
      schemaVersion: 1, mode: 'manual-handoff', revisions: review.revisions,
      inventory: input.inventory, cmpImage, inputSha256: sha256(canonical(input)), renderedSha256: hashes,
      applicationCount: applications.length, generatedFileCount: 13,
      operationalAcceptance: { status: 'pending', checks: pendingChecks.map(check => ({ check, status: 'pending' })) },
      rendering: { status: 'operator-supplied', note: '동일 입력 metadata와 파일 집합을 대조했다. 실제 C/H checkout·live 동일성은 별도 운영 수락이다.' },
      manualStages,
      instructions: [
        '관리 chart의 Role을 적용하기 전에 동일 cert-manager 렌더의 Namespace만 준비한다. 이후 cert-manager Application이 그 Namespace를 추적한다.',
        '운영 수락 선행 조건을 확인한 뒤 관리 chart와 bootstrap+argocd-values overlay를 수동 Helm으로 적용한다.',
        'Application 등록 후 각 단계를 수동 sync하고 목표 revision·현재 health·단계별 gate를 확인한다.',
        'H 인계에는 root가 없으므로 wave annotation은 Application 사이의 실행 순서를 보장하지 않는다.',
        '기존 workload의 수동 Helm과 Argo를 상시 병행하지 않는다. 자동화·공통 publisher 상태는 후속이다.',
      ],
    },
  };
}

export function writeHandoff(input, options, directory) {
  const result = generateHandoff(input, options);
  const output = resolve(directory);
  mkdirSync(output, { mode: 0o700 });
  mkdirSync(join(output, 'applications'), { mode: 0o700 });
  const write = (file, content) => writeFileSync(join(output, file), content, { flag: 'wx', mode: 0o600 });
  for (const { id, application } of result.applications) write(`applications/${id}.yaml`, dump(application, { noRefs: true, lineWidth: -1 }));
  write('argocd-values.yaml', dump(result.argoValues, { noRefs: true, lineWidth: -1 }));
  write('management-values.yaml', dump(result.managementValues, { noRefs: true, lineWidth: -1 }));
  write('handoff-report.json', `${JSON.stringify(result.report, null, 2)}\n`);
  return result;
}

export function run(argv) {
  const args = {};
  const keys = ['--input', '--rendered-manifests', '--cmp-image', '--output-dir'];
  for (let i = 0; i < argv.length; i += 2) {
    if (!keys.includes(argv[i]) || !argv[i + 1] || args[argv[i]]) throw new Error('사용법: --input JSON --rendered-manifests DIRECTORY --cmp-image REPOSITORY@sha256:DIGEST --output-dir NEW_DIRECTORY');
    args[argv[i]] = argv[i + 1];
  }
  if (Object.keys(args).length !== keys.length) throw new Error('인계 입력·렌더 디렉터리·CMP digest·새 출력 디렉터리가 모두 필요하다');
  const input = parseInput(regularFile(resolve(args['--input'])));
  const rendered = readRenderedManifests(input, args['--rendered-manifests']);
  const result = writeHandoff(input, { cmpImage: args['--cmp-image'], ...rendered }, args['--output-dir']);
  console.log(`수동 인계 Application ${result.applications.length}개와 관리 설정 생성 완료; 운영 수락 pending; 외부 적용 없음`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { run(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
