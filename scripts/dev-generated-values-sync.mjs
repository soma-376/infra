#!/usr/bin/env node
// PROJ-334: 승인된 인프라 설정을 현재 이미지와 합쳐 Argo 선언으로 게시한다.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dump } from 'js-yaml';
import pipeline from './dev-cdk-pipeline.cjs';
import profiles from '../lib/dev/deployment-profile.cjs';
import { generateValues, parseRuntimeValues } from './eks-values.mjs';
import { collectGeneratedValuesInputs } from './dev-generated-values-inputs.mjs';
import { validateGeneratedValues } from './validate-generated-values.mjs';
import { githubClient, verifyPublicationEvidence } from './generated-values-github.mjs';
import { APPS, assert } from './dev-gitops/contract.mjs';
import { readYaml, makeSnapshot } from './dev-gitops/simple-release.mjs';
import { SimpleGitStore, publishWithRetry } from './dev-gitops/publication.mjs';
import {validateApplicationRenders} from './dev-gitops/validate-render.mjs';

export async function syncGeneratedValues({root,directory,env=process.env,dependencies={}}) {
  const expected=pipeline.context(env);
  const pipelineRun=(dependencies.createPipeline??pipeline.createPipeline)({root,directory,env});
  const {plan,receipt}=pipelineRun.verifyPublication(expected);
  assert(plan.generatedValues?.mode==='simple-v2','새 plan이 필요하다');
  const github=(dependencies.githubClient??githubClient)(env.GH_TOKEN);
  const verifyEvidence=()=> (dependencies.verifyPublicationEvidence??verifyPublicationEvidence)({receipt,receiptArtifactId:env.RECEIPT_ARTIFACT_ID,github});
  const verify=async()=>{
    await verifyEvidence();
    pipelineRun.checkPublicationBaseline(expected,receipt);
    const branch=await github('/repos/soma-376/infra/commits/develop');
    assert(branch.sha===expected.sourceSha,'설정 source 이후 develop이 변경되어 새 plan이 필요하다');
  };
  await verify();
  const store=await (dependencies.openStore??SimpleGitStore.open)({env});
  try {
    return await publishWithRetry({store,prepare:async current=>{
      let collected,retained=false;
      const temporary=mkdtempSync(path.join(tmpdir(),'dev-values-v2-'));
      const close=async()=>{try{await collected?.close();}finally{rmSync(temporary,{recursive:true,force:true});}};
      try {
        collected=await (dependencies.collectInputs??collectGeneratedValuesInputs)({accountId:expected.account,runId:expected.runId,runAttempt:expected.runAttempt});
        const profile=profiles.readDeploymentProfile(path.join(root,'config/dev/deployment.json'));
        const images=Object.fromEntries(APPS.map(app=>[app,{...readYaml(current.generated.get(`dev/generated/${app}.yaml`)).image,platform:'linux/arm64'}]));
        for(const app of APPS)assert(images[app].repository===`${expected.account}.dkr.ecr.ap-northeast-2.amazonaws.com/soma-376/${app}`,'현재 이미지의 실행 계정 불일치');
        const image=app=>`${images[app].repository}@${images[app].digest}`;
        const values=generateValues(collected.outputs,{enrollment:image('enrollment-api'),ingest:image('telemetry-ingest'),gateway:image('telemetry-gateway'),dashboard:image('dashboard-api')},
          parseRuntimeValues(readFileSync(profile.runtimeValuesPath,'utf8')),undefined,undefined,profile,JSON.stringify(collected.metadata));
        const generatedDirectory=path.join(temporary,'generated');mkdirSync(generatedDirectory);
        const generated=new Map(Object.entries(values).map(([name,value])=>{
          const text='# CDK output 참조에서 생성했다. Secret 값을 넣지 않는다.\n'+dump(value,{noRefs:true,lineWidth:-1});
          writeFileSync(path.join(generatedDirectory,name),text,{mode:0o600});return [`dev/generated/${name}`,text];
        }));
        await (dependencies.validateValues??validateGeneratedValues)({root,directory:generatedDirectory,images,expectedValues:values});
        (dependencies.validateRenders??validateApplicationRenders)({root,directory:generatedDirectory,applications:current.applications});
        await collected.verifyMetadata();
        const snapshot=makeSnapshot(generated,current.bundle.bytes,current.producerBytes,expected.sourceSha);
        retained=true;
        return {snapshot,infraCommit:expected.sourceSha,
          verify:()=>collected.verifyMetadata(),close};
      } finally {if(!retained)await close();}
    },verify});
  } finally {await store.close();}
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [flag,directory,...extra]=process.argv.slice(2);
  let result={result:'failed'};
  try {
    assert(flag==='--directory' && directory && extra.length===0,'사용법: --directory PATH');
    result=await syncGeneratedValues({root:path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),directory});
  } catch {console.error('설정 Git 게시 실패. 승인 자료·현재 baseline·private 선택을 확인한다.');process.exitCode=1;}
  if(directory) {
    // 공개 artifact에는 private SHA·values를 넣지 않는다.
    const safe={status:result.result};
    writeFileSync(path.join(directory,'result-publish.json'),JSON.stringify(safe,null,2)+'\n',{mode:0o600});
    if(process.env.GITHUB_STEP_SUMMARY)writeFileSync(process.env.GITHUB_STEP_SUMMARY,`\nGenerated values: **${safe.status}**\n`,{flag:'a'});
  }
}
