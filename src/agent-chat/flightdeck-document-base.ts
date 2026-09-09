import type { FlightDeckPgDocumentResult } from "./tower-client";

export function flightDeckDocumentBase(result: FlightDeckPgDocumentResult): { baseVersionId: string; baseBodySha256Hex: string } {
  const version = result.canonical_version;
  if (!version || !version.version_id || !/^[0-9a-f]{64}$/i.test(version.body_sha256_hex ?? "")
    || version.row_version !== result.doc?.row_version || version.storage_object_id !== result.doc?.storage_object_id) {
    throw new Error("Document update requires the matching canonical base version and body hash from Tower");
  }
  return { baseVersionId: version.version_id, baseBodySha256Hex: version.body_sha256_hex! };
}
