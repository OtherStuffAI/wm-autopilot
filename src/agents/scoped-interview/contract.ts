import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { publicSourceUrl } from "./public-fetch.ts";
import { validateImage } from "./image.ts";

export interface InterviewSource {id: string; url: string; label?: string}
export interface InterviewAttachment {id: string; mimeType: string; base64?: string; sha256?: string; bytes?: number}
export interface AttachmentSource {url: string; ticket: string; jobId: string; expiresAt: number}
export interface ScopedInterviewInput {attachmentSource?: AttachmentSource; sources: InterviewSource[]; attachments: InterviewAttachment[]}
export const INTERVIEW_POLICY_VERSION = "scoped-interview-v1";
export function interviewDirectory(owner: string, conversationKey: string): string {
  return join(homedir(), ".wingmen", "runtime", "scoped-interviews", createHash("sha256").update(JSON.stringify([owner,conversationKey])).digest("hex"));
}
export function parseInterviewInput(value: unknown): ScopedInterviewInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("scopedInterview is required");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !["sources","attachments","attachmentSource"].includes(k))) throw Error("Unknown scopedInterview field");
  const sources = v.sources ?? [], attachments = v.attachments ?? [];
  if (!Array.isArray(sources) || sources.length > 30 || !Array.isArray(attachments) || attachments.length > 2 || sources.length + attachments.length > 30) throw Error("Interview candidate limit exceeded");
  const ids = new Set<string>();
  function id(value: unknown): string {
    if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(value) || ids.has(value)) throw Error("Invalid or duplicate source ID");
    ids.add(value); return value;
  }
  let attachmentSource: AttachmentSource | undefined;
  if (v.attachmentSource !== undefined) {
    const a = v.attachmentSource as AttachmentSource;
    if (!a || Object.keys(a).sort().join() !== "expiresAt,jobId,ticket,url" || typeof a.ticket !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(a.ticket) || !/^[0-9a-f-]{36}$/.test(a.jobId) || !Number.isSafeInteger(a.expiresAt) || a.expiresAt > Date.now() + 10*60*1000) throw Error("Invalid image attachment source");
    const url = publicSourceUrl(a.url);
    if (url.pathname !== `/api/interview-job-images/${a.jobId}` || url.search) throw Error("Invalid attachment source path");
    attachmentSource = {...a,url:url.href};
  }
  return {
    ...(attachmentSource ? {attachmentSource} : {}),
    sources: sources.map(s => {
      if (!s || Object.keys(s).some(k => !["id","url","label"].includes(k)) || typeof s.url !== "string" || s.label !== undefined && (typeof s.label !== "string" || s.label.length > 200)) throw Error("Invalid source candidate");
      return {id: id(s.id), url: publicSourceUrl(s.url).href, ...(s.label ? {label: s.label} : {})};
    }),
    attachments: attachments.map(a => {
      if (a && a.base64 === undefined) {
        if (!attachmentSource || Object.keys(a).some(k => !["id","mimeType","sha256","bytes"].includes(k)) || !["image/png","image/jpeg","image/webp"].includes(a.mimeType) || !/^[a-f0-9]{64}$/.test(a.sha256) || !Number.isSafeInteger(a.bytes) || a.bytes < 1 || a.bytes > 2*1024*1024) throw Error("Invalid pinned attachment metadata");
        return {id:id(a.id),mimeType:a.mimeType,sha256:a.sha256,bytes:a.bytes};
      }
      if (!a || Object.keys(a).some(k => !["id","mimeType","base64","sha256"].includes(k)) || typeof a.base64 !== "string" || a.base64.length > 2_800_000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(a.base64)) throw Error("Invalid inline attachment");
      const proof = validateImage(Buffer.from(a.base64,"base64"), a.mimeType);
      if (a.sha256 !== undefined && a.sha256 !== proof.sha256) throw Error("Attachment digest mismatch");
      return {id: id(a.id), mimeType: a.mimeType, base64: a.base64, sha256: proof.sha256};
    }),
  };
}
