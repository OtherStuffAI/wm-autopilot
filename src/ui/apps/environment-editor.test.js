import { describe, expect, test } from "bun:test";

import { buildManagedEnvironmentPayload } from "./environment-editor.js";

describe("managed app environment editor", () => {
  test("retains masked values, changes entered values, and omits removed rows", () => {
    expect(buildManagedEnvironmentPayload([
      { key: "RETAIN", value: "", existing: true },
      { key: "CHANGE", value: "new", existing: true },
      { key: "ADD", value: "added", existing: false },
    ])).toEqual([
      { key: "RETAIN", retain: true },
      { key: "CHANGE", value: "new" },
      { key: "ADD", value: "added" },
    ]);
  });

  test("rejects invalid names before sending secrets", () => {
    expect(() => buildManagedEnvironmentPayload([{ key: "BAD-NAME", value: "secret" }]))
      .toThrow("Invalid environment variable key");
  });
});
