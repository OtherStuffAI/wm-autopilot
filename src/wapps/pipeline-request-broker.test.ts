import {expect,test} from "bun:test";
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync,statSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {generateSecretKey,getPublicKey,nip19,verifyEvent} from "nostr-tools";
import {PipelineStore} from "../pipelines/pipeline-store";
import type {PipelineApiContext} from "../pipelines/pipeline-api-routes";
import {WappStore} from "./wapp-store";
import {WappPipelineGrantStore} from "./pipeline-grant-store";
import {WappPipelineRequestBroker,WAPP_PIPELINE_BROKER_PATH} from "./pipeline-request-broker";
import {handleWappPipelineBrokerRoute} from "../server/wapp-pipeline-broker-route";
import {handleWappRemotePipelineBrokerRoute} from "../server/wapp-remote-pipeline-broker-route";
const owner=nip19.npubEncode(getPublicKey(generateSecretKey()));
async function fixture(fn:(x:any)=>Promise<void>) {
  const dir=mkdtempSync(join(tmpdir(),"pipeline-app-broker-")),previous=process.env.WINGMEN_PIPELINES_ROOT;
  process.env.WINGMEN_PIPELINES_ROOT=join(dir,"pipelines");
  mkdirSync(join(dir,"pipelines/shared/definitions"),{recursive:true});
  const definitionPath=join(dir,"pipelines/shared/definitions/app-proof.json");
  writeFileSync(definitionPath,JSON.stringify({name:"app-proof",version:1,steps:[]}));
  const wapps=new WappStore(join(dir,"wapps.sqlite"));
  const wapp=wapps.create({id:"installation",appId:"app",title:"App",ownerNpub:owner,createdByNpub:owner,
    workspaceOwnerNpub:owner,scopeId:"scope",allowedNpubs:[],launchUrl:"https://example.com"});
  expect(wapp.appNpub).toBeNull(); const identity=wapps.ensureLocalAppSigningIdentity(wapp.id,owner);
  expect(identity.appNpub).not.toBe(owner); expect(wapps.hasAppSigningKey(wapp.id)).toBe(true);
  const grants=new WappPipelineGrantStore(join(dir,"grants.sqlite")); let now=Date.now();
  const {listPipelineDefinitions}=await import("../pipelines/pipeline-loader");
  const definition=(await listPipelineDefinitions(null)).find(d=>d.name==="app-proof")!;
  const broker=new WappPipelineRequestBroker(grants,wapps,async()=>({root:dir,ownerNpub:owner}),()=>now,
    (async(value:string)=>({url:new URL(value),addresses:[]})) as any);
  const registration=await broker.register(owner,{installationId:wapp.id,appId:wapp.appId,
    origin:"https://autopilot.example",definitionId:definition.id,callbackUrl:"https://example.com/result",expiresAt:now+60000});
  const token=readFileSync(registration.credentialFile,"utf8").trim();
  expect(statSync(registration.credentialFile).mode&0o777).toBe(0o600);
  const store=new PipelineStore(join(dir,"runs.sqlite"));
  const ctx:PipelineApiContext={store,defaultAgent:"codex",sessionApiContext:{} as any,
    ensureApiAccess:async()=>{throw new Error("broad execution must not be requested")},
    AccessActions:{SessionsManage:"sessions:manage"},resultWebhooks:{pubkey:"synthetic"} as any};
  const path=`/api/pipelines/definitions/${encodeURIComponent(definition.id)}/runs`;
  const payload={mode:"webhook",idempotencyKey:"request",input:{requestId:"request",projectId:"project"},webhook:{url:"https://example.com/result"}};
  try {await fn({dir,wapps,grants,broker,registration,token,ctx,path,payload,definitionPath,identity,setNow:(n:number)=>{now=n}})}
  finally {if(previous===undefined)delete process.env.WINGMEN_PIPELINES_ROOT;else process.env.WINGMEN_PIPELINES_ROOT=previous;
    grants.close();rmSync(dir,{recursive:true,force:true})}
}
test("managed app scope signs exact bytes, runs native public call and owns private polling",()=>fixture(async x=>{
  const first=await x.broker.request(x.token,{method:"POST",path:x.path,serializedBody:JSON.stringify(x.payload)},x.ctx);
  expect(first.status).toBe(202); const body=await first.json(); expect(body.response.runId).toBeString();
  expect(verifyEvent(body.receipt.event)).toBe(true);
  expect(body.receipt.event.tags).toContainEqual(["u","https://autopilot.example"+x.path]);
  const run=x.ctx.store.getRun(body.response.runId); expect(run.ownerNpub).toBe(x.identity.appNpub);
  const retry=await x.broker.request(x.token,{method:"POST",path:x.path,serializedBody:JSON.stringify(x.payload)},x.ctx);
  const replay=await retry.json();expect(replay.response.runId).toBe(run.id);expect(replay.response.replayed).toBe(true);
  expect(replay.receipt.event.id).not.toBe(body.receipt.event.id);
  const read=await x.broker.request(x.token,{method:"GET",path:`/api/pipelines/runs/${run.id}`},x.ctx);
  expect(read.status).toBe(200);
  expect(x.grants.ownsRun(x.registration.grant.id,run.id)).toBe(true);
}));
test("denies foreign runs/routes, callback widening, drift, expiry and revocation",()=>fixture(async x=>{
  for(const input of [{method:"GET",path:"/api/pipelines/runs/foreign"},{method:"POST",path:"/api/sessions"},
    {method:"GET",path:"/api/pipelines/webhook-signer?admin=true"},
    {method:"POST",path:x.path,serializedBody:JSON.stringify({...x.payload,webhook:{url:"https://other.example/result"}})}]) {
    expect((await x.broker.request(x.token,input,x.ctx)).status).toBe(403);
  }
  writeFileSync(x.definitionPath,JSON.stringify({name:"changed",steps:[]}));
  expect((await x.broker.request(x.token,{method:"POST",path:x.path,serializedBody:JSON.stringify(x.payload)},x.ctx)).status).toBe(403);
  x.grants.revoke(x.registration.grant.id);
  await expect(x.broker.request(x.token,{method:"GET",path:"/api/pipelines/webhook-signer"},x.ctx)).rejects.toThrow();
}));
test("grant survives store reopen; runtime route denies browser/remote and unbounded bodies",()=>fixture(async x=>{
  const reopened=new WappPipelineGrantStore(join(x.dir,"grants.sqlite"));
  expect(reopened.authorize(x.token).appNpub).toBe(x.identity.appNpub);reopened.close();
  const make=(remote:boolean,origin?:string)=>handleWappPipelineBrokerRoute({broker:x.broker,pipelines:x.ctx,
    url:new URL("http://localhost"+WAPP_PIPELINE_BROKER_PATH),isLoopback:!remote,
    request:new Request("http://localhost"+WAPP_PIPELINE_BROKER_PATH,{method:"POST",headers:{authorization:"Bearer "+x.token,...(origin?{origin}:{})},body:JSON.stringify({method:"GET",path:"/api/pipelines/webhook-signer"})})});
  expect((await make(true))!.status).toBe(403);expect((await make(false,"https://browser.example"))!.status).toBe(403);
  expect((await make(false))!.status).toBe(200);
  const oversized=await handleWappPipelineBrokerRoute({broker:x.broker,pipelines:x.ctx,isLoopback:true,
    url:new URL("http://localhost"+WAPP_PIPELINE_BROKER_PATH),request:new Request("http://localhost"+WAPP_PIPELINE_BROKER_PATH,
      {method:"POST",headers:{authorization:"Bearer "+x.token},body:"x".repeat(1100001)})});
  expect(oversized!.status).toBe(413);
  x.setNow(x.registration.grant.expiresAt);
  await expect(x.broker.request(x.token,{method:"GET",path:"/api/pipelines/webhook-signer"},x.ctx)).rejects.toThrow();
}));
test("remote managed route binds deployment identity, preserves idempotency and fails closed",()=>fixture(async x=>{
  const remote=await x.broker.register(owner,{installationId:"installation",appId:"app",origin:"https://autopilot.example",
    definitionId:x.registration.grant.definitionId,callbackUrl:"https://example.com/result",expiresAt:x.registration.grant.expiresAt,
    access:"remote",clientOrigin:"https://example.com"});
  const token=readFileSync(remote.credentialFile,"utf8").trim();
  const body={installationId:"installation",appId:"app",ownerNpub:owner,clientOrigin:"https://example.com",
    operation:"pipeline.request",request:{method:"POST",path:x.path,serializedBody:JSON.stringify(x.payload)}} as const;
  const call=(value:any=body,origin?:string,credential=token)=>handleWappRemotePipelineBrokerRoute({broker:x.broker,pipelines:x.ctx,
    url:new URL("https://autopilot.example/api/wapps/remote-managed-pipelines"),request:new Request("https://autopilot.example/api/wapps/remote-managed-pipelines",
      {method:"POST",headers:{authorization:"Bearer "+credential,...(origin?{origin}:{})},body:JSON.stringify(value)})});
  const first=await call();expect(first!.status).toBe(202);const accepted=await first!.json();
  const retry=await call();expect(retry!.status).toBe(200);const replay=(await retry!.json()).response;
  expect(replay.runId).toBe(accepted.response.runId);expect(replay.replayed).toBe(true);
  expect((await call({...body,installationId:"foreign"}))!.status).toBe(403);
  expect((await call({...body,appId:"foreign"}))!.status).toBe(403);
  expect((await call({...body,ownerNpub:nip19.npubEncode(getPublicKey(generateSecretKey()))}))!.status).toBe(403);
  expect((await call({...body,clientOrigin:"https://foreign.example"}))!.status).toBe(403);
  expect((await call({...body,request:{method:"GET",path:"/api/pipelines/runs/foreign"}}))!.status).toBe(403);
  expect((await call(body,"https://example.com"))!.status).toBe(403);
  expect((await call(body,undefined,x.token))!.status).toBe(403);
  await expect(x.broker.request(token,{method:"GET",path:"/api/pipelines/webhook-signer"},x.ctx)).rejects.toThrow("pipeline_grant_binding_denied");
  x.setNow(remote.grant.expiresAt);expect((await call())!.status).toBe(403);
  x.grants.revoke(remote.grant.id);expect((await call())!.status).toBe(403);
}));
