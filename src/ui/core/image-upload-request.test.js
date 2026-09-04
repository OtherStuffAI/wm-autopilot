import { describe, expect, test } from "bun:test";

import { uploadImageWithRecovery } from "./image-upload-request.js";

const uploadId = "550e8400-e29b-41d4-a716-446655440000";

function createImage() {
  return new File(["image"], "screen.png", { type: "image/png" });
}

describe("uploadImageWithRecovery", () => {
  test("recovers an image when the POST response is lost", async () => {
    const requests = [];
    const fetchImpl = async (url, options) => {
      requests.push({ url, options });
      if (options?.method === "POST") {
        throw new TypeError("Load failed");
      }
      return Response.json({
        placeholder: "![uploaded image](/uploads/images/screen.png)",
        publicPath: "/uploads/images/screen.png",
      });
    };

    const payload = await uploadImageWithRecovery({
      agent: "codex",
      file: createImage(),
      fetchImpl,
      uploadId,
      attempts: 1,
    });

    expect(payload.publicPath).toBe("/uploads/images/screen.png");
    expect(requests).toHaveLength(2);
    expect(requests[0].options.body.get("uploadId")).toBe(uploadId);
    expect(requests[1].url).toContain("/api/uploads/images/status?");
    expect(requests[1].url).toContain(`uploadId=${uploadId}`);
  });

  test("does not retry a rejected upload request", async () => {
    const requests = [];
    const fetchImpl = async (url) => {
      requests.push(url);
      return Response.json({ error: "Only image uploads are supported" }, { status: 400 });
    };

    await expect(uploadImageWithRecovery({
      agent: "codex",
      file: createImage(),
      fetchImpl,
      uploadId,
    })).rejects.toThrow("Image upload failed (400): Only image uploads are supported");
    expect(requests).toHaveLength(1);
  });
});
