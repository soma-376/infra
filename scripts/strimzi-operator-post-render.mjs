#!/usr/bin/env node
// upstream chart가 자체 namespace를 감시 목록에 붙이므로 runtime 감시만 정확히 제한한다.
// 원본 tgz/checksum과 upstream RBAC는 보존한다. 추가 namespace 감시를 묵인하지 않는다.
import { readFileSync } from 'node:fs';
import { loadAll, dump } from 'js-yaml';
try {
  const documents = loadAll(readFileSync(0, 'utf8')).filter(Boolean);
  const deployments = documents.filter(x => x.kind === 'Deployment' && x.spec?.template?.spec?.containers?.some(c => c.name === 'strimzi-cluster-operator'));
  if (deployments.length !== 1) throw new Error('공식 Strimzi operator Deployment 하나가 필요하다');
  const deployment = deployments[0];
  if (deployment.metadata.namespace !== 'strimzi-system') throw new Error('operator namespace는 strimzi-system이어야 한다');
  const operator = deployment.spec.template.spec.containers.find(x => x.name === 'strimzi-cluster-operator');
  const namespaces = operator.env.filter(x => x.name === 'STRIMZI_NAMESPACE');
  if (namespaces.length !== 1 || namespaces[0].value !== 'pulsemetry-dev,strimzi-system') throw new Error('예상한 upstream watch namespace가 아니다');
  namespaces[0].value = 'pulsemetry-dev';
  process.stdout.write(documents.map(x => dump(x, { noRefs: true, lineWidth: -1 })).join('---\n'));
} catch (error) { console.error(error.message); process.exitCode = 1; }
