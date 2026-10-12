import type { CompletedTurnStore } from './completed-turn-store.ts';
export type ConversationDeletionRequest={conversationKey:string;projectId:string;directory:string;requestId:string;confirmation:'delete_native_transcript'};
export interface ConversationDeletionRuntime { remove(input:{owner:string;conversationKey:string;projectId:string;directory:string;sessionId:string}):Promise<{runtimeStorageDeleted:boolean;nativeTranscriptDeleted:boolean;nativeSessionId:string;nativeStorageDeleted:false;metadataIndexesPreserved:true}> }
const inFlight=new WeakMap<CompletedTurnStore,Map<string,Promise<any>>>();
/** The authenticated pipeline principal supplies owner; callers cannot supply session IDs or paths. */
export async function deleteCompletedConversation(input:{owner:string;request:ConversationDeletionRequest;store:CompletedTurnStore;runtime:ConversationDeletionRuntime}) {
  const {owner,request,store,runtime}=input;
  if(!owner || request.confirmation!=='delete_native_transcript' || !request.directory?.startsWith('/') || ['conversationKey','projectId','requestId'].some(key=>typeof request[key as keyof ConversationDeletionRequest]!=='string'||!request[key as keyof ConversationDeletionRequest]||request[key as keyof ConversationDeletionRequest].length>200))throw Error('Conversation deletion request denied');
  const deletion=store.beginDeletion(owner,request);
  if(deletion.receiptJson)return JSON.parse(deletion.receiptJson);
  const key=JSON.stringify([owner,request.conversationKey]);
  let pending=inFlight.get(store);if(!pending){pending=new Map();inFlight.set(store,pending);}
  const existing=pending.get(key);if(existing)return existing;
  const work=(async()=>{
  const outcome=await runtime.remove({owner,conversationKey:request.conversationKey,projectId:request.projectId,directory:request.directory,sessionId:deletion.sessionId});
  const receipt={...outcome,owner,conversationKey:request.conversationKey,projectId:request.projectId,requestId:request.requestId,sessionId:deletion.sessionId,receiptId:deletion.receiptId,status:'deleted',auditReceiptsPreserved:true};
  store.finishDeletion(owner,request.conversationKey,receipt);
  return receipt;
  })();
  pending.set(key,work);
  try{return await work;}finally{pending.delete(key);}
}
