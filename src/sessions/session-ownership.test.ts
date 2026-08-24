import { describe, expect, test } from "bun:test";

import { resolveSessionOwnerNpub, sessionBelongsToViewer } from "./session-ownership";

describe("session ownership", () => {
  test("prefers metadata owner npub when present", () => {
    expect(
      resolveSessionOwnerNpub("npub1runtime", { ownerNpub: "npub1owner" } as any),
    ).toBe("npub1owner");
  });

  test("falls back to session npub when metadata owner is absent", () => {
    expect(
      resolveSessionOwnerNpub("npub1runtime", { ownerNpub: undefined } as any),
    ).toBe("npub1runtime");
  });

  test("treats metadata owner as visible to the matching viewer", () => {
    expect(
      sessionBelongsToViewer(null, { ownerNpub: "npub1owner" } as any, "npub1owner", false),
    ).toBe(true);
  });

  test("keeps admin access unconditional", () => {
    expect(
      sessionBelongsToViewer(null, null, null, true),
    ).toBe(true);
  });
});
