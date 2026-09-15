import { describe, expect, test } from "bun:test";

import { AccessActions, type AccessContext } from "./access-control";
import { isCapabilityBoundSelfSessionMetadataRead } from "./session-capability-access";

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
});
