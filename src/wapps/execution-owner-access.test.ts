import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PipelineStore } from "../pipelines/pipeline-store";
import { handlePipelineApi, type PipelineApiContext } from "../pipelines/pipeline-api-routes";
import { installedAppExecutionNpubs, installedAppExecutionOwner, installedAppSessionMatches } from "./execution-owner-access";
import type { WappRecord } from "./types";
const owner="npub1operator", app="npub1app", other="npub1other";
const installation = {ownerNpub:owner,appNpub:app,status:"active",recordState:"active"} as WappRecord;

test("installation authority grants only its owner native session access and fails closed on conflicting/revoked relationships",()=>{
  const rows=[installation];
  expect(installedAppExecutionNpubs(owner,rows)).toEqual([app]);
  expect(installedAppExecutionNpubs(other,rows)).toEqual([]);
  expect(installedAppSessionMatches(app,{ownerNpub:app},owner,rows)).toBe(true);
  expect(installedAppSessionMatches(app,{ownerNpub:other},owner,rows)).toBe(false);
  expect(installedAppSessionMatches(other,{ownerNpub:other,executionOperatorNpub:owner} as any,owner,rows)).toBe(false);
  expect(installedAppSessionMatches(app,null,other,rows)).toBe(false);
  expect(installedAppExecutionOwner(app,[installation,{...installation,ownerNpub:other}])).toBeNull();
  expect(installedAppExecutionNpubs(owner,[{...installation,recordState:"deleted"}])).toEqual([]);
  expect(installedAppExecutionNpubs(owner,[{...installation,status:"archived"}])).toEqual([]);
});

test("ordinary pipeline APIs expose real app runs and steps to installation owner/delegate, retain provenance, reject foreign owners",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"app-owner-access-"));
  const store=new PipelineStore(join(dir,"pipelines.sqlite"));
  let rows=[installation];
  const ctx={store,defaultAgent:"codex",sessionApiContext:{manager:{stopSession:async()=>true},scheduleSessionArchive(){}},
    ensureApiAccess:async()=>null,AccessActions:{SessionsManage:"sessions:manage"},
    installedAppExecutionNpubs:(npub:string)=>installedAppExecutionNpubs(npub,rows)} as PipelineApiContext;
  const native=store.publicCalls.create({owner:app,definitionId:"app-definition",key:"saved",fingerprint:"fingerprint",webhookUrl:"https://app.test/callback"},()=>store.createRun({definitionId:"app-definition",name:"App builder",scope:"user",ownerNpub:app,input:{requestId:"saved"}}));
  const foreign=store.createRun({definitionId:"foreign",name:"Other private builder",scope:"user",ownerNpub:other,input:{}});
  const call=async(path:string,viewer:string,delegate=false)=>{
    const url=new URL("https://autopilot.test"+path);
    return (await handlePipelineApi(new Request(url),url,"GET",{npub:delegate?"npub1bot":viewer,signerNpub:delegate?"npub1bot":viewer,
      delegatedOwnerNpub:delegate?viewer:null,session:null},ctx))!;
  };
  try {
    const list=await (await call('/api/pipelines/runs?includeDefinitionMeta=0',owner)).json();
    expect(list.runs.map((r:any)=>r.id)).toEqual([native.id]);
    for(const delegate of [false,true])for(const suffix of ['', '/steps', '/delivery'])expect((await call('/api/pipelines/runs/'+native.id+suffix,owner,delegate)).status).toBe(200);
    expect((await call('/api/pipelines/runs/'+native.id,other)).status).toBe(404);
    expect((await call('/api/pipelines/runs/'+foreign.id,owner)).status).toBe(404);
    expect(store.getRun(native.id)?.ownerNpub).toBe(app);
    rows=[{...installation,recordState:"deleted"}];
    expect((await call('/api/pipelines/runs/'+native.id,owner)).status).toBe(404);
    expect((await (await call('/api/pipelines/runs?includeDefinitionMeta=0',owner)).json()).runs).toEqual([]);
    expect((await call('/api/pipelines/runs/'+native.id,app)).status).toBe(200);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
