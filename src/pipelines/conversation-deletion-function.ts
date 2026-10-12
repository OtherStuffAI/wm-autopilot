import { lstat, realpath, unlink } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { SessionApiContext } from '../server/session-api-routes.ts';
import type { PipelineStore, JsonObject } from './pipeline-store.ts';
import { deleteCompletedConversation, type ConversationDeletionRequest, type ConversationDeletionRuntime } from '../sessions/conversation-deletion.ts';
import { resolveSessionOwnerNpub } from '../sessions/session-ownership.ts';
import { completedTurnBindingId } from '../sessions/completed-turn-runtime.ts';
import { findCodexSessionFileForReading, resolveCodexHome } from '../agents/codex-session-fork.ts';
export const conversationDeletionFunctionName='session.deleteConversation';
export async function executeConversationDeletionFunction(input:{store:PipelineStore;sessionApiContext:SessionApiContext;ownerNpub:string|null;request:JsonObject}):Promise<JsonObject>{
  return deleteCompletedConversation({owner:input.ownerNpub??'',request:input.request as ConversationDeletionRequest,store:input.store.completedTurns,runtime:createConversationDeletionRuntime(input.sessionApiContext)});
}
export function createConversationDeletionRuntime(ctx:SessionApiContext,codexHome?:string):ConversationDeletionRuntime {
  return {remove:async target=>{
    const source=ctx.manager.getSession(target.sessionId)??ctx.messageStore.getSession(target.sessionId)??ctx.sessionArchiveStore?.getArchivedSession(target.sessionId);
    if(!source)throw Error('Deletion source unavailable; reconcile same deletion receipt, never recreate');
    const bindingId=completedTurnBindingId(target.owner,target.conversationKey);
    const authorized=(s:any)=>resolveSessionOwnerNpub(s.npub??null,s.metadata)===target.owner && s.agent==='codex' && s.workingDirectory===target.directory && s.metadata?.role==='completed-turn' && s.metadata?.agentTransport==='codex-sdk' && s.metadata?.bindingId===bindingId;
    if(!authorized(source))throw Error('Conversation deletion dedicated ownership denied');
    const native=source.metadata?.nativeAgentSession;
    if(native?.agent!=='codex'||!native.sessionId||native.workingDirectory!==target.directory)throw Error('Native deletion reference unavailable');
    const archived=[];
    if(ctx.sessionArchiveStore)for(let offset=0;;offset+=200){const page=ctx.sessionArchiveStore.listArchivedSessions({limit:200,offset});archived.push(...page);if(page.length<200)break;}
    const all=[...ctx.manager.listSessions(),...ctx.messageStore.listSessions(),...archived];
    const matches=all.filter(s=>s.metadata?.nativeAgentSession?.sessionId===native.sessionId);
    if(matches.some(s=>!authorized(s)))throw Error('Native conversation has a foreign association; deletion denied');
    const ids=new Set(matches.map(s=>s.id));ids.add(target.sessionId);
    for(const id of ids){const live=ctx.manager.getSession(id);if(live&&(live.status==='running'||live.status==='starting'))await ctx.manager.stopSession(id);}
    const home=resolveCodexHome(codexHome),file=await findCodexSessionFileForReading({codexHome:home,sessionId:native.sessionId,workingDirectory:target.directory});
    let nativeTranscriptDeleted=false;
    if(file){const root=await realpath(join(home,'sessions')),actual=await realpath(file),rel=relative(root,actual),stats=await lstat(file);if(!stats.isFile()||stats.isSymbolicLink()||rel.startsWith('..')||rel.startsWith('/'))throw Error('Native transcript deletion path denied');await unlink(file);nativeTranscriptDeleted=true;}
    for(const id of ids){ctx.cancelPendingArchive(id);if(ctx.manager.getSession(id))ctx.manager.deleteSession(id);ctx.messageStore.removeSession(id);ctx.sessionArchiveStore?.deleteArchivedSession(id);}
    return {runtimeStorageDeleted:true,nativeTranscriptDeleted,nativeStorageDeleted:false,metadataIndexesPreserved:true};
  }};
}
