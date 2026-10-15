import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RequestAuthContext } from "../auth/request-context";
import type { SessionSnapshot } from "../agents/process-manager";
import { handleSessionApi } from "./session-api-routes";
import { loadWarmRestartMarker, restoreRestartedSessions } from "./bootstrap/warm-restart";

test("an explicitly closed Agent Direct session stays closed across two warm bootstraps", async () => {
  const root = await mkdtemp(join(tmpdir(), "wingman-explicit-close-restart-"));
  const markerPath = join(root, "restart.json");
  let session: SessionSnapshot = {
    id: "agent-direct-old",
    agent: "codex",
    port: 3700,
    name: "Flight Deck Agent Direct Chat (resumed)",
    status: "running",
    agentRuntimeStatus: "stable",
    startedAt: "2026-10-15T03:34:30.000Z",
    npub: "npub1owner",
    command: [],
    workingDirectory: "/tmp/project",
    logs: [],
    origin: { type: "native-resume", id: "earlier-generation" },
    metadata: {
      AGENT: true,
      billingMode: "subscription",
      role: "agent-chat",
      routedBy: "agent-chat",
      nextAction: "reflect",
      nativeAgentSession: {
        agent: "codex",
        sessionId: "native-thread",
        workingDirectory: "/tmp/project",
        capturedAt: "2026-10-13T05:51:28.352Z",
        source: "adapter",
      },
    },
  };
  let stored = { ...session };
  const archived: string[] = [];
  let launches = 0;
  const manager = {
    listSessions: () => [session],
    getSession: (id: string) => id === session.id ? session : undefined,
    updateSessionMetadata: (id: string, metadata: Record<string, unknown>) => {
      if (id !== session.id) return null;
      session = { ...session, metadata: { ...session.metadata, ...metadata } };
      stored = { ...stored, metadata: session.metadata };
      return session;
    },
    stopSession: async (id: string) => {
      if (id !== session.id) return undefined;
      session = { ...session, status: "stopped" };
      return session;
    },
    createSession: async () => {
      launches += 1;
      return { id: `unexpected-${launches}` };
    },
  };
  const auth: RequestAuthContext = {
    npub: "npub1owner",
    actorNpub: "npub1owner",
    signerNpub: "npub1owner",
    subjectNpub: "npub1owner",
    session: null,
    authMethod: "nip98",
  };
  const url = new URL("http://localhost/api/sessions/agent-direct-old");
  const closeResponse = await handleSessionApi(
    new Request(url, { method: "DELETE" }),
    url,
    "DELETE",
    auth,
    {
      manager,
      ensureApiAccess: async () => null,
      AccessActions: { SessionsManage: "sessions:manage", SessionsRead: "sessions:read" },
      getViewerNormalizedNpub: () => "npub1owner",
      isAdminNpub: () => false,
      sessionBelongsToViewer: () => true,
      messageStore: { listSessions: () => [stored] },
      serializeSession: (value: SessionSnapshot) => value,
      scheduleSessionArchive: (id: string) => archived.push(id),
    } as never,
  );

  expect(closeResponse?.status).toBe(200);
  expect(session.status).toBe("stopped");
  expect(session.metadata.explicitlyClosedAt).toBeString();
  expect(archived).toEqual([session.id]);

  await writeFile(markerPath, `${JSON.stringify({
    createdAt: "2026-10-15T07:44:00.000Z",
    mode: "resume-or-fresh",
    version: 4,
    operationId: "preexisting-operation",
    sessionIds: [session.id],
  })}\n`);

  const firstMarker = await loadWarmRestartMarker(markerPath);
  const first = await restoreRestartedSessions(
    firstMarker,
    markerPath,
    manager as never,
    { listSessions: () => [stored], listSessionMessages: () => [], replaceMessages: () => undefined } as never,
    ["codex"],
  );
  const secondMarker = await loadWarmRestartMarker(markerPath);
  const second = await restoreRestartedSessions(
    secondMarker,
    markerPath,
    manager as never,
    { listSessions: () => [stored], listSessionMessages: () => [], replaceMessages: () => undefined } as never,
    ["codex"],
  );

  expect(first).toMatchObject({ restored: 0, failed: [], closedSessionIds: [session.id] });
  expect(second).toMatchObject({ restored: 0, failed: [], closedSessionIds: [session.id] });
  expect(secondMarker).toMatchObject({ status: "recovered", closedSessionIds: [session.id] });
  expect(launches).toBe(0);
});
