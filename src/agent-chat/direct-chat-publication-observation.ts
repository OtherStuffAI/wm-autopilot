import {
  DirectChatPublicationObservationConflict,
  buildDirectChatPublicationPayload,
  directChatPublicationPayloadHash,
  type DirectChatTurnRecord,
  type DirectChatTurnStore,
} from "./direct-chat-turn-store";

/** Resume the saved request; a later transcript observation cannot replace it. */
export function freezeOrResumeDirectChatReply(
  store: DirectChatTurnStore,
  turnId: string,
  body: string,
  candidateAt: string | undefined,
  log: Pick<Console, "warn">,
): DirectChatTurnRecord {
  try {
    return store.freezeReply(turnId, body, candidateAt);
  } catch (error) {
    if (!(error instanceof DirectChatPublicationObservationConflict)) throw error;
    const current = store.get(turnId);
    if (!current?.publicationPayload || current.publicationPayload.body === body) throw error;
    const integrityError = directChatPublicationIntegrityError(current);
    if (integrityError) {
      store.markIntegrityHalt(turnId, "immutable_payload_mismatch", integrityError);
      throw error;
    }
    // Hashes identify differing observations without copying private replies.
    log.warn("[agent-chat] competing final observation; retaining frozen publication", {
      turnId, state: current.state, candidateHash: error.candidateHash, frozenHash: error.frozenHash,
    });
    return current;
  }
}

export function directChatPublicationIntegrityError(record: DirectChatTurnRecord): string | null {
  if (!record.publicationPayload || !record.payloadHash) return "Frozen publication payload or hash is missing.";
  if (directChatPublicationPayloadHash(record.publicationPayload) !== record.payloadHash) {
    return "Frozen publication no longer matches its saved payload hash.";
  }
  if (directChatPublicationPayloadHash(buildDirectChatPublicationPayload(record, record.publicationPayload.body)) !== record.payloadHash) {
    return "Frozen publication no longer matches its saved session, source messages, thread, or agent binding.";
  }
  return null;
}
