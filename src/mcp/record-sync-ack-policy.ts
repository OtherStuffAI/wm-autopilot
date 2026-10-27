/** Only the existing v2 checkpoint payload and negotiated chunk receipts. */
export function validRecordSyncAcknowledgement(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const intent = value as Record<string, unknown>;
  const keys = Object.keys(intent).sort().join();
  if (!["cursor,expected_revision", "cursor,expected_revision,large_record_receipts"].includes(keys) ||
    typeof intent.cursor !== "string" || !intent.cursor || typeof intent.expected_revision !== "string" ||
    !/^(0|[1-9][0-9]*)$/.test(intent.expected_revision)) return false;
  if (!("large_record_receipts" in intent)) return true;
  return Array.isArray(intent.large_record_receipts) && intent.large_record_receipts.length <= 1 &&
    intent.large_record_receipts.every(value => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const receipt = value as Record<string, unknown>;
      return Object.keys(receipt).sort().join() === "manifest_id,sha256" &&
        typeof receipt.manifest_id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(receipt.manifest_id) &&
        typeof receipt.sha256 === "string" && /^[0-9a-f]{64}$/.test(receipt.sha256);
    });
}
