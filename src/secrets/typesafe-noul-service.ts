import type {JsonObject} from "../pipelines/pipeline-store";
import type {SecretStore} from "./secret-store";
import type {SecretConsumer} from "./secret-policy";

export const typedInferenceError=(code:string):JsonObject=>({classifierError:{code,retryable:true}});
export async function callTypeSafeNoul(input:JsonObject,store:SecretStore,consumer:SecretConsumer,
  fetchImpl:typeof fetch=fetch,registerSecret:(value:string)=>void=()=>{},timeoutMs=15000):Promise<JsonObject> {
  try {
    const questions=input.questions as Record<string,unknown>;
    if(typeof input.credentialRef!=="string" || !input.credentialRef || typeof input.model!=="string" ||
      !/^jev-[a-zA-Z0-9.-]+$/.test(input.model) || !questions || Array.isArray(questions) ||
      Object.keys(questions).length<1 || Object.keys(questions).length>32 || input.state===undefined ||
      Object.entries(questions).some(([id,q])=> !/^[a-z][a-z0-9_]{0,63}$/.test(id) ||
        !q || (q as any).type!=="noul" || !(q as any).instructions) ||
      Object.keys(input).some(key=>!["credentialRef","model","questions","state"].includes(key)))return typedInferenceError("configuration");
    const body=JSON.stringify({model:input.model,state:input.state,questions});
    if(Buffer.byteLength(body)>65536)return typedInferenceError("configuration");
    return await store.withServiceCredential(input.credentialRef,consumer,async value=>{
      registerSecret(value);
      const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),timeoutMs);
      let received=false;
      try {
        const response=await fetchImpl("https://api.typesafe.ai/v1/systemone",{method:"POST",redirect:"error",signal:controller.signal,
          headers:{authorization:`Bearer ${value}`,"content-type":"application/json"},body});
        received=true;
        if(!response.ok){await response.body?.cancel();return typedInferenceError("service")}
        if(!response.body)return typedInferenceError("malformed");
        const reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
        try {for(;;){const {done,value:chunk}=await reader.read();if(done)break;size+=chunk.byteLength;
          if(size>131072){await reader.cancel();return typedInferenceError("malformed")}chunks.push(chunk)}}
        finally {reader.releaseLock()}
        const text=Buffer.concat(chunks,size).toString();
        if(text.includes(value))return typedInferenceError("malformed");
        const raw=JSON.parse(text);
        if(typeof raw.model!=="string" || !/^jev-[a-zA-Z0-9.-]+$/.test(raw.model))return typedInferenceError("malformed");
        const answers:JsonObject={};
        for(const id of Object.keys(questions)) {
          const answer=raw.answers?.[id];
          if(answer?.type!=="noul" || typeof answer.noul!=="number" || !Number.isFinite(answer.noul) || answer.noul<0 || answer.noul>1)return typedInferenceError("malformed");
          answers[id]={type:"noul",noul:answer.noul};
        }
        return {model:raw.model,answers}; // No arbitrary provider body/header/usage escapes.
      } catch {return typedInferenceError(controller.signal.aborted?"timeout":received?"malformed":"service")}
      finally {clearTimeout(timer)}
    });
  } catch {return typedInferenceError("configuration")}
}
