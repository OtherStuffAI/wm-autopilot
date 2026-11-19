import { RemoteStorageError, storageAssert, storageHash, storageObject, storageUuid } from "./remote-storage-contract";

export const REGISTERED_STORAGE_PROTOCOL = "registered-app-storage-v1";
export const REGISTERED_STORAGE_BROKER_PATH = "/api/internal/wapps/registered-app-storage";
export const REGISTERED_STORAGE_MAX_BYTES = 8 * 1024 * 1024;
export const REGISTERED_STORAGE_JSON_BYTES = 12 * 1024 * 1024;
export const REGISTERED_STORAGE_OPERATIONS = ["prepare", "upload", "complete", "metadata", "content", "head"];

export interface RegisteredStorageRequest {
  installationId?: string;
  method: string;
  path: string;
  body?: unknown;
}

export function parseRegisteredStorageRequest(value: unknown): RegisteredStorageRequest {
  const row = storageObject(value, ["installationId", "method", "path", "body"]);
  if (Object.hasOwn(row, "installationId")) storageAssert(typeof row.installationId === "string" && row.installationId.length > 0, "storage_installation_invalid");
  const { method, path } = row;
  storageAssert(typeof method === "string" && typeof path === "string", "storage_request_invalid");
  const object = /^\/objects\/([0-9a-f-]+)(\/complete|\/content)?$/.exec(path);
  if (object) storageAssert(storageUuid.test(object[1]!), "storage_path_denied", 403);
  const allowed = path === "/descriptor" ? ["GET"] : path === "/prepare" ? ["POST"]
    : object ? object[2] === "/complete" ? ["POST"] : object[2] === "/content" ? ["GET", "HEAD"] : ["GET", "PUT"] : [];
  storageAssert(allowed.includes(method), "storage_path_denied", 403);
  if (method === "GET" || method === "HEAD") {
    storageAssert(!Object.hasOwn(row, "body"), "storage_body_denied");
  } else if (method === "PUT") {
    const body = storageObject(row.body, ["base64_data"]);
    storageAssert(typeof body.base64_data === "string" && body.base64_data.length <= 4 * Math.ceil(REGISTERED_STORAGE_MAX_BYTES / 3), "storage_size_invalid", 413);
    storageAssert(body.base64_data.length % 4 === 0 && !/[^A-Za-z0-9+/=]/.test(body.base64_data), "storage_base64_invalid");
    const bytes = Buffer.from(body.base64_data, "base64");
    storageAssert(bytes.length > 0 && bytes.length <= REGISTERED_STORAGE_MAX_BYTES, "storage_size_invalid", 413);
    storageAssert(bytes.toString("base64") === body.base64_data, "storage_base64_invalid");
  } else {
    const prepare = path === "/prepare";
    const body = storageObject(row.body, prepare ? ["idempotency_key", "file_name", "content_type", "size_bytes", "sha256_hex"] : ["size_bytes", "sha256_hex"]);
    storageAssert(Number.isSafeInteger(body.size_bytes) && Number(body.size_bytes) > 0 && Number(body.size_bytes) <= REGISTERED_STORAGE_MAX_BYTES, "storage_size_invalid", 413);
    storageAssert(typeof body.sha256_hex === "string" && storageHash.test(body.sha256_hex), "storage_hash_invalid");
    if (prepare) {
      storageAssert(typeof body.idempotency_key === "string" && storageUuid.test(body.idempotency_key), "storage_idempotency_invalid");
      storageAssert(typeof body.file_name === "string" && body.file_name.length > 0 && body.file_name.length <= 255
        && !/[\u0000-\u001f\u007f/\\]/.test(body.file_name), "storage_filename_invalid");
      storageAssert(typeof body.content_type === "string" && /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(body.content_type)
        && body.content_type.length <= 255, "storage_content_type_invalid");
    }
  }
  return row as unknown as RegisteredStorageRequest;
}

/** Bounded reads also apply to chunked bodies, and abort cancels stalled streams. */
export async function readRegisteredStorageBytes(input: Request | Response, max: number, signal: AbortSignal): Promise<Buffer> {
  storageAssert(!signal.aborted, "storage_timeout", 504);
  const declared = input.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > max)) {
    await input.body?.cancel();
    throw new RemoteStorageError("storage_size_invalid", 413);
  }
  if (!input.body) return Buffer.alloc(0);
  const reader = input.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => { reject(new RemoteStorageError("storage_timeout", 504)); void reader.cancel().catch(() => {}); };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    while (true) {
      const part = await Promise.race([reader.read(), aborted]);
      storageAssert(!signal.aborted, "storage_timeout", 504);
      if (part.done) break;
      size += part.value.byteLength;
      storageAssert(size <= max, "storage_size_invalid", 413);
      chunks.push(part.value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    signal.removeEventListener("abort", onAbort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function readRegisteredStorageJson(input: Request | Response, max: number, signal: AbortSignal): Promise<Record<string, unknown>> {
  storageAssert(input.headers.get("content-type")?.split(";")[0] === "application/json", "storage_json_invalid");
  const bytes = await readRegisteredStorageBytes(input, max, signal);
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch { storageAssert(false, "storage_json_invalid"); }
  return storageObject(parsed);
}
