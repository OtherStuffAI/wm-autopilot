import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const schema = readFileSync(new URL("./db.js", import.meta.url), "utf8");
const source = readFileSync(new URL("./message-store.js", import.meta.url), "utf8");

describe("optimistic user message reconciliation", () => {
  test("clears only the derived message cache when upgrading past the duplicate bug", () => {
    expect(schema).toContain('db.version(7).stores({');
    expect(schema).toContain('db.version(8).stores({');
    expect(schema).toContain('.upgrade((transaction) => transaction.table("messages").clear())');
  });

  test("keeps pending rows through stale snapshots and reconciles the ACP user echo in place", () => {
    expect(source).toContain('entry.optimistic === true && entry.content === content');
    expect(source).toContain('optimistic: true');
    expect(source).toContain('optimistic: false');
    expect(source).toContain('createdAt,\n          messageId: messageId ?? matchingMessage.messageId ?? null');
    expect(source).toContain('createdAt: inc.createdAt,\n              messageId: inc.messageId ?? old.messageId ?? null');
    expect(source).toContain('pending: false');
    expect(source).toContain('old.pending !== true');
  });

  test("does not let an identified ACP working row consume a pending user row by position", () => {
    expect(source).toContain('positionalMessage?.pending !== true');
    expect(source).toContain('?? positionalFallback');
  });

  test("keeps a newly sent user turn when the canonical snapshot is stale", () => {
    expect(source).toContain('if (message.role !== "user") return index.snapshotCovers(message)');
    expect(source).toContain('return index.userCovered(message)');
  });

  test("deduplicates no-id user history without positional cross-role rewrites", () => {
    expect(source).toContain('const matchingLegacyMessage = !inc.messageId');
    expect(source).toContain('positionalMessage?.role === inc.role');
    expect(source).toContain('return index.userCovered(message)');
  });
});
