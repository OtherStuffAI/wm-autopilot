import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {PipelineStore} from './pipeline-store.ts';
import {parseCompletedTurnRequest} from '../sessions/completed-turn-contract.ts';
import {completedTurnBindingId} from '../sessions/completed-turn-runtime.ts';
import {invokeNativeProjectTool} from './native-project-tool.ts';
import {runtimeFunctionHash,pipelineFunctionHashes} from './pipeline-function-pins.ts';
import type {SessionSnapshot} from '../agents/process-manager.ts';

test('native tool resolves only immutable pinned handler and active own turn; caller cannot choose authority',async()=>{
 const root=mkdtempSync('/private/tmp/native-tool-'),store=new PipelineStore(root+'/pipelines.sqlite');
 try{
  const owner='owner',request=parseCompletedTurnRequest({conversationKey:'conversation',requestId:'request',projectId:'project',directory:root,prompt:'Build and publish'});
  const handler=Object.assign(async (input:any)=>({published:true,correlation:input.nativeReceipt,request:input.input}),{[runtimeFunctionHash]:'pinned-hash'});
  const definition:any={id:'definition',name:'test',scope:'user',ownerAlias:'owner',path:null,spec:{name:'test',version:1,steps:[{name:'Native turn',type:'code',function:'session.completedTurn',agentTools:{publish:'app.publish'}}]}};
  const run=store.createRun({definitionId:'definition',name:'test',scope:'user',ownerNpub:owner,ownerAlias:'owner',input:{projectId:'project',requestId:'request',generation:4}});
  const step=store.createStep({runId:run.id,stepIndex:0,name:'Native turn',kind:'code',input:{},metadata:{agentTools:{publish:'app.publish'}}});
  store.setRunActiveStep(run.id,step.id);
  store.composition.pin(run.id,definition,{functionHashes:pipelineFunctionHashes(definition,{'app.publish':handler})});
  const row=store.completedTurns.enqueue(owner,request,run.id,step.id);store.completedTurns.claim(row.receiptId,'claim');store.completedTurns.bind(row.receiptId,'claim','execution','session');store.completedTurns.sending(row.receiptId,'claim','native',0);
  const session={id:'session',npub:owner,workingDirectory:root,metadata:{role:'completed-turn',nativeProjectTools:true,bindingId:completedTurnBindingId(owner,'conversation'),nativeAgentSession:{agent:'codex',sessionId:'native',workingDirectory:root}},agent:'codex'} as SessionSnapshot;
  const load:any=async()=>({registry:{'app.publish':handler},records:[]});
  const result:any=await invokeNativeProjectTool(store,session,'publish',{requestId:'foreign',directory:'/elsewhere'},load);
  expect(result.correlation.requestId).toBe('request');expect(result.correlation.invocationRunId).toBe(run.id);expect(result.correlation.nativeSessionId).toBe('native');expect(result.request.generation).toBe(4);
  await expect(invokeNativeProjectTool(store,{...session,id:'foreign'},'publish',{},load)).rejects.toThrow('turn_denied');
  await expect(invokeNativeProjectTool(store,session,'other',{},load)).rejects.toThrow('grant_denied');
  await expect(invokeNativeProjectTool(store,{...session,npub:'other'},'publish',{},load)).rejects.toThrow('turn_denied');
  await expect(invokeNativeProjectTool(store,session,'publish',{},async()=>({registry:{},records:[]}))).rejects.toThrow('Pinned');
  store.cancelRun(run.id);await expect(invokeNativeProjectTool(store,session,'publish',{},load)).rejects.toThrow('grant_denied');
 }finally{rmSync(root,{recursive:true,force:true});}
});
