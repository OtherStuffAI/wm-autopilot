import { createHash } from "node:crypto";
import { nip19, verifyEvent } from "nostr-tools";
import type { RemoteStorageGrant } from "./remote-storage-grants";
import { REMOTE_STORAGE_PREFIX, storageAssert, storageObject, storageUuid } from "./remote-storage-contract";

export function validateStorageCursor(value: unknown, grant: RemoteStorageGrant): string {
  storageAssert(typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value), "storage_response_invalid", 502);
  const cursor = storageObject(JSON.parse(Buffer.from(value, "base64url").toString("utf8")), ["w", "d", "t", "id"]);
  storageAssert(cursor.w === grant.workspaceId && cursor.d === grant.delegationId && typeof cursor.t === "string"
    && Number.isFinite(Date.parse(cursor.t)) && typeof cursor.id === "string" && storageUuid.test(cursor.id), "storage_response_invalid", 502);
  return value;
}
export function validatePublisherReceipt(value: unknown, grant: RemoteStorageGrant, hash: string, size: number) {
  const receipt = storageObject(value, ["event", "body", "accepted_at"]);
  storageAssert(typeof receipt.body === "string" && Buffer.byteLength(receipt.body) <= 2048
    && typeof receipt.accepted_at === "string" && Number.isFinite(Date.parse(receipt.accepted_at)), "storage_receipt_invalid", 502);
  const event = storageObject(receipt.event);
  storageAssert(Buffer.byteLength(JSON.stringify(event)) <= 4096 && verifyEvent(event as any)
    && event.kind === 27235 && event.content === "" && typeof event.pubkey === "string"
    && nip19.npubEncode(event.pubkey) === grant.appNpub && Number.isSafeInteger(event.created_at)
    && Math.abs(Date.parse(receipt.accepted_at) / 1000 - Number(event.created_at)) <= 61,
  "storage_receipt_invalid", 502);
  const url = `${grant.origin}${REMOTE_STORAGE_PREFIX}/workspaces/${grant.workspaceId}/delegations/${grant.delegationId}/prepare`;
  const tags = event.tags as string[][];
  for (const [name, expected] of [["u", url], ["method", "POST"], ["payload", createHash("sha256").update(receipt.body).digest("hex")]]) {
    const matching = tags.filter(tag => tag[0] === name);
    storageAssert(matching.length === 1 && matching[0]!.length === 2 && matching[0]![1] === expected, "storage_receipt_invalid", 502);
  }
  const body = storageObject(JSON.parse(receipt.body), ["installation_id", "app_id", "revision", "expected_service_npub", "idempotency_key", "sha256_hex", "size_bytes"]);
  storageAssert(body.installation_id === grant.installationId && body.app_id === grant.appId && body.expected_service_npub === grant.serviceNpub
    && body.sha256_hex === hash && body.size_bytes === size && typeof body.idempotency_key === "string"
    && storageUuid.test(body.idempotency_key) && typeof body.revision === "string", "storage_receipt_invalid", 502);
  // Historical proof: no comparison with the reader's current clock/revision.
  return receipt;
}
