import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./db.js", import.meta.url), "utf8");

describe("optimistic user message reconciliation", () => {
  test("clears only the derived message cache when upgrading past the duplicate bug", () => {
    expect(source).toContain('db.version(7).stores({');
    expect(source).toContain('db.version(8).stores({');
    expect(source).toContain('.upgrade((transaction) => transaction.table("messages").clear())');
  });

  test("keeps pending rows through stale snapshots and reconciles the ACP user echo in place", () => {
    expect(source).toContain('entry.optimistic === true && entry.content === content');
    expect(source).toContain('optimistic: true');
    expect(source).toContain('optimistic: false');
    expect(source).toContain('createdAt,\n        messageId: messageId ?? matchingMessage.messageId ?? null');
    expect(source).toContain('createdAt: inc.createdAt,\n            messageId: inc.messageId ?? old.messageId ?? null');
    expect(source).toContain('pending: false');
    expect(source).toContain('message.pending !== true');
  });

  test("does not let an identified ACP working row consume a pending user row by position", () => {
    expect(source).toContain('positionalMessage?.pending !== true');
    expect(source).toContain('?? positionalFallback');
  });

  test("keeps a newly sent user turn when the canonical snapshot is stale", () => {
    expect(source).toContain('if (message.role !== "user") return true');
    expect(source).toContain('isUserMessageCoveredBySnapshot(message, incoming)');
  });

  test("deduplicates no-id user history without positional cross-role rewrites", () => {
    expect(source).toContain('const matchingLegacyMessage = !inc.messageId');
    expect(source).toContain('positionalMessage?.role === inc.role');
    expect(source).toContain('return hasEquivalentIncomingUser(message, incoming)');
  });
});
