import { expect, test } from "bun:test";
import { acquireDocumentEditLease } from "./document-edit-lease.ts";

const protocol = "document_concurrent_edit_v1";

for (const echo of [undefined, "document_edit_session_v1", protocol]) {
  for (const session of ["missing", "wrong", "matching"]) {
    test(`strict concurrent authority: ${echo}/${session}`, async () => {
      const calls: unknown[] = [];
      const acquire = acquireDocumentEditLease("workspace", "doc", async (method, path, query, body) => {
        calls.push({ method, path, query, body });
        if (method === "GET") return { document_edit_protocol: "document_edit_session_v1", document_edit_protocols: [protocol] };
        const payload = body as Record<string, unknown>;
        expect(payload.editor_session_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(payload.takeover).toBeUndefined();
        expect(payload.expected_lease_id).toBeUndefined();
        return { document_edit_protocol: echo, lease: { lease_token: "token", editor_session_id:
          session === "matching" ? payload.editor_session_id : session === "wrong" ? "other" : undefined } };
      });
      if (echo === protocol && session === "matching") await expect(acquire).resolves.toBe("token");
      else await expect(acquire).rejects.toThrow("update refused");
      expect(calls).toHaveLength(2);
    });
  }
}

for (const failure of ["edit_lease_held", "document_edit_protocol_conflict", "permission_denied"]) {
  test(`never downgrade on ${failure}`, async () => {
    let acquires = 0;
    await expect(acquireDocumentEditLease("workspace", "doc", async (method) => {
      if (method === "GET") return { document_edit_protocols: [protocol] };
      acquires++;
      throw new Error(failure);
    })).rejects.toThrow(failure);
    expect(acquires).toBe(1);
  });
}

test("old server acquires unchanged legacy payload", async () => {
  await expect(acquireDocumentEditLease("workspace", "doc", async (method, _path, _query, body) => {
    if (method === "GET") return { document_edit_protocol: "document_edit_session_v1" };
    expect(body).toEqual({ entity_type: "document", entity_id: "doc", ttl_seconds: 120 });
    return { lease: { lease_token: "legacy" } };
  })).resolves.toBe("legacy");
});

for (const token of [undefined, 42, "", " "]) {
  test(`reject invalid concurrent token: ${String(token)}`, async () => {
    await expect(acquireDocumentEditLease("workspace", "doc", async (method, _path, _query, body) => {
      if (method === "GET") return { document_edit_protocols: [protocol] };
      return { document_edit_protocol: protocol, lease: { lease_token: token,
        editor_session_id: (body as Record<string, unknown>).editor_session_id } };
    })).rejects.toThrow("lease_token");
  });
}

test("inspection failure cannot acquire legacy authority", async () => {
  let calls = 0;
  await expect(acquireDocumentEditLease("workspace", "doc", async () => {
    calls++;
    throw new Error("inspection unavailable");
  })).rejects.toThrow("inspection unavailable");
  expect(calls).toBe(1);
});
