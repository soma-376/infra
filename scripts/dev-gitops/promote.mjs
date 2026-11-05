import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assert, parse, validateOwner } from './contract.mjs';
import { promote, validateActivation } from './engine.mjs';
import { GitStore } from './git-store.mjs';
import { producerChecks, runtimeObservers } from './runtime.mjs';

export async function main(args, env = process.env) {
  assert(env.DELIVERY_ENABLED === 'true', 'DELIVERY_ENABLED 기본 비활성');
  assert(args.length === 4 && args[0] === '--candidate' && args[2] === '--provenance', '사용법: promote.mjs --candidate FILE --provenance FILE');
  assert(env.GITHUB_REPOSITORY === 'soma-376/pulsemetry-backend' && env.GITHUB_REF === 'refs/heads/main' &&
    env.GITHUB_WORKFLOW_REF === 'soma-376/pulsemetry-backend/.github/workflows/promote_dev.yml@refs/heads/main', '검토한 default main 승격 workflow만 실행한다');
  const owner = { repository: env.GITHUB_REPOSITORY, workflowRef: env.GITHUB_WORKFLOW_REF,
    workflowRunId: env.GITHUB_RUN_ID, workflowRunAttempt: env.GITHUB_RUN_ATTEMPT };
  validateOwner(owner);
  const candidateBytes = await readFile(args[1], 'utf8'), provenance = parse(await readFile(args[3], 'utf8'), '원본 실행 증거');
  const store = await GitStore.open({ env });
  let observer;
  try {
    const head = await store.refresh();
    const activation = validateActivation(parse(await store.read(head, 'dev/activation.json'), '자동화 수락'));
    observer = await runtimeObservers(activation, { env, store });
    const result = await promote({ store, candidateBytes, provenance, owner, ...observer, ...producerChecks(env) });
    // 공개 Actions 로그에는 private SHA·endpoint·관측 원문을 남기지 않는다.
    console.log(JSON.stringify({ result: result.result, ...(result.reason ? { reason: result.reason } : {}) }));
    if (result.result === 'blocked') return 2;
    return 0;
  } finally { await observer?.close(); await store.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(() => {
    console.error('배포 승격을 완료하지 못했다. private 상태를 확인한 뒤 재개한다.'); process.exitCode = 1;
  });
}
