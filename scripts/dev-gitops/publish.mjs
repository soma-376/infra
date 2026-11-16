// 성공한 backend 생산물만 짧은 Git 게시로 연결한다. Argo 접근 권한은 쓰지 않는다.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assert, parse, validateManifest } from './contract.mjs';
import { imageSnapshot } from './simple-release.mjs';
import { SimpleGitStore, publishWithRetry } from './publication.mjs';
import { verifySourceBundle } from './source-proof.mjs';

export async function publishImages({store,candidateBytes,provenance,verifySource}) {
  const bundle = validateManifest(candidateBytes,provenance);
  const verify = () => verifySource(bundle,provenance);
  await verify();
  return publishWithRetry({store,prepare:async current=>{
    const prior=Date.parse(current.producer.createdAt), next=Date.parse(provenance.createdAt);
    assert(next>prior || (next===prior && BigInt(provenance.workflowRunId)>=BigInt(current.producer.workflowRunId)), '과거 생산 실행은 게시하지 않는다');
    if(provenance.workflowRunId===current.producer.workflowRunId)
      assert(BigInt(provenance.workflowRunAttempt)>=BigInt(current.producer.workflowRunAttempt), '과거 attempt는 게시하지 않는다');
    return {snapshot:imageSnapshot(current,bundle,provenance),infraCommit:current.selection.infraCommit};
  },verify});
}
export async function main(args,env=process.env,deps={}) {
  assert(env.DELIVERY_ENABLED==='true','이미지 게시가 비활성이다');
  assert(env.GITHUB_REPOSITORY==='soma-376/pulsemetry-backend' && env.GITHUB_REF==='refs/heads/develop' &&
    env.GITHUB_WORKFLOW_REF==='soma-376/pulsemetry-backend/.github/workflows/promote_dev.yml@refs/heads/develop' &&
    ['workflow_run','workflow_dispatch'].includes(env.GITHUB_EVENT_NAME),'허용한 develop 게시 workflow가 필요하다');
  assert(args.length===4 && args[0]==='--candidate' && args[2]==='--provenance','사용법: publish.mjs --candidate FILE --provenance FILE');
  const candidateBytes=await readFile(args[1],'utf8'), provenance=parse(await readFile(args[3],'utf8'),'생산 출처');
  const store=await (deps.openStore??SimpleGitStore.open)({env});
  let packageVerified=false;
  const verifySource=deps.verifySource??(async(bundle,proof)=>{
    // 같은 immutable digest의 패키지는 한 번만 추출한다. 매 게시 직전 API/ZIP/최신성은 다시 확인한다.
    await verifySourceBundle(bundle,proof,{env,requireLatest:true,...(packageVerified?{verifyImages:async()=>{}}:{})});
    packageVerified=true;
  });
  try {
    const result=await publishImages({store,candidateBytes,provenance,
      verifySource});
    console.log(JSON.stringify({result:result.result})); return 0;
  } finally {await store.close();}
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
  main(process.argv.slice(2)).then(code=>{process.exitCode=code;}).catch(()=>{console.error('이미지 Git 게시 실패. 현재 선택은 Argo에서 확인하고 원본 workflow를 재실행한다.');process.exitCode=1;});
