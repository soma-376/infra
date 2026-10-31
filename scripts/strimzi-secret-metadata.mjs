#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { STRIMZI_CA, STRIMZI_NAMESPACE, strimziUser, parseStrimziSecrets } from './strimzi-values.mjs';

// kubectl은 metadata만 투영한다. Secret data를 포함한 API 응답을 저장·출력하지 않는다.
const [stage, destination] = process.argv.slice(2);
if (!['validation', 'main'].includes(stage) || !destination || process.argv.length !== 4) {
  console.error('사용법: node scripts/strimzi-secret-metadata.mjs validation|main <metadata.json>');
  process.exit(1);
}
try {
  const names = [STRIMZI_CA, ...['gateway', 'ingest', 'topic-admin', 'offset-admin'].map(role => strimziUser(role, stage))];
  const items = names.map(name => {
    const fields = execFileSync('kubectl', ['get', 'secret', name, '-n', STRIMZI_NAMESPACE, '-o', 'jsonpath={.metadata.name}{"\\t"}{.metadata.namespace}{"\\t"}{.metadata.uid}{"\\t"}{.metadata.resourceVersion}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\t');
    if (fields.length !== 4) throw new Error('metadata projection failed');
    return { metadata: Object.fromEntries(['name', 'namespace', 'uid', 'resourceVersion'].map((field, i) => [field, fields[i]])) };
  });
  const text = JSON.stringify({ items }, null, 2) + '\n';
  parseStrimziSecrets(text, stage);
  writeFileSync(destination, text, { mode: 0o600 });
  console.log(`Secret metadata ${items.length}개 저장 (namespace=${STRIMZI_NAMESPACE}, stage=${stage})`);
} catch (error) {
  // execFileSync 예외에는 명령 출력이 포함되므로 예외 객체를 그대로 출력하지 않는다.
  console.error('Secret metadata 수집 실패: kubectl context·namespace·사용자 readiness를 확인한다');
  process.exitCode = 1;
}
