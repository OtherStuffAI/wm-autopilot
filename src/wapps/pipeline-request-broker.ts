import { createHash, randomUUID } from "node:crypto";
import { nip19, verifyEvent } from "nostr-tools";
import { generateIdentityAlias } from "../identity/identity-alias";
import { getPipelineDefinition } from "../pipelines/pipeline-loader";
import { loadPipelineFunctionRegistry } from "../pipelines/function-loader";
import { builtinPipelineFunctions } from "../pipelines/functions";
import { pipelineFunctionHashes } from "../pipelines/pipeline-function-pins";
import { handlePublicPipelineCall } from "../pipelines/public-call-routes";
import { publicDelivery, runEnvelope } from "../pipelines/public-call-contract";
import type { PipelineApiContext } from "../pipelines/pipeline-api-routes";
import { validateWebhookUrl } from "../pipelines/result-webhook-http";
import { createWappNip98Authorization } from "./wapp-publishing-client";
import type { WappStore } from "./wapp-store";
import { WappPipelineGrantStore, type WappPipelineGrant } from "./pipeline-grant-store";

export const WAPP_PIPELINE_BROKER_PATH = "/api/internal/wapps/pipelines";
export const WAPP_REMOTE_PIPELINE_BROKER_PATH = "/api/wapps/remote-managed-pipelines";
const hash = (value:unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export interface WappPipelineRequest {method:"GET"|"POST"; path:string; serializedBody?:string;}
export interface RemoteWappPipelineRequest {
  installationId:string; appId:string; ownerNpub:string; clientOrigin:string;
  operation:"pipeline.request"; request:WappPipelineRequest;
}
export class WappPipelineRequestBroker {
  constructor(readonly grants:WappPipelineGrantStore, private readonly wapps:WappStore,
    private readonly appLookup:(id:string)=>Promise<{root:string;ownerNpub:string|null}|undefined>,
    private readonly now=()=>Date.now(),
    private readonly validateCallback=validateWebhookUrl) {}
  async register(ownerNpub:string,input:{installationId:string;appId:string;definitionId:string;origin:string;callbackUrl:string;expiresAt:number;access?:"loopback"|"remote";clientOrigin?:string}) {
    const wapp=this.wapps.get(input.installationId),app=await this.appLookup(input.appId);
    if (!wapp || wapp.appId!==input.appId || wapp.ownerNpub!==ownerNpub || app?.ownerNpub!==ownerNpub ||
        wapp.recordState!=="active" || wapp.status!=="active" || !wapp.appNpub || !this.wapps.hasAppSigningKey(wapp.id)) throw new Error("pipeline_app_binding_denied");
    const origin=new URL(input.origin);
    if (origin.protocol!=="https:" || origin.origin!==input.origin || origin.username || origin.password) throw new Error("pipeline_origin_denied");
    if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt<=this.now() || input.expiresAt>this.now()+90*86400000) throw new Error("pipeline_expiry_denied");
    const callback=(await this.validateCallback(input.callbackUrl)).url;
    if (callback.origin!==new URL(wapp.launchUrl).origin) throw new Error("pipeline_callback_denied");
    const access=input.access??"loopback";
    if (access!=="loopback"&&access!=="remote") throw new Error("pipeline_access_denied");
    if (access==="remote") {
      const clientOrigin=new URL(input.clientOrigin!);
      if (clientOrigin.protocol!=="https:" || clientOrigin.origin!==input.clientOrigin || clientOrigin.username || clientOrigin.password ||
          clientOrigin.origin!==new URL(wapp.launchUrl).origin || clientOrigin.origin!==callback.origin) throw new Error("pipeline_client_origin_denied");
    } else if (input.clientOrigin!==undefined) throw new Error("pipeline_client_origin_denied");
    const alias=generateIdentityAlias(ownerNpub),definition=await getPipelineDefinition(input.definitionId,alias);
    if (!definition || definition.spec.enabled===false) throw new Error("pipeline_definition_denied");
    const functions=await loadPipelineFunctionRegistry(alias,builtinPipelineFunctions);
    return this.grants.register({...input,appRoot:app.root,appNpub:wapp.appNpub,ownerNpub,
      callbackUrl:callback.href,definitionOwnerAlias:alias,definitionHash:hash(definition.spec),
      functionHashes:pipelineFunctionHashes(definition,functions.registry)});
  }
  private async authorize(token:string,access:"loopback"|"remote") {
    const grant=this.grants.authorize(token),wapp=this.wapps.get(grant.installationId),app=await this.appLookup(grant.appId);
    if ((grant.access??"loopback")!==access || grant.expiresAt<=this.now() || !this.grants.active(grant.id) || !wapp || wapp.appId!==grant.appId ||
        wapp.ownerNpub!==grant.ownerNpub || wapp.appNpub!==grant.appNpub || wapp.recordState!=="active" ||
        wapp.status!=="active" || app?.root!==grant.appRoot || app.ownerNpub!==grant.ownerNpub ||
        new URL(wapp.launchUrl).origin!==new URL(grant.callbackUrl).origin || !this.wapps.hasAppSigningKey(wapp.id)) throw new Error("pipeline_grant_binding_denied");
    return grant;
  }
  async remoteRequest(token:string,input:RemoteWappPipelineRequest,ctx:PipelineApiContext):Promise<Response> {
    const grant=await this.authorize(token,"remote");
    if (!input || Object.keys(input).sort().join(",")!=="appId,clientOrigin,installationId,operation,ownerNpub,request" ||
        input.installationId!==grant.installationId || input.appId!==grant.appId || input.ownerNpub!==grant.ownerNpub ||
        input.clientOrigin!==grant.clientOrigin || input.operation!=="pipeline.request") {
      this.grants.audit(grant.id,"remote-envelope","denied");
      return Response.json({error:"pipeline_request_denied"},{status:403});
    }
    return this.request(token,input.request,ctx,"remote");
  }
  async request(token:string,input:WappPipelineRequest,ctx:PipelineApiContext,access:"loopback"|"remote"="loopback"):Promise<Response> {
    const grant=await this.authorize(token,access);
    try {
      if (!input || Object.keys(input).some(k=>!["method","path","serializedBody"].includes(k)) ||
          !["GET","POST"].includes(input.method) || typeof input.path!=="string" || !input.path.startsWith("/api/pipelines/") ||
          input.path.includes("?") || input.path.includes("#") || input.path.includes("\\")) throw new Error("pipeline_route_denied");
      const url=new URL(input.path,grant.origin);
      if (url.origin!==grant.origin || url.pathname!==input.path) throw new Error("pipeline_route_denied");
      const start=input.method==="POST" && input.path===`/api/pipelines/definitions/${encodeURIComponent(grant.definitionId)}/runs`;
      const runMatch=input.path.match(/^\/api\/pipelines\/runs\/([^/]+)(\/delivery)?$/);
      if (start) {
        if (typeof input.serializedBody!=="string" || Buffer.byteLength(input.serializedBody)>1048576) throw new Error("pipeline_body_denied");
        const body=JSON.parse(input.serializedBody);
        if (!body || Object.keys(body).sort().join(",")!=="idempotencyKey,input,mode,webhook" || body.mode!=="webhook" ||
            !body.input || typeof body.input!=="object" || Array.isArray(body.input) ||
            typeof body.idempotencyKey!=="string" || !body.idempotencyKey || body.idempotencyKey.length>200 ||
            body.webhook?.url!==grant.callbackUrl || Object.keys(body.webhook).join(",")!=="url") throw new Error("pipeline_body_denied");
      } else if (input.method!=="GET" || input.serializedBody!==undefined ||
          (input.path!=="/api/pipelines/webhook-signer" && (!runMatch || !this.grants.ownsRun(grant.id,decodeURIComponent(runMatch[1]!))))) throw new Error("pipeline_route_denied");
      // Signing is a validated HTTP operation, not arbitrary kind-27235 signing.
      const authorization=await this.wapps.withAppSigningKey(grant.installationId,nsec=>createWappNip98Authorization({
        url:url.href,method:input.method,nsec,serializedBody:input.serializedBody,nonce:randomUUID()}));
      const event=JSON.parse(Buffer.from(authorization.slice(6),"base64").toString());
      const decoded=nip19.decode(grant.appNpub);
      if (decoded.type!=="npub" || event.pubkey!==decoded.data || !verifyEvent(event)) throw new Error("pipeline_signer_denied");
      // Revalidate after custody/lookup awaits; revocation cannot race execution.
      await this.authorize(token,access);
      const request=new Request(url.href,{method:input.method,headers:{authorization,"content-type":"application/json"},...(start?{body:input.serializedBody}:{})});
      let response:Response;
      if (start) {
        const definition=await getPipelineDefinition(grant.definitionId,grant.definitionOwnerAlias);
        const functions=await loadPipelineFunctionRegistry(grant.definitionOwnerAlias,builtinPipelineFunctions);
        if (!definition || hash(definition.spec)!==grant.definitionHash ||
            hash(pipelineFunctionHashes(definition,functions.registry))!==hash(grant.functionHashes)) throw new Error("pipeline_definition_drift");
        const submitted=JSON.parse(input.serializedBody!).input;
        if (Object.keys(submitted).some(key=>Object.prototype.hasOwnProperty.call(definition.spec.input??{},key))) throw new Error("pipeline_default_override_denied");
        await this.authorize(token,access);
        // Explicit installation grant supplies execution authority. Run owner is
        // the app identity, separate from its human owner's broad API permissions.
        response=await handlePublicPipelineCall(request,url,{npub:grant.appNpub,actorNpub:grant.appNpub,
          signerNpub:grant.appNpub,session:null,authMethod:"nip98"},ctx,definition,grant.appNpub,grant.definitionOwnerAlias,
          {principalNpub:grant.appNpub,workspaceId:"local",credentialOwnerNpub:grant.ownerNpub},
          {registry:functions.registry,beforeAccept:async()=>{await this.authorize(token,access)},
            assertActive:()=>{if(!this.grants.active(grant.id)||grant.expiresAt<=this.now())throw new Error("pipeline_grant_revoked")}});
        const body=await response.clone().json() as {runId?:unknown};
        if (response.ok && typeof body.runId==="string") this.grants.bindRun(grant.id,body.runId);
      } else if (runMatch) {
        const run=ctx.store.getRun(decodeURIComponent(runMatch[1]!));
        if (!run || run.ownerNpub!==grant.appNpub || run.definitionId!==grant.definitionId) throw new Error("pipeline_run_denied");
        response=Response.json({...runEnvelope(run),...(runMatch[2]?{delivery:publicDelivery(ctx.store.publicCalls.getDelivery(run.id))}:{})});
      } else response=Response.json({pubkey:ctx.resultWebhooks?.pubkey??null,scheme:"NIP-98"});
      this.grants.audit(grant.id,input.method,response.ok?"allowed":"rejected");
      // Public signed receipt contains no publisher secret or bearer capability.
      const body=await response.json();
      return Response.json({response:body,httpStatus:response.status,receipt:{url:url.href,method:input.method,event,
        bodyHash:input.serializedBody?createHash("sha256").update(input.serializedBody).digest("hex"):null}},
        {status:response.status,headers:{"cache-control":"no-store"}});
    } catch { this.grants.audit(grant.id,"request","denied"); return Response.json({error:"pipeline_request_denied"},{status:403}); }
  }
}
