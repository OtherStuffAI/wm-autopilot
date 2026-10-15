import {
  WAPP_REMOTE_PIPELINE_BROKER_PATH,
  type RemoteWappPipelineRequest,
  type WappPipelineRequestBroker,
} from "../wapps/pipeline-request-broker";
import type { PipelineApiContext } from "../pipelines/pipeline-api-routes";

const MAXIMUM_BODY_BYTES = 1_100_000;

async function readBoundedJson(request: Request): Promise<unknown> {
  if (Number(request.headers.get("content-length")) > MAXIMUM_BODY_BYTES) throw new Error("body_too_large");
  if (!request.body) throw new Error("body_required");
  const reader=request.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try {
    for (;;) {
      const {done,value}=await reader.read();if(done)break;
      size+=value.byteLength;if(size>MAXIMUM_BODY_BYTES){await reader.cancel();throw new Error("body_too_large");}
      chunks.push(value);
    }
  } finally {reader.releaseLock();}
  return JSON.parse(Buffer.concat(chunks,size).toString());
}

export async function handleWappRemotePipelineBrokerRoute(input:{request:Request;url:URL;
  broker:WappPipelineRequestBroker;pipelines:PipelineApiContext}):Promise<Response|null> {
  if (input.url.pathname!==WAPP_REMOTE_PIPELINE_BROKER_PATH) return null;
  if (input.url.search) return Response.json({error:"route_denied"},{status:403});
  if (input.request.headers.has("origin")) return Response.json({error:"server_caller_required"},{status:403});
  if (input.request.method!=="POST") return Response.json({error:"method_denied"},{status:405});
  const token=input.request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
  if (!token) return Response.json({error:"capability_required"},{status:401});
  try {
    return await input.broker.remoteRequest(token,await readBoundedJson(input.request) as RemoteWappPipelineRequest,input.pipelines);
  } catch (error) {
    return Response.json({error:error instanceof Error&&error.message==="body_too_large"?"body_too_large":"pipeline_request_denied"},
      {status:error instanceof Error&&error.message==="body_too_large"?413:403});
  }
}
