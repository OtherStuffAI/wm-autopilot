import { randomBytes } from "node:crypto";

export const LOGIN_CHALLENGE_TTL_MS = 2 * 60 * 1000;
const MAX_PENDING_LOGIN_CHALLENGES = 10_000;

export interface LoginChallenge {
  challenge: string;
  expiresAt: number;
}

function encodeChallenge(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export class LoginChallengeStore {
  private readonly pending = new Map<string, number>();

  issue(now = Date.now()): LoginChallenge {
    this.prune(now);
    if (this.pending.size >= MAX_PENDING_LOGIN_CHALLENGES) {
      const oldestChallenge = this.pending.keys().next().value;
      if (oldestChallenge) {
        this.pending.delete(oldestChallenge);
      }
    }

    const challenge = encodeChallenge(randomBytes(32));
    const expiresAt = now + LOGIN_CHALLENGE_TTL_MS;
    this.pending.set(challenge, expiresAt);
    return { challenge, expiresAt };
  }

  consume(challenge: string, now = Date.now()): boolean {
    const expiresAt = this.pending.get(challenge);
    if (expiresAt === undefined) return false;

    this.pending.delete(challenge);
    return expiresAt > now;
  }

  private prune(now: number): void {
    for (const [challenge, expiresAt] of this.pending) {
      if (expiresAt <= now) {
        this.pending.delete(challenge);
      }
    }
  }
}
