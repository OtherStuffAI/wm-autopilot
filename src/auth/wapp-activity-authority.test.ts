import { describe, expect, test } from "bun:test";

import type { SessionSnapshot } from "../agents/process-manager";
import { hasWappActivityAuthority } from "./wapp-activity-authority";
import type { RequestAuthContext } from "./request-context";

const auth = (sessionId: string | null): RequestAuthContext => ({
  npub: "npub1owner",
  authMethod: "nip98",
  capabilitySessionId: sessionId,
  session: null,
});

function session(status: SessionSnapshot["status"], installationId: string): SessionSnapshot {
  return {
    id: "scheduled-session",
    agent: "codex",
    port: 3700,
    name: "Book of Sand schedule",
    status,
    startedAt: new Date().toISOString(),
    command: [],
    workingDirectory: "/tmp",
    logs: [],
    origin: { type: "scheduler", id: "book-trigger" },
    metadata: { AGENT: true, billingMode: "subscription", wappActivityInstallationId: installationId },
  };
}

describe("WApp activity authority", () => {
  test("requires an exact installed-WApp binding on a live capability session", () => {
    const live = session("running", "book-of-sand");
    const getSession = (id: string) => id === live.id ? live : null;
    const getScheduledInstallationId = (id: string) => id === "book-trigger" ? "book-of-sand" : null;

    expect(hasWappActivityAuthority(auth(live.id), "book-of-sand", getSession, getScheduledInstallationId)).toBeTrue();
    expect(hasWappActivityAuthority(auth(live.id), "another-installation", getSession, getScheduledInstallationId)).toBeFalse();
    expect(hasWappActivityAuthority(auth(null), "book-of-sand", getSession, getScheduledInstallationId)).toBeFalse();
    expect(hasWappActivityAuthority({ ...auth(live.id), authMethod: "session" }, "book-of-sand", getSession, getScheduledInstallationId)).toBeFalse();
    expect(hasWappActivityAuthority(auth(live.id), "book-of-sand", () => session("stopped", "book-of-sand"), getScheduledInstallationId)).toBeFalse();
    expect(hasWappActivityAuthority(auth(live.id), "book-of-sand", getSession, () => "another-installation")).toBeFalse();
  });
});
