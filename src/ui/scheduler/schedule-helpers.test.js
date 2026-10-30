import { describe, expect, test } from "bun:test";

import { buildCron, describeCron, displayTimezone, formatTimestamp, parseCron } from "./schedule-helpers.js";

const roundTrip = (expr) => {
  const s = parseCron(expr);
  return buildCron(s.frequency, s.hour, s.minute, s.weekday, s.customCron);
};

describe("parseCron edit round-trip", () => {
  test("preserves midnight instead of turning it into 09:00", () => {
    expect(parseCron("0 0 * * *")).toMatchObject({ frequency: "daily", hour: 0, minute: 0 });
    expect(roundTrip("0 0 * * *")).toBe("0 0 * * *");
    expect(roundTrip("30 0 * * 1-5")).toBe("30 0 * * 1-5");
    expect(parseCron("0 0 * * 0")).toMatchObject({ frequency: "weekly", hour: 0, weekday: "0" });
    expect(roundTrip("0 0 * * 0")).toBe("0 0 * * 0");
  });

  test("keeps every friendly schedule exactly", () => {
    for (const expr of ["* * * * *", "*/5 * * * *", "*/15 * * * *", "*/30 * * * *", "15 * * * *", "0 */2 * * *", "45 */6 * * *", "0 9 * * *", "5 17 * * 1-5", "0 7 * * 1", "55 23 * * 6"]) {
      expect(parseCron(expr).frequency).not.toBe("custom");
      expect(roundTrip(expr)).toBe(expr);
    }
  });

  test("keeps custom expressions verbatim as a custom schedule", () => {
    for (const expr of ["0 9-17 * * 1-5", "0 9 * * 1,3", "0 */12 * * *", "0 9 1 * *", "0 9 * 6 *", "00 09 * * *", "0 9 * * 7", "*/10 * * * *", "0 9 * *", "0 9 * * MON"]) {
      expect(parseCron(expr).frequency).toBe("custom");
      expect(roundTrip(expr)).toBe(expr);
      expect(describeCron(expr)).toBe(`Custom schedule: ${expr}`);
    }
  });

  test("keeps off-grid minutes exact while describing them accurately", () => {
    expect(parseCron("7 9 * * *").frequency).toBe("custom");
    expect(roundTrip("7 9 * * *")).toBe("7 9 * * *");
    expect(describeCron("7 9 * * *")).toBe("Daily at 09:07");
  });

  test("normalises only whitespace and defaults when there is no expression", () => {
    expect(roundTrip("  0   9 * * *  ")).toBe("0 9 * * *");
    expect(parseCron("")).toMatchObject({ frequency: "daily", hour: 9, minute: 0 });
  });

  test("describes exact friendly schedules in plain language", () => {
    expect(describeCron("0 0 * * *")).toBe("Daily at 00:00");
    expect(describeCron("30 8 * * 1-5")).toBe("Weekdays at 08:30");
    expect(describeCron("0 */4 * * *")).toBe("Every 4h at :00");
  });
});

describe("timestamp display zone", () => {
  test("labels the zone and converts into it", () => {
    const perth = formatTimestamp("2026-10-30T06:05:00Z", "Australia/Perth");
    expect(perth).toContain("2:05");
    expect(perth).toMatch(/GMT\+8|AWST/);
    expect(formatTimestamp("2026-10-30T06:05:00Z", "UTC")).toMatch(/UTC/);
  });

  test("handles empty, invalid and unknown-zone input", () => {
    expect(formatTimestamp("")).toBe("—");
    expect(formatTimestamp("nope")).toBe("nope");
    expect(formatTimestamp("2026-10-30T06:05:00Z", "Not/AZone")).toMatch(/\d/);
  });

  test("reports a valid browser zone", () => {
    expect(displayTimezone().length).toBeGreaterThan(0);
  });
});
