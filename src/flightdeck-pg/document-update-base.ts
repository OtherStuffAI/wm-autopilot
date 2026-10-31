import { flightDeckDocumentBase } from "../agent-chat/flightdeck-document-base.ts";
import type { FlightDeckPgDocumentResult } from "../agent-chat/tower-client.ts";

export interface CapturedDocumentBase {
  row_version: number;
  base_version_id: string;
  base_body_sha256_hex: string;
}

export function requireCapturedDocumentBase(input: unknown): CapturedDocumentBase {
  const value = input as Partial<CapturedDocumentBase> | null | undefined;
  if (!value || !Number.isInteger(value.row_version) || Number(value.row_version) < 1
    || typeof value.base_version_id !== "string" || !value.base_version_id.trim()
    || typeof value.base_body_sha256_hex !== "string" || !/^[0-9a-f]{64}$/i.test(value.base_body_sha256_hex)) {
    throw new Error("Concurrent document update requires captured_base (row_version, base_version_id, base_body_sha256_hex) from the doc_get/doc show used to author this draft. Fetch and review the document before editing; never relabel an older draft with a newer base.");
  }
  return value as CapturedDocumentBase;
}

export function documentUpdateBase(current: FlightDeckPgDocumentResult, captured?: unknown) {
  if (captured !== undefined) {
    const value = requireCapturedDocumentBase(captured);
    return { rowVersion: value.row_version, baseVersionId: value.base_version_id, baseBodySha256Hex: value.base_body_sha256_hex };
  }
  return { rowVersion: Number(current.doc?.row_version), ...flightDeckDocumentBase(current) };
}

export function capturedDocumentBase(current: FlightDeckPgDocumentResult): CapturedDocumentBase {
  const base = flightDeckDocumentBase(current);
  return requireCapturedDocumentBase({ row_version: current.doc?.row_version,
    base_version_id: base.baseVersionId, base_body_sha256_hex: base.baseBodySha256Hex });
}
