/**
 * Route handlers for voice-note uploads and send-time transcription.
 */

import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, join, normalize } from "node:path";

import type { RequestAuthContext } from "../auth/request-context";
import type { AgentType } from "../config";
import { deriveNpubSegment } from "../identity/npub-utils";
import { secureResolvePath, validatePathSegment } from "./path-security.js";
import type { UploadApiContext } from "./upload-routes.js";
import { maxAttachmentSizeBytes } from "./upload-routes.js";
import { transcribeAudioFile } from "./audio-transcription.js";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";
type RequestFormData = Awaited<ReturnType<Request["formData"]>>;

const VOICE_NOTE_UPLOAD_PATH = "/api/uploads/voice-notes";
const VOICE_NOTE_TRANSCRIBE_PATH = "/api/uploads/voice-notes/transcribe";
const UPLOADS_FILES_PREFIX = "/uploads/files/";

export interface VoiceNoteUploadApiContext extends UploadApiContext {
  // Voice notes reuse the existing upload auth/storage model.
}

function parseAgentType(value: unknown, isAgentType: (value: string) => value is AgentType): AgentType | null {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!raw || !isAgentType(raw)) {
    return null;
  }
  return raw;
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function readUploadFile(entry: unknown): Blob & { name?: string; size: number; type?: string } | null {
  if (!entry || typeof (entry as Blob).arrayBuffer !== "function") {
    return null;
  }
  return entry as Blob & { name?: string; size: number; type?: string };
}

function resolveAudioExtension(mimeType: string | undefined): string {
  const normalized = (mimeType ?? "").trim().toLowerCase().split(";")[0] ?? "";
  if (normalized.includes("webm")) return ".webm";
  if (normalized.includes("ogg")) return ".ogg";
  if (normalized.includes("wav")) return ".wav";
  if (normalized.includes("mp4")) return ".m4a";
  if (normalized.includes("mpeg")) return ".mp3";
  return ".webm";
}

function resolveAudioMimeType(filename: string): string | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".webm")) return "audio/webm";
  if (lower.endsWith(".ogg")) return "audio/ogg";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".m4a") || lower.endsWith(".mp4")) return "audio/mp4";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  return null;
}

function isAcceptedVoiceNoteMimeType(mimeType: string | undefined): boolean {
  const normalized = (mimeType ?? "").trim().toLowerCase().split(";")[0] ?? "";
  if (!normalized) {
    return true;
  }
  if (normalized.startsWith("audio/")) {
    return true;
  }
  // Some browsers emit audio-only MediaRecorder blobs in a video container.
  return normalized === "video/webm" || normalized === "video/mp4";
}

function sanitizeLinkLabel(value: string | undefined): string {
  const cleaned = (value ?? "").replace(/[\r\n[\]]+/g, " ").trim();
  return cleaned || "voice note";
}

function buildVoiceNotePlaceholder(label: string | undefined, publicPath: string): string {
  return `[${sanitizeLinkLabel(label)}](${publicPath})`;
}

async function parseMultipartFormData(request: Request): Promise<RequestFormData | null> {
  try {
    const contentType = request.headers.get("content-type") ?? "";
    const bodyBlob = await request.blob();
    const bufferedRequest = new Request(request.url, {
      method: request.method,
      headers: { "content-type": contentType },
      body: bodyBlob,
    });
    return await bufferedRequest.formData();
  } catch {
    return null;
  }
}

async function parseJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed = await request.json();
    return parseJsonObject(parsed);
  } catch {
    return null;
  }
}

function resolveVoiceNoteStoragePath(
  publicPath: string,
  authContext: RequestAuthContext,
  ctx: VoiceNoteUploadApiContext,
): { diskPath: string; relativePath: string; filename: string } {
  const trimmed = publicPath.trim();
  if (!trimmed.startsWith(UPLOADS_FILES_PREFIX)) {
    throw new Error("Voice note reference must point to /uploads/files/...");
  }

  const relativeRaw = trimmed.slice(UPLOADS_FILES_PREFIX.length);
  const parts = relativeRaw.split("/").filter(Boolean);
  if (parts.length < 3) {
    throw new Error("Voice note reference is incomplete");
  }

  const segment = parts[0];
  const agentSegment = parts[1];
  const fileParts = parts.slice(2);
  if (!segment || !agentSegment || !validatePathSegment(segment) || !validatePathSegment(agentSegment) || fileParts.some((part) => !validatePathSegment(part))) {
    throw new Error("Voice note reference contains an invalid path");
  }

  const normalizedAgent = agentSegment.toLowerCase();
  if (!ctx.isAgentType(normalizedAgent)) {
    throw new Error("Voice note reference points to an unsupported agent");
  }

  const expectedSegment = deriveNpubSegment(authContext.npub ?? null);
  if (!ctx.isAdminContext(authContext) && segment !== expectedSegment) {
    throw new Error("Voice note reference does not belong to the current user");
  }

  const relativePath = [segment, normalizedAgent, ...fileParts].join("/");
  const diskPath = secureResolvePath(ctx.attachmentRoot, relativePath);
  return {
    diskPath,
    relativePath,
    filename: basename(diskPath),
  };
}

async function handleVoiceNoteUpload(
  request: Request,
  authContext: RequestAuthContext,
  ctx: VoiceNoteUploadApiContext,
): Promise<Response> {
  const denied = await ctx.ensureApiAccess(ctx.AccessActions.FilesWrite, request, new URL(request.url), authContext);
  if (denied) {
    return denied;
  }

  const form = await parseMultipartFormData(request);
  if (!form) {
    return Response.json({ error: "Invalid form data" }, { status: 400 });
  }

  const agent = parseAgentType(form.get("agent") as unknown, ctx.isAgentType);
  if (!agent) {
    return Response.json({ error: "Unsupported agent target" }, { status: 400 });
  }

  const audioEntry = readUploadFile(form.get("audio") ?? form.get("file") ?? form.get("voiceNote"));
  if (!audioEntry) {
    return Response.json({ error: "Voice note audio is required" }, { status: 400 });
  }

  if (audioEntry.size === 0) {
    return Response.json({ error: "Empty files are not allowed" }, { status: 400 });
  }

  if (audioEntry.size > maxAttachmentSizeBytes) {
    return Response.json({ error: "Voice note exceeds 25MB limit" }, { status: 413 });
  }

  if (!isAcceptedVoiceNoteMimeType(audioEntry.type ?? undefined)) {
    return Response.json({ error: "Only audio uploads are supported" }, { status: 400 });
  }

  const userNpub = authContext.npub ?? null;
  const voiceSegment = deriveNpubSegment(userNpub);

  let directory: string;
  try {
    directory = await ctx.ensureAttachmentDirectory(agent, userNpub);
  } catch (error) {
    console.error("[voice-notes] failed to ensure directory", error);
    return Response.json({ error: "Failed to prepare voice note storage" }, { status: 500 });
  }

  const extension = resolveAudioExtension(audioEntry.type ?? undefined);
  const filename = `voice-note-${Date.now()}-${randomUUID()}${extension}`;
  const diskPath = join(directory, filename);
  const relativePath = normalize(join(voiceSegment, agent, filename)).replace(/\\/g, "/");
  const publicPath = `${UPLOADS_FILES_PREFIX}${relativePath}`;

  try {
    const buffer = Buffer.from(await audioEntry.arrayBuffer());
    await writeFile(diskPath, buffer);
  } catch (error) {
    console.error("[voice-notes] failed to persist audio", error);
    return Response.json({ error: "Failed to store voice note" }, { status: 500 });
  }

  const placeholder = buildVoiceNotePlaceholder(audioEntry.name ?? filename, publicPath);
  return Response.json(
    {
      agent,
      name: audioEntry.name ?? filename,
      mime: audioEntry.type ?? resolveAudioMimeType(filename),
      publicPath,
      relativePath,
      placeholder,
    },
    { status: 201 },
  );
}

async function handleVoiceNoteTranscription(
  request: Request,
  authContext: RequestAuthContext,
  ctx: VoiceNoteUploadApiContext,
): Promise<Response> {
  const denied = await ctx.ensureApiAccess(ctx.AccessActions.FilesWrite, request, new URL(request.url), authContext);
  if (denied) {
    return denied;
  }

  const body = await parseJsonBody(request);
  if (!body) {
    return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const publicPath = typeof body.publicPath === "string" ? body.publicPath.trim() : "";
  if (!publicPath) {
    return Response.json({ error: "publicPath is required" }, { status: 400 });
  }

  let resolved;
  try {
    resolved = resolveVoiceNoteStoragePath(publicPath, authContext, ctx);
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 400 });
  }

  const audioFile = Bun.file(resolved.diskPath);
  if (audioFile.size === 0) {
    return Response.json({ error: "Voice note file not found" }, { status: 404 });
  }

  let transcript = "";
  try {
    transcript = await transcribeAudioFile({
      audio: audioFile,
      filename: resolved.filename,
      mimeType: resolveAudioMimeType(resolved.filename),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: `Voice note transcription failed: ${message}` }, { status: 502 });
  }

  if (!transcript) {
    return Response.json({ error: "Voice note transcription returned no text" }, { status: 502 });
  }

  return Response.json(
    {
      publicPath,
      relativePath: resolved.relativePath,
      transcript,
      transcriptLength: transcript.length,
    },
    { status: 200 },
  );
}

export async function handleVoiceNoteUploadsApi(
  request: Request,
  url: URL,
  method: HttpMethod,
  authContext: RequestAuthContext,
  ctx: VoiceNoteUploadApiContext,
): Promise<Response | null> {
  if (url.pathname === VOICE_NOTE_UPLOAD_PATH && method === "POST") {
    return handleVoiceNoteUpload(request, authContext, ctx);
  }

  if (url.pathname === VOICE_NOTE_TRANSCRIBE_PATH && method === "POST") {
    return handleVoiceNoteTranscription(request, authContext, ctx);
  }

  return null;
}
