import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {CATALOG,INFRA_REPOSITORY,VALUES_REPOSITORY} from '../../scripts/dev-argocd-applications.mjs';
import {APPS,json,validateManifest} from '../../scripts/dev-gitops/contract.mjs';
import {makeBundle,provenance,values,C,GENERATED_FILES} from './fixtures.mjs';
import {makeSnapshot,imageSnapshot,readYaml} from '../../scripts/dev-gitops/simple-release.mjs';
import {SimpleGitStore,publishPrepared,publishWithRetry,selectedRelease} from '../../scripts/dev-gitops/publication.mjs';
import {publishImages} from '../../scripts/dev-gitops/publish.mjs';

function git(cwd,...args){return execFileSync('git',args,{cwd,encoding:'utf8',env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_AUTHOR_NAME:'test',GIT_AUTHOR_EMAIL:'t@example.test',GIT_COMMITTER_NAME:'test',GIT_COMMITTER_EMAIL:'t@example.test'}}).trim();}
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'simple-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const remote=join(dir,'remote.git'),seed=join(dir,'seed');await mkdir(seed);git(dir,'init','--bare','--quiet','--initial-branch=main',remote);git(seed,'init','--quiet','--initial-branch=main');
 await writeFile(join(seed,'README.md'),'preserve\n');git(seed,'add','.');git(seed,'commit','-qm','seed');git(seed,'remote','add','origin',remote);git(seed,'push','-q','origin','main');
 const store=await SimpleGitStore.open({remote,local:true});t.after(()=>store.close());
 const bundle=makeBundle({commit:'a'.repeat(40),run:'200',imageSeed:'baseline'}),producer=provenance(bundle);
 const generated=new Map(GENERATED_FILES.map(name=>[`dev/generated/${name}`,APPS.some(a=>name===`${a}.yaml`)?values(name.slice(0,-5),bundle):'fixed: true\n']));
 const applications=new Map(CATALOG.applications.map(entry=>[`dev/applications/${entry.id}.yaml`,json({apiVersion:'argoproj.io/v1alpha1',kind:'Application',metadata:{name:entry.name,namespace:'argocd',annotations:{'argocd.argoproj.io/sync-wave':String(entry.wave)}},spec:{project:entry.project,destination:{server:'https://kubernetes.default.svc',namespace:entry.namespace},sources:[{repoURL:INFRA_REPOSITORY,path:entry.chart,targetRevision:C,...(entry.renderer==='strimzi-cmp'?{plugin:{name:'pulsemetry-strimzi-v1'}}:{helm:{releaseName:entry.id}})},...(entry.generatedFile?[{repoURL:VALUES_REPOSITORY,ref:'values',targetRevision:'a'.repeat(40)}]:[])],syncPolicy:{automated:{enabled:true,selfHeal:true,prune:false,allowEmpty:false},retry:{limit:0}}}})]));
 const result=await publishPrepared({store,expectedHead:await store.refresh(),snapshot:makeSnapshot(generated,bundle.bytes,producer,C),applications,infraCommit:C});
 return {dir,remote,store,bundle,producer,generated,applications,result};
}
test('snapshot과 Application을 한 번에 게시하고 재실행은 no-op',async t=>{
 const f=await fixture(t),current=await selectedRelease(f.store,await f.store.refresh());
 assert.equal(current.selection.valuesCommit,f.result.valuesCommit);assert.equal(current.bundle.B,f.bundle.B);
 assert.equal((await f.store.files(await f.store.refresh())).get('README.md'),'preserve\n');
 const again=await publishPrepared({store:f.store,expectedHead:await f.store.refresh(),snapshot:makeSnapshot(f.generated,f.bundle.bytes,f.producer,C),applications:current.applications,infraCommit:C});
 assert.equal(again.result,'noop');assert.equal(git(f.dir,'--git-dir',f.remote,'rev-list','--count','main'),'3');
});
test('backend publication preserves nonimage bytes and manual sync policy',async t=>{
 const f=await fixture(t),before=await selectedRelease(f.store,await f.store.refresh());
 const appPath='dev/applications/telemetry-gateway.yaml',app=readYaml(before.applications.get(appPath));app.spec.syncPolicy.automated.enabled=false;
 const change=await f.store.commit(await f.store.refresh(),new Map([[appPath,json(app)]]),'maintenance');await f.store.push(await f.store.refresh(),change);
 const bundle=makeBundle(),proof=provenance(bundle,{createdAt:'2026-11-07T00:00:00Z'});let checks=0;
 const result=await publishImages({store:f.store,candidateBytes:bundle.bytes,provenance:proof,verifySource:async()=>{checks++;}});
 assert.equal(result.result,'published');assert.equal(checks,2);
 const after=await selectedRelease(f.store,await f.store.refresh());
 assert.equal(after.selection.infraCommit,C);assert.equal(after.bundle.B,bundle.B);
 assert.equal(readYaml(after.applications.get(appPath)).spec.syncPolicy.automated.enabled,false);
 assert.equal(after.generated.get('dev/generated/clickhouse.yaml'),before.generated.get('dev/generated/clickhouse.yaml'));
 const stale=provenance(f.bundle,{createdAt:'2026-11-01T00:00:00Z'});
 await assert.rejects(publishImages({store:f.store,candidateBytes:f.bundle.bytes,provenance:stale,verifySource:async()=>{}}),/과거/);
});
test('경합 시 최신 선택을 다시 읽고 상대 변경을 보존한다',async t=>{
 const f=await fixture(t),other=await SimpleGitStore.open({remote:f.remote,local:true});t.after(()=>other.close());
 const bundle=makeBundle(),proof=provenance(bundle,{createdAt:'2026-11-07T00:00:00Z'});let attempt=0;
 const originalPush=f.store.push.bind(f.store);
 f.store.push=async(expected,p)=>{
   if(attempt++===0){const current=await selectedRelease(other,await other.refresh());const gen=new Map(current.generated);gen.set('dev/generated/clickhouse.yaml','fixed: changed\n');await publishPrepared({store:other,expectedHead:await other.refresh(),snapshot:makeSnapshot(gen,current.bundle.bytes,current.producer,C),applications:current.applications,infraCommit:C});}
   return originalPush(expected,p);
 };
 await publishWithRetry({store:f.store,prepare:async current=>({snapshot:imageSnapshot(current,bundle,proof),infraCommit:C})});
 const current=await selectedRelease(f.store,await f.store.refresh());assert.equal(current.generated.get('dev/generated/clickhouse.yaml'),'fixed: changed\n');assert.equal(current.bundle.B,bundle.B);assert.equal(attempt,2);
});
test('push response loss verifies exact P ancestry without duplicate publication',async t=>{
 const f=await fixture(t),bundle=makeBundle(),proof=provenance(bundle,{createdAt:'2026-11-07T00:00:00Z'});
 const gitCall=f.store.git.bind(f.store);let lost=false;
 f.store.git=async(args,...rest)=>{const result=await gitCall(args,...rest);if(args.includes('push')&&!args.includes('core.hooksPath=/dev/null')&&!lost){lost=true;throw Error('lost');}return result;};
 await publishImages({store:f.store,candidateBytes:bundle.bytes,provenance:proof,verifySource:async()=>{}});
 assert.equal((await selectedRelease(f.store,await f.store.refresh())).bundle.B,bundle.B);assert.equal(git(f.dir,'--git-dir',f.remote,'rev-list','--count','main'),'5');
});
test('validation failure writes no remote commit; legacy state is refused',async t=>{
 const f=await fixture(t),head=await f.store.refresh();
 await assert.rejects(publishWithRetry({store:f.store,prepare:async()=>{throw Error('validation');}}),/validation/);assert.equal(await f.store.refresh(),head);
 const broken=await f.store.commit(head,new Map([['dev/desired.yaml','schemaVersion: 1\n']]),'legacy');await f.store.push(head,broken);
 await assert.rejects(selectedRelease(f.store,broken),/v2/);
});
