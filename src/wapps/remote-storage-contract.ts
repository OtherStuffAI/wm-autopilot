import { isCollectionOperation, parseCollectionOperation, type CollectionOperation } from './remote-storage-collections';
export const REMOTE_STORAGE_BROKER_PATH = "/api/internal/wapps/remote-storage";
export const REMOTE_STORAGE_PREFIX = "/api/v4/managed-app-storage";
export const REMOTE_STORAGE_PROTOCOL = "managed-app-storage-v1";
export const REMOTE_STORAGE_CONTROL_BYTES = 16_384;
export const REMOTE_STORAGE_MAX_OBJECT_BYTES = 8 * 1024 * 1024;
export const REMOTE_STORAGE_TOKEN_HEADER = "X-Managed-Storage-Token";
export const storageUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const storageHash = /^[0-9a-f]{64}$/;
export class RemoteStorageError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code); }
}
export function storageAssert(value: unknown, code: string, status = 400): asserts value {
  if (!value) throw new RemoteStorageError(code, status);
}
export function storageObject(value: unknown, keys?: string[]): Record<string, unknown> {
  storageAssert(value && typeof value === "object" && !Array.isArray(value), "storage_request_invalid");
  const row = value as Record<string, unknown>;
  if (keys) storageAssert(Object.keys(row).every(key => keys.includes(key)), "storage_request_invalid");
  return row;
}
export async function readStorageJson(input: Request | Response, signal: AbortSignal): Promise<Record<string, unknown>> {
  storageAssert(input.headers.get("content-type")?.split(";")[0] === "application/json", "storage_json_invalid", 502);
  storageAssert(input.body, "storage_json_invalid", 502);
  const reader = input.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let abort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    abort = () => { reject(new RemoteStorageError("storage_timeout", 504)); void reader.cancel().catch(() => {}); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    while (true) {
      const part = await Promise.race([reader.read(), aborted]);
      storageAssert(!signal.aborted, "storage_timeout", 504);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > REMOTE_STORAGE_CONTROL_BYTES) {
        void reader.cancel().catch(() => {});
        throw new RemoteStorageError("storage_control_too_large", 413);
      }
      chunks.push(part.value);
    }
    try { return storageObject(JSON.parse(Buffer.concat(chunks, size).toString("utf8"))); }
    catch { throw new RemoteStorageError("storage_json_invalid", 502); }
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}
export type RemoteStorageOperation = CollectionOperation
  | { operation: "prepare"; idempotencyKey: string; sha256: string; sizeBytes: number }
  | { operation: "status"; objectId?: string; cursor?: string }
  | { operation: "complete" | "download-url"; objectId: string };
export function parseStorageOperation(value: unknown, maxBytes: number): RemoteStorageOperation {
  const row = storageObject(value);
  if (isCollectionOperation(String(row.operation))) return parseCollectionOperation(row);
  if (row.operation === "prepare") {
    storageObject(row, ["operation", "idempotencyKey", "sha256", "sizeBytes"]);
    storageAssert(typeof row.idempotencyKey === "string" && storageUuid.test(row.idempotencyKey)
      && typeof row.sha256 === "string" && storageHash.test(row.sha256), "storage_request_invalid");
    storageAssert(Number.isSafeInteger(row.sizeBytes) && Number(row.sizeBytes) > 0 && Number(row.sizeBytes) <= maxBytes, "storage_size_invalid", 413);
  } else {
    storageObject(row, ["operation", "objectId", "cursor"]);
    if (Object.hasOwn(row, "cursor")) storageAssert(row.operation === "status" && !Object.hasOwn(row, "objectId")
      && typeof row.cursor === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(row.cursor), "storage_request_invalid");
    storageAssert(["status", "complete", "download-url"].includes(String(row.operation)), "storage_operation_not_allowed", 403);
    if (Object.hasOwn(row, "objectId") || row.operation !== "status") {
      storageAssert(typeof row.objectId === "string" && storageUuid.test(row.objectId), "storage_request_invalid");
    }
  }
  return row as unknown as RemoteStorageOperation;
}
