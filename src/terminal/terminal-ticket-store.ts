import { randomBytes } from "node:crypto";

interface TicketRecord {
  npub: string;
  expiresAt: number;
}

export interface TerminalTicketStoreOptions {
  ttlMs: number;
  now?: () => number;
}

export class TerminalTicketStore {
  private readonly tickets = new Map<string, TicketRecord>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: TerminalTicketStoreOptions) {
    this.ttlMs = options.ttlMs;
    this.now = options.now ?? Date.now;
  }

  create(npub: string): { ticket: string; expiresAt: string } {
    this.pruneExpired();
    const ticket = randomBytes(24).toString("base64url");
    const expiresAtMs = this.now() + this.ttlMs;
    this.tickets.set(ticket, { npub, expiresAt: expiresAtMs });
    return {
      ticket,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  consume(ticket: string | null | undefined, npub: string | null | undefined): boolean {
    if (!ticket || !npub) return false;
    this.pruneExpired();
    const record = this.tickets.get(ticket);
    if (!record) return false;
    this.tickets.delete(ticket);
    return record.npub === npub && record.expiresAt > this.now();
  }

  pruneExpired(): void {
    const now = this.now();
    for (const [ticket, record] of this.tickets.entries()) {
      if (record.expiresAt <= now) {
        this.tickets.delete(ticket);
      }
    }
  }

  clear(): void {
    this.tickets.clear();
  }
}
