import {test,expect} from "bun:test";
import {readInterviewAttachment} from "./attachment.ts";
import {createHash} from "node:crypto";
const bytes=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6l8AAAAASUVORK5CYII=","base64");
const attachment={id:"pinned",mimeType:"image/png",sha256:createHash("sha256").update(bytes).digest("hex"),bytes:bytes.length};
function fixture() {
 const jobId="00000000-0000-0000-0000-000000000000";
 const source={url:`https://app.example/api/interview-job-images/${jobId}`,ticket:"a".repeat(43),jobId,expiresAt:Date.now()+60000};
 const context={runId:"runtime-run",clientOrigin:"https://app.example",grantId:"trusted-grant",expiresAt:Date.now()+60000};
 return {source,context};
}
test("ticket image authority is exact job/origin/runtime run; only fixed private headers leave host",async()=>{
 const {source,context}=fixture();let headers:Record<string,string>|undefined;
 const dependencies={destination:async(value:string)=>({url:new URL(value),address:{address:"8.8.8.8",family:4}}),get:async(_url:any,_address:any,_max:any,_signal:any,h:any)=>{headers=h;return {status:200,mimeType:"image/png",bytes,connectedAddress:"8.8.8.8"};}};
 expect((await readInterviewAttachment(attachment,source,context,AbortSignal.timeout(1000),dependencies)).bytes).toEqual(bytes);
 expect(headers).toEqual({"x-byo-image-ticket":source.ticket,"x-wingman-run-id":"runtime-run","x-byo-image-id":"pinned"});
 for (const change of [{clientOrigin:"https://foreign.example"},{expiresAt:0}]) await expect(readInterviewAttachment(attachment,source,{...context,...change},AbortSignal.timeout(1000),dependencies)).rejects.toThrow();
 await expect(readInterviewAttachment(attachment,{...source,jobId:"foreign-job"},context,AbortSignal.timeout(1000),dependencies)).rejects.toThrow("binding");
 await expect(readInterviewAttachment(attachment,{...source,expiresAt:0},context,AbortSignal.timeout(1000),dependencies)).rejects.toThrow("expired");
 await expect(readInterviewAttachment(attachment,source,undefined,AbortSignal.timeout(1000),dependencies)).rejects.toThrow("authority");
});
test("private image redirects and incorrect bytes/hash/MIME fail closed; 409 prebinding retry is bounded",async()=>{
 const {source,context}=fixture();const destination=async(value:string)=>({url:new URL(value),address:{address:"8.8.8.8",family:4}});
 for(const response of [{status:302,mimeType:"image/png",bytes},{status:403,mimeType:"image/png",bytes},{status:200,mimeType:"image/jpeg",bytes},{status:200,mimeType:"image/png",bytes:Buffer.from("wrong")}]) {
  await expect(readInterviewAttachment(attachment,source,context,AbortSignal.timeout(1000),{destination,get:async()=>({...response,connectedAddress:"8.8.8.8"})})).rejects.toThrow();
 }
 let calls=0;
 const r=await readInterviewAttachment(attachment,source,context,AbortSignal.timeout(1000),{destination,get:async()=>({status:++calls===1?409:200,mimeType:"image/png",bytes,connectedAddress:"8.8.8.8"})});
 expect(calls).toBe(2);expect(r.bytes).toEqual(bytes);
});
