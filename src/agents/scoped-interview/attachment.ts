import { createHash } from "node:crypto";
import { publicDestination, pinnedGet } from "./public-fetch.ts";
import { validateImage } from "./image.ts";
import type { InterviewAttachment, AttachmentSource } from "./contract.ts";

export interface InterviewImageContext {runId: string; clientOrigin: string; grantId: string; expiresAt: number}
export async function readInterviewAttachment(attachment: InterviewAttachment, source: AttachmentSource | undefined, context: InterviewImageContext | undefined, signal: AbortSignal, dependencies: {destination?: typeof publicDestination; get?: typeof pinnedGet} = {}) {
  if (attachment.base64) return {bytes: Buffer.from(attachment.base64,"base64"), mimeType: attachment.mimeType};
  if (!source || !context || context.expiresAt <= Date.now() || source.expiresAt <= Date.now()) throw Error("Attachment authority missing or expired");
  const url = new URL(source.url);
  if (url.origin !== context.clientOrigin || url.pathname !== `/api/interview-job-images/${source.jobId}` || url.search || url.hash) throw Error("Attachment origin/job binding denied");
  const deadline = Date.now() + 2000;
  for (;;) {
    signal.throwIfAborted();
    if (source.expiresAt <= Date.now()) throw Error("Attachment ticket expired");
    const destination = await (dependencies.destination ?? publicDestination)(url.href);
    const r = await (dependencies.get ?? pinnedGet)(destination.url,destination.address,2*1024*1024,signal,{
      "x-byo-image-ticket": source.ticket, "x-wingman-run-id": context.runId, "x-byo-image-id": attachment.id,
    });
    if (r.status === 409 && Date.now() < deadline) {await new Promise(resolve => setTimeout(resolve,100)); continue;}
    if (r.status !== 200) throw Error(`Attachment HTTP ${r.status}`);
    if (r.mimeType !== attachment.mimeType || r.bytes.length !== attachment.bytes || createHash("sha256").update(r.bytes).digest("hex") !== attachment.sha256) throw Error("Attachment integrity binding denied");
    validateImage(r.bytes,r.mimeType);
    return {bytes:r.bytes,mimeType:r.mimeType};
  }
}
