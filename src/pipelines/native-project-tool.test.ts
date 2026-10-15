import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {PipelineStore} from './pipeline-store.ts';
import {parseCompletedTurnRequest} from '../sessions/completed-turn-contract.ts';
import {completedTurnBindingId} from '../sessions/completed-turn-runtime.ts';
import {invokeNativeProjectTool} from './native-project-tool.ts';
import {runtimeFunctionHash,pipelineFunctionHashes} from './pipeline-function-pins.ts';
import type {SessionSnapshot} from '../agents/process-manager.ts';
import {registerActiveCompletedTurnClaim} from '../sessions/active-completed-turn-claims.ts';

function fixture(operation:((input:any)=>Promise<any>)=async input=>({published:true,correlation:input.nativeReceipt,request:input.input}),agent:"codex"|"goose"|"claude"="codex"){
 const root=mkdtempSync('/private/tmp/native-tool-'),store=new PipelineStore(root+'/pipelines.sqlite');
 const owner='owner',request=parseCompletedTurnRequest({conversationKey:'conversation',requestId:'request',projectId:'project',...(agent==='goose'?{agent,model:'z-ai/glm-5.3'}:agent==='claude'?{agent}:{}),directory:root,prompt:'Build and publish'});
 const handler=Object.assign(operation,{[runtimeFunctionHash]:'pinned-hash'});
 const definition:any={id:'definition',name:'test',scope:'user',ownerAlias:'owner',path:null,spec:{name:'test',version:1,steps:[{name:'Native turn',type:'code',function:'session.completedTurn',agentTools:{publish:'app.publish'}}]}};
 const run=store.createRun({definitionId:'definition',name:'test',scope:'user',ownerNpub:owner,ownerAlias:'owner',input:{projectId:'project',requestId:'request',generation:4}});
 const step=store.createStep({runId:run.id,stepIndex:0,name:'Native turn',kind:'code',input:{},metadata:{agentTools:{publish:'app.publish'}}});
 store.setRunActiveStep(run.id,step.id);store.composition.pin(run.id,definition,{functionHashes:pipelineFunctionHashes(definition,{'app.publish':handler})});
 const row=store.completedTurns.enqueue(owner,request,run.id,step.id);store.completedTurns.claim(row.receiptId,'claim');store.completedTurns.bind(row.receiptId,'claim','execution','session');store.completedTurns.sending(row.receiptId,'claim','native',0);
 const session={id:'session',npub:owner,workingDirectory:root,metadata:{agentTransport:agent==='goose'?'goose-acp':agent==='claude'?'claude-sdk':'codex-sdk',role:'completed-turn',nativeProjectTools:true,bindingId:completedTurnBindingId(owner,'conversation'),nativeAgentSession:{agent,sessionId:'native',workingDirectory:root}},agent} as SessionSnapshot;
 const load:any=async()=>({registry:{'app.publish':handler},records:[]});
 return {store,row,run,step,session,handler,load,definition,expire(){const db=new Database(store.path);try{db.run('UPDATE completed_turn_receipts SET leaseUntil=0 WHERE receiptId=?',[row.receiptId]);}finally{db.close();}},close(){rmSync(root,{recursive:true,force:true});}};
}

test('native tool resolves immutable pinned handler and own turn; opt-in, foreign authority and missing/changed pins fail closed',async()=>{
 const f=fixture();try{
  const result:any=await invokeNativeProjectTool(f.store,f.session,'publish',{requestId:'foreign',directory:'/elsewhere'},f.load);
  expect(result.correlation.requestId).toBe('request');expect(result.correlation.invocationRunId).toBe(f.run.id);expect(result.correlation.nativeSessionId).toBe('native');expect(result.request.generation).toBe(4);
  await expect(invokeNativeProjectTool(f.store,{...f.session,id:'foreign'},'publish',{},f.load)).rejects.toThrow('turn_denied');
  await expect(invokeNativeProjectTool(f.store,f.session,'other',{},f.load)).rejects.toThrow('grant_denied');
  await expect(invokeNativeProjectTool(f.store,{...f.session,npub:'other'},'publish',{},f.load)).rejects.toThrow('turn_denied');
  await expect(invokeNativeProjectTool(f.store,{...f.session,metadata:{...f.session.metadata!,nativeProjectTools:undefined}},'publish',{},f.load)).rejects.toThrow('turn_denied');
  await expect(invokeNativeProjectTool(f.store,f.session,'publish',{},async()=>({registry:{},records:[]}))).rejects.toThrow('Pinned');
  const changed=Object.assign(async()=>({}),{[runtimeFunctionHash]:'changed-hash'});
  await expect(invokeNativeProjectTool(f.store,f.session,'publish',{},async()=>({registry:{'app.publish':changed},records:[]}))).rejects.toThrow('Pinned');
  expect(()=>pipelineFunctionHashes(f.definition,{})).toThrow('must be hash pinned');
  f.store.cancelRun(f.run.id);await expect(invokeNativeProjectTool(f.store,f.session,'publish',{},f.load)).rejects.toThrow('grant_denied');
 }finally{f.close();}
});
test('expired and completed native turns cannot invoke a pinned tool',async()=>{
 const expired=fixture(),completed=fixture();try{
  expired.expire();await expect(invokeNativeProjectTool(expired.store,expired.session,'publish',{},expired.load)).rejects.toThrow('turn_denied');
  completed.store.completedTurns.complete(completed.row.receiptId,'claim','Ordinary final','native');
  await expect(invokeNativeProjectTool(completed.store,completed.session,'publish',{},completed.load)).rejects.toThrow('turn_denied');
 }finally{expired.close();completed.close();}
});
test('the exact in-process sender may refresh an elapsed lease but a replaced recovery claim remains fenced',async()=>{
 const active=fixture(),recovered=fixture();let releaseActive=()=>{},releaseRecovered=()=>{};try{
  releaseActive=registerActiveCompletedTurnClaim(active.store.path,active.session.id,active.row.receiptId,'claim');
  active.expire();expect(await invokeNativeProjectTool(active.store,active.session,'publish',{},active.load)).toEqual(expect.objectContaining({published:true}));
  releaseRecovered=registerActiveCompletedTurnClaim(recovered.store.path,recovered.session.id,recovered.row.receiptId,'claim');
  recovered.expire();expect(recovered.store.completedTurns.claim(recovered.row.receiptId,'recovery')).toBe(true);
  await expect(invokeNativeProjectTool(recovered.store,recovered.session,'publish',{},recovered.load)).rejects.toThrow('turn_denied');
 }finally{releaseActive();releaseRecovered();active.close();recovered.close();}
});
test('same turn/tool concurrent invocation is refused without a second handler; completed call releases the slot',async()=>{
 let release!:()=>void,entered!:()=>void,calls=0;
 const gate=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>entered=resolve);
 const f=fixture(async()=>{calls++;entered();await gate;return {ok:true};});try{
  const first=invokeNativeProjectTool(f.store,f.session,'publish',{},f.load);await started;
  await expect(invokeNativeProjectTool(f.store,f.session,'publish',{},f.load)).rejects.toThrow('in_progress');expect(calls).toBe(1);
  release();expect(await first).toEqual({ok:true});expect(await invokeNativeProjectTool(f.store,f.session,'publish',{},f.load)).toEqual({ok:true});expect(calls).toBe(2);
 }finally{release();f.close();}
});
test('expiry during asynchronous module loading is rechecked before effects and releases the invocation slot',async()=>{
 let release!:()=>void,entered!:()=>void;
 const gate=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>entered=resolve);
 let calls=0;const f=fixture(async()=>{calls++;return {ok:true};});try{
  const invocation=invokeNativeProjectTool(f.store,f.session,'publish',{},async()=>{entered();await gate;return f.load();});
  await started;f.expire();release();await expect(invocation).rejects.toThrow('lease_changed');expect(calls).toBe(0);
  f.store.completedTurns.renew(f.row.receiptId,'claim');expect(await invokeNativeProjectTool(f.store,f.session,'publish',{},f.load)).toEqual({ok:true});
 }finally{release();f.close();}
});

test('Goose publication invokes the genuine pinned tool dispatcher with exact saved native lineage',async()=>{
 const f=fixture(undefined,'goose');try{
  const result:any=await invokeNativeProjectTool(f.store,f.session,'publish',{validation:['Actual build check']},f.load);
  expect(result.published).toBe(true);expect(result.correlation.nativeSessionId).toBe('native');expect(result.correlation.receiptId).toBe(f.row.receiptId);
  for(const session of [{...f.session,agent:'codex'},{...f.session,metadata:{...f.session.metadata,agentTransport:'codex-sdk'}},{...f.session,metadata:{...f.session.metadata,nativeAgentSession:{...f.session.metadata!.nativeAgentSession!,agent:'codex'}}}])await expect(invokeNativeProjectTool(f.store,session as SessionSnapshot,'publish',{},f.load)).rejects.toThrow('lineage_denied');
 }finally{f.close()}
});

test('Claude publication invokes the genuine pinned tool dispatcher with exact saved native lineage',async()=>{
 const f=fixture(undefined,'claude');try{
  const result:any=await invokeNativeProjectTool(f.store,f.session,'publish',{validation:['Actual build check']},f.load);
  expect(result.published).toBe(true);expect(result.correlation.nativeSessionId).toBe('native');expect(result.correlation.receiptId).toBe(f.row.receiptId);
  for(const session of [{...f.session,agent:'codex'},{...f.session,metadata:{...f.session.metadata,agentTransport:'codex-sdk'}},{...f.session,metadata:{...f.session.metadata,nativeAgentSession:{...f.session.metadata!.nativeAgentSession!,agent:'codex'}}}])await expect(invokeNativeProjectTool(f.store,session as SessionSnapshot,'publish',{},f.load)).rejects.toThrow('lineage_denied');
 }finally{f.close()}
});
