import { describe, expect, test } from "bun:test";
import { ARTEFACT_CONTEXT_KEY, validateArtefactDispatchContext } from "./artefact-dispatch-context";
import { isAgentDirectMessageEligible, normaliseDirectChatMessage, selectUndeliveredActionableMessages } from "./direct-chat-contract";
import { buildInitialDirectChatEnvelope, buildRehydratedDirectChatEnvelope } from "./direct-chat-prompt-envelope";
import { hydrateFlightDeckPgChatEvent } from "./direct-chat-tower-hydration";
import type { FlightDeckPgMessage } from "./tower-client";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const channelId = "22222222-2222-4222-8222-222222222222";
const threadId = "33333333-3333-4333-8333-333333333333";
const recordId = "44444444-4444-4444-8444-444444444444";
const revision = "55555555-5555-4555-8555-555555555555";
const messageId = "66666666-6666-4666-8666-666666666666";

function draftSnapshot() {
  return {
    schemaVersion: 1, workspaceID: workspaceId, channelID: channelId, threadID: null,
    workspaceVisible: true, visibleRecordID: recordId,
    open: [{ kind: "file", recordID: recordId, revision, revisionKind: "file_version_id", historical: true, digest: "a".repeat(64) }],
  };
}

// Shape returned by NStack's effective-transcript serializer, not event metadata.
function rootMessage(): FlightDeckPgMessage {
  return {
    id: messageId, workspace_id: workspaceId, channel_id: channelId,
    thread_id: threadId, owning_thread_id: threadId, effective_thread_id: threadId,
    thread_source_message_id: messageId, inherited: false, read_only: false,
    body: "Use this exact whiteboard", created_at: "2026-11-28T00:00:00.000Z",
    metadata: { [ARTEFACT_CONTEXT_KEY]: draftSnapshot() },
  };
}

describe("draft artefact context", () => {
  test("retrieves an actual root record and carries exact references into prompt context", async () => {
    const root = rootMessage();
    const result = await hydrateFlightDeckPgChatEvent({
      subscription: { workspaceId, backendBaseUrl: "https://tower", sourceAppNpub: "app" } as never,
      botIdentity: {} as never, channelId, includeChannel: true,
      event: { entity_type: "message", entity_id: messageId, thread_id: threadId },
    }, {
      fetchChannel: async () => ({ id: channelId, workspace_id: workspaceId }),
      fetchMessages: async (input) => {
        expect(input.threadId).toBe(threadId);
        expect(input.effectiveTranscript).toBe(true);
        return { messages: [root], next_cursor: null };
      },
    });
    expect(result.message).toBe(root);
    const message = normaliseDirectChatMessage(result.message!);
    expect(message.artefactContext).toEqual({ ...draftSnapshot(), threadID: threadId });
    expect(message.owningThreadId).toBe(threadId);
    expect(root.metadata![ARTEFACT_CONTEXT_KEY]).toEqual(draftSnapshot());
    for (const envelope of [
      buildInitialDirectChatEnvelope({ metadata: {}, history: [], prompts: [message] }),
      buildRehydratedDirectChatEnvelope({ history: [], prompts: [message] }),
    ]) {
      const section = envelope.split("# Artefact dispatch context")[1]!;
      const context = JSON.parse(section.split("```json\n")[1]!.split("```")[0]!);
      expect(context).toEqual([{ messageId, context: { ...draftSnapshot(), threadID: threadId } }]);
      expect(envelope.split("# Prompt\n")[1]).toStartWith("\nUse this exact whiteboard\n");
    }
    expect(buildRehydratedDirectChatEnvelope({ history: [message], prompts: [] })).not.toContain(revision);
    // Descriptive context does not address an agent or confer instruction eligibility.
    expect(isAgentDirectMessageEligible({ id: channelId }, message, "bot")).toBe(false);
  });

  test("accepts a fetched ordinary root shape without optional effective-transcript fields", () => {
    const { owning_thread_id, effective_thread_id, inherited, read_only, ...ordinary } = rootMessage();
    expect(validateArtefactDispatchContext(draftSnapshot(), ordinary)?.threadID).toBe(threadId);
  });

  test("rejects missing threadID, foreign destinations, extra fields and oversized draft snapshots", () => {
    const root = rootMessage(), base = draftSnapshot();
    const { threadID, ...missing } = base;
    for (const snapshot of [missing, { ...base, threadID: undefined }, { ...base, threadID: workspaceId },
      { ...base, workspaceID: channelId }, { ...base, channelID: workspaceId },
      { ...base, root: true }, { ...base, open: [{ ...base.open[0], digest: "a".repeat(20_000) }] }]) {
      expect(validateArtefactDispatchContext(snapshot, root)).toBeUndefined();
    }
  });

  test("requires authoritative root identity and consistent owned route; null replies cannot qualify", () => {
    const base = rootMessage();
    const invalid: Array<Record<string, unknown>> = [
      { id: revision }, { id: "root", thread_source_message_id: "root" },
      { thread_source_message_id: undefined }, { thread_source_message_id: null },
      { thread_source_message_id: true }, { thread_source_message_id: { id: messageId } },
      { owning_thread_id: null }, { owning_thread_id: workspaceId },
      { thread_id: null }, { thread_id: workspaceId },
      { owning_thread_id: undefined, thread_id: null },
      { owning_thread_id: undefined, thread_id: "invalid" },
      { effective_thread_id: workspaceId }, { effective_thread_id: null },
      { inherited: true }, { inherited: "false" }, { inherited: null },
      { read_only: true }, { read_only: "false" },
    ];
    for (const overrides of invalid) {
      expect(validateArtefactDispatchContext(draftSnapshot(), { ...base, ...overrides } as FlightDeckPgMessage)).toBeUndefined();
    }
    const forged = { ...base, thread_source_message_id: undefined,
      metadata: { ...base.metadata, thread_source_message_id: messageId, root: true } };
    expect(normaliseDirectChatMessage(forged).artefactContext).toBeUndefined();
  });

  test("inherited roots and branched history remain inert; UUID reply snapshots retain validation", () => {
    const root = rootMessage();
    const inherited = normaliseDirectChatMessage({ ...root, inherited: true, read_only: true, effective_thread_id: workspaceId });
    expect(inherited.artefactContext).toBeUndefined();
    expect(selectUndeliveredActionableMessages([inherited], null, "bot")).toEqual([]);
    const reply = { ...root, id: revision };
    expect(validateArtefactDispatchContext(draftSnapshot(), reply)).toBeUndefined();
    const posted = { ...draftSnapshot(), threadID: threadId };
    expect(validateArtefactDispatchContext(posted, reply)).toEqual(posted);
    expect(validateArtefactDispatchContext({ ...posted, threadID: workspaceId }, reply)).toBeUndefined();
  });

  test("keeps exact Doc row version and digest detached from the saved null snapshot", () => {
    const snapshot = { ...draftSnapshot(), open: [{ kind: "doc", recordID: recordId, revision: "42",
      revisionKind: "doc_versions.row_version", historical: true, digest: "b".repeat(64) }] };
    const validated = validateArtefactDispatchContext(snapshot, rootMessage())!;
    expect(validated).toEqual({ ...snapshot, threadID: threadId });
    validated.open[0]!.revision = "43";
    expect(snapshot.open[0]!.revision).toBe("42");
    expect(snapshot.threadID).toBeNull();
  });
});
