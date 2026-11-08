import { describe, expect, test } from "bun:test";

import { AccessActions, type AccessContext } from "./access-control";
import {
  isCapabilityBoundSelfSessionMetadataOperation,
  isCapabilityBoundSelfSessionQueueOperation,
  isCapabilityBoundSelfSessionMetadataRead,
} from "./session-capability-access";

function context(method: string, pathname: string, capabilitySessionId: string | null): AccessContext {
  const request = new Request(`http://localhost${pathname}`, { method });
  return {
    action: AccessActions.SessionsRead,
    request,
    url: new URL(request.url),
    auth: {
      npub: "npub1bot",
      actorNpub: "npub1bot",
      signerNpub: "npub1bot",
      subjectNpub: "npub1bot",
      targetOwnerNpub: "npub1bot",
      delegatedOwnerNpub: null,
      session: null,
      authMethod: "nip98",
      capabilitySessionId,
    },
  };
}

describe("session capability access helpers", () => {
  test("allows only broker-bound self-session metadata reads", () => {
    expect(
      isCapabilityBoundSelfSessionMetadataRead(
        context("GET", "/api/sessions/session-self/metadata", "session-self"),
      ),
    ).toBeTrue();
    expect(
      isCapabilityBoundSelfSessionMetadataRead(
        context("GET", "/api/sessions/session-other/metadata", "session-self"),
      ),
    ).toBeFalse();
    expect(
      isCapabilityBoundSelfSessionMetadataRead(
        context("PATCH", "/api/sessions/session-self/metadata", "session-self"),
      ),
    ).toBeFalse();
    expect(
      isCapabilityBoundSelfSessionMetadataRead(
        context("GET", "/api/sessions", "session-self"),
      ),
    ).toBeFalse();
  });

  test("allows self metadata PATCH but denies cross-session and owner-space PATCH", () => {
    expect(isCapabilityBoundSelfSessionMetadataOperation(
      context("PATCH", "/api/sessions/session-self/metadata", "session-self"),
    )).toBeTrue();
    expect(isCapabilityBoundSelfSessionMetadataOperation(
      context("PATCH", "/api/sessions/session-other/metadata", "session-self"),
    )).toBeFalse();
    expect(isCapabilityBoundSelfSessionMetadataOperation(
      context("PATCH", "/api/owners/npub1owner/sessions/session-self/metadata", "session-self"),
    )).toBeFalse();
  });
});

test("exact-session queue authority grants only exact-session list and handled operations", () => {
  for (const [method, path, allowed] of [
    ["GET", "/api/sessions/session-self/queue", true],
    ["POST", "/api/sessions/session-self/queue/item/acknowledge", true],
    ["POST", "/api/sessions/session-self/queue/item/consume", true],
    ["POST", "/api/sessions/session-other/queue/item/consume", false],
    ["POST", "/api/sessions/session-self/queue/item/reconcile", true],
    ["GET", "/api/sessions/session-other/queue", false],
    ["POST", "/api/sessions/session-other/queue/item/acknowledge", false],
    ["POST", "/api/sessions/session-other/queue/item/reconcile", false],
    ["POST", "/api/sessions/session-self/queue/next", false],
    ["DELETE", "/api/sessions/session-self/queue/item", false],
    ["GET", "/api/owners/owner/sessions/session-self/queue", false],
  ] as const) expect(isCapabilityBoundSelfSessionQueueOperation(context(method, path, "session-self"))).toBe(allowed);
});

import { permitsSessionQueueSigning } from "../signing/session-queue-policy";
import { handleQueueRoutes } from "../server/session-queue-routes";
import { PromptQueueStore } from "../storage/prompt-queue-store";
import { runSessionQueueCli } from "../../clis/session-queue";
import type { SessionApiContext } from "../server/session-api-routes";
import type { SessionSnapshot } from "../agents/process-manager";

test("CLI consume and acknowledge compose signing, exact-session access, route and revision storage", async () => {
  for (const action of ["consume", "acknowledge"]) {
    const store = new PromptQueueStore(":memory:");
    const prompt = store.addPrompt("self", { content: "Incorporate this steering" })!;
    const ctx = { promptQueueStore: store, queueDispatchInFlight: new Set() } as unknown as SessionApiContext;
    const owned = { id: "self", status: "running" } as SessionSnapshot;
    const request = async (_url: string, method: string, path: string, body?: unknown) => {
      expect(permitsSessionQueueSigning(path, method, "self", "signed-body-hash")).toBeTrue();
      const access = context(method, path, "self");
      expect(isCapabilityBoundSelfSessionQueueOperation(access)).toBeTrue();
      const http = new Request(access.url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const response = await handleQueueRoutes(http, method, path.split("/"), "self", owned, access.auth, ctx);
      const payload = await response.json();
      if (!response.ok) throw new Error(`${response.status}`);
      return payload;
    };
    await expect(runSessionQueueCli([action, prompt.id, "--revision", "999", "--reason", "stale"], {
      env: { SESSION_ID: "self" }, request, stdout: () => {},
    })).rejects.toThrow("409");
    expect(store.getSessionQueue("self")).toHaveLength(1);
    await runSessionQueueCli([action, prompt.id, "--revision", prompt.revision, "--reason", "Incorporated into active plan"], {
      env: { SESSION_ID: "self" }, request, stdout: () => {},
    });
    expect(store.getSessionQueue("self")).toHaveLength(0);
    expect(store.getHandledPrompts("self")[0]).toMatchObject({ handledBy: "session:self", handledReason: "Incorporated into active plan" });
    for (const path of [`/api/sessions/other/queue/${prompt.id}/${action}`, `/api/owners/owner/sessions/self/queue/${prompt.id}/${action}`]) {
      expect(permitsSessionQueueSigning(path, "POST", "self", "hash")).toBeFalse();
      expect(isCapabilityBoundSelfSessionQueueOperation(context("POST", path, "self"))).toBeFalse();
    }
    expect(isCapabilityBoundSelfSessionQueueOperation(context("GET", `/api/sessions/self/queue/${prompt.id}/${action}`, "self"))).toBeFalse();
  }
});
