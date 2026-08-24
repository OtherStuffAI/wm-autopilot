import { describe, expect, test } from "bun:test";

import { getConfiguredAdminNpubs, normaliseNpubList } from "./npub-utils";

describe("normaliseNpubList", () => {
  test("parses comma-separated npubs and removes duplicates", () => {
    expect(normaliseNpubList(" npub1admin , npub1second , npub1admin ")).toEqual([
      "npub1admin",
      "npub1second",
    ]);
  });
});

describe("getConfiguredAdminNpubs", () => {
  test("parses all admins from ADMIN_NPUBS", () => {
    expect(getConfiguredAdminNpubs({
      ADMIN_NPUBS: " npub1admin , npub1secondadmin ",
    })).toEqual(["npub1admin", "npub1secondadmin"]);
  });

  test("prefers the plural variable over legacy aliases", () => {
    expect(getConfiguredAdminNpubs({
      ADMIN_NPUBS: "npub1plural",
      ADMIN_NPUB: "npub1legacy",
      WINGMAN_ADMIN_NPUB: "npub1wingman",
    })).toEqual(["npub1plural"]);
  });
});
