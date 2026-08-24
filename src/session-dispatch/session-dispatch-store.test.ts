import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { SessionDispatchStore } from "./session-dispatch-store";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("SessionDispatchStore", () => {
  test("persists optional reporting context and terminal state across reopen", () => {
    const root = mkdtempSync(join(tmpdir(), "dispatch-store-")); roots.push(root);
    const path = join(root, "dispatches.db");
    const store = new SessionDispatchStore(path);
    const created = store.create({ workerSessionId: "worker", callbackSessionId: "supervisor", ownerNpub: "npub1owner",
      state: "running", prompt: "Do it", promptQueuedAt: "2026-01-01T00:00:00.000Z",
      reportingContext: { taskId: "optional" }, terminalStatus: null, terminalMessage: null,
      terminalMessageCreatedAt: null, terminalFingerprint: null, callbackPrompt: null,
      nativeDiscoveryStartedAt: null, nativeDiscoveryNextAttemptAt: null,
      nativeDiscoveryAttemptCount: 0, nativeDiscoveryLastError: null,
      callbackAttemptCount: 0, callbackNextAttemptAt: null, callbackExpiresAt: null,
      callbackQueuedAt: null, callbackAcknowledgedAt: null, closedAt: null, lastError: null });
    store.update(created.dispatchId, { state: "callback_delivered", terminalStatus: "completed", terminalMessage: "Done",
      callbackNextAttemptAt: "2026-01-01T00:02:00.000Z", callbackExpiresAt: "2026-01-02T00:00:00.000Z" });
    const reopened = new SessionDispatchStore(path).get(created.dispatchId);
    expect(reopened?.reportingContext).toEqual({ taskId: "optional" });
    expect(reopened?.terminalMessage).toBe("Done");
    expect(reopened?.callbackNextAttemptAt).toBe("2026-01-01T00:02:00.000Z");
    expect(reopened?.callbackExpiresAt).toBe("2026-01-02T00:00:00.000Z");
    expect(reopened?.nativeDiscoveryAttemptCount).toBe(0);
  });

  test("adds closeout scheduling columns to an existing dispatch database", () => {
    const root = mkdtempSync(join(tmpdir(), "dispatch-store-migration-")); roots.push(root);
    const path = join(root, "dispatches.db");
    const legacyDb = new Database(path);
    legacyDb.exec(`CREATE TABLE session_dispatches (
      dispatch_id TEXT PRIMARY KEY, worker_session_id TEXT NOT NULL,
      callback_session_id TEXT, owner_npub TEXT, state TEXT NOT NULL,
      prompt TEXT NOT NULL, prompt_queued_at TEXT NOT NULL,
      reporting_context_json TEXT NOT NULL DEFAULT '{}', terminal_status TEXT,
      terminal_message TEXT, terminal_message_created_at TEXT,
      terminal_fingerprint TEXT, callback_prompt TEXT,
      callback_attempt_count INTEGER NOT NULL DEFAULT 0, callback_queued_at TEXT,
      callback_acknowledged_at TEXT, closed_at TEXT, last_error TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);

    new SessionDispatchStore(path);

    const columns = legacyDb.query("PRAGMA table_info(session_dispatches)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain("callback_next_attempt_at");
    expect(columns.map((column) => column.name)).toContain("callback_expires_at");
    expect(columns.map((column) => column.name)).toContain("native_discovery_started_at");
    expect(columns.map((column) => column.name)).toContain("native_discovery_next_attempt_at");
    expect(columns.map((column) => column.name)).toContain("native_discovery_attempt_count");
    expect(columns.map((column) => column.name)).toContain("native_discovery_last_error");
  });
});
