export type CodexMessageRecordSource = "event_msg" | "response_item";

export interface CodexMessageMirrorCandidate {
  source: CodexMessageRecordSource;
  type: "user_message" | "agent_message";
  phase: string;
  content: string;
  timestampMs: number | null;
}

const MIRROR_WINDOW_MS = 500;
const RECENT_MESSAGE_LIMIT = 8;

export class CodexMessageMirrorDeduper {
  private readonly recentMessages: CodexMessageMirrorCandidate[] = [];

  isMirrored(candidate: CodexMessageMirrorCandidate): boolean {
    if (candidate.timestampMs === null) {
      return false;
    }
    const candidateTimestampMs = candidate.timestampMs;

    const mirrored = this.recentMessages.some((recent) => (
      recent.source !== candidate.source &&
      recent.type === candidate.type &&
      recent.phase === candidate.phase &&
      recent.content === candidate.content &&
      recent.timestampMs !== null &&
      Math.abs(recent.timestampMs - candidateTimestampMs) <= MIRROR_WINDOW_MS
    ));
    if (mirrored) {
      return true;
    }

    this.recentMessages.push(candidate);
    if (this.recentMessages.length > RECENT_MESSAGE_LIMIT) {
      this.recentMessages.shift();
    }
    return false;
  }
}
