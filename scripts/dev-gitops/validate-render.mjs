// 실제 Application의 release와 values 순서로 18개를 렌더한다. 원문은 로그에 남기지 않는다.
import {spawnSync} from 'node:child_process';
import {isDeepStrictEqual} from 'node:util';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {loadAll,JSON_SCHEMA} from 'js-yaml';
import {CATALOG} from '../dev-argocd-applications.mjs';
import {prepareCharts} from '../dev-argocd-prepare-charts.mjs';
import {assert} from './contract.mjs';
import {readYaml,validateApplication} from './simple-release.mjs';

export function validateApplicationRenders({root,directory,applications,helm=process.env.HELM_BIN??'helm',nativeHelm=process.env.ARGOCD_NATIVE_HELM_BIN??'helm4'},run=spawnSync) {
  const command=(bin,args,env={})=>{
    const result=run(bin,args,{cwd:root,env:{...process.env,...env},encoding:'utf8',timeout:120000,maxBuffer:64*1024*1024});
    assert(!result.error&&result.status===0&&result.stdout?.trim(),'Application 렌더 실패');return result.stdout;
  };
  assert(/^v3\.22\.0(?:\+|\s|$)/.test(command(helm,['version','--short'])),'Helm 3.22.0 필요');
  assert(/^v4\.2\.1(?:\+|\s|$)/.test(command(nativeHelm,['version','--short'])),'Argo native Helm 4.2.1 필요');
  prepareCharts({root});
  const documents=text=>{
    try{return loadAll(text,{schema:JSON_SCHEMA}).filter(Boolean).sort((a,b)=>`${a.apiVersion}/${a.kind}/${a.metadata?.namespace}/${a.metadata?.name}`.localeCompare(`${b.apiVersion}/${b.kind}/${b.metadata?.namespace}/${b.metadata?.name}`));}
    catch{throw new Error('Application 렌더 YAML 오류');}
  };
  for(const entry of CATALOG.applications){
    const app=validateApplication(readYaml(applications.get(`dev/applications/${entry.id}.yaml`)),entry),source=app.spec.sources[0];
    if(entry.renderer==='strimzi-cmp'){
      const release=source.plugin.env?.find(item=>item.name==='RELEASE_NAME')?.value;
      const output=command(process.execPath,[join(root,'helm/dev/platform/argocd/cmp/bin/render-strimzi.mjs')],{
        HELM_BIN:helm,ARGOCD_ENV_RELEASE_NAME:release,PULSEMETRY_CMP_NODE_MODULES:join(root,'node_modules')});
      assert(documents(output).length>0,'CMP 빈 렌더');continue;
    }
    const chart=resolve(root,source.path),options=source.helm;
    const args=['template',options.releaseName,chart,'--namespace',entry.namespace,'--kube-version',options.kubeVersion??'1.36.0','--include-crds','--skip-tests'];
    for(const file of options.valueFiles??[]){
      let path;
      if(file.startsWith('$values/dev/generated/'))path=join(directory,file.slice('$values/dev/generated/'.length));
      else {path=resolve(chart,file);const rel=relative(root,path);assert(rel&&!isAbsolute(rel)&&!rel.startsWith('..'),'values 경로 오류');}
      args.push('--values',path);
    }
    const old=documents(command(helm,args)),current=documents(command(nativeHelm,args));
    assert(current.length>0&&isDeepStrictEqual(old,current),'Helm 3/4 렌더 불일치');
  }
}
