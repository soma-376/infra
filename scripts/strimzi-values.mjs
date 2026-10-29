import { createHash } from 'node:crypto';
import { load, JSON_SCHEMA } from 'js-yaml';

// 허브 ADR-0026·infra ADR-0049. endpoint/Secret 이름은 사용자 override가 아닌 배포 계약이다.
export const STRIMZI_CLUSTER = 'soma-376-dev-telemetry';
export const STRIMZI_NAMESPACE = 'pulsemetry-dev';
export const STRIMZI_BOOTSTRAP = `${STRIMZI_CLUSTER}-kafka-bootstrap.${STRIMZI_NAMESPACE}.svc.cluster.local:9093`;
export const strimziUser = (role, stage) => `pulsemetry-${role}-${stage}`;
export const STRIMZI_CA = `${STRIMZI_CLUSTER}-cluster-ca-cert`;

/** Secret 원문은 받지 않는다. kubectl로 투영한 metadata 네 필드만 판정·해시한다. */
export function parseStrimziSecrets(text, stage) {
  let document;
  try { document = JSON.parse(text); load(text, { schema: JSON_SCHEMA }); }
  catch { throw new Error('strimzi-secrets: 중복 키 없는 metadata JSON이 필요하다'); }
  if (!document || Object.keys(document).join() !== 'items' || !Array.isArray(document.items)) {
    throw new Error('strimzi-secrets: items에 Secret metadata만 담는다');
  }
  const names = [STRIMZI_CA, ...['gateway', 'ingest', 'topic-admin', 'offset-admin'].map(role => strimziUser(role, stage))];
  const metadata = new Map();
  for (const item of document.items) {
    if (!item || Object.keys(item).join() !== 'metadata' || !item.metadata || Array.isArray(item.metadata)) {
      throw new Error('strimzi-secrets: data/stringData 등 Secret 원문 필드는 허용하지 않는다');
    }
    const m = item.metadata;
    if (Object.keys(m).sort().join() !== 'name,namespace,resourceVersion,uid' ||
        m.namespace !== STRIMZI_NAMESPACE || !names.includes(m.name) || metadata.has(m.name) ||
        typeof m.uid !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(m.uid) ||
        typeof m.resourceVersion !== 'string' || !/^[0-9]{1,40}$/.test(m.resourceVersion)) {
      throw new Error('strimzi-secrets: 지정한 namespace/stage의 고유 name·uid·resourceVersion이 필요하다');
    }
    metadata.set(m.name, { name: m.name, namespace: m.namespace, uid: m.uid, resourceVersion: m.resourceVersion });
  }
  if (metadata.size !== names.length) throw new Error('strimzi-secrets: CA와 stage별 사용자 4개의 metadata가 모두 필요하다');
  return Object.fromEntries(['gateway', 'ingest', 'topic-admin', 'offset-admin'].map(role => {
    const userSecretName = strimziUser(role, stage);
    const revision = [STRIMZI_CA, userSecretName].map(name => {
      const { uid, resourceVersion } = metadata.get(name);
      return { uid, resourceVersion };
    });
    const tlsRevision = createHash('sha256').update(JSON.stringify(revision)).digest('hex');
    return [role, { clusterCaSecretName: STRIMZI_CA, userSecretName, tlsRevision }];
  }));
}

export function kafkaPlatformValues(outputs) {
  const required = key => { if (!outputs[key]) throw new Error(`${key}: 배포 output이 없다`); return outputs[key]; };
  if (required('KafkaProvider') !== 'strimzi') throw new Error('prepare-kafka는 strimzi 공급자만 허용한다');
  const prefix = required('ArchivePrefix');
  if (!['eks_validation', 'eks'].includes(prefix)) throw new Error('ArchivePrefix는 eks_validation 또는 eks여야 한다');
  const stage = required('KafkaStage');
  if (!['validation', 'main'].includes(stage) || stage !== (prefix === 'eks' ? 'main' : 'validation')) {
    throw new Error('KafkaStage와 ArchivePrefix가 다르다');
  }
  if (required('KafkaTopicName') !== `pulsemetry-dev-telemetry-ingress-${stage}` || required('KafkaConsumerGroupName') !== `pulsemetry-dev-telemetry-ingest-${stage}`) {
    throw new Error('Kafka topic/group은 stage 계약을 따라야 한다');
  }
  const zone = required('EksKafkaAvailabilityZone');
  if (!/^ap-northeast-2[a-z]$/.test(zone) || zone !== required('EksClickhouseAvailabilityZone')) throw new Error('Kafka와 ClickHouse AZ가 다르다');
  const sg = key => { const value = required(key); if (!/^sg-[a-f0-9]{8}([a-f0-9]{9})?$/.test(value)) throw new Error(`${key}: SG ID가 올바르지 않다`); return value; };
  const subnets = required('EksSubnetIds').split(',').map(x => x.trim());
  if (subnets.length < 2 || new Set(subnets).size !== subnets.length || !subnets.every(x => /^subnet-[a-f0-9]{8}([a-f0-9]{9})?$/.test(x))) throw new Error('EksSubnetIds가 올바르지 않다');
  const role = required('EksNodeRoleName');
  if (!/^[a-zA-Z0-9_+=,.@-]{1,64}$/.test(role)) throw new Error('EksNodeRoleName이 올바르지 않다');
  return {
    'base.yaml': { nodeRoleName: role, subnetIds: subnets, appNodeSecurityGroupId: sg('EksAppNodeSecurityGroupId'),
      clickhouseNodeSecurityGroupId: sg('EksClickhouseNodeSecurityGroupId'), clickhouseAvailabilityZone: zone,
      observabilityNodeSecurityGroupId: sg('ObservabilityNodeSecurityGroupId'),
      kafka: { enabled: true, securityGroupId: sg('EksKafkaNodeSecurityGroupId'), availabilityZone: zone } },
    'kafka-strimzi.yaml': { clusterName: STRIMZI_CLUSTER, stage, availabilityZone: zone },
  };
}
