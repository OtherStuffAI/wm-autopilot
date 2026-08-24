export interface SessionOutputMessage {
  role: string;
  createdAt: string;
}

const OUTPUT_ROLES = new Set(["assistant", "agent", "agent-working"]);

export function isSessionOutputRole(role: string): boolean {
  return OUTPUT_ROLES.has(role.trim().toLowerCase());
}

export function resolveLastSessionOutputAt(messages: SessionOutputMessage[]): string | null {
  let latestTimestamp = Number.NEGATIVE_INFINITY;

  for (const message of messages) {
    if (!isSessionOutputRole(message.role)) continue;
    const timestamp = Date.parse(message.createdAt);
    if (Number.isFinite(timestamp) && timestamp > latestTimestamp) {
      latestTimestamp = timestamp;
    }
  }

  return Number.isFinite(latestTimestamp) ? new Date(latestTimestamp).toISOString() : null;
}
