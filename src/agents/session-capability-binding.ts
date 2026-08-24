import type { ProcessManager, SessionSnapshot } from "./process-manager";
import {
  resolveSessionCapabilityBotRecord,
  type SessionCapabilityAgentProfile,
  type SessionCapabilityBotRecord,
} from "./session-capability-identity";

type SessionCapabilityBindingManager = Pick<
  ProcessManager,
  "getSession" | "bindSessionCapabilityIdentity"
>;

export function resolveAndBindSessionCapabilityBotRecord<
  T extends SessionCapabilityBotRecord,
>(input: {
  manager: SessionCapabilityBindingManager;
  sessionId: string;
  ownerNpub: string;
  requestedBotNpub?: string | null;
  profiles: SessionCapabilityAgentProfile[];
  getActiveByBotNpub: (botNpub: string) => T | null;
  getActiveForOwner: (ownerNpub: string) => T | null;
}): { record: T; session: SessionSnapshot } {
  const session = input.manager.getSession(input.sessionId);
  if (!session || session.npub !== input.ownerNpub) {
    throw new Error("Cannot bind capability identity for an unknown or mismatched session");
  }

  const record = resolveSessionCapabilityBotRecord({
    ownerNpub: input.ownerNpub,
    requestedBotNpub: input.requestedBotNpub,
    workingDirectory: session.workingDirectory,
    profiles: input.profiles,
    getActiveByBotNpub: input.getActiveByBotNpub,
    getActiveForOwner: input.getActiveForOwner,
  });
  if (!record) throw new Error("Session owner has no active bot identity");
  if (record.userNpub !== input.ownerNpub) {
    throw new Error("Selected agent identity is not managed by the session owner");
  }

  const boundSession = input.manager.bindSessionCapabilityIdentity(input.sessionId, record.botNpub);
  if (!boundSession) throw new Error("Cannot bind capability identity for an inactive session");

  return { record, session: boundSession };
}
