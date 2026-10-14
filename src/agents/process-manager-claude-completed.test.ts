import {test,expect} from 'bun:test';

// Isolate SDK module doubles in a child so other adapter tests retain the real SDK.
test('ProcessManager preallocates Claude completed-turn identity before SDK start and preserves it through publication readiness and resume',async()=>{
 const script=String.raw`
 import {mock} from 'bun:test';
 import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
 import {join} from 'node:path';
 import {tmpdir} from 'node:os';
 const root=mkdtempSync(join(tmpdir(),'manager-claude-completed-'));
 process.env.WINGMAN_CLAUDE_TURN_JOURNAL_DIR=join(root,'journal');
 const path=join(root,'mcp.json');
 writeFileSync(path,JSON.stringify({mcpServers:{wingman:{type:'stdio',command:'bun',args:['fake.ts']}}}));
 mock.module('./src/agents/mcp-injector.ts',()=>({injectMcpConfig:async()=>({commandArgs:['--mcp-config',path],cleanupFiles:[],env:{}}),cleanupMcpConfig:()=>{}}));
 const launches=[];
 mock.module('@anthropic-ai/claude-agent-sdk',()=>({startup:async({options})=>{
  launches.push(options);return {query:()=>({async *[Symbol.asyncIterator](){
   const id=options.sessionId??options.resume;
   yield {type:'system',subtype:'init',session_id:id,model:'configured-model',mcp_servers:[{name:'wingman',status:'connected'}]};
   yield {type:'result',subtype:'success',is_error:false,result:'safe final',session_id:id};
  },close(){}}),close(){}};
 }}));
 const {ProcessManager}=await import('./src/agents/process-manager.ts');
 const {resolveNativeResumeLaunch}=await import('./src/sessions/native-resume-launch.ts');
 const {claudeTurnCheckpoint,recoverClaudeTurn}=await import('./src/sessions/claude-turn-journal.ts');
 const manager=new ProcessManager({allowedHosts:'localhost',agentPortStart:47894,agentPortMax:47896,agents:{claude:{label:'Claude',command:({port})=>['agentapi','--port',String(port),'--','claude'],modelOptions:['default'],env:{}}}});
 function assert(value,message){if(!value)throw Error(message);}
 try{
  const session=await manager.createSession('claude',root,'Builder',null,undefined,undefined,{agentTransport:'claude-sdk',role:'completed-turn',nativeProjectTools:true,bindingId:'binding',nextAction:'none',autoStop:false});
  const native=session.metadata.nativeAgentSession;
  assert(native.source==='preallocated'&&native.agent==='claude'&&native.workingDirectory===root,'missing fresh preallocated lineage');
  assert(/^[a-f0-9-]{36}$/.test(native.sessionId),'missing native UUID');
  assert(launches[0].sessionId===native.sessionId&&!launches[0].resume,'fresh SDK must start sessionId, not resume');
  assert(manager.getAdapter(session.id).getSessionId()===null,'unstarted native ID must remain preallocated');
  assert(manager.getSession(session.id).metadata.nativeAgentSession.source==='preallocated','snapshot falsely advanced identity');
  const context={nativeSessionId:native.sessionId,directory:root};assert(claudeTurnCheckpoint(context)===0,'checkpoint missing before prompt');
  assert(await manager.getAdapter(session.id).sendCompletedMessage('build')==='safe final','terminal reply missing');
  assert(recoverClaudeTurn(context,0,'build')==='safe final','trusted recovery missing');
  const completed=manager.getSession(session.id);assert(completed.metadata.nativeAgentSession.sessionId===native.sessionId&&completed.metadata.nativeAgentSession.source==='adapter','terminal lineage changed');
  await manager.stopSession(session.id);
  const launch=resolveNativeResumeLaunch(completed,agent=>agent==='claude');
  const resumed=await manager.createSession(launch.agent,launch.workingDirectory,launch.name,launch.origin,undefined,undefined,launch.metadata);
  assert(launches[1].resume===native.sessionId&&!launches[1].sessionId,'owned resume must keep native ID');
  await manager.stopSession(resumed.id);
  console.log('CLAUDE_PROCESS_MANAGER_OK');
 }finally{rmSync(root,{recursive:true,force:true});}
 `;
 const child=Bun.spawn([process.execPath,'-e',script],{cwd:process.cwd(),stdout:'pipe',stderr:'pipe'});
 const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
 expect({code,error:code?stderr:''}).toEqual({code:0,error:''});
 expect(stdout).toContain('CLAUDE_PROCESS_MANAGER_OK');
},15000);
