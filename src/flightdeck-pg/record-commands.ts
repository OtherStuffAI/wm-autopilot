import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

type SignedJson = (method: string, path: string, query?: undefined, body?: unknown) => Promise<Record<string, unknown>>;
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export async function renameFlightDeckThread(request: SignedJson, workspaceId: string, threadId: string, title: string) {
  const path = `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(workspaceId)}/threads/${encodeURIComponent(threadId)}`;
  const before = await request("GET", path);
  const rowVersion = Number(object(before.thread).row_version);
  if (!Number.isInteger(rowVersion) || rowVersion < 1) throw new Error("Thread rename requires thread.row_version from Tower.");
  const updated = await request("PATCH", path, undefined, { title, row_version: rowVersion });
  const expected = object(updated.thread);
  const readback = await request("GET", path);
  const actual = object(readback.thread);
  if (actual.id !== threadId || actual.title !== title || Number(actual.row_version) <= rowVersion || actual.row_version !== expected.row_version) {
    throw new Error("Thread rename readback did not match the saved title/version; inspect current thread state.");
  }
  return { ...updated, verified: true, thread: actual };
}

export async function downloadFlightDeckFile(result: Record<string, unknown>, fileId: string, outPath: string) {
  // The typed object route applies file ACLs and returns exact bytes plus
  // authoritative integrity metadata. Never forward auth to a supplied URL.
  const metadata = object(result.object);
  const encoded = metadata.base64_data;
  const digest = metadata.sha256_hex;
  const size = metadata.size_bytes;
  if (metadata.encoding !== "base64" || typeof encoded !== "string" || typeof digest !== "string" || !/^[a-f0-9]{64}$/i.test(digest)
    || typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) throw new Error("File object is missing canonical bytes, size or SHA-256.");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded || bytes.byteLength !== size || createHash("sha256").update(bytes).digest("hex") !== digest.toLowerCase()) {
    throw new Error("File object bytes failed size/SHA-256 verification; output was not written.");
  }
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, bytes, { flag: "wx" });
  return { ok: true, fileId, outPath, sizeBytes: size, sha256: digest.toLowerCase() };
}
