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

test("exact-session queue authority grants list and acknowledge only", () => {
  for (const [method, path, allowed] of [
    ["GET", "/api/sessions/session-self/queue", true],
    ["POST", "/api/sessions/session-self/queue/item/acknowledge", true],
    ["GET", "/api/sessions/session-other/queue", false],
    ["POST", "/api/sessions/session-other/queue/item/acknowledge", false],
    ["POST", "/api/sessions/session-self/queue/next", false],
    ["DELETE", "/api/sessions/session-self/queue/item", false],
    ["GET", "/api/owners/owner/sessions/session-self/queue", false],
  ] as const) expect(isCapabilityBoundSelfSessionQueueOperation(context(method, path, "session-self"))).toBe(allowed);
});
