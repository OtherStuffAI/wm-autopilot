import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { RequestAuthContext } from "../auth/request-context";
import type { AgentType } from "../config";
import { deriveNpubSegment } from "../identity/npub-utils";
import { maxAttachmentSizeBytes, type UploadApiContext } from "./upload-routes";

const transcribeAudioFileMock = mock(async () => "Transcribed voice note");

mock.module("./audio-transcription.js", () => ({
  transcribeAudioFile: transcribeAudioFileMock,
}));

const { handleVoiceNoteUploadsApi } = await import("./voice-note-routes");
type VoiceNoteUploadApiContext = UploadApiContext;

const USER_NPUB = "npub1voiceuser";
const OTHER_NPUB = "npub1otheruser";

function makeAuthContext(npub: string): RequestAuthContext {
  return {
    npub,
    session: null,
  };
}

function makeContext(attachmentRoot: string): VoiceNoteUploadApiContext {
  return {
    imageRoot: join(attachmentRoot, "images"),
    attachmentRoot,
    isAdminContext: () => false,
    isAgentType: (value: string): value is AgentType => value === "codex",
    ensureImageDirectory: async () => {
      throw new Error("ensureImageDirectory should not be called in voice note tests");
    },
    ensureAttachmentDirectory: async (agent, npub) => {
      const directory = join(attachmentRoot, deriveNpubSegment(npub), agent);
      await mkdir(directory, { recursive: true });
      return directory;
    },
    createImageFilename: () => "unused",
    createAttachmentFilename: () => "unused",
    buildAgentImagePlaceholder: () => "unused",
    buildAgentFilePlaceholder: () => "unused",
    ensureApiAccess: async () => null,
    AccessActions: { FilesWrite: "files.write" as never },
  };
}

describe("voice-note-routes", () => {
  let rootDir = "";
  let ctx: VoiceNoteUploadApiContext;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "voice-note-routes-"));
    ctx = makeContext(rootDir);
    transcribeAudioFileMock.mockClear();
    transcribeAudioFileMock.mockImplementation(async () => "Transcribed voice note");
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  test("uploads a voice note and returns a saved placeholder", async () => {
    const audio = new File([new Uint8Array([1, 2, 3, 4])], "memo.webm", { type: "audio/webm" });
    const form = new FormData();
    form.set("agent", "codex");
    form.set("audio", audio);

    const request = new Request("http://localhost/api/uploads/voice-notes", {
      method: "POST",
      body: form,
    });

    const response = await handleVoiceNoteUploadsApi(
      request,
      new URL(request.url),
      "POST",
      makeAuthContext(USER_NPUB),
      ctx,
    );

    expect(response).not.toBeNull();
    expect(response?.status).toBe(201);

    const body = await response!.json();
    expect(body.name).toBe("memo.webm");
    expect(["audio/webm", "video/webm"]).toContain(body.mime);
    expect(body.publicPath).toStartWith(`/uploads/files/${deriveNpubSegment(USER_NPUB)}/codex/voice-note-`);
    expect(body.publicPath).toEndWith(".webm");
    expect(body.placeholder).toBe(`[memo.webm](${body.publicPath})`);

    const relativePath = String(body.relativePath ?? "");
    const savedBytes = await readFile(join(rootDir, relativePath));
    expect(Array.from(savedBytes)).toEqual([1, 2, 3, 4]);
  });

  test("rejects non-audio uploads", async () => {
    const image = new File([new Uint8Array([1])], "not-audio.png", { type: "image/png" });
    const form = new FormData();
    form.set("agent", "codex");
    form.set("audio", image);

    const request = new Request("http://localhost/api/uploads/voice-notes", {
      method: "POST",
      body: form,
    });

    const response = await handleVoiceNoteUploadsApi(
      request,
      new URL(request.url),
      "POST",
      makeAuthContext(USER_NPUB),
      ctx,
    );

    expect(response?.status).toBe(400);
    await expect(response!.json()).resolves.toMatchObject({
      error: "Only audio uploads are supported",
    });
  });

  test("rejects transcription for another user's saved note", async () => {
    const otherSegment = deriveNpubSegment(OTHER_NPUB);
    const otherDir = join(rootDir, otherSegment, "codex");
    await mkdir(otherDir, { recursive: true });
    await writeFile(join(otherDir, "voice-note-foreign.webm"), new Uint8Array([9, 9, 9]));

    const request = new Request("http://localhost/api/uploads/voice-notes/transcribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        publicPath: `/uploads/files/${otherSegment}/codex/voice-note-foreign.webm`,
      }),
    });

    const response = await handleVoiceNoteUploadsApi(
      request,
      new URL(request.url),
      "POST",
      makeAuthContext(USER_NPUB),
      ctx,
    );

    expect(response?.status).toBe(400);
    await expect(response!.json()).resolves.toMatchObject({
      error: "Voice note reference does not belong to the current user",
    });
  });

  test("transcribes a saved voice note for the current user", async () => {
    const userSegment = deriveNpubSegment(USER_NPUB);
    const userDir = join(rootDir, userSegment, "codex");
    await mkdir(userDir, { recursive: true });
    await writeFile(join(userDir, "voice-note-local.webm"), new Uint8Array([7, 8, 9]));

    const request = new Request("http://localhost/api/uploads/voice-notes/transcribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        publicPath: `/uploads/files/${userSegment}/codex/voice-note-local.webm`,
      }),
    });

    const response = await handleVoiceNoteUploadsApi(
      request,
      new URL(request.url),
      "POST",
      makeAuthContext(USER_NPUB),
      ctx,
    );

    expect(response).not.toBeNull();
    expect(response?.status).toBe(200);

    const body = await response!.json();
    expect(body.transcript).toBe("Transcribed voice note");
    expect(body.transcriptLength).toBe("Transcribed voice note".length);
    expect(transcribeAudioFileMock).toHaveBeenCalledTimes(1);
    expect(transcribeAudioFileMock).toHaveBeenCalledWith({
      audio: expect.any(Object),
      filename: "voice-note-local.webm",
      mimeType: "audio/webm",
    });
  });

  test("rejects oversized uploads before writing to disk", async () => {
    const oversized = new File(
      [new Uint8Array(maxAttachmentSizeBytes + 1)],
      "huge.webm",
      { type: "audio/webm" },
    );
    const form = new FormData();
    form.set("agent", "codex");
    form.set("audio", oversized);

    const request = new Request("http://localhost/api/uploads/voice-notes", {
      method: "POST",
      body: form,
    });

    const response = await handleVoiceNoteUploadsApi(
      request,
      new URL(request.url),
      "POST",
      makeAuthContext(USER_NPUB),
      ctx,
    );

    expect(response?.status).toBe(413);
    await expect(response!.json()).resolves.toMatchObject({
      error: "Voice note exceeds 25MB limit",
    });
  });
});
