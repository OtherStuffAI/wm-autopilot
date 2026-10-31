import { randomUUID } from "node:crypto";

const concurrentProtocol = "document_concurrent_edit_v1";

type SignedJson = (method: string, path: string, query?: Record<string, string>, body?: unknown) => Promise<unknown>;

/** Negotiate once: a refused or inconsistent concurrent acquire must never retry legacy. */
export async function acquireDocumentEditLease(workspaceId: string, documentId: string, request: SignedJson, beforeConcurrentAcquire?: () => void): Promise<string> {
  const path = `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(workspaceId)}/edit-leases`;
  const inspection = await request("GET", path, { entity_type: "document", entity_id: documentId }) as {
    document_edit_protocols?: unknown;
  };
  const concurrent = Array.isArray(inspection.document_edit_protocols)
    && inspection.document_edit_protocols.includes(concurrentProtocol);
  if (concurrent) beforeConcurrentAcquire?.();
  const editorSessionId = concurrent ? randomUUID() : undefined;
  const result = await request("POST", `${path}/acquire`, undefined, {
    entity_type: "document",
    entity_id: documentId,
    ttl_seconds: 120,
    ...(concurrent ? { document_edit_protocol: concurrentProtocol, editor_session_id: editorSessionId } : {}),
  }) as {
    document_edit_protocol?: unknown;
    lease?: { lease_token?: unknown; editor_session_id?: unknown };
  };
  if (concurrent && (result.document_edit_protocol !== concurrentProtocol
    || result.lease?.editor_session_id !== editorSessionId)) {
    throw new Error("Tower did not confirm the negotiated concurrent document protocol and editor session; document update refused.");
  }
  const token = result.lease?.lease_token;
  if (typeof token !== "string" || !token.trim()) {
    throw new Error("Flight Deck PG edit lease acquire did not return lease_token.");
  }
  return token;
}
