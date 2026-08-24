import { describe, expect, test } from "bun:test";

import { formatSatoshis } from "./dom.js";

describe("identity DOM utilities", () => {
  test("formatSatoshis remains available for cached UI modules", () => {
    expect(formatSatoshis(0)).toBe("0 sats");
    expect(formatSatoshis(1)).toBe("1 sat");
    expect(formatSatoshis(1234.9)).toBe("1,234 sats");
  });

  test("formatSatoshis handles invalid values defensively", () => {
    expect(formatSatoshis(null)).toBe("0 sats");
    expect(formatSatoshis(Number.NaN)).toBe("0 sats");
    expect(formatSatoshis(-10)).toBe("0 sats");
  });
});
