import { expect, test } from "bun:test";
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { buildFlightDeckPgMessageInstructionSignatureForIdentity } from "../agent-chat/tower-client";
import { requirePrivateReportContext, sendPrivateReport, type PrivateReportRequest } from "./private-report";

// Run with TOWER_CHECKOUT pointing at the active checkout to exercise its actual validator.
const towerCheckout = process.env.TOWER_CHECKOUT;
(towerCheckout ? test : test.skip)("private report satisfies active Tower body and signature contract", async () => {
  const { validateFlightDeckPgMessageInstructionSignature: validate } = await import(`${towerCheckout}/src/services/flightdeck-pg-message-signatures.ts`);
  // Ephemeral synthetic identity only; never use a managed bot or human key in tests.
  const secret = generateSecretKey();
  const npub = nip19.npubEncode(getPublicKey(secret));
  const identity = { botNpub: npub, signNostrEvent: async (event: any) => finalizeEvent(event, secret) };
  const context = requirePrivateReportContext({ workspace: { workspaceId: "10000000-0000-4000-8000-000000000001", backendBaseUrl: "https://tower.test", sourceAppNpub: "app" }, bot: { npub, available: true } });
  const channel = { id: "20000000-0000-4000-8000-000000000001", kind: "dm", participant_npubs: [npub, "synthetic-recipient"] };
  const raw = "Synthetic bounded report\n";
  const sign = (body: string) => buildFlightDeckPgMessageInstructionSignatureForIdentity({ botIdentity: identity as any, body, workspaceId: context.workspace.workspaceId, channelId: channel.id });
  const old = validate({ value: await sign(raw), body: raw.trim(), actorNpub: npub, workspaceId: context.workspace.workspaceId, channelId: channel.id });
  expect(old.errors.map((e: any) => e.path)).toEqual(["message_signature.nostr_event.content", "message_signature.body_sha256"]);
  const rows: any[] = [];
  const request: PrivateReportRequest = async (method, path, body: any) => {
    if (method === "POST") {
      const result = validate({ value: await sign(body.body), body: String(body.body || "").trim(), actorNpub: npub, workspaceId: context.workspace.workspaceId, channelId: channel.id });
      expect(result.errors).toEqual([]);
      rows.push({ id: "saved", body: body.body.trim(), sender_npub: npub, client_request_id: body.client_request_id });
      return {};
    }
    if (path.includes("/messages?")) return { channel_id: channel.id, messages: rows, next_cursor: null, cursor_semantics: { order: "created_at ASC, id ASC" } };
    if (path.includes("/scopes?")) return { scopes: [{ id: "dm", kind: "dm" }], next_cursor: null };
    if (path.includes("/channels?")) return { channels: [channel], next_cursor: null };
    return { channel };
  };
  const input = { recipient: "synthetic-recipient", body: raw, clientRequestId: "synthetic-report" };
  expect(await sendPrivateReport(context, request, input)).toMatchObject({ delivered: true, reused: false });
  expect(await sendPrivateReport(context, request, input)).toMatchObject({ delivered: true, reused: true });
  expect(rows).toHaveLength(1);
});
