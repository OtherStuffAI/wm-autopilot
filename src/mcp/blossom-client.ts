import { createHash } from "node:crypto";

import { callCapabilityBroker, type CapabilityClientContext } from "./capability-client";

export interface BlossomUploadResult {
  objectHash: string;
  objectSize: number;
  response: unknown;
}

export async function uploadBlossomObject(input: {
  server: string;
  bytes: Uint8Array;
  contentType?: string;
  context?: CapabilityClientContext;
}): Promise<BlossomUploadResult> {
  const origin = new URL(input.server).origin;
  const objectHash = createHash("sha256").update(input.bytes).digest("hex");
  const authorization = await callCapabilityBroker<{ authorization: string }>(
    "/api/mcp/capabilities/blossom/authorize",
    { server: origin, method: "upload", objectHash, objectSize: input.bytes.byteLength },
    input.context,
  );
  const fetchImpl = input.context?.fetch ?? globalThis.fetch;
  const response = await fetchImpl(`${origin}/upload`, {
    method: "PUT",
    headers: {
      authorization: authorization.authorization,
      "content-type": input.contentType?.trim() || "application/octet-stream",
    },
    body: input.bytes,
  });
  if (!response.ok) {
    throw new Error(`Blossom upload failed (${response.status})`);
  }
  const responseBody = await response.json().catch(() => null);
  return { objectHash, objectSize: input.bytes.byteLength, response: responseBody };
}
