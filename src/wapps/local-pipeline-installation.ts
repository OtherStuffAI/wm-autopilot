import {nip19} from "nostr-tools";
import type {WappStore} from "./wapp-store";

/** Trusted local management only. Does not assert Tower ACLs or publishing grants. */
export async function ensureLocalPipelineInstallation(store:WappStore,
  lookup:(id:string)=>Promise<{root:string;ownerNpub:string|null}|undefined>,
  input:{appId:string;ownerNpub:string;scopeId:string;launchUrl:string;sourceWingmanUrl:string;title:string}) {
  if(!input || Object.keys(input).sort().join(",")!=="appId,launchUrl,ownerNpub,scopeId,sourceWingmanUrl,title")throw new Error("installation_input_denied");
  const owner=nip19.decode(input.ownerNpub),app=await lookup(input.appId);
  if(owner.type!=="npub" || app?.ownerNpub!==input.ownerNpub || !app.root.startsWith("/"))throw new Error("installation_owner_denied");
  if(!/^[0-9a-f-]{36}$/.test(input.scopeId)||!input.title.trim()||input.title.length>200)throw new Error("installation_metadata_denied");
  for(const value of [input.launchUrl,input.sourceWingmanUrl]) {
    const url=new URL(value);
    if(url.protocol!=="https:"||url.username||url.password||url.hash||url.search||url.pathname!=="/")throw new Error("installation_origin_denied");
  }
  let record=store.getByAppId(input.appId);
  if(record) {
    if(record.ownerNpub!==input.ownerNpub||record.scopeId!==input.scopeId||new URL(record.launchUrl).href!==new URL(input.launchUrl).href||
      record.recordState!=="active"||record.status!=="active")throw new Error("installation_drift_denied");
  } else record=store.create({appId:input.appId,title:input.title,ownerNpub:input.ownerNpub,createdByNpub:input.ownerNpub,
    workspaceOwnerNpub:input.ownerNpub,scopeId:input.scopeId,allowedNpubs:[input.ownerNpub],launchUrl:new URL(input.launchUrl).href,
    sourceWingmanUrl:new URL(input.sourceWingmanUrl).href});
  const identity=store.ensureLocalAppSigningIdentity(record.id,input.ownerNpub);
  return {installationId:record.id,appId:record.appId,appNpub:identity.appNpub,ownerNpub:record.ownerNpub,
    launchUrl:record.launchUrl,scopeId:record.scopeId,towerPublicationGranted:false};
}
