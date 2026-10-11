import type { PipelineApiContext } from "../pipelines/pipeline-api-routes";
import { WAPP_PIPELINE_BROKER_PATH, type WappPipelineRequestBroker, type WappPipelineRequest } from "../wapps/pipeline-request-broker";

export async function handleWappPipelineBrokerRoute(input:{request:Request;url:URL;isLoopback:boolean;
  broker:WappPipelineRequestBroker;pipelines:PipelineApiContext}):Promise<Response|null> {
  if (input.url.pathname!==WAPP_PIPELINE_BROKER_PATH) return null;
  if (!input.isLoopback || input.request.headers.has("origin")) return Response.json({error:"loopback_server_required"},{status:403});
  if (input.request.method!=="POST") return Response.json({error:"method_denied"},{status:405});
  const token=input.request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
  if (!token) return Response.json({error:"capability_required"},{status:401});
  const maximum=1100000;
  if (Number(input.request.headers.get("content-length"))>maximum) return Response.json({error:"body_too_large"},{status:413});
  try {
    if (!input.request.body) throw new Error();
    const reader=input.request.body.getReader(); const chunks:Uint8Array[]=[]; let size=0;
    try {
      for (;;) { const {done,value}=await reader.read(); if(done)break;
        size+=value.byteLength; if(size>maximum){await reader.cancel();return Response.json({error:"body_too_large"},{status:413});}
        chunks.push(value);
      }
    } finally {reader.releaseLock()}
    const body=JSON.parse(Buffer.concat(chunks,size).toString()) as WappPipelineRequest;
    return await input.broker.request(token,body,input.pipelines);
  } catch {return Response.json({error:"pipeline_broker_denied"},{status:403})}
}
