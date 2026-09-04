import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { RequestAuthContext } from "../auth/request-context";
import type { AgentType } from "../config";
import { createUploadHelpers } from "./uploads/helpers";
import { handleUploadsApi, type UploadApiContext } from "./upload-routes";

const userNpub = "npub1uploaduser";
const uploadId = "550e8400-e29b-41d4-a716-446655440000";

function createAuthContext(): RequestAuthContext {
  return { npub: userNpub, session: null };
}

describe("image upload routes", () => {
  let root = "";
  let context: UploadApiContext;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "image-upload-routes-"));
    const imageRoot = join(root, "images");
    const attachmentRoot = join(root, "files");
    const helpers = createUploadHelpers({
      userIdentityRoot: join(root, "users"),
      imageRoot,
      attachmentRoot,
    });
    context = {
      imageRoot,
      attachmentRoot,
      isAdminContext: () => false,
      isAgentType: (value: string): value is AgentType => value === "codex",
      ensureImageDirectory: helpers.ensureImageDirectory,
      ensureAttachmentDirectory: async () => {
        const directory = join(attachmentRoot, "unused");
        await mkdir(directory, { recursive: true });
        return directory;
      },
      createImageFilename: helpers.createImageFilename,
      createAttachmentFilename: helpers.createAttachmentFilename,
      buildAgentImagePlaceholder: helpers.buildAgentImagePlaceholder,
      buildAgentFilePlaceholder: helpers.buildAgentFilePlaceholder,
      ensureApiAccess: async () => null,
      AccessActions: { FilesWrite: "files.write" as never },
    };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("finds a completed idempotent image upload after its response is lost", async () => {
    const form = new FormData();
    form.set("agent", "codex");
    form.set("uploadId", uploadId);
    form.set("image", new File([new Uint8Array([1, 2, 3])], "screen.png", { type: "image/png" }));
    const uploadRequest = new Request("http://localhost/api/uploads/images", {
      method: "POST",
      body: form,
    });

    const uploadResponse = await handleUploadsApi(
      uploadRequest,
      new URL(uploadRequest.url),
      "POST",
      createAuthContext(),
      context,
    );
    expect(uploadResponse?.status).toBe(200);
    const uploaded = await uploadResponse!.json();
    expect(uploaded.publicPath).toEndWith(`/${uploadId}.png`);

    const statusUrl = new URL("http://localhost/api/uploads/images/status");
    statusUrl.searchParams.set("agent", "codex");
    statusUrl.searchParams.set("uploadId", uploadId);
    statusUrl.searchParams.set("name", "screen.png");
    statusUrl.searchParams.set("mime", "image/png");
    const statusResponse = await handleUploadsApi(
      new Request(statusUrl),
      statusUrl,
      "GET",
      createAuthContext(),
      context,
    );

    expect(statusResponse?.status).toBe(200);
    await expect(statusResponse!.json()).resolves.toMatchObject({
      publicPath: uploaded.publicPath,
      placeholder: uploaded.placeholder,
    });
  });

  test("rejects invalid image upload IDs", async () => {
    const form = new FormData();
    form.set("agent", "codex");
    form.set("uploadId", "../../escape");
    form.set("image", new File(["image"], "screen.png", { type: "image/png" }));
    const request = new Request("http://localhost/api/uploads/images", {
      method: "POST",
      body: form,
    });

    const response = await handleUploadsApi(
      request,
      new URL(request.url),
      "POST",
      createAuthContext(),
      context,
    );
    expect(response?.status).toBe(400);
    await expect(response!.json()).resolves.toEqual({ error: "Invalid image upload ID" });
  });
});
