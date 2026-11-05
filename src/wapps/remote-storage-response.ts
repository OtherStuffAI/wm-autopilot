import { isCollectionOperation, validateCollectionResponse, type CollectionOperation } from './remote-storage-collections';
import { validateStorageCursor, validatePublisherReceipt } from "./remote-storage-recovery";
import type { RemoteStorageGrant } from "./remote-storage-grants";
import { REMOTE_STORAGE_PREFIX, REMOTE_STORAGE_PROTOCOL, REMOTE_STORAGE_TOKEN_HEADER, storageAssert, storageHash, storageObject, storageUuid,
  type RemoteStorageOperation } from "./remote-storage-contract";

function validateStream(value: unknown, grant: RemoteStorageGrant, id: string, direction: "upload" | "download", size: number, now: number) {
  const stream = storageObject(value, ["url", "method", "expires_at", "headers"]);
  const path = `${REMOTE_STORAGE_PREFIX}/workspaces/${grant.workspaceId}/delegations/${grant.delegationId}/objects/${id}/${direction}`;
  storageAssert(stream.url === `${grant.origin}${path}` && stream.method === (direction === "upload" ? "PUT" : "GET"), "storage_response_invalid", 502);
  storageAssert(typeof stream.expires_at === "string", "storage_response_invalid", 502);
  const expiry = Date.parse(stream.expires_at);
  storageAssert(expiry > now && expiry <= now + 65_000 && expiry <= Date.parse(grant.expiresAt), "storage_response_invalid", 502);
  const headers = storageObject(stream.headers, direction === "upload"
    ? [REMOTE_STORAGE_TOKEN_HEADER, "Content-Type", "Content-Length"] : [REMOTE_STORAGE_TOKEN_HEADER]);
  storageAssert(typeof headers[REMOTE_STORAGE_TOKEN_HEADER] === "string" && /^[A-Za-z0-9_-]{43}$/.test(headers[REMOTE_STORAGE_TOKEN_HEADER]), "storage_response_invalid", 502);
  if (direction === "upload") storageAssert(headers["Content-Type"] === "application/octet-stream"
    && headers["Content-Length"] === String(size), "storage_response_invalid", 502);
  return stream;
}
export function validateStorageResponse(value: unknown, grant: RemoteStorageGrant, operation: RemoteStorageOperation, now: number) {
  const row = storageObject(value);
  storageAssert(row.protocol === REMOTE_STORAGE_PROTOCOL && row.service_npub === grant.serviceNpub
    && row.workspace_id === grant.workspaceId && row.delegation_id === grant.delegationId
    && row.installation_id === grant.installationId, "storage_response_binding_mismatch", 502);
  if(isCollectionOperation(operation.operation)) return validateCollectionResponse(row,grant,operation as CollectionOperation,now);
  const binding = { protocol: row.protocol, service_npub: row.service_npub, workspace_id: row.workspace_id,
    delegation_id: row.delegation_id, installation_id: row.installation_id };
  if (operation.operation === "status" && Object.hasOwn(operation, "cursor")) {
    storageAssert(Array.isArray(row.objects) && row.objects.length <= 50, "storage_response_invalid", 502);
    const objects = row.objects.map(value => {
      const item = storageObject(value, ["object_id", "state", "sha256_hex", "size_bytes", "verified_at"]);
      storageAssert(typeof item.object_id === "string" && storageUuid.test(item.object_id) && item.state === "complete"
        && typeof item.sha256_hex === "string" && storageHash.test(item.sha256_hex) && Number.isSafeInteger(item.size_bytes)
        && Number(item.size_bytes) > 0 && Number(item.size_bytes) <= grant.maxObjectBytes
        && typeof item.verified_at === "string" && Number.isFinite(Date.parse(item.verified_at)), "storage_response_invalid", 502);
      return item;
    });
    return { ...binding, objects, next_cursor: row.next_cursor === null ? null : validateStorageCursor(row.next_cursor, grant) };
  }
  if (operation.operation === "status" && !Object.hasOwn(operation, "objectId")) {
    storageAssert(Number.isSafeInteger(row.remaining_bytes) && Number(row.remaining_bytes) >= 0
      && Number.isSafeInteger(row.remaining_objects) && Number(row.remaining_objects) >= 0
      && Number.isSafeInteger(row.max_object_bytes) && Number(row.max_object_bytes) > 0
      && Number(row.max_object_bytes) <= grant.maxObjectBytes && row.billing === "operator_budget"
      && row.budget_mode === "operator_allocated_unmetered" && typeof row.billing_ok === "boolean", "storage_response_invalid", 502);
    return { ...binding, remaining_bytes: row.remaining_bytes, remaining_objects: row.remaining_objects,
      physical_delete_policy: row.physical_delete_policy === "never_versioned_exclusive_writer" ? "never_versioned_exclusive_writer" : "disabled",
      max_object_bytes: row.max_object_bytes, max_receipt_bytes: 6144, list_cursor: validateStorageCursor(row.list_cursor, grant), billing: row.billing, budget_mode: row.budget_mode, billing_ok: row.billing_ok };
  }
  storageAssert(typeof row.object_id === "string" && storageUuid.test(row.object_id)
    && typeof row.sha256_hex === "string" && storageHash.test(row.sha256_hex)
    && Number.isSafeInteger(row.size_bytes) && Number(row.size_bytes) > 0 && Number(row.size_bytes) <= grant.maxObjectBytes
    && ["pending", "uploaded", "complete"].includes(String(row.state)), "storage_response_invalid", 502);
  if (operation.operation === "prepare") storageAssert(row.sha256_hex === operation.sha256 && row.size_bytes === operation.sizeBytes, "storage_response_invalid", 502);
  else storageAssert(row.object_id === operation.objectId, "storage_response_invalid", 502);
  storageAssert(row.state === "complete" ? typeof row.verified_at === "string" && Number.isFinite(Date.parse(row.verified_at))
    : row.verified_at === null, "storage_response_invalid", 502);
  if (operation.operation === "complete" || operation.operation === "download-url") storageAssert(row.state === "complete", "storage_response_invalid", 502);
  const result: Record<string, unknown> = { ...binding, object_id: row.object_id, state: row.state,
    size_bytes: row.size_bytes, sha256_hex: row.sha256_hex, verified_at: row.verified_at };
  if (operation.operation === "status") result.publisher_receipt = validatePublisherReceipt(row.publisher_receipt, grant, row.sha256_hex as string, Number(row.size_bytes));
  if (operation.operation === "prepare" && row.state === "pending") result.upload = validateStream(row.upload, grant, row.object_id, "upload", Number(row.size_bytes), now);
  if (operation.operation === "download-url") result.download = validateStream(row.download, grant, row.object_id, "download", Number(row.size_bytes), now);
  return result;
}
